// setup_form_cases.h — the request-level tests of SetupForm (setup_form.h), written once and run
// against each sketch's real key table by test_setup_form_recorder.cpp and
// test_setup_form_person.cpp. (Two files, not one: both sketch folders hold their own copy of
// settings_logic.h, and one program cannot include both copies.)
//
// The including file first includes its sketch's settings_schema.h and setup_form.h, then defines
//
//     struct SetupFixture { ... };          // what is specific to that sketch, see below
//
// and finally includes this header and calls runSetupFormCases() from main().
//
// The two setup settings (SETUP_MODE, SETUP_PASSWORD) are added to the sketch's table here when it
// does not have them yet (F-21 S1 adds them to the real tables; `extended()` then adds nothing),
// so these tests do not depend on when S1 lands.
//
// What the cases are for: the form is reachable by anybody who has the master password, so what
// matters most is what a request must NOT be able to do — store half a form, skip the password
// rule, bypass the CSRF token, inject markup, read a secret back, or keep the board in setup mode.

#pragma once

#include "framework.h"

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "settings_fakes.h"

using namespace esp32cam_setup;

static const char* const DEFAULT_PW = SETUP_DEFAULT_PASSWORD;
static const char* const OWN_PW     = "My-Own-Master-1";
static const char* const TOKEN      = "0123456789abcdef0123456789abcdef";
static const char* const PORTAL     = "http://192.168.4.1/";

// ── the sketch's table plus the two setup settings ──────────────────────

struct ExtendedSchema {
    std::vector<KeyDef> keys;
    Schema schema;
    explicit ExtendedSchema(const Schema& base, bool withSetupKeys) {
        for (size_t i = 0; i < base.count; ++i) {
            std::string n = base.keys[i].name;
            if (!withSetupKeys && (n == SETUP_MODE_KEY || n == SETUP_PASSWORD_KEY)) continue;
            keys.push_back(base.keys[i]);
        }
        if (withSetupKeys) {
            KeyDef mode = { SETUP_MODE_KEY, Kind::Bool, 0, 0, Cond::Optional, nullptr, nullptr, "1: open the setup WiFi on the next restart" };
            KeyDef pass = { SETUP_PASSWORD_KEY, Kind::Secret, 0, 0, Cond::Optional, nullptr, nullptr, "master password of the setup WiFi" };
            if (!findKey(base, SETUP_MODE_KEY)) keys.push_back(mode);
            if (!findKey(base, SETUP_PASSWORD_KEY)) keys.push_back(pass);
        }
        schema.keys = keys.data();
        schema.count = keys.size();
        schema.crossCheck = base.crossCheck;
    }
private:
    ExtendedSchema(const ExtendedSchema&);
    ExtendedSchema& operator=(const ExtendedSchema&);
};

static const Schema& extended() {
    static ExtendedSchema ext(SetupFixture::schema(), true);
    return ext.schema;
}
static const Schema& withoutSetupKeys() {
    static ExtendedSchema ext(SetupFixture::schema(), false);
    return ext.schema;
}

// ── request building ────────────────────────────────────────────────────

// Percent-encodes everything but letters, digits and -_.~ — what a browser sends.
static std::string enc(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

struct Post {
    std::vector<std::pair<std::string, std::string> > f;
    Post& add(const std::string& k, const std::string& v) { f.push_back(std::make_pair(k, v)); return *this; }
    // replaces the value of a field that is already there
    Post& set(const std::string& k, const std::string& v) {
        for (size_t i = 0; i < f.size(); ++i) if (f[i].first == k) { f[i].second = v; return *this; }
        return add(k, v);
    }
    Post& drop(const std::string& k) {
        for (size_t i = 0; i < f.size(); ++i) if (f[i].first == k) { f.erase(f.begin() + i); break; }
        return *this;
    }
    std::string body() const {
        std::string b;
        for (size_t i = 0; i < f.size(); ++i) {
            if (i) b += '&';
            b += enc(f[i].first) + "=" + enc(f[i].second);
        }
        return b;
    }
};

// A line "KEY=v;KEY=v;..." as the form fields a browser would send for it.
static Post fieldsOf(const Schema& schema, const std::string& line) {
    Post p;
    ParsedLine parsed = parseLine(line);
    for (size_t i = 0; i < parsed.pairs.size(); ++i) {
        const KeyDef* def = findKey(schema, parsed.pairs[i].key);
        if (def && def->kind == Kind::Wifi) {
            std::vector<WifiNet> nets;
            std::string err;
            parseWifiList(parsed.pairs[i].value, nets, err);
            for (size_t n = 0; n < nets.size(); ++n) {
                std::string idx = std::to_string(n + 1);
                p.add("w.ssid." + idx, nets[n].ssid);
                p.add("w.pass." + idx, nets[n].pass);
                if (nets[n].pass.empty()) p.add("w.open." + idx, "1");
            }
            continue;
        }
        std::string v, err;
        unescapeText(parsed.pairs[i].value, v, err);
        p.add(fieldOf(parsed.pairs[i].key), v);
    }
    return p;
}

// Everything a blank board needs, plus the CSRF token and a master password typed twice.
static Post fullPost() {
    Post p;
    p.add("csrf", TOKEN);
    Post f = fieldsOf(extended(), SetupFixture::typical());
    p.f.insert(p.f.end(), f.f.begin(), f.f.end());
    p.add("v.SETUP_PASSWORD", OWN_PW).add("v.SETUP_PASSWORD.confirm", OWN_PW);
    return p;
}

// ── the board under test ────────────────────────────────────────────────

// Remembers the order of writes (SETUP_MODE must come last).
struct RecordingStore : MemoryStore {
    std::vector<std::string> order;
    bool set(const std::string& k, const std::string& v) override {
        bool ok = MemoryStore::set(k, v);
        if (ok) order.push_back(k);
        return ok;
    }
};

static FormConfig makeConfig() {
    FormConfig c;
    c.title = "espcamsys2-test-d4e5f6";
    c.prerequisites = SetupFixture::prerequisites();
    return c;
}

struct Env {
    RecordingStore st;
    SetupForm form;
    Env() : form(extended(), st, makeConfig(), TOKEN) {}
    explicit Env(const std::string& token) : form(extended(), st, makeConfig(), token) {}
    Env(const Schema& schema, bool) : form(schema, st, makeConfig(), TOKEN) {}

    HttpReply get(const std::string& path = "/") { return form.handle("GET", path, ""); }
    HttpReply post(const std::string& path, const Post& p) { return form.handle("POST", path, p.body()); }
    HttpReply save(const Post& p) { return post("/save", p); }

    // A board that is fully configured (the typical line), with its own master password unless told otherwise.
    void configure(bool ownPassword = true, bool armed = false) {
        CheckedLine c = checkLine(extended(), SetupFixture::typical());
        for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
        if (ownPassword) st.set("SETUP_PASSWORD", OWN_PW);
        if (armed) st.set("SETUP_MODE", "1");
        st.order.clear();
    }
};

static bool has(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }

static const std::string* header(const HttpReply& r, const std::string& name) {
    for (size_t i = 0; i < r.headers.size(); ++i) if (r.headers[i].first == name) return &r.headers[i].second;
    return nullptr;
}

static std::map<std::string, std::string> snapshot(RecordingStore& st) { return st.m; }

static std::string stored(Env& e, const std::string& key) { return e.st.has(key) ? e.st.get(key) : std::string("<absent>"); }

// ── a blank board ───────────────────────────────────────────────────────

TEST(a_blank_board_gets_a_form_that_asks_for_what_is_missing) {
    Env e;
    HttpReply r = e.get();
    TEST_ASSERT_EQ(r.status, 200, "the form is served");
    TEST_ASSERT(has(r.contentType, "text/html"), "as HTML");
    TEST_ASSERT(has(r.body, "name=\"csrf\" value=\"" + std::string(TOKEN) + "\""), "with the session's CSRF token");
    TEST_ASSERT(has(r.body, "action=\"/save\""), "posting to /save");
    TEST_ASSERT(has(r.body, "required"), "missing settings are marked");
    TEST_ASSERT(has(r.body, "name=\"v.API_KEY\"") && has(r.body, "type=\"password\""), "a secret is a password box");
    TEST_ASSERT(has(r.body, "name=\"w.ssid.1\"") && has(r.body, "name=\"w.open.3\""), "WiFi is rows of name / password / open");
    TEST_ASSERT(has(r.body, "name=\"v.SETUP_PASSWORD\"") && has(r.body, "name=\"v.SETUP_PASSWORD.confirm\""), "the master password is asked twice");
    TEST_ASSERT(has(r.body, "public default"), "and says why");
    TEST_ASSERT(!has(r.body, "name=\"v.SETUP_MODE\""), "the setup switch is not on the form");
    TEST_ASSERT(!has(r.body, "action=\"/exit\"") && !has(r.body, "Exit setup mode"), "no exit button: there is nothing to go back to");
    TEST_ASSERT(!has(r.body, "<script"), "there is no script in the page at all");
    TEST_ASSERT(!has(r.body, DEFAULT_PW), "the default password is not printed");
    const std::string* csp = header(r, "Content-Security-Policy");
    TEST_ASSERT(csp && has(*csp, "default-src 'none'") && !has(*csp, "script-src"), "a strict content security policy");
    const std::string* cache = header(r, "Cache-Control");
    TEST_ASSERT(cache && *cache == "no-store", "never cached");
    TEST_ASSERT(header(r, "X-Content-Type-Options") != nullptr, "nosniff");
    TEST_ASSERT(e.st.m.empty() && e.st.badGets == 0, "viewing the form stores nothing and reads no missing key");
}

TEST(a_complete_form_on_a_blank_board_is_stored_and_ends_setup) {
    Env e;
    HttpReply r = e.save(fullPost());
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT(e.form.saved(), "saved() is set");
    TEST_ASSERT(!e.form.exited(), "not exited");
    TEST_ASSERT(has(r.body, "restarting"), "the page says the board restarts");
    TEST_ASSERT(findProblems(extended(), e.st).empty(), "the board is complete");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("0"), "SETUP_MODE is switched off");
    TEST_ASSERT_EQ(stored(e, "SETUP_PASSWORD"), std::string(OWN_PW), "the new master password is stored");
    CheckedLine typical = checkLine(extended(), SetupFixture::typical());
    bool all = true;
    for (size_t i = 0; i < typical.pairs.size(); ++i) {
        if (stored(e, typical.pairs[i].key) != typical.pairs[i].value) all = false;
    }
    TEST_ASSERT(all, "every setting has exactly the value that was typed");
    TEST_ASSERT_EQ(e.st.badGets, 0, "no missing key was read");
}

TEST(SETUP_MODE_is_written_last_so_an_interrupted_save_leaves_the_board_in_setup) {
    Env e;
    e.save(fullPost());
    TEST_ASSERT(!e.st.order.empty() && e.st.order.back() == "SETUP_MODE", "SETUP_MODE is the last write");
    Env armed;
    armed.configure(true, true);
    armed.save(Post().add("csrf", TOKEN).add("v." + SetupFixture::changeKey(), SetupFixture::changeNew()));
    TEST_ASSERT(!armed.st.order.empty() && armed.st.order.back() == "SETUP_MODE", "also on an armed board");
}

TEST(a_flash_failure_stores_nothing_new_and_does_not_end_setup) {
    Env e;
    e.configure(true, true);
    e.st.failWrites = true;
    HttpReply r = e.save(Post().add("csrf", TOKEN).add("v." + SetupFixture::changeKey(), SetupFixture::changeNew()));
    TEST_ASSERT(r.status >= 400, "reported");
    TEST_ASSERT(has(r.body, "flash"), "says why");
    TEST_ASSERT(!e.form.saved(), "not saved");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("1"), "still armed");
    TEST_ASSERT_EQ(stored(e, SetupFixture::changeKey()), SetupFixture::changeOld(), "the old value is still there");
}

// ── nothing is stored unless the whole form is valid ────────────────────

TEST(a_missing_setting_stores_nothing_and_names_it) {
    Env e;
    Post p = fullPost();
    p.drop("v.API_KEY");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected");
    TEST_ASSERT(e.st.m.empty(), "NOTHING is stored (all or nothing)");
    TEST_ASSERT(!e.form.saved(), "not saved");
    TEST_ASSERT(has(r.body, "API_KEY"), "the missing setting is named");
    TEST_ASSERT(has(r.body, "role=\"alert\""), "in an alert");
    TEST_ASSERT(has(r.body, "value=\"" + SetupFixture::hostValue() + "\""), "what was typed comes back, nothing has to be typed again");
}

TEST(an_invalid_value_stores_nothing_and_every_problem_is_listed_at_once) {
    Env e;
    Post p = fullPost();
    p.set("v.HTTP_PORT", "70000").set("v.SERVER_HOST", "bad host!");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
    TEST_ASSERT(has(r.body, "HTTP_PORT") && has(r.body, "SERVER_HOST"), "both problems are reported together");
}

TEST(the_error_messages_never_contain_a_secret) {
    Env e;
    Post p = fullPost();
    p.set("v.API_KEY", "change-me");                    // refused by name, must not be echoed in the list
    p.set("v.SETUP_PASSWORD", "tiny-secret").set("v.SETUP_PASSWORD.confirm", "other-secret");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected");
    TEST_ASSERT(!has(r.body, "tiny-secret") && !has(r.body, "other-secret"), "typed passwords are not in the page");
    TEST_ASSERT(!has(r.body, "change-me\""), "the API key is not echoed");
}

TEST(a_cross_setting_rule_is_enforced) {
    Env e;
    e.configure();
    Post p = Post().add("csrf", TOKEN);
    p.add("v." + SetupFixture::ruleKey(), SetupFixture::ruleBadValue());
    auto before = snapshot(e.st);
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected");
    TEST_ASSERT(snapshot(e.st) == before, "nothing changed");
}

// ── the master password rule ────────────────────────────────────────────

TEST(a_blank_board_cannot_leave_without_choosing_a_master_password) {
    Env e;
    Post p = fullPost();
    p.drop("v.SETUP_PASSWORD").drop("v.SETUP_PASSWORD.confirm");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected");
    TEST_ASSERT(has(r.body, "master password"), "with a clear message");
    TEST_ASSERT(e.st.m.empty() && !e.form.saved(), "nothing stored");

    Post blank = fullPost();
    blank.set("v.SETUP_PASSWORD", "").set("v.SETUP_PASSWORD.confirm", "");
    TEST_ASSERT_EQ(e.save(blank).status, 422, "empty fields are the same as absent ones");
    TEST_ASSERT(e.st.m.empty(), "still nothing stored");
}

TEST(the_default_a_short_or_an_odd_password_is_refused) {
    const char* bad[] = { DEFAULT_PW, "short", "1234567", "has\x01" "control", "accent-\xC3\xA9-1234", "" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        Env e;
        Post p = fullPost();
        p.set("v.SETUP_PASSWORD", bad[i]).set("v.SETUP_PASSWORD.confirm", bad[i]);
        HttpReply r = e.save(p);
        TEST_ASSERT_EQ(r.status, 422, ("refused: " + std::to_string(i)).c_str());
        TEST_ASSERT(e.st.m.empty() && !e.form.saved(), ("nothing stored: " + std::to_string(i)).c_str());
    }
    Env d;
    Post p = fullPost();
    p.set("v.SETUP_PASSWORD", DEFAULT_PW).set("v.SETUP_PASSWORD.confirm", DEFAULT_PW);
    HttpReply r = d.save(p);
    TEST_ASSERT(has(r.body, "built-in default"), "the default gets its own message");
    TEST_ASSERT(!has(r.body, DEFAULT_PW), "which does not print it");
}

TEST(the_two_password_fields_must_match) {
    Env e;
    Post p = fullPost();
    p.set("v.SETUP_PASSWORD.confirm", "Not-The-Same-1");
    TEST_ASSERT_EQ(e.save(p).status, 422, "different");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
    p.drop("v.SETUP_PASSWORD.confirm");
    TEST_ASSERT_EQ(e.save(p).status, 422, "no confirmation at all");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
    TEST_ASSERT_EQ(e.save(fullPost()).status, 200, "the same twice is accepted");
}

TEST(a_configured_board_that_still_has_the_default_must_also_choose_one) {
    Env none;
    none.configure(false);
    Post keep = Post().add("csrf", TOKEN);
    TEST_ASSERT_EQ(none.save(keep).status, 422, "no stored password and none typed");
    TEST_ASSERT(!none.form.saved() && stored(none, "SETUP_PASSWORD") == "<absent>", "nothing stored");

    Env serialDefault;
    serialDefault.configure(false);
    serialDefault.st.set("SETUP_PASSWORD", DEFAULT_PW);      // set to the default over serial: still the default
    TEST_ASSERT_EQ(serialDefault.save(keep).status, 422, "a stored default does not count");

    Env tooShort;
    tooShort.configure(false);
    tooShort.st.set("SETUP_PASSWORD", "abc");                // the setup WiFi could not even use it (WPA2 needs 8)
    TEST_ASSERT_EQ(tooShort.save(keep).status, 422, "a stored password WPA2 cannot use does not count");

    Env ok;
    ok.configure(false);
    Post fresh = Post().add("csrf", TOKEN).add("v.SETUP_PASSWORD", OWN_PW).add("v.SETUP_PASSWORD.confirm", OWN_PW);
    TEST_ASSERT_EQ(ok.save(fresh).status, 200, "a new one is accepted");
    TEST_ASSERT_EQ(stored(ok, "SETUP_PASSWORD"), std::string(OWN_PW), "and stored");
}

TEST(a_stored_own_password_is_kept_when_the_boxes_are_blank_and_never_shown) {
    Env e;
    e.configure(true, true);
    HttpReply page = e.get();
    TEST_ASSERT(has(page.body, "One is set"), "the page says a password is set");
    TEST_ASSERT(!has(page.body, "public default"), "and does not nag");
    TEST_ASSERT(!has(page.body, OWN_PW), "without showing it");
    HttpReply r = e.save(Post().add("csrf", TOKEN).add("v.SETUP_PASSWORD", "").add("v.SETUP_PASSWORD.confirm", ""));
    TEST_ASSERT_EQ(r.status, 200, "saving with blank password boxes is fine");
    TEST_ASSERT_EQ(stored(e, "SETUP_PASSWORD"), std::string(OWN_PW), "the password is unchanged");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("0"), "and the switch is off");
}

// ── CSRF ────────────────────────────────────────────────────────────────

TEST(a_post_without_the_right_token_is_forbidden_and_changes_nothing) {
    const char* paths[] = { "/save", "/exit" };
    for (size_t k = 0; k < 2; ++k) {
        std::string path = paths[k];
        Env e;
        e.configure(true, true);
        auto before = snapshot(e.st);
        Post base = fullPost();

        Post missing = base; missing.drop("csrf");
        TEST_ASSERT_EQ(e.post(path, missing).status, 403, (path + ": no token").c_str());
        Post wrong = base; wrong.set("csrf", "ffffffffffffffffffffffffffffffff");
        TEST_ASSERT_EQ(e.post(path, wrong).status, 403, (path + ": wrong token").c_str());
        Post empty = base; empty.set("csrf", "");
        TEST_ASSERT_EQ(e.post(path, empty).status, 403, (path + ": empty token").c_str());
        Post shorter = base; shorter.set("csrf", std::string(TOKEN).substr(0, 31));
        TEST_ASSERT_EQ(e.post(path, shorter).status, 403, (path + ": a prefix of the token").c_str());
        Post longer = base; longer.set("csrf", std::string(TOKEN) + "0");
        TEST_ASSERT_EQ(e.post(path, longer).status, 403, (path + ": the token plus a character").c_str());
        Post upper = base; upper.set("csrf", "0123456789ABCDEF0123456789ABCDEF");
        TEST_ASSERT_EQ(e.post(path, upper).status, 403, (path + ": same letters, other case").c_str());
        Post renamed = base; renamed.drop("csrf").add("CSRF", TOKEN);
        TEST_ASSERT_EQ(e.post(path, renamed).status, 403, (path + ": the field name is exact").c_str());
        Post prefixed = base; prefixed.drop("csrf").add("v.csrf", TOKEN);
        TEST_ASSERT_EQ(e.post(path, prefixed).status, 403, (path + ": not hidden among the settings").c_str());

        TEST_ASSERT(snapshot(e.st) == before, (path + ": nothing was stored by any of them").c_str());
        TEST_ASSERT(!e.form.saved() && !e.form.exited(), (path + ": neither saved nor exited").c_str());
    }
}

TEST(a_board_without_a_usable_token_refuses_every_post) {
    Env e(std::string("short"));            // shorter than MIN_TOKEN_LENGTH: as good as none
    Post p = fullPost();
    p.set("csrf", "short");
    TEST_ASSERT_EQ(e.save(p).status, 403, "even when the (weak) token matches");
    Env none{std::string()};
    p.set("csrf", "");
    TEST_ASSERT_EQ(none.save(p).status, 403, "an empty token never matches an empty field");
    TEST_ASSERT(none.st.m.empty(), "nothing stored");
}

TEST(a_get_request_cannot_change_anything) {
    Env e;
    e.configure(true, true);
    auto before = snapshot(e.st);
    e.get("/?v.API_KEY=pwned&csrf=" + std::string(TOKEN));
    e.get("/save?v.API_KEY=pwned&csrf=" + std::string(TOKEN));
    e.form.handle("GET", "/exit?csrf=" + std::string(TOKEN), "");
    TEST_ASSERT(snapshot(e.st) == before, "a query string is ignored");
    TEST_ASSERT(!e.form.saved() && !e.form.exited(), "nothing happened");
}

// ── routing ─────────────────────────────────────────────────────────────

TEST(only_the_documented_requests_are_answered) {
    Env e;
    TEST_ASSERT_EQ(e.get("/").status, 200, "GET /");
    TEST_ASSERT_EQ(e.get("/?x=1").status, 200, "a query string is ignored");
    HttpReply a = e.form.handle("POST", "/", "");
    TEST_ASSERT_EQ(a.status, 405, "POST / is refused");
    TEST_ASSERT(header(a, "Allow") && *header(a, "Allow") == "GET", "with an Allow header");
    HttpReply b = e.get("/save");
    TEST_ASSERT_EQ(b.status, 405, "GET /save");
    TEST_ASSERT(header(b, "Allow") && *header(b, "Allow") == "POST", "Allow: POST");
    TEST_ASSERT_EQ(e.get("/exit").status, 405, "GET /exit");
    TEST_ASSERT_EQ(e.form.handle("PUT", "/save", "").status, 405, "PUT /save");
    TEST_ASSERT_EQ(e.form.handle("DELETE", "/", "").status, 405, "DELETE /");
    TEST_ASSERT_EQ(e.form.handle("HEAD", "/", "").status, 405, "HEAD /");
    TEST_ASSERT_EQ(e.form.handle("get", "/", "").status, 405, "methods are case-sensitive");
    TEST_ASSERT_EQ(e.get("/nothing-here").status, 404, "unknown path");
    TEST_ASSERT_EQ(e.get("/SAVE").status, 404, "paths are case-sensitive");
    TEST_ASSERT_EQ(e.get("/save/").status, 404, "no trailing-slash alias");
    TEST_ASSERT_EQ(e.get("/favicon.ico").status, 404, "favicon");
    TEST_ASSERT_EQ(e.get("").status, 404, "an empty target");
    TEST_ASSERT_EQ(e.get("http://192.168.4.1/").status, 404, "an absolute-form target is not routed");
    TEST_ASSERT_EQ(e.get("//").status, 404, "double slash");
    TEST_ASSERT_EQ(e.get("/..%2f").status, 404, "traversal-looking path");
    TEST_ASSERT(e.st.m.empty(), "none of that stored anything");
}

TEST(captive_portal_probes_are_sent_to_the_form) {
    Env e;
    const char* probes[] = { "/generate_204", "/hotspot-detect.html", "/connecttest.txt", "/ncsi.txt", "/canonical.html" };
    for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); ++i) {
        HttpReply r = e.get(probes[i]);
        TEST_ASSERT_EQ(r.status, 302, (std::string(probes[i]) + " is redirected").c_str());
        TEST_ASSERT(header(r, "Location") && *header(r, "Location") == PORTAL, "to the form");
    }
    TEST_ASSERT_EQ(e.form.handle("POST", "/generate_204", "").status, 405, "only GET is a probe");
}

// ── a configured board ──────────────────────────────────────────────────

TEST(a_configured_board_shows_its_values_and_offers_to_exit) {
    Env e;
    e.configure(true, true);
    HttpReply r = e.get();
    TEST_ASSERT(has(r.body, "action=\"/exit\"") && has(r.body, "Exit setup mode"), "the exit button is there");
    TEST_ASSERT(has(r.body, "name=\"csrf\" value=\"" + std::string(TOKEN) + "\""), "...with the token");
    TEST_ASSERT(has(r.body, "value=\"" + SetupFixture::hostValue() + "\""), "stored plain values are shown");
    TEST_ASSERT(has(r.body, "value=\"" + SetupFixture::wifiSsid() + "\""), "stored WiFi names are shown");
    TEST_ASSERT(has(r.body, "password set"), "a stored password is only said to be set");
    TEST_ASSERT(!has(r.body, "class=\"tag\">required"), "nothing is marked required");
    TEST_ASSERT(!has(r.body, "name=\"v.SETUP_MODE\""), "the setup switch is not offered");
}

TEST(a_partial_change_on_a_configured_board_changes_only_that_setting_and_ends_setup) {
    Env e;
    e.configure(true, true);
    auto before = snapshot(e.st);
    HttpReply r = e.save(Post().add("csrf", TOKEN).add("v." + SetupFixture::changeKey(), SetupFixture::changeNew()));
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT(e.form.saved(), "saved");
    auto after = snapshot(e.st);
    TEST_ASSERT_EQ(after[SetupFixture::changeKey()], SetupFixture::changeNew(), "the setting changed");
    TEST_ASSERT_EQ(after["SETUP_MODE"], std::string("0"), "SETUP_MODE went to 0");
    after.erase(SetupFixture::changeKey());
    after.erase("SETUP_MODE");
    before.erase(SetupFixture::changeKey());
    before.erase("SETUP_MODE");
    TEST_ASSERT(after == before, "everything else is as it was");
}

TEST(submitting_the_page_as_it_was_served_changes_nothing_but_the_switch) {
    Env e;
    e.configure(true, true);
    Post p = Post().add("csrf", TOKEN);
    Post f = fieldsOf(extended(), SetupFixture::typical());
    for (size_t i = 0; i < f.f.size(); ++i) {
        if (f.f[i].first.compare(0, 7, "w.pass.") == 0) p.add(f.f[i].first, "");     // the browser sends the blank password boxes
        else p.f.push_back(f.f[i]);
    }
    auto before = snapshot(e.st);
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    auto after = snapshot(e.st);
    TEST_ASSERT_EQ(after["SETUP_MODE"], std::string("0"), "the switch is off");
    after.erase("SETUP_MODE");
    before.erase("SETUP_MODE");
    TEST_ASSERT(after == before, "no other value changed (the WiFi passwords were kept)");
}

TEST(a_configured_board_that_is_still_incomplete_can_be_filled_in_later) {
    Env e;
    e.configure();
    e.st.m.erase(SetupFixture::changeKey());                  // something the relay would still fill in
    TEST_ASSERT_EQ(e.save(Post().add("csrf", TOKEN)).status, 422, "saving without it is refused (the engine says it is needed)");
    TEST_ASSERT(e.st.m.count("SETUP_MODE") == 0 || e.st.m["SETUP_MODE"] != "0", "and does not end setup");
    TEST_ASSERT_EQ(e.save(Post().add("csrf", TOKEN).add("v." + SetupFixture::changeKey(), SetupFixture::changeNew())).status, 200, "typing it fixes that");
}

TEST(the_locked_settings_can_be_changed_here_because_the_user_is_at_the_board) {
    Env e;
    e.configure(true, true);
    std::vector<std::string> locked = SetupFixture::locked();
    const char* keys[] = { "WIFI", "SERVER_HOST", "API_KEY" };
    for (size_t i = 0; i < 3; ++i) {
        bool isLocked = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == keys[i]) isLocked = true;
        TEST_ASSERT(isLocked, (std::string(keys[i]) + " really is locked against the dashboard").c_str());
    }
    RecordingStore probe;
    CheckedLine c = checkLine(extended(), SetupFixture::typical());
    for (size_t i = 0; i < c.pairs.size(); ++i) probe.set(c.pairs[i].key, c.pairs[i].value);
    TEST_ASSERT(!applyChangeLine(extended(), probe, "SERVER_HOST=10.9.9.9", locked).ok(), "the dashboard path refuses it");

    Post p = Post().add("csrf", TOKEN);
    p.add("v.SERVER_HOST", "192.168.7.7").add("v.API_KEY", "a-brand-new-key");
    p.add("w.ssid.1", "new-router").add("w.pass.1", "new-router-password");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "the form accepts it");
    TEST_ASSERT_EQ(stored(e, "SERVER_HOST"), std::string("192.168.7.7"), "SERVER_HOST changed");
    TEST_ASSERT_EQ(stored(e, "API_KEY"), std::string("a-brand-new-key"), "API_KEY changed");
    std::vector<WifiNet> nets;
    std::string err;
    TEST_ASSERT(parseWifiList(stored(e, "WIFI"), nets, err) && nets.size() == 1 && nets[0].ssid == "new-router" && nets[0].pass == "new-router-password",
                "the WiFi list was replaced");
}

TEST(a_blank_field_means_unchanged_not_empty) {
    Env e;
    e.configure(true, true);
    auto before = snapshot(e.st);
    Post p = Post().add("csrf", TOKEN).add("v." + SetupFixture::changeKey(), "").add("v." + SetupFixture::hostKey(), "   ")
                   .add("v.API_KEY", "");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "blank (or only spaces) boxes are accepted");
    TEST_ASSERT_EQ(stored(e, SetupFixture::changeKey()), SetupFixture::changeOld(), "a blank number keeps the old one");
    TEST_ASSERT_EQ(stored(e, SetupFixture::hostKey()), SetupFixture::hostValue(), "spaces only count as blank for a host");
    TEST_ASSERT_EQ(stored(e, "API_KEY"), before["API_KEY"], "a blank secret keeps the stored one");
}

// ── the WiFi rows ───────────────────────────────────────────────────────

static std::vector<WifiNet> storedNets(Env& e) {
    std::vector<WifiNet> nets;
    std::string err;
    parseWifiList(e.st.has("WIFI") ? e.st.get("WIFI") : std::string(), nets, err);
    return nets;
}

TEST(wifi_rows_a_blank_password_keeps_the_stored_one_only_for_the_same_network_name) {
    Env e;
    e.configure(true, true);
    std::vector<WifiNet> before = storedNets(e);
    TEST_ASSERT(!before.empty() && !before[0].pass.empty(), "precondition: the first network has a password");

    // same name, blank password: kept
    Post keep = Post().add("csrf", TOKEN).add("w.ssid.1", before[0].ssid).add("w.pass.1", "");
    TEST_ASSERT_EQ(e.save(keep).status, 200, "kept");
    TEST_ASSERT(storedNets(e).size() == 1 && storedNets(e)[0].pass == before[0].pass, "the stored password is still there");

    // another name, blank password, not open: the user must say what they mean
    Env f;
    f.configure(true, true);
    Post renamed = Post().add("csrf", TOKEN).add("w.ssid.1", "some-other-net").add("w.pass.1", "");
    HttpReply r = f.save(renamed);
    TEST_ASSERT_EQ(r.status, 422, "a new network without a password is refused...");
    TEST_ASSERT(has(r.body, "open network"), "...with the way out explained");
    TEST_ASSERT_EQ(joinWifiList(storedNets(f)), joinWifiList(before), "the stored list is unchanged");
    TEST_ASSERT(!f.form.saved(), "not saved");
}

TEST(wifi_rows_open_network_and_conflicting_rows) {
    Env e;
    e.configure(true, true);
    Post open = Post().add("csrf", TOKEN).add("w.ssid.1", "cafe-wifi").add("w.pass.1", "").add("w.open.1", "1");
    TEST_ASSERT_EQ(e.save(open).status, 200, "an open network is accepted when ticked");
    std::vector<WifiNet> nets = storedNets(e);
    TEST_ASSERT(nets.size() == 1 && nets[0].ssid == "cafe-wifi" && nets[0].pass.empty(), "stored as ssid with an empty password");

    Env f;
    f.configure(true, true);
    auto before = snapshot(f.st);
    Post both = Post().add("csrf", TOKEN).add("w.ssid.1", "x-net").add("w.pass.1", "password-1").add("w.open.1", "1");
    TEST_ASSERT_EQ(f.save(both).status, 422, "open AND a password is ambiguous");
    Post nameless = Post().add("csrf", TOKEN).add("w.ssid.1", "").add("w.pass.1", "password-1");
    TEST_ASSERT_EQ(f.save(nameless).status, 422, "a password with no network name");
    TEST_ASSERT(snapshot(f.st) == before, "nothing stored by either");
}

TEST(wifi_rows_can_add_a_network_and_drop_one) {
    Env e;
    e.configure(true, true);
    std::vector<WifiNet> before = storedNets(e);
    Post add = Post().add("csrf", TOKEN).add("w.ssid.1", before[0].ssid).add("w.pass.1", "")
                     .add("w.ssid.2", "second-net").add("w.pass.2", "second-password");
    TEST_ASSERT_EQ(e.save(add).status, 200, "a second network is added");
    TEST_ASSERT_EQ(storedNets(e).size(), (size_t)2, "two networks");

    Env f;
    f.configure(true, true);
    f.st.set("WIFI", joinWifiList(std::vector<WifiNet>{ {"first-net", "first-password"}, {"second-net", "second-password"} }));
    Post drop = Post().add("csrf", TOKEN).add("w.ssid.1", "").add("w.pass.1", "").add("w.ssid.2", "second-net").add("w.pass.2", "");
    TEST_ASSERT_EQ(f.save(drop).status, 200, "a row with a blank name is dropped");
    std::vector<WifiNet> nets = storedNets(f);
    TEST_ASSERT(nets.size() == 1 && nets[0].ssid == "second-net" && nets[0].pass == "second-password", "the other one keeps its password");
}

TEST(wifi_rows_all_blank_leaves_the_setting_alone) {
    Env e;
    e.configure(true, true);
    std::string before = stored(e, "WIFI");
    Post p = Post().add("csrf", TOKEN).add("w.ssid.1", "").add("w.pass.1", "").add("w.ssid.2", "").add("w.pass.2", "");
    TEST_ASSERT_EQ(e.save(p).status, 200, "accepted");
    TEST_ASSERT_EQ(stored(e, "WIFI"), before, "WIFI is unchanged");
}

TEST(wifi_rows_survive_the_special_characters_of_the_line_format) {
    Env e;
    Post p = fullPost();
    for (size_t i = 0; i < p.f.size(); ++i) {
        if (p.f[i].first.compare(0, 2, "w.") == 0) { p.f.erase(p.f.begin() + i); --i; }
    }
    p.add("w.ssid.1", "my net;1:b\\s").add("w.pass.1", "pa;ss:wo\\rd 1=&%+");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    std::vector<WifiNet> nets = storedNets(e);
    TEST_ASSERT(nets.size() == 1, "one network");
    TEST_ASSERT(nets.size() == 1 && nets[0].ssid == "my net;1:b\\s", "the name came through exactly (; : \\ and a space)");
    TEST_ASSERT(nets.size() == 1 && nets[0].pass == "pa;ss:wo\\rd 1=&%+", "so did the password (; : \\ = & % +)");
}

TEST(wifi_rows_are_handled_when_the_stored_list_is_damaged) {
    Env e;
    e.configure(true, true);
    e.st.set("WIFI", "not:a:valid");                          // odd number of fields
    Post p = Post().add("csrf", TOKEN).add("w.ssid.1", "fresh-net").add("w.pass.1", "fresh-password");
    TEST_ASSERT_EQ(e.save(p).status, 200, "a damaged list can be replaced");
    TEST_ASSERT_EQ(storedNets(e).size(), (size_t)1, "by the new one");
    HttpReply page = Env().get();
    TEST_ASSERT_EQ(page.status, 200, "(and a blank board renders)");
}

// ── values with special characters ──────────────────────────────────────

TEST(values_with_separators_equals_signs_and_percent_signs_are_stored_exactly) {
    Env e;
    Post p = fullPost();
    p.set("v.API_KEY", "a;b\\c:d=e%f+g&h i");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT_EQ(stored(e, "API_KEY"), std::string("a;b\\c:d=e%f+g&h i"), "stored byte for byte");
}

TEST(structured_values_are_trimmed_but_secrets_keep_their_spaces) {
    Env e;
    Post p = fullPost();
    p.set("v.API_KEY", "  spaced key  ");
    p.set("v." + SetupFixture::hostKey(), "  " + SetupFixture::hostValue() + "  ");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT_EQ(stored(e, "API_KEY"), std::string("  spaced key  "), "a secret keeps its spaces");
    TEST_ASSERT_EQ(stored(e, SetupFixture::hostKey()), SetupFixture::hostValue(), "a host is trimmed");
}

TEST(a_control_character_in_a_value_is_refused_by_the_engine) {
    Env e;
    Post p = fullPost();
    p.set("v.API_KEY", "bad\nkey");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "refused");
    TEST_ASSERT(has(r.body, "API_KEY") && has(r.body, "control"), "by the engine's own message");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
}

// ── malformed requests ──────────────────────────────────────────────────

TEST(malformed_bodies_are_bad_requests_and_store_nothing) {
    Env e;
    const char* bodies[] = { "csrf", "csrf=%zz", "csrf=%00", "=1", "csrf=0123456789abcdef0123456789abcdef&csrf=0123456789abcdef0123456789abcdef", "a b=1" };
    for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
        HttpReply r = e.form.handle("POST", "/save", bodies[i]);
        TEST_ASSERT_EQ(r.status, 400, ("400: " + std::string(bodies[i])).c_str());
    }
    HttpReply nul = e.form.handle("POST", "/save", std::string("csrf=a\0b", 8));
    TEST_ASSERT_EQ(nul.status, 400, "a raw NUL");
    TEST_ASSERT_EQ(e.form.handle("POST", "/save", "").status, 403, "an empty body has no token");
    TEST_ASSERT(e.st.m.empty() && !e.form.saved(), "nothing stored");
}

TEST(an_oversized_body_is_refused_with_413) {
    Env e;
    std::string big = "csrf=" + std::string(TOKEN) + "&v.API_KEY=" + std::string(MAX_BODY_BYTES, 'x');
    TEST_ASSERT_EQ(e.form.handle("POST", "/save", big).status, 413, "over the limit");
    TEST_ASSERT_EQ(e.form.handle("POST", "/exit", big).status, 413, "also for /exit");
    TEST_ASSERT_EQ(e.form.handle("POST", "/save", std::string(100000, 'a')).status, 413, "far over it");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
}

TEST(too_many_fields_and_duplicates_are_refused) {
    Env e;
    std::string body = "csrf=" + std::string(TOKEN);
    for (size_t i = 0; i < MAX_FORM_FIELDS; ++i) body += "&x" + std::to_string(i) + "=1";
    TEST_ASSERT_EQ(e.form.handle("POST", "/save", body).status, 400, "more fields than any form has");
    Post dup = fullPost();
    dup.add("v.SERVER_HOST", "192.168.1.1");               // second value for one setting: which one counts?
    TEST_ASSERT_EQ(e.save(dup).status, 400, "a setting given twice");
    Post dupToken = fullPost();
    dupToken.add("csrf", TOKEN);
    TEST_ASSERT_EQ(e.save(dupToken).status, 400, "the token given twice");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
}

TEST(unknown_fields_are_ignored_and_the_setup_switch_cannot_be_set_through_the_form) {
    Env e;
    Post p = fullPost();
    p.add("foo", "bar").add("v.NOT_A_SETTING", "1").add("v.SETUP_MODE", "1").add("SETUP_MODE", "1").add("w.ssid.99", "x");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("0"), "a posted SETUP_MODE=1 does not keep the board in setup");
    TEST_ASSERT(e.st.m.count("NOT_A_SETTING") == 0 && e.st.m.count("foo") == 0, "unknown names store nothing");
}

// ── markup injection ────────────────────────────────────────────────────

static const char* const XSS = "<script>alert(1)</script>\"'&<img src=x onerror=alert(2)>";

// The payload may appear in the page, but only as inert text: never as a tag of its own (<script, <img)
// and never with a raw quote that could end an attribute. ("onerror=alert" inside &lt;img ...&gt; is text.)
static bool safe(const std::string& body) {
    return !has(body, "<script") && !has(body, "<img") && !has(body, "\"'&<") && !has(body, "'&<img");
}

TEST(markup_in_any_submitted_value_is_escaped_when_the_form_comes_back) {
    for (size_t i = 0; i < extended().count; ++i) {
        const KeyDef& def = extended().keys[i];
        std::string name = def.name;
        if (name == "SETUP_MODE" || name == "SETUP_PASSWORD" || def.kind == Kind::Wifi) continue;
        Env e;
        Post p = fullPost();
        p.set("v." + name, XSS);
        HttpReply r = e.save(p);
        TEST_ASSERT(r.status == 422 || r.status == 200, (name + ": answered").c_str());
        TEST_ASSERT(safe(r.body), (name + ": no markup got through").c_str());
        if (def.kind != Kind::Secret && r.status == 422) {
            TEST_ASSERT(!has(r.body, "x onerror") || has(r.body, "&lt;img src=x onerror"), (name + ": shown only in escaped form").c_str());
        }
    }
}

TEST(markup_in_a_wifi_name_the_title_the_token_and_the_flash_is_escaped_too) {
    Env e;
    Post p = Post().add("csrf", TOKEN).add("w.ssid.1", XSS).add("w.pass.1", "");
    HttpReply r = e.save(p);
    TEST_ASSERT_EQ(r.status, 422, "rejected (no password, not open)");
    TEST_ASSERT(safe(r.body), "the WiFi name is escaped");
    TEST_ASSERT(has(r.body, "&lt;script&gt;"), "and still shown");

    // damaged flash: every stored text can hold anything
    Env f;
    f.configure(true, true);
    f.st.set("SERVER_HOST", XSS);
    f.st.set("WIFI", joinWifiList(std::vector<WifiNet>{ {XSS, "password-1"} }));
    f.st.set(SetupFixture::idKey(), XSS);
    HttpReply g = f.get();
    TEST_ASSERT_EQ(g.status, 200, "served");
    TEST_ASSERT(safe(g.body), "values read back from flash are escaped");

    // the config's own text
    RecordingStore st;
    FormConfig cfg = makeConfig();
    cfg.title = "<script>evil</script>";
    SetupForm form(extended(), st, cfg, "tok\"<en>'&-0123456789abcdef");
    HttpReply h = form.handle("GET", "/", "");
    TEST_ASSERT(safe(h.body) && !has(h.body, "<script>evil"), "the title is escaped");
    TEST_ASSERT(has(h.body, "value=\"tok&quot;&lt;en&gt;&#39;&amp;-0123456789abcdef\""), "and so is the token, so it cannot break out of its attribute");
}

TEST(no_secret_is_ever_put_into_a_page) {
    Env e;
    e.configure(true, true);
    e.st.set("API_KEY", "TOPSECRET-api-key-value");
    e.st.set("WIFI", joinWifiList(std::vector<WifiNet>{ {"home-net", "TOPSECRET-wifi-password"} }));
    e.st.set("SETUP_PASSWORD", "TOPSECRET-master-pw");
    const char* secrets[] = { "TOPSECRET-api-key-value", "TOPSECRET-wifi-password", "TOPSECRET-master-pw" };

    std::vector<HttpReply> pages;
    pages.push_back(e.get());                                                                   // the form
    Post bad = Post().add("csrf", TOKEN).add("v.API_KEY", "typed-secret-xyz").add("v.SERVER_HOST", "bad host!")
                     .add("w.ssid.1", "home-net").add("w.pass.1", "typed-wifi-secret")
                     .add("v.SETUP_PASSWORD", "typed-master-secret").add("v.SETUP_PASSWORD.confirm", "typed-master-secret");
    pages.push_back(e.save(bad));                                                               // a rejected save, re-rendered
    pages.push_back(e.get("/generate_204"));
    for (size_t i = 0; i < pages.size(); ++i) {
        for (size_t s = 0; s < 3; ++s) TEST_ASSERT(!has(pages[i].body, secrets[s]), (std::string("stored secret ") + std::to_string(s) + " absent from page " + std::to_string(i)).c_str());
        TEST_ASSERT(!has(pages[i].body, "typed-secret-xyz") && !has(pages[i].body, "typed-wifi-secret") && !has(pages[i].body, "typed-master-secret"),
                    ("typed secrets are not sent back, page " + std::to_string(i)).c_str());
    }
    TEST_ASSERT_EQ(pages[1].status, 422, "(the bad save was rejected)");

    Env ok;
    ok.configure(true, true);
    HttpReply saved = ok.save(Post().add("csrf", TOKEN).add("v.API_KEY", "typed-secret-xyz"));
    TEST_ASSERT_EQ(saved.status, 200, "a successful save");
    TEST_ASSERT(!has(saved.body, "typed-secret-xyz"), "does not repeat the new secret");
}

// ── exit ────────────────────────────────────────────────────────────────

TEST(exit_switches_setup_mode_off_and_changes_nothing_else) {
    Env e;
    e.configure(true, true);
    auto before = snapshot(e.st);
    HttpReply r = e.post("/exit", Post().add("csrf", TOKEN));
    TEST_ASSERT_EQ(r.status, 200, "accepted");
    TEST_ASSERT(e.form.exited() && !e.form.saved(), "exited(), not saved()");
    TEST_ASSERT(has(r.body, "restarting"), "the page says the board restarts");
    auto after = snapshot(e.st);
    TEST_ASSERT_EQ(after["SETUP_MODE"], std::string("0"), "SETUP_MODE is 0");
    after.erase("SETUP_MODE");
    before.erase("SETUP_MODE");
    TEST_ASSERT(after == before, "no other setting was touched");
    TEST_ASSERT_EQ(e.st.order.size(), (size_t)1, "exactly one write");
}

TEST(exit_does_not_need_the_form_and_ignores_it_if_sent) {
    Env e;
    e.configure(true, true);
    Post p = fullPost();                                   // a whole form with new values, posted to /exit
    p.set("v.API_KEY", "should-not-be-stored");
    auto before = snapshot(e.st);
    TEST_ASSERT_EQ(e.post("/exit", p).status, 200, "exit accepted");
    TEST_ASSERT_EQ(stored(e, "API_KEY"), before["API_KEY"], "nothing from the form was stored");
}

TEST(exit_works_when_setup_mode_was_already_off_or_absent) {
    Env e;
    e.configure(true, false);                              // SETUP_MODE absent
    TEST_ASSERT_EQ(e.post("/exit", Post().add("csrf", TOKEN)).status, 200, "absent");
    TEST_ASSERT(e.form.exited(), "exited");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("0"), "written as 0");

    Env f;
    f.configure(true, false);
    f.st.set("SETUP_MODE", "0");
    f.st.order.clear();
    TEST_ASSERT_EQ(f.post("/exit", Post().add("csrf", TOKEN)).status, 200, "already 0");
    TEST_ASSERT(f.st.order.empty(), "no needless flash write");

    Env g;
    g.configure(true, false);
    g.st.set("SETUP_MODE", "banana");                      // damaged
    TEST_ASSERT_EQ(g.post("/exit", Post().add("csrf", TOKEN)).status, 200, "damaged");
    TEST_ASSERT_EQ(stored(g, "SETUP_MODE"), std::string("0"), "repaired");
}

TEST(exit_is_refused_on_a_blank_board) {
    Env e;
    HttpReply r = e.post("/exit", Post().add("csrf", TOKEN));
    TEST_ASSERT_EQ(r.status, 409, "nothing to go back to");
    TEST_ASSERT(!e.form.exited(), "not exited");
    TEST_ASSERT(e.st.m.empty(), "nothing stored");
}

TEST(exit_works_on_a_board_that_only_lacks_what_the_relay_still_fills_in) {
    Env e;
    e.configure(true, true);
    e.st.m.erase(SetupFixture::changeKey());
    HttpReply r = e.post("/exit", Post().add("csrf", TOKEN));
    TEST_ASSERT_EQ(r.status, 200, "accepted: an incomplete board must still be able to leave setup");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("0"), "switched off");
    TEST_ASSERT_EQ(stored(e, SetupFixture::changeKey()), std::string("<absent>"), "and nothing else was added");
}

TEST(a_flash_failure_on_exit_is_reported_and_the_board_stays_in_setup) {
    Env e;
    e.configure(true, true);
    e.st.failWrites = true;
    HttpReply r = e.post("/exit", Post().add("csrf", TOKEN));
    TEST_ASSERT_EQ(r.status, 500, "reported");
    TEST_ASSERT(!e.form.exited(), "not exited");
    TEST_ASSERT_EQ(stored(e, "SETUP_MODE"), std::string("1"), "still armed");
}

// ── after the board is done ─────────────────────────────────────────────

TEST(once_saved_no_further_request_can_change_anything) {
    Env e;
    TEST_ASSERT_EQ(e.save(fullPost()).status, 200, "saved");
    auto before = snapshot(e.st);
    Post again = fullPost();
    again.set("v.API_KEY", "second-attempt").set("v.SETUP_PASSWORD", "Second-Master-1").set("v.SETUP_PASSWORD.confirm", "Second-Master-1");
    TEST_ASSERT_EQ(e.save(again).status, 409, "a second save in the restart window");
    TEST_ASSERT_EQ(e.post("/exit", Post().add("csrf", TOKEN)).status, 409, "and an exit");
    TEST_ASSERT(snapshot(e.st) == before, "nothing changed");
    TEST_ASSERT(e.form.saved() && !e.form.exited(), "the outcome stays what it was");
    HttpReply page = e.get();
    TEST_ASSERT_EQ(page.status, 200, "the form page now just says it is restarting");
    TEST_ASSERT(has(page.body, "restarting") && !has(page.body, "name=\"v.API_KEY\""), "with no form to fill in");
}

TEST(once_exited_the_form_is_closed_too) {
    Env e;
    e.configure(true, true);
    e.post("/exit", Post().add("csrf", TOKEN));
    auto before = snapshot(e.st);
    TEST_ASSERT_EQ(e.save(Post().add("csrf", TOKEN).add("v.API_KEY", "late")).status, 409, "a save after exit");
    TEST_ASSERT(snapshot(e.st) == before && e.form.exited() && !e.form.saved(), "nothing changed");
}

// ── a table without the setup settings ──────────────────────────────────

TEST(a_firmware_without_the_two_setup_settings_refuses_to_work_rather_than_keep_the_default_password) {
    Env e(withoutSetupKeys(), true);
    TEST_ASSERT_EQ(e.get().status, 500, "the form is not served");
    TEST_ASSERT_EQ(e.save(fullPost()).status, 500, "a save is refused");
    TEST_ASSERT_EQ(e.post("/exit", Post().add("csrf", TOKEN)).status, 500, "so is an exit");
    TEST_ASSERT(e.st.m.empty() && !e.form.saved() && !e.form.exited(), "nothing stored");
    TEST_ASSERT_EQ(e.get("/generate_204").status, 302, "(probes still get their redirect)");
}

// ── the sketch's own table ──────────────────────────────────────────────

TEST(the_form_renders_every_setting_of_the_table_once) {
    Env e;
    HttpReply r = e.get();
    for (size_t i = 0; i < extended().count; ++i) {
        std::string name = extended().keys[i].name;
        if (name == "SETUP_MODE") continue;
        std::string field = extended().keys[i].kind == Kind::Wifi ? "name=\"w.ssid.1\"" : "name=\"v." + name + "\"";
        size_t first = r.body.find(field);
        TEST_ASSERT(first != std::string::npos, (name + ": has an input").c_str());
        TEST_ASSERT(first == std::string::npos || r.body.find(field, first + 1) == std::string::npos, (name + ": only one").c_str());
    }
}

TEST(the_session_can_drive_the_form_through_its_outcome_interface) {
    Env e;
    e.configure(true, true);
    const ISetupOutcome& outcome = e.form;                 // what the S4 session holds
    TEST_ASSERT(!outcome.saved() && !outcome.exited(), "nothing decided yet");
    e.post("/exit", Post().add("csrf", TOKEN));
    TEST_ASSERT(!outcome.saved() && outcome.exited(), "exit is visible through the interface");
    Env f;
    f.save(fullPost());
    const ISetupOutcome& o2 = f.form;
    TEST_ASSERT(o2.saved() && !o2.exited(), "so is save");
    HttpReply probe = f.get("/generate_204");
    TEST_ASSERT(header(probe, "Location") && *header(probe, "Location") == std::string("http://") + SETUP_AP_IP + "/", "probes go to S2's AP address");
}

static void runSetupFormCases() {
    RUN_TEST(the_session_can_drive_the_form_through_its_outcome_interface);
    RUN_TEST(a_blank_board_gets_a_form_that_asks_for_what_is_missing);
    RUN_TEST(a_complete_form_on_a_blank_board_is_stored_and_ends_setup);
    RUN_TEST(SETUP_MODE_is_written_last_so_an_interrupted_save_leaves_the_board_in_setup);
    RUN_TEST(a_flash_failure_stores_nothing_new_and_does_not_end_setup);
    RUN_TEST(a_missing_setting_stores_nothing_and_names_it);
    RUN_TEST(an_invalid_value_stores_nothing_and_every_problem_is_listed_at_once);
    RUN_TEST(the_error_messages_never_contain_a_secret);
    RUN_TEST(a_cross_setting_rule_is_enforced);
    RUN_TEST(a_blank_board_cannot_leave_without_choosing_a_master_password);
    RUN_TEST(the_default_a_short_or_an_odd_password_is_refused);
    RUN_TEST(the_two_password_fields_must_match);
    RUN_TEST(a_configured_board_that_still_has_the_default_must_also_choose_one);
    RUN_TEST(a_stored_own_password_is_kept_when_the_boxes_are_blank_and_never_shown);
    RUN_TEST(a_post_without_the_right_token_is_forbidden_and_changes_nothing);
    RUN_TEST(a_board_without_a_usable_token_refuses_every_post);
    RUN_TEST(a_get_request_cannot_change_anything);
    RUN_TEST(only_the_documented_requests_are_answered);
    RUN_TEST(captive_portal_probes_are_sent_to_the_form);
    RUN_TEST(a_configured_board_shows_its_values_and_offers_to_exit);
    RUN_TEST(a_partial_change_on_a_configured_board_changes_only_that_setting_and_ends_setup);
    RUN_TEST(submitting_the_page_as_it_was_served_changes_nothing_but_the_switch);
    RUN_TEST(a_configured_board_that_is_still_incomplete_can_be_filled_in_later);
    RUN_TEST(the_locked_settings_can_be_changed_here_because_the_user_is_at_the_board);
    RUN_TEST(a_blank_field_means_unchanged_not_empty);
    RUN_TEST(wifi_rows_a_blank_password_keeps_the_stored_one_only_for_the_same_network_name);
    RUN_TEST(wifi_rows_open_network_and_conflicting_rows);
    RUN_TEST(wifi_rows_can_add_a_network_and_drop_one);
    RUN_TEST(wifi_rows_all_blank_leaves_the_setting_alone);
    RUN_TEST(wifi_rows_survive_the_special_characters_of_the_line_format);
    RUN_TEST(wifi_rows_are_handled_when_the_stored_list_is_damaged);
    RUN_TEST(values_with_separators_equals_signs_and_percent_signs_are_stored_exactly);
    RUN_TEST(structured_values_are_trimmed_but_secrets_keep_their_spaces);
    RUN_TEST(a_control_character_in_a_value_is_refused_by_the_engine);
    RUN_TEST(malformed_bodies_are_bad_requests_and_store_nothing);
    RUN_TEST(an_oversized_body_is_refused_with_413);
    RUN_TEST(too_many_fields_and_duplicates_are_refused);
    RUN_TEST(unknown_fields_are_ignored_and_the_setup_switch_cannot_be_set_through_the_form);
    RUN_TEST(markup_in_any_submitted_value_is_escaped_when_the_form_comes_back);
    RUN_TEST(markup_in_a_wifi_name_the_title_the_token_and_the_flash_is_escaped_too);
    RUN_TEST(no_secret_is_ever_put_into_a_page);
    RUN_TEST(exit_switches_setup_mode_off_and_changes_nothing_else);
    RUN_TEST(exit_does_not_need_the_form_and_ignores_it_if_sent);
    RUN_TEST(exit_works_when_setup_mode_was_already_off_or_absent);
    RUN_TEST(exit_is_refused_on_a_blank_board);
    RUN_TEST(exit_works_on_a_board_that_only_lacks_what_the_relay_still_fills_in);
    RUN_TEST(a_flash_failure_on_exit_is_reported_and_the_board_stays_in_setup);
    RUN_TEST(once_saved_no_further_request_can_change_anything);
    RUN_TEST(once_exited_the_form_is_closed_too);
    RUN_TEST(a_firmware_without_the_two_setup_settings_refuses_to_work_rather_than_keep_the_default_password);
    RUN_TEST(the_form_renders_every_setting_of_the_table_once);
}
