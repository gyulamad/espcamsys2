// test_setup_fuzz.cpp — randomized attacks on the setup mode's request path (F-21 S10): the strict form
// parser, the form handler, the HTTP request reader and the reply writer. The unit tests next to it
// (test_setup_form*.cpp, test_setup_mode_glue.cpp) pin down the cases somebody thought of; this one throws
// thousands of mutated, truncated, hostile ones at the same code and checks PROPERTIES that must hold
// whatever the input is:
//
//   parser   a refusal leaves nothing behind and never repeats the input; an acceptance respects every cap
//   form     the flash changes ONLY through a successful /save or /exit; a successful save always leaves a
//            valid master password that is not the default, SETUP_MODE=0 and a complete board; no reply
//            contains markup that was typed in, or any secret (stored or typed); once done nothing changes
//   reader   the answer does not depend on how TCP cut the bytes; a request it accepts obeys every cap
//   reply    whatever the handler asks for, the bytes sent are one well-formed message (no header injection)
//
// The generator is a fixed-seed PRNG: a failure names the iteration and is reproduced by running again.
// To hunt further, raise FUZZ_ROUNDS (or change FUZZ_SEED) and, with `g++ -fsanitize=address,undefined`,
// let the sanitizers watch memory as well.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -I tests/cpp/ota_fakes -I Arduino/ESP32_CAM_Recorder tests/cpp/test_setup_fuzz.cpp
// Only the recorder's key table is used: setup_form.h and setup_mode.h are identical in both sketches
// (run_tests.sh checks it) and the properties above do not depend on which settings exist.

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "fake_core.h"
#include "framework.h"
#include "settings_schema.h"
#include "setup_mode.h"
#include "settings_fakes.h"   // after the settings engine: its fakes derive from it

using namespace esp32cam_setup;
using namespace esp32cam_settings;

#ifndef FUZZ_ROUNDS
#define FUZZ_ROUNDS 1500
#endif
#ifndef FUZZ_SEED
#define FUZZ_SEED 0x5EEDF00D12345ULL
#endif

// ── a small deterministic generator ─────────────────────────────────────────────────────────────

struct Rng {
    uint64_t s;
    explicit Rng(uint64_t seed) : s(seed ? seed : 1) {}
    uint64_t next() { s ^= s >> 12; s ^= s << 25; s ^= s >> 27; return s * 0x2545F4914F6CDD1DULL; }
    size_t below(size_t n) { return n ? static_cast<size_t>(next() % n) : 0; }
    bool chance(unsigned percent) { return below(100) < percent; }
};

// Collects the first problem found per property, so thousands of checks make one line of output each.
struct Property {
    std::string name;
    long checks = 0;
    std::string firstFailure;
    explicit Property(const std::string& n) : name(n) {}
    void check(bool ok, const std::string& what) {
        ++checks;
        if (!ok && firstFailure.empty()) firstFailure = what;
    }
    void report() const {
        TEST_ASSERT(checks > 0, name + ": was exercised");
        TEST_ASSERT(firstFailure.empty(), name + (firstFailure.empty() ? "" : " -- " + firstFailure));
    }
};

static std::string printable(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size() && i < 80; ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (c >= 0x20 && c < 0x7f) out += static_cast<char>(c);
        else { static const char* hex = "0123456789abcdef"; out += "\\x"; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return s.size() > 80 ? out + "..." : out;
}

// Bytes that are special to URL encoding, HTTP, HTML and the settings line, plus high bytes and NUL.
static const char SPICY[] = "%&=+;:\\<>\"'/ \t\r\n.-_?#0123456789abcdefABCDEFxX";

static char spicyByte(Rng& r) {
    if (r.chance(15)) return static_cast<char>(r.below(256));
    if (r.chance(5)) return '\0';
    return SPICY[r.below(sizeof(SPICY) - 1)];
}

static std::string randomText(Rng& r, size_t maxLen) {
    std::string s;
    size_t n = r.below(maxLen + 1);
    for (size_t i = 0; i < n; ++i) s += spicyByte(r);
    return s;
}

static const char* const PAYLOADS[] = {
    "\"><script>alert(1)</script>", "'><svg onload=alert(1)>", "</textarea><img src=x onerror=alert(1)>",
    "javascript:alert(1)", "&lt;script&gt;", "%3Cscript%3E", "a\r\nSet-Cookie: x=1", "{{7*7}}", "\\;\\:\\\\",
    "x;SETUP_MODE=1;y", "a=b;c=d", "../../etc/passwd", "%00", "%", "+++", "\xC3\x28", "\xF0\x9F\x92\xA9",
};
static std::string payload(Rng& r) { return PAYLOADS[r.below(sizeof(PAYLOADS) / sizeof(PAYLOADS[0]))]; }

// Cuts, repeats, overwrites and inserts bytes: what a broken client, a bit flip or an attacker does.
static std::string mutate(Rng& r, std::string s) {
    size_t rounds = 1 + r.below(4);
    for (size_t k = 0; k < rounds; ++k) {
        if (s.empty()) { s += spicyByte(r); continue; }
        size_t at = r.below(s.size());
        switch (r.below(7)) {
            case 0: s[at] = spicyByte(r); break;                                           // overwrite
            case 1: s.insert(at, 1, spicyByte(r)); break;                                  // insert
            case 2: s.erase(at, 1 + r.below(8)); break;                                    // delete a run
            case 3: s.resize(at); break;                                                   // truncate
            case 4: s.insert(at, s.substr(at, 1 + r.below(64))); break;                    // repeat a run
            case 5: s.insert(at, payload(r)); break;                                       // hostile text
            default: s.insert(at, std::string(1 + r.below(300), spicyByte(r))); break;     // a long run
        }
    }
    return s;
}

// ── the same encoding a browser uses (also what the unit tests use) ─────────────────────────────

static std::string enc(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%'; out += hex[c >> 4]; out += hex[c & 15];
        }
    }
    return out;
}

typedef std::vector<std::pair<std::string, std::string> > Fields;

static std::string bodyOf(const Fields& f) {
    std::string b;
    for (size_t i = 0; i < f.size(); ++i) {
        if (i) b += '&';
        b += enc(f[i].first) + "=" + enc(f[i].second);
    }
    return b;
}

// ── the board ───────────────────────────────────────────────────────────────────────────────────

static const char* const TOKEN = "0123456789abcdef0123456789abcdef";

// Secrets that are stored on a configured board, and ones an attacker (or the user) types: none of
// them may ever appear in a reply.
static const char* const STORED_API_KEY  = "ApiKey-Zq7-stored-secret";
static const char* const STORED_WIFI_PW  = "Wifi-Zq7-stored-secret";
static const char* const STORED_MASTER   = "Master-Zq7-stored-secret";
static const char* const TYPED_API_KEY   = "ApiKey-Zq7-typed-secret";
static const char* const TYPED_WIFI_PW   = "Wifi-Zq7-typed-secret";
static const char* const TYPED_MASTER    = "Master-Zq7-typed-secret";

static const Schema& schema() { return esp32cam_settings::RECORDER_SCHEMA; }

static std::string typicalLine(const char* apiKey, const char* wifiPw) {
    return std::string("WIFI=extender-1:") + wifiPw + ";SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
           "CAMERA_ID=cam2;API_KEY=" + apiKey + ";PUSH_GAP_MUL=1.5;JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63;SIZE_DROP=1;"
           "ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
           "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
           "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";
}

enum BoardKind { Blank, ConfiguredOwnPassword, ConfiguredDefaultPassword, Armed };

struct Board {
    MemoryStore st;
    SetupForm form;
    static FormConfig config() {
        FormConfig c;
        c.title = "espcamsys2-recorder-d4e5f6";
        c.prerequisites = esp32cam_settings::recorderRemotePrerequisites();
        return c;
    }
    explicit Board(BoardKind kind) : form(schema(), st, config(), TOKEN) {
        if (kind == Blank) return;
        CheckedLine c = checkLine(schema(), typicalLine(STORED_API_KEY, STORED_WIFI_PW));
        for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
        if (kind != ConfiguredDefaultPassword) st.set("SETUP_PASSWORD", STORED_MASTER);
        if (kind == Armed) st.set("SETUP_MODE", "1");
    }
};

// A legitimate full form for a blank board, the starting point of most attacks.
static Fields validFields(Rng& r) {
    Fields f;
    f.push_back(std::make_pair("csrf", std::string(TOKEN)));
    ParsedLine parsed = parseLine(typicalLine(TYPED_API_KEY, TYPED_WIFI_PW));
    for (size_t i = 0; i < parsed.pairs.size(); ++i) {
        const KeyDef* def = findKey(schema(), parsed.pairs[i].key);
        std::string v, err;
        unescapeText(parsed.pairs[i].value, v, err);
        if (def && def->kind == Kind::Wifi) {
            f.push_back(std::make_pair("w.ssid.1", std::string("extender-1")));
            f.push_back(std::make_pair("w.pass.1", std::string(TYPED_WIFI_PW)));
            continue;
        }
        f.push_back(std::make_pair("v." + parsed.pairs[i].key, v));
    }
    std::string pw = r.chance(50) ? std::string(TYPED_MASTER) : std::string("Fuzz-Master-") + std::to_string(r.below(1000));
    f.push_back(std::make_pair("v.SETUP_PASSWORD", pw));
    f.push_back(std::make_pair("v.SETUP_PASSWORD.confirm", pw));
    return f;
}

// Field-level attacks (the encoding stays valid, the content is hostile).
static void attackFields(Rng& r, Fields& f) {
    size_t rounds = r.below(4);
    for (size_t k = 0; k < rounds && !f.empty(); ++k) {
        size_t at = r.below(f.size());
        switch (r.below(9)) {
            case 0: f[at].second = payload(r); break;
            case 1: f[at].second = randomText(r, 120); break;
            case 2: f[at].second = std::string(1 + r.below(900), 'A'); break;
            case 3: f[at].second.clear(); break;
            case 4: f.push_back(f[at]); break;                                                   // duplicate field
            case 5: f.push_back(std::make_pair(randomText(r, 20), randomText(r, 20))); break;    // unknown field
            case 6: f[at].first = payload(r); break;
            case 7: f.erase(f.begin() + at); break;
            default: f.push_back(std::make_pair(std::string("v.SETUP_MODE"), std::string(r.chance(50) ? "1" : "0"))); break;
        }
    }
    // the master password pair: sometimes break the rule on purpose
    if (r.chance(40)) {
        static const char* const pws[] = { "", "Admin1234", "admin1234", "short", "1234567", "Pässwörd-1234", "Admin1234 ",
                                           "a very long password a very long password a very long password 1234", TYPED_MASTER };
        std::string pw = pws[r.below(sizeof(pws) / sizeof(pws[0]))];
        bool found = false;
        for (size_t i = 0; i < f.size(); ++i) {
            if (f[i].first == "v.SETUP_PASSWORD") { f[i].second = pw; found = true; }
            if (f[i].first == "v.SETUP_PASSWORD.confirm") f[i].second = r.chance(85) ? pw : payload(r);
        }
        if (!found) f.push_back(std::make_pair(std::string("v.SETUP_PASSWORD"), pw));
    }
    // the token: right, wrong, missing
    unsigned t = static_cast<unsigned>(r.below(100));
    for (size_t i = 0; i < f.size(); ++i) {
        if (f[i].first != "csrf") continue;
        if (t < 8) f[i].second = std::string(TOKEN).substr(0, 31);
        else if (t < 14) f[i].second = std::string(TOKEN) + "0";
        else if (t < 18) f[i].second = "";
        else if (t < 22) f.erase(f.begin() + i);
        break;
    }
}

// The master password rule, written out again here ON PURPOSE: the properties below must not ask the
// code under test (validSetupPassword / isDefaultSetupPassword) whether its own answer was right.
static bool goodMasterPassword(const std::string& pw) {
    if (pw.size() < 8 || pw.size() > 63) return false;
    for (size_t i = 0; i < pw.size(); ++i) if (pw[i] < 0x20 || pw[i] > 0x7e) return false;
    return pw != "Admin1234" && pw != SETUP_DEFAULT_PASSWORD;
}

static bool contains(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }

// True when `text` was sent in a field that is NOT a secret field: then the form may echo it, as it
// echoes everything the sender typed into a plain field. A secret field's content must never come back.
static bool typedInPlainField(const std::string& body, const std::string& text) {
    std::vector<FormField> fields;
    std::string err;
    if (!parseUrlEncoded(body, fields, err)) return false;
    for (size_t i = 0; i < fields.size(); ++i) {
        const std::string& n = fields[i].name;
        bool secretField = n == "v.API_KEY" || n == "v.SETUP_PASSWORD" || n == "v.SETUP_PASSWORD.confirm" || n.compare(0, 7, "w.pass.") == 0;
        if (!secretField && fields[i].value.find(text) != std::string::npos) return true;
    }
    return false;
}

static const char* const SECRETS[] = { STORED_API_KEY, STORED_WIFI_PW, STORED_MASTER, TYPED_API_KEY, TYPED_WIFI_PW, TYPED_MASTER };

static bool statusAllowed(int s) {
    return s == 200 || s == 302 || s == 400 || s == 403 || s == 404 || s == 405 || s == 409 || s == 413 || s == 422 || s == 500;
}

// ── is the page still the page? ─────────────────────────────────────────────────────────────────
// Typed text may come back inside the page, so what matters is that it stays TEXT: every '<' must open
// one of the page's own tags, and every tag must be made of double-quoted attributes that are not event
// handlers. (Looking for "<script" would miss `" autofocus onfocus=...` inside an attribute, and would
// flag harmless escaped text like `&lt;img onerror=`.) Returns "" when the page is sound, else why not.
static std::string htmlProblem(const std::string& html) {
    static const char* const TAGS[] = { "!doctype", "html", "head", "meta", "title", "style", "body", "main", "h1", "div", "p", "ul", "li", "b",
                                        "form", "input", "label", "select", "option", "button", "span", "fieldset", "legend" };
    size_t pos = 0;
    while ((pos = html.find('<', pos)) != std::string::npos) {
        size_t i = pos + 1;
        bool closing = i < html.size() && html[i] == '/';
        if (closing) ++i;
        std::string tag;
        while (i < html.size() && ((html[i] >= 'a' && html[i] <= 'z') || (html[i] >= '0' && html[i] <= '9') || html[i] == '!')) tag += html[i++];
        bool known = false;
        for (size_t k = 0; k < sizeof(TAGS) / sizeof(TAGS[0]); ++k) known = known || tag == TAGS[k];
        if (!known) return "an unknown tag '<" + printable(tag) + "' at " + std::to_string(pos);
        // the attributes, up to '>'
        while (true) {
            while (i < html.size() && html[i] == ' ') ++i;
            if (i >= html.size()) return "a tag that never ends at " + std::to_string(pos);
            if (html[i] == '>') break;
            if (html[i] == '/') { ++i; continue; }
            std::string name;
            while (i < html.size() && ((html[i] >= 'a' && html[i] <= 'z') || (html[i] >= 'A' && html[i] <= 'Z') || html[i] == '-')) name += html[i++];
            if (name.empty()) return "an odd character in a tag at " + std::to_string(i) + ": " + printable(html.substr(i, 20));
            if (name.compare(0, 2, "on") == 0 || name == "style" || name == "src" || name == "href" || name == "srcdoc")
                return "a forbidden attribute '" + name + "' at " + std::to_string(pos);
            if (i < html.size() && html[i] == '=') {
                ++i;
                if (i >= html.size() || html[i] != '"') return "an unquoted attribute value for '" + name + "' at " + std::to_string(pos);
                size_t close = html.find('"', i + 1);
                if (close == std::string::npos) return "an attribute value that never ends at " + std::to_string(pos);
                i = close + 1;
                if (i < html.size() && html[i] != ' ' && html[i] != '>' && html[i] != '/') return "text glued to an attribute value at " + std::to_string(pos);
            }
        }
        pos = i;
    }
    return "";
}

// ── the parser ──────────────────────────────────────────────────────────────────────────────────

TEST(fuzz_the_parser_refuses_cleanly_and_accepts_only_within_its_caps) {
    Rng r(FUZZ_SEED);
    Property refusal("a refusal leaves nothing behind and never repeats the input");
    Property accept("an accepted body respects every cap");
    Property decode("urlDecode never lets a NUL through");
    for (int i = 0; i < FUZZ_ROUNDS * 4; ++i) {
        std::string raw;
        switch (r.below(3)) {
            case 0: raw = randomText(r, 200); break;
            case 1: raw = mutate(r, bodyOf(validFields(r))); break;
            default: {   // many fields, long fields, long names
                size_t n = r.below(130);
                for (size_t k = 0; k < n; ++k) raw += (k ? "&" : "") + std::string("f") + std::to_string(k) + "=" + randomText(r, 6);
            }
        }
        std::string where = "iteration " + std::to_string(i) + ", input " + printable(raw);

        std::string out = "junk", err;
        bool ok = urlDecode(raw, out, err);
        if (!ok) refusal.check(out.empty() && !err.empty() && (raw.size() < 4 || !contains(err, raw)), "urlDecode refusal: " + where);
        else decode.check(out.find('\0') == std::string::npos, "NUL decoded: " + where);

        std::vector<FormField> fields;
        err.clear();
        ok = parseUrlEncoded(raw, fields, err);
        if (!ok) {
            refusal.check(fields.empty() && !err.empty() && err.size() < 100 && (raw.size() < 8 || !contains(err, raw.substr(0, 8))),
                          "parseUrlEncoded refusal: " + where);
            continue;
        }
        std::set<std::string> seen;
        bool good = raw.size() <= MAX_BODY_BYTES && fields.size() <= MAX_FORM_FIELDS;
        for (size_t k = 0; k < fields.size(); ++k) {
            const FormField& f = fields[k];
            good = good && !f.name.empty() && f.name.size() <= MAX_FIELD_NAME && seen.insert(f.name).second &&
                   f.value.find('\0') == std::string::npos;
            for (size_t c = 0; c < f.name.size(); ++c) good = good && isFieldNameChar(f.name[c]);
        }
        accept.check(good, where);
    }
    refusal.report();
    accept.report();
    decode.report();
}

// ── the form ────────────────────────────────────────────────────────────────────────────────────

TEST(fuzz_the_form_changes_the_flash_only_through_a_good_save_or_exit) {
    Rng r(FUZZ_SEED + 1);
    Property flash("the flash changes only through a successful /save or /exit");
    Property saves("a successful save leaves a real master password, SETUP_MODE=0 and a complete board");
    Property status("every answer has a status the handler is documented to give");
    Property markup("typed text stays text: every page is made of the form's own tags and clean attributes");
    Property secret("no reply contains a stored or a typed secret");
    Property closed("once saved or exited, nothing can change any more");
    Property clean("nothing stored holds a NUL or a control character");
    long saved = 0, exited = 0, rejected = 0, forbidden = 0;

    for (int i = 0; i < FUZZ_ROUNDS * 2; ++i) {
        BoardKind kind = static_cast<BoardKind>(r.below(4));
        Board b(kind);
        std::string title = "iteration " + std::to_string(i) + " (board " + std::to_string(kind) + ")";
        bool wasDone = false;
        std::map<std::string, std::string> doneSnapshot;

        // two or three requests per board: the second one tests "done is done" and retry-after-reject
        size_t requests = 1 + r.below(3);
        for (size_t q = 0; q < requests; ++q) {
            std::string method = "POST", path = "/save", body;
            switch (r.below(10)) {
                case 0: path = "/exit"; body = bodyOf(Fields(1, std::make_pair(std::string("csrf"), std::string(r.chance(80) ? TOKEN : "nope")))); break;
                case 1: method = "GET"; path = r.chance(50) ? "/" : "/" + randomText(r, 30); break;
                case 2: method = r.chance(50) ? "POST" : "PUT"; path = "/" + randomText(r, 12); body = randomText(r, 100); break;
                case 3: body = randomText(r, 300); break;                                           // pure noise to /save
                default: {
                    Fields f = validFields(r);
                    attackFields(r, f);
                    body = bodyOf(f);
                    if (r.chance(30)) body = mutate(r, body);
                }
            }
            std::string what = title + ", request " + std::to_string(q) + ": " + method + " " + printable(path) + " " + printable(body);

            std::map<std::string, std::string> before = b.st.m;
            bool wasSaved = b.form.saved(), wasExited = b.form.exited();
            HttpReply reply = b.form.handle(method, path, body);

            status.check(statusAllowed(reply.status), "status " + std::to_string(reply.status) + ": " + what);
            if (reply.status == 403) ++forbidden;
            if (reply.status == 422) ++rejected;

            // 1. the flash
            bool changed = b.st.m != before;
            bool goodSave = method == "POST" && path.substr(0, path.find('?')) == "/save" && reply.status == 200 && b.form.saved() && !wasSaved;
            bool goodExit = method == "POST" && path.substr(0, path.find('?')) == "/exit" && reply.status == 200 && b.form.exited() && !wasExited;
            if (changed) flash.check(goodSave || goodExit, "the flash changed without a good save/exit: " + what);
            else flash.check(!goodSave || kind != Blank, "a save of a blank board stored nothing: " + what);
            if (goodSave) ++saved;
            if (goodExit) ++exited;

            // 2. what a successful save leaves behind
            if (goodSave) {
                std::string pw = b.st.has("SETUP_PASSWORD") ? b.st.get("SETUP_PASSWORD") : std::string();
                saves.check(goodMasterPassword(pw), "bad master password '" + printable(pw) + "': " + what);
                saves.check(b.st.has("SETUP_MODE") && b.st.get("SETUP_MODE") == "0", "SETUP_MODE not 0: " + what);
                saves.check(findProblems(schema(), b.st).empty(), "board incomplete after a save: " + what);
                saves.check(!b.form.exited(), "saved and exited at once: " + what);
            }
            if (goodExit) {
                saves.check(b.st.has("SETUP_MODE") && b.st.get("SETUP_MODE") == "0", "exit left SETUP_MODE on: " + what);
                // an exit touches nothing but the switch
                std::map<std::string, std::string> expected = before;
                expected["SETUP_MODE"] = "0";
                saves.check(b.st.m == expected, "exit changed more than SETUP_MODE: " + what);
            }

            // 3. what comes back
            for (size_t k = 0; k < sizeof(SECRETS) / sizeof(SECRETS[0]); ++k) {
                if (!contains(reply.body, SECRETS[k])) { secret.check(true, ""); continue; }
                // Text the sender typed into a PLAIN field comes back (escaped): that is the sender's own text.
                secret.check(typedInPlainField(body, SECRETS[k]), std::string("secret ") + SECRETS[k] + " in a reply: " + what);
            }
            if (reply.contentType.compare(0, 9, "text/html") == 0) {
                std::string why = htmlProblem(reply.body);
                markup.check(why.empty(), why + ": " + what);
            } else {
                markup.check(!contains(reply.body, "<"), "markup in a plain-text reply: " + what);
            }
            for (size_t k = 0; k < reply.headers.size(); ++k)
                markup.check(reply.headers[k].second.find('\n') == std::string::npos && reply.headers[k].second.find('\r') == std::string::npos,
                             "a header value with CR/LF: " + what);

            // 4. nothing stored is odd
            for (std::map<std::string, std::string>::const_iterator it = b.st.m.begin(); it != b.st.m.end(); ++it) {
                bool odd = false;
                for (size_t c = 0; c < it->second.size(); ++c) {
                    unsigned char ch = static_cast<unsigned char>(it->second[c]);
                    if (ch < 0x20 || ch == 0x7f) odd = true;
                }
                clean.check(!odd, "control character stored in " + it->first + ": " + what);
            }

            // 5. done is done
            if (wasDone) closed.check(b.st.m == doneSnapshot, "the flash changed after the form was done: " + what);
            if (b.form.saved() || b.form.exited()) {
                if (!wasDone) doneSnapshot = b.st.m;
                wasDone = true;
                closed.check(b.form.saved() == (wasSaved || goodSave) && b.form.exited() == (wasExited || goodExit), "the outcome flipped: " + what);
            }
        }
    }
    flash.report();
    saves.report();
    status.report();
    markup.report();
    secret.report();
    closed.report();
    clean.report();
    // the generator must really reach all the interesting paths, or the properties above prove little
    TEST_ASSERT(saved > 50, "the fuzzer reached successful saves (" + std::to_string(saved) + ")");
    TEST_ASSERT(exited > 20, "the fuzzer reached successful exits (" + std::to_string(exited) + ")");
    TEST_ASSERT(rejected > 200, "the fuzzer reached rejected forms (" + std::to_string(rejected) + ")");
    TEST_ASSERT(forbidden > 100, "the fuzzer reached the CSRF check (" + std::to_string(forbidden) + ")");
}

TEST(fuzz_the_master_password_rule_cannot_be_walked_around) {
    // Every way of leaving a board with no real master password that a request can try: the field
    // missing, empty, the default, the public one, wrong length, not ASCII, mismatching confirmation.
    Rng r(FUZZ_SEED + 2);
    Property rule("a save never ends with an absent, default, invalid or unconfirmed master password");
    long attempts = 0;
    for (int i = 0; i < FUZZ_ROUNDS; ++i) {
        Board b(r.chance(50) ? Blank : ConfiguredDefaultPassword);
        Fields f = validFields(r);
        std::string pw = r.chance(30) ? std::string() : (r.chance(50) ? randomText(r, 70) : std::string(r.below(80), static_cast<char>('a' + r.below(26))));
        if (r.chance(15)) pw = SETUP_PUBLIC_PASSWORD;
        if (r.chance(15)) pw = SETUP_DEFAULT_PASSWORD;
        std::string confirm = r.chance(80) ? pw : pw + "x";
        bool confirmSent = !r.chance(20), passwordSent = !r.chance(15);
        for (size_t k = 0; k < f.size();) {
            if (f[k].first == "v.SETUP_PASSWORD") { if (!passwordSent) { f.erase(f.begin() + k); continue; } f[k].second = pw; }
            if (f[k].first == "v.SETUP_PASSWORD.confirm") { if (!confirmSent) { f.erase(f.begin() + k); continue; } f[k].second = confirm; }
            ++k;
        }
        HttpReply reply = b.form.handle("POST", "/save", bodyOf(f));
        ++attempts;
        if (!b.form.saved()) continue;
        std::string stored = b.st.has("SETUP_PASSWORD") ? b.st.get("SETUP_PASSWORD") : std::string();
        // typed twice, identically, and then stored exactly as typed (these boards had no password of their own)
        rule.check(reply.status == 200 && goodMasterPassword(stored) && passwordSent && confirmSent && confirm == pw && stored == pw,
                   "saved with master password '" + printable(stored) + "' (typed '" + printable(pw) + "', " + (passwordSent ? "" : "NOT sent, ") +
                   (confirmSent ? "confirmed with '" + printable(confirm) + "'" : "no confirmation") + ")");
    }
    rule.report();
    TEST_ASSERT(attempts > 0, "attempts were made");
}

// ── the HTTP reader ─────────────────────────────────────────────────────────────────────────────

struct ReadResult {
    HttpRequestReader::Status status;
    int rejectStatus;
    std::string method, target, body;
    bool operator==(const ReadResult& o) const {
        return status == o.status && rejectStatus == o.rejectStatus && method == o.method && target == o.target && body == o.body;
    }
};

// Feeds `req` cut into pieces by `cuts` (sizes), stopping as soon as the reader has decided.
static ReadResult readIn(const std::string& req, Rng* cutter, size_t maxPiece) {
    HttpRequestReader rd;
    HttpRequestReader::Status st = HttpRequestReader::NeedMore;
    size_t pos = 0;
    while (pos < req.size() && st == HttpRequestReader::NeedMore) {
        size_t n = cutter ? 1 + cutter->below(maxPiece) : req.size();
        if (n > req.size() - pos) n = req.size() - pos;
        st = rd.feed(req.data() + pos, n);
        pos += n;
    }
    ReadResult out;
    out.status = st;
    out.rejectStatus = rd.rejectStatus();
    if (st == HttpRequestReader::Complete) { out.method = rd.method(); out.target = rd.target(); out.body = rd.body(); }
    return out;
}

static std::string requestOf(Rng& r) {
    switch (r.below(4)) {
        case 0: return "GET / HTTP/1.1\r\nHost: 192.168.4.1\r\n\r\n";
        case 1: return "GET /generate_204 HTTP/1.1\r\nHost: connectivitycheck.gstatic.com\r\nUser-Agent: x\r\nAccept: */*\r\n\r\n";
        default: {
            std::string body = bodyOf(validFields(r));
            return "POST /save HTTP/1.1\r\nHost: 192.168.4.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: " +
                   std::to_string(body.size()) + "\r\n\r\n" + body;
        }
    }
}

TEST(fuzz_the_reader_answers_the_same_however_the_bytes_are_cut_and_accepts_only_within_its_caps) {
    Rng r(FUZZ_SEED + 3);
    Property split("the same request gives the same answer whole, in random pieces and byte by byte");
    Property caps("an accepted request respects every cap");
    Property refused("a refusal is one of the documented statuses");
    long accepted = 0, rejected = 0;
    for (int i = 0; i < FUZZ_ROUNDS * 2; ++i) {
        std::string req = r.chance(15) ? randomText(r, 300) : mutate(r, requestOf(r));
        std::string where = "iteration " + std::to_string(i) + ": " + printable(req);

        ReadResult whole = readIn(req, nullptr, 0);
        ReadResult pieces = readIn(req, &r, 1 + r.below(64));
        ReadResult bytes = readIn(req, &r, 1);
        split.check(whole == pieces && whole == bytes, "the answer depends on the cut (" + std::to_string(whole.status) + "/" +
                    std::to_string(pieces.status) + "/" + std::to_string(bytes.status) + "): " + where);

        if (whole.status == HttpRequestReader::Rejected) {
            ++rejected;
            int s = whole.rejectStatus;
            refused.check(s == 400 || s == 411 || s == 413 || s == 431 || s == 501, "status " + std::to_string(s) + ": " + where);
        }
        if (whole.status != HttpRequestReader::Complete) continue;
        ++accepted;
        bool good = !whole.method.empty() && whole.method.size() <= 8 && !whole.target.empty() && whole.target[0] == '/' &&
                    whole.target.size() <= 256 && whole.target.find(' ') == std::string::npos && whole.body.size() <= MAX_BODY_BYTES;
        for (size_t k = 0; k < whole.method.size(); ++k) good = good && whole.method[k] >= 'A' && whole.method[k] <= 'Z';
        for (size_t k = 0; k < whole.target.size(); ++k) good = good && static_cast<unsigned char>(whole.target[k]) >= 0x20 && whole.target[k] != 0x7f;
        caps.check(good, where);
    }
    split.report();
    caps.report();
    refused.report();
    TEST_ASSERT(accepted > 100 && rejected > 100, "the fuzzer reached both accepted (" + std::to_string(accepted) + ") and refused (" + std::to_string(rejected) + ") requests");
}

TEST(a_request_head_at_the_size_cap_is_judged_by_its_size_not_by_how_it_was_cut) {
    // The head (request line + headers, without the blank line) may be SETUP_HEAD_MAX bytes. The reader
    // sees the head grow before it sees the blank line that ends it, so bytes of a partly arrived
    // "\r\n\r\n" must not count against the cap, or a head of 2045..2048 bytes is accepted or refused
    // depending on where TCP happened to cut it.
    for (int headLen = SETUP_HEAD_MAX - 6; headLen <= SETUP_HEAD_MAX + 3; ++headLen) {
        std::string head = "GET / HTTP/1.1\r\nX-Pad: ";
        head += std::string(headLen - head.size(), 'a');
        std::string req = head + "\r\n\r\n";
        ReadResult whole = readIn(req, nullptr, 0);
        bool allSame = true;
        for (size_t cut = 1; cut < req.size(); ++cut) {   // every possible cut into two pieces
            HttpRequestReader rd;
            rd.feed(req.data(), cut);
            if (rd.feed(req.data() + cut, req.size() - cut) != whole.status) allSame = false;
        }
        HttpRequestReader one;   // and one byte at a time
        HttpRequestReader::Status st = HttpRequestReader::NeedMore;
        for (size_t k = 0; k < req.size() && st == HttpRequestReader::NeedMore; ++k) st = one.feed(req.data() + k, 1);
        TEST_ASSERT(allSame && st == whole.status, "a head of " + std::to_string(headLen) + " bytes gets the same answer however it is cut");
        TEST_ASSERT((headLen <= SETUP_HEAD_MAX) == (whole.status == HttpRequestReader::Complete),
                    "a head of " + std::to_string(headLen) + " bytes is " + (headLen <= SETUP_HEAD_MAX ? "accepted" : "refused"));
    }
}

TEST(a_tab_or_other_control_character_in_the_request_target_is_refused_but_a_tab_in_a_header_value_is_fine) {
    // Found by the fuzzer: parseHead() lets a TAB through because header values may hold one, and the
    // request line then accepted it inside the target ("/generate_204<TAB>" is not the probe address).
    const char* const bad[] = { "GET /a\tb HTTP/1.1\r\n\r\n", "GET /generate_204\t HTTP/1.1\r\nHost: x\r\n\r\n", "GET /\x7f HTTP/1.1\r\n\r\n",
                                "POST /save\t HTTP/1.1\r\nContent-Length: 0\r\n\r\n" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        ReadResult r = readIn(bad[i], nullptr, 0);
        TEST_ASSERT(r.status == HttpRequestReader::Rejected && r.rejectStatus == 400, std::string("refused with 400: ") + printable(bad[i]));
    }
    ReadResult ok = readIn("GET / HTTP/1.1\r\nX-A:\tvalue\t\r\nHost: 192.168.4.1\r\n\r\n", nullptr, 0);
    TEST_ASSERT(ok.status == HttpRequestReader::Complete && ok.target == "/", "a tab inside a header value is still accepted");
}

// ── the reply ───────────────────────────────────────────────────────────────────────────────────

TEST(fuzz_a_reply_is_always_one_well_formed_message) {
    Rng r(FUZZ_SEED + 4);
    Property framing("the bytes sent are one message: one status line, clean headers, the exact length, the exact body");
    static const int STATUSES[] = { 200, 302, 400, 403, 404, 405, 409, 413, 422, 500, 0, 99, 204, 600, -1 };
    for (int i = 0; i < FUZZ_ROUNDS * 2; ++i) {
        HttpReply reply;
        reply.status = STATUSES[r.below(sizeof(STATUSES) / sizeof(STATUSES[0]))];
        reply.contentType = r.chance(60) ? "text/html; charset=utf-8" : randomText(r, 30);
        reply.body = r.chance(50) ? randomText(r, 200) : "<p>ok</p>\r\n\r\nHTTP/1.1 200 OK\r\n\r\nforged";
        size_t headers = r.below(6);
        for (size_t k = 0; k < headers; ++k) {
            static const char* const NAMES[] = { "Cache-Control", "Location", "Allow", "Content-Length", "content-type", "Transfer-Encoding",
                                                 "Connection", "X-Pad", "Set-Cookie" };
            std::string name = r.chance(70) ? std::string(NAMES[r.below(sizeof(NAMES) / sizeof(NAMES[0]))]) : randomText(r, 12);
            std::string value = r.chance(60) ? std::string("no-store") : randomText(r, 40) + (r.chance(30) ? "\r\nSet-Cookie: x=1" : "");
            reply.headers.push_back(std::make_pair(name, value));
        }
        std::string out = formatHttpReply(reply);
        std::string where = "iteration " + std::to_string(i) + ": " + printable(out);

        size_t end = out.find("\r\n\r\n");
        if (end == std::string::npos) { framing.check(false, "no end of head: " + where); continue; }
        std::string head = out.substr(0, end);
        bool ok = out.compare(end + 4, std::string::npos, reply.body) == 0;   // the body is exactly what was given
        ok = ok && head.compare(0, 9, "HTTP/1.1 ") == 0 && head.size() > 12 && head[12] == ' ';
        int lengthHeaders = 0, typeHeaders = 0;
        size_t pos = head.find("\r\n");
        while (pos != std::string::npos) {
            size_t next = head.find("\r\n", pos + 2);
            std::string line = head.substr(pos + 2, next == std::string::npos ? std::string::npos : next - pos - 2);
            pos = next;
            size_t colon = line.find(':');
            if (colon == std::string::npos || colon == 0) { ok = false; continue; }
            std::string name;
            for (size_t k = 0; k < colon; ++k) name += (line[k] >= 'A' && line[k] <= 'Z') ? static_cast<char>(line[k] - 'A' + 'a') : line[k];
            for (size_t k = 0; k < line.size(); ++k) {
                unsigned char c = static_cast<unsigned char>(line[k]);
                if ((c < 0x20 && c != '\t') || c == 0x7f) ok = false;
            }
            if (name.find(' ') != std::string::npos) ok = false;
            if (name == "content-length") {
                ++lengthHeaders;
                ok = ok && line.substr(colon + 1) == " " + std::to_string(reply.body.size());
            }
            if (name == "content-type") ++typeHeaders;
            if (name == "transfer-encoding") ok = false;
        }
        framing.check(ok && lengthHeaders == 1 && typeHeaders == 1, where);
    }
    framing.report();
}

int main() {
    RUN_TEST(fuzz_the_parser_refuses_cleanly_and_accepts_only_within_its_caps);
    RUN_TEST(fuzz_the_form_changes_the_flash_only_through_a_good_save_or_exit);
    RUN_TEST(fuzz_the_master_password_rule_cannot_be_walked_around);
    RUN_TEST(fuzz_the_reader_answers_the_same_however_the_bytes_are_cut_and_accepts_only_within_its_caps);
    RUN_TEST(a_request_head_at_the_size_cap_is_judged_by_its_size_not_by_how_it_was_cut);
    RUN_TEST(a_tab_or_other_control_character_in_the_request_target_is_refused_but_a_tab_in_a_header_value_is_fine);
    RUN_TEST(fuzz_a_reply_is_always_one_well_formed_message);
    return test::summarize();
}
