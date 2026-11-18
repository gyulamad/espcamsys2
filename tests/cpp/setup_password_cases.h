// setup_password_cases.h — T4 (F-29): the master password of the setup WiFi, written once and run against
// each sketch's real key table by test_setup_password_recorder.cpp and test_setup_password_person.cpp.
// (Two files, not one: both sketch folders hold their own copy of settings_logic.h.)
//
// The including file first includes its sketch's settings_schema.h and setup_form.h, then defines
//
//     struct PasswordFixture { ... };      // what is specific to that sketch, see below
//
// and finally includes this header and calls runSetupPasswordCases() from main().
//
// What is proved here (the pieces are tested one by one elsewhere; this is the whole rule, from the
// user's side):
//   1. a blank board uses the build-time default, and the default is a usable WPA2 passphrase;
//   2. a password changed over the serial port is stored, survives a restart and overrides the default;
//   3. the same through the setup form;
//   4. a refused password (too short, not WPA2, the default itself, ...) changes nothing: the board keeps
//      the password it had;
//   5. a locked key (the secrets) is masked everywhere the board shows its settings: the serial listing,
//      the setup form and the report to the dashboard, and the dashboard may not change it.

#pragma once

#include "framework.h"

#include <string>
#include <vector>

#include "settings_fakes.h"

using namespace esp32cam_setup;

static const char* const TOKEN_T4  = "0123456789abcdef0123456789abcdef";
static const char* const OWN_T4    = "Own-Master-Pw-42";
static const char* const SECOND_T4 = "Second-Master-Pw-77";

// ── helpers ─────────────────────────────────────────────────────────────

static std::string enc4(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        bool plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
        if (plain) { out += static_cast<char>(c); continue; }
        out += '%';
        out += hex[c >> 4];
        out += hex[c & 15];
    }
    return out;
}

// The form body a browser sends to choose a master password (typed twice).
static std::string passwordBody(const std::string& pw, const std::string& again) {
    return "csrf=" + std::string(TOKEN_T4) + "&v.SETUP_PASSWORD=" + enc4(pw) + "&v.SETUP_PASSWORD.confirm=" + enc4(again);
}

// A board that holds a complete configuration and no master password of its own.
static void configureBoard(MemoryStore& flash) {
    CheckedLine c = checkLine(PasswordFixture::schema(), PasswordFixture::typical());
    for (size_t i = 0; i < c.pairs.size(); ++i) flash.set(c.pairs[i].key, c.pairs[i].value);
}

// The password the setup WiFi would open with, as the next boot reads it from the flash.
static std::string wifiPasswordOf(MemoryStore& flash) {
    DefaultingStore view(flash, PasswordFixture::schema().meta, PasswordFixture::schema().metaCount);
    return setupPassword(PasswordFixture::schema(), view);
}

static FormConfig formConfig() {
    FormConfig c;
    c.title = "espcamsys2-test-d4e5f6";
    c.prerequisites = PasswordFixture::prerequisites();
    return c;
}

// Types `lines` at the serial port of a configured board that is asked "Change settings?" and answers y.
// Returns how the conversation ended.
static BootConfigFlow::Status typeAtSerial(MemoryStore& flash, ScriptConsole& con, const std::vector<std::string>& lines) {
    con.in = "y\n";
    for (size_t i = 0; i < lines.size(); ++i) con.in += lines[i] + "\n";
    con.in += "\n";   // an empty line ends the conversation
    BootConfigFlow flow(PasswordFixture::schema(), flash, con, 5000);
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; t < 20000 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    return s;
}

static bool contains(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }

// ── 1. the build-time default ───────────────────────────────────────────

TEST(a_blank_board_uses_the_build_time_default_and_it_is_a_valid_wpa2_passphrase) {
    MemoryStore flash;
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(SETUP_DEFAULT_PASSWORD), "nothing stored: the default opens the setup WiFi");
    TEST_ASSERT_EQ(flash.badGets, 0, "and the flash was only asked for keys it has");

    const std::string def = SETUP_DEFAULT_PASSWORD;
    TEST_ASSERT(def.size() >= WPA2_PASS_MIN && def.size() <= WPA2_PASS_MAX, "the default is 8 to 63 characters");
    TEST_ASSERT(validSetupPassword(def), "and printable ASCII: a WPA2 passphrase");
    TEST_ASSERT(validSetupPassword(SETUP_PUBLIC_PASSWORD), "the public built-in password is one too");
    TEST_ASSERT(isDefaultSetupPassword(def) && isDefaultSetupPassword(SETUP_PUBLIC_PASSWORD), "both count as \"not chosen yet\"");
}

TEST(the_default_stays_in_use_while_a_stored_password_is_missing_or_unusable) {
    MemoryStore flash;
    configureBoard(flash);
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(SETUP_DEFAULT_PASSWORD), "a configured board that never chose one");
    const char* unusable[] = { "short", "has-a-tab\there", "caf\xc3\xa9-with-accent" };
    for (size_t i = 0; i < sizeof(unusable) / sizeof(unusable[0]); ++i) {
        flash.set("SETUP_PASSWORD", unusable[i]);
        std::string pw = wifiPasswordOf(flash);
        TEST_ASSERT_EQ(pw, std::string(SETUP_DEFAULT_PASSWORD), std::string("unusable stored value #") + std::to_string(i) + ": the default, never a broken passphrase");
        TEST_ASSERT(validSetupPassword(pw), "always something softAP() accepts");
    }
}

// ── 2. changed over the serial port ─────────────────────────────────────

TEST(a_password_typed_at_the_serial_port_is_stored_survives_a_restart_and_overrides_the_default) {
    MemoryStore flash;
    configureBoard(flash);
    ScriptConsole con;
    BootConfigFlow::Status s = typeAtSerial(flash, con, { std::string("SETUP_PASSWORD=") + OWN_T4 });
    TEST_ASSERT(s == BootConfigFlow::Restart, "a change ends with a restart");
    TEST_ASSERT(flash.has("SETUP_PASSWORD"), "it is in the flash");
    TEST_ASSERT_EQ(flash.m["SETUP_PASSWORD"], std::string(OWN_T4), "exactly as typed");

    // the next boot: a new view of the same flash
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(OWN_T4), "after the restart the setup WiFi opens with it");
    TEST_ASSERT(std::string(OWN_T4) != std::string(SETUP_DEFAULT_PASSWORD), "and that is not the build-time default");
    TEST_ASSERT(!isDefaultSetupPassword(OWN_T4), "which the form would call chosen");
}

TEST(a_password_typed_at_the_serial_port_can_be_changed_again) {
    MemoryStore flash;
    configureBoard(flash);
    ScriptConsole first, second;
    typeAtSerial(flash, first, { std::string("SETUP_PASSWORD=") + OWN_T4 });
    typeAtSerial(flash, second, { std::string("SETUP_PASSWORD=") + SECOND_T4 });
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(SECOND_T4), "the latest one wins");
}

TEST(a_password_the_serial_port_refuses_changes_nothing) {
    MemoryStore flash;
    configureBoard(flash);
    flash.set("SETUP_PASSWORD", OWN_T4);
    const std::string bad[] = { "short", std::string(64, 'p'), "" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        ScriptConsole con;
        typeAtSerial(flash, con, { "SETUP_PASSWORD=" + bad[i] });
        TEST_ASSERT_EQ(flash.m["SETUP_PASSWORD"], std::string(OWN_T4), std::string("refused value #") + std::to_string(i) + ": the old password is kept");
        TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(OWN_T4), "and still opens the WiFi");
    }
}

// ── 3. changed through the setup form ───────────────────────────────────

TEST(a_password_chosen_in_the_setup_form_is_stored_survives_a_restart_and_overrides_the_default) {
    MemoryStore flash;
    configureBoard(flash);
    SetupForm form(PasswordFixture::schema(), flash, formConfig(), TOKEN_T4);
    HttpReply r = form.handle("POST", "/save", passwordBody(OWN_T4, OWN_T4));
    TEST_ASSERT_EQ(r.status, 200, "the form accepts it");
    TEST_ASSERT(form.saved(), "and the board is to restart");
    TEST_ASSERT_EQ(flash.m["SETUP_PASSWORD"], std::string(OWN_T4), "stored exactly as typed");
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(OWN_T4), "the next setup WiFi opens with it, not with the default");
    TEST_ASSERT(!contains(r.body, OWN_T4), "and the answer does not repeat it");
}

TEST(the_setup_form_refuses_a_password_that_would_not_override_the_default_and_keeps_the_old_one) {
    const std::string pwDefault = SETUP_DEFAULT_PASSWORD;
    struct Case { std::string typed, again; const char* why; };
    const Case cases[] = {
        { pwDefault, pwDefault, "the build-time default is not a choice" },
        { SETUP_PUBLIC_PASSWORD, SETUP_PUBLIC_PASSWORD, "neither is the public one" },
        { "short", "short", "7 characters or fewer" },
        { std::string(64, 'p'), std::string(64, 'p'), "64 characters or more" },
        { "caf\xc3\xa9-with-accent", "caf\xc3\xa9-with-accent", "not WPA2 (accent)" },
        { OWN_T4, SECOND_T4, "the two boxes differ" },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        MemoryStore flash;
        configureBoard(flash);
        flash.set("SETUP_PASSWORD", SECOND_T4);
        SetupForm form(PasswordFixture::schema(), flash, formConfig(), TOKEN_T4);
        HttpReply r = form.handle("POST", "/save", passwordBody(cases[i].typed, cases[i].again));
        TEST_ASSERT_EQ(r.status, 422, std::string("refused: ") + cases[i].why);
        TEST_ASSERT(!form.saved(), "nothing saved");
        TEST_ASSERT_EQ(flash.m["SETUP_PASSWORD"], std::string(SECOND_T4), std::string("the old password is kept: ") + cases[i].why);
    }
}

TEST(blank_password_boxes_keep_a_chosen_password_and_do_not_bring_the_default_back) {
    MemoryStore flash;
    configureBoard(flash);
    flash.set("SETUP_PASSWORD", OWN_T4);
    SetupForm form(PasswordFixture::schema(), flash, formConfig(), TOKEN_T4);
    HttpReply r = form.handle("POST", "/save", passwordBody("", ""));
    TEST_ASSERT_EQ(r.status, 200, "saving with blank boxes is fine");
    TEST_ASSERT_EQ(wifiPasswordOf(flash), std::string(OWN_T4), "the chosen password still wins");
}

// ── 5. locked keys are masked ───────────────────────────────────────────

static bool isSecretLike(const KeyDef& k) { return k.kind == Kind::Secret || k.kind == Kind::Wifi; }

TEST(every_secret_and_wifi_key_is_locked_against_the_dashboard) {
    const Schema& schema = PasswordFixture::schema();
    std::vector<std::string> locked = PasswordFixture::locked();
    int secrets = 0;
    for (size_t i = 0; i < schema.count; ++i) {
        if (!isSecretLike(schema.keys[i])) continue;
        secrets++;
        bool found = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == schema.keys[i].name) found = true;
        TEST_ASSERT(found, std::string(schema.keys[i].name) + " is locked: a secret can only be changed at the board");
    }
    TEST_ASSERT(secrets >= 3, "WIFI, API_KEY and SETUP_PASSWORD were all looked at");
}

TEST(the_dashboard_cannot_change_a_locked_secret_and_the_report_masks_it) {
    const Schema& schema = PasswordFixture::schema();
    MemoryStore flash;
    configureBoard(flash);
    flash.set("SETUP_PASSWORD", OWN_T4);
    std::map<std::string, std::string> before = flash.m;
    const char* secretKeys[] = { "SETUP_PASSWORD", "API_KEY" };
    for (size_t i = 0; i < 2; ++i) {
        ChangeResult r = applyChangeLine(schema, flash, std::string(secretKeys[i]) + "=attacker-chosen-pw", PasswordFixture::locked());
        TEST_ASSERT(!r.ok(), std::string(secretKeys[i]) + ": the dashboard's change is refused");
    }
    TEST_ASSERT(flash.m == before, "and nothing was written");

    DefaultingStore view(flash, schema.meta, schema.metaCount);
    std::vector<std::string> lines = renderAll(schema, view, true);
    std::string all;
    for (size_t i = 0; i < lines.size(); ++i) all += lines[i] + "\n";
    TEST_ASSERT(contains(all, "SETUP_PASSWORD=********") && contains(all, "API_KEY=********"), "the masked listing shows only the mask");
    TEST_ASSERT(!contains(all, OWN_T4) && !contains(all, "s3cret"), "never the value");
}

TEST(the_serial_listing_masks_the_secrets_unless_one_key_is_asked_for_by_name) {
    MemoryStore flash;
    configureBoard(flash);
    flash.set("SETUP_PASSWORD", OWN_T4);
    ScriptConsole con;
    typeAtSerial(flash, con, { "SHOW" });
    TEST_ASSERT(con.said("SETUP_PASSWORD=********"), "SHOW prints the mask");
    for (size_t i = 0; i < con.out.size(); ++i) {
        TEST_ASSERT(!contains(con.out[i], OWN_T4), "no line of the start-up listing or of SHOW carries the password");
    }
    ScriptConsole asked;
    typeAtSerial(flash, asked, { "SHOW SETUP_PASSWORD" });
    TEST_ASSERT(asked.said(OWN_T4), "the person at the cable may ask for one value by name (documented in HELP)");
}

TEST(the_setup_form_never_shows_a_secret_and_asks_for_a_new_one_in_a_password_box) {
    const Schema& schema = PasswordFixture::schema();
    MemoryStore flash;
    configureBoard(flash);
    flash.set("SETUP_PASSWORD", OWN_T4);
    SetupForm form(schema, flash, formConfig(), TOKEN_T4);
    HttpReply page = form.handle("GET", "/", "");
    TEST_ASSERT_EQ(page.status, 200, "the form is served");
    TEST_ASSERT(!contains(page.body, OWN_T4) && !contains(page.body, "s3cret") && !contains(page.body, "password1"), "no stored secret is in the page");
    for (size_t i = 0; i < schema.count; ++i) {
        const KeyDef& k = schema.keys[i];
        if (k.kind != Kind::Secret) continue;
        std::string field = std::string("name=\"") + fieldOf(k.name) + "\"";
        size_t at = page.body.find(field);
        TEST_ASSERT(at != std::string::npos, std::string(k.name) + " has a box");
        if (at == std::string::npos) continue;
        size_t open = page.body.rfind("<input", at), close = page.body.find('>', at);
        std::string tag = page.body.substr(open, close - open);
        TEST_ASSERT(contains(tag, "type=\"password\""), std::string(k.name) + ": a masked box");
        TEST_ASSERT(!contains(tag, "value="), std::string(k.name) + ": with no value in it");
    }
}

static void runSetupPasswordCases() {
    RUN_TEST(a_blank_board_uses_the_build_time_default_and_it_is_a_valid_wpa2_passphrase);
    RUN_TEST(the_default_stays_in_use_while_a_stored_password_is_missing_or_unusable);
    RUN_TEST(a_password_typed_at_the_serial_port_is_stored_survives_a_restart_and_overrides_the_default);
    RUN_TEST(a_password_typed_at_the_serial_port_can_be_changed_again);
    RUN_TEST(a_password_the_serial_port_refuses_changes_nothing);
    RUN_TEST(a_password_chosen_in_the_setup_form_is_stored_survives_a_restart_and_overrides_the_default);
    RUN_TEST(the_setup_form_refuses_a_password_that_would_not_override_the_default_and_keeps_the_old_one);
    RUN_TEST(blank_password_boxes_keep_a_chosen_password_and_do_not_bring_the_default_back);
    RUN_TEST(every_secret_and_wifi_key_is_locked_against_the_dashboard);
    RUN_TEST(the_dashboard_cannot_change_a_locked_secret_and_the_report_masks_it);
    RUN_TEST(the_serial_listing_masks_the_secrets_unless_one_key_is_asked_for_by_name);
    RUN_TEST(the_setup_form_never_shows_a_secret_and_asks_for_a_new_one_in_a_password_box);
}
