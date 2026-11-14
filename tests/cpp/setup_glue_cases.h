// setup_glue_cases.h — what the sketches' "Settings glue" block does with the setup mode (F-21), written
// once and run against each sketch's real block by test_setup_glue_recorder.cpp and
// test_setup_glue_person.cpp. The block is the sketch's own code (extracted verbatim); the flash, the
// serial port, the clock and the radio are fakes, and SetupBoot, the form and the session are the real ones.
//
// The including file defines, in this order: the glue fakes, the sketch's schema and g_cfg, the link
// fake, the extracted block, `powerUp()`, and
//
//     struct GlueFixture { static std::string typical(); static std::string type(); };
//
// then includes this header and calls runSetupGlueCases(). What is tested here is the wiring: which
// path the board takes (nothing / the setup WiFi alone / the setup WiFi next to the serial prompt), that
// the board really waits, and that every way out ends with the switch off and a restart.

#pragma once

#include "setup_boot_fakes.h"

#include <string>

static const char* const OWN_PW = "My-Own-Master-1";
static const char* const TOKEN_V = "0123456789abcdef0123456789abcdef";

static void provision(const std::string& line) {
    eraseFlash();
    esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(GlueFixture::schema(), line);
    for (size_t i = 0; i < c.pairs.size(); ++i) g_flash[c.pairs[i].key] = c.pairs[i].value;
}

static std::string percent(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}

// What a phone would POST to /save for `line`, plus the token and a new master password typed twice.
static std::string formBody(const std::string& line) {
    std::string body = "csrf=" + std::string(TOKEN_V);
    esp32cam_settings::ParsedLine parsed = esp32cam_settings::parseLine(line);
    for (size_t i = 0; i < parsed.pairs.size(); ++i) {
        const esp32cam_settings::KeyDef* def = esp32cam_settings::findKey(GlueFixture::schema(), parsed.pairs[i].key);
        if (def && def->kind == esp32cam_settings::Kind::Wifi) {
            std::vector<esp32cam_settings::WifiNet> nets;
            std::string err;
            esp32cam_settings::parseWifiList(parsed.pairs[i].value, nets, err);
            for (size_t n = 0; n < nets.size(); ++n) {
                std::string idx = std::to_string(n + 1);
                body += "&w.ssid." + idx + "=" + percent(nets[n].ssid) + "&w.pass." + idx + "=" + percent(nets[n].pass);
            }
            continue;
        }
        std::string v, err;
        esp32cam_settings::unescapeText(parsed.pairs[i].value, v, err);
        body += "&" + esp32cam_setup::fieldOf(parsed.pairs[i].key) + "=" + percent(v);
    }
    body += std::string("&v.SETUP_PASSWORD=") + OWN_PW + "&v.SETUP_PASSWORD.confirm=" + OWN_PW;
    return body;
}

static int phonePost(const std::string& target, const std::string& body) {
    return setupWorld().handler("POST", target, body).status;
}

// ── a board that is not in setup is not touched ─────────────────────────

TEST(a_configured_board_that_is_not_armed_never_touches_the_setup_hardware) {
    provision(GlueFixture::typical()); powerUp(); setupWorld().reset();
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 0, "no restart");
    TEST_ASSERT(said("Change settings? [y/N]") && g_now >= 5000 && g_now <= 5100, "the usual 5 second window");
    TEST_ASSERT_EQ(setupWorld().touched(), 0, "the setup hardware was not asked for anything: no address, no access point, no log");
    TEST_ASSERT(!g_flash.count("SETUP_MODE") && !g_flash.count("SETUP_PASSWORD"), "and nothing was written for it");
}

// ── an armed board ──────────────────────────────────────────────────────

TEST(an_armed_board_serves_the_setup_wifi_instead_of_the_serial_prompt_and_restarts_when_exited) {
    provision(GlueFixture::typical());
    g_flash["SETUP_MODE"] = "1";
    g_flash["SETUP_PASSWORD"] = OWN_PW;
    powerUp(); setupWorld().reset();
    int polls = 0;
    setupWorld().onPoll = [&polls]() { if (++polls == 3) phonePost("/exit", std::string("csrf=") + TOKEN_V); };
    setupSettings();
    TEST_ASSERT_EQ(setupWorld().ssid, std::string("espcamsys2-") + GlueFixture::type() + "-d4e5f6", "its own WiFi, named after its type and address");
    TEST_ASSERT_EQ(setupWorld().password, std::string(OWN_PW), "protected with the master password");
    TEST_ASSERT(!said("Change settings?"), "the serial prompt is not shown: a configured board has nothing to ask there");
    TEST_ASSERT_EQ(g_flash["SETUP_MODE"], std::string("0"), "the switch is off in flash");
    TEST_ASSERT_EQ(g_restarts, 1, "the board restarted");
    TEST_ASSERT(setupWorld().stops >= 1, "after taking the setup WiFi down");
    TEST_ASSERT(g_now >= 1500, "and after the grace time, so the browser got its page");
    TEST_ASSERT(g_cfg.serverHost.empty(), "it did not carry on into normal operation");
    TEST_ASSERT(!said(OWN_PW), "the password was never printed");
}

TEST(an_armed_board_that_nobody_visits_waits_for_days_and_does_not_start_normally) {
    provision(GlueFixture::typical());
    g_flash["SETUP_MODE"] = "1";
    powerUp(); setupWorld().reset();
    int polls = 0;
    bool restartedEarly = false;
    setupWorld().onPoll = [&polls, &restartedEarly]() {
        if (g_restarts != 0) restartedEarly = true;
        g_now += 3600u * 1000u;                    // an hour passes between two polls
        if (++polls == 72) phonePost("/exit", std::string("csrf=") + TOKEN_V);   // three days later somebody comes
    };
    setupSettings();
    TEST_ASSERT(polls >= 72 && !restartedEarly, "it served for three days without giving up");
    TEST_ASSERT_EQ(g_restarts, 1, "and restarted only when it was told to");
    TEST_ASSERT_EQ(setupWorld().starts, 1, "from one access point, never reopened");
}

// ── a blank board ───────────────────────────────────────────────────────

TEST(a_blank_board_has_the_setup_wifi_open_while_the_serial_prompt_keeps_working) {
    eraseFlash(); powerUp(); setupWorld().reset();
    typeAt(300, GlueFixture::typical() + "\n");
    setupSettings();
    TEST_ASSERT(said("These settings need a value"), "the serial conversation happened");
    TEST_ASSERT_EQ(g_restarts, 1, "settings typed on serial: restarted");
    TEST_ASSERT_EQ(setupWorld().starts, 1, "the setup WiFi was open meanwhile");
    TEST_ASSERT(setupWorld().polls > 0, "and served");
    TEST_ASSERT(setupWorld().stops >= 1, "and was taken down before the restart (the serial conversation got there first)");
    TEST_ASSERT_EQ(setupWorld().ssid, std::string("espcamsys2-") + GlueFixture::type() + "-d4e5f6", "named after the type");
    TEST_ASSERT_EQ(setupWorld().password, std::string(esp32cam_setup::SETUP_DEFAULT_PASSWORD), "with the default master password: a blank board has no other");
}

TEST(a_blank_board_can_be_configured_from_the_form_and_the_browser_gets_its_page_first) {
    eraseFlash(); powerUp(); setupWorld().reset();
    int polls = 0, status = 0;
    setupWorld().onPoll = [&polls, &status]() { if (++polls == 10) status = phonePost("/save", formBody(GlueFixture::typical())); };
    setupSettings();
    TEST_ASSERT_EQ(status, 200, "the form accepted the settings");
    TEST_ASSERT_EQ(g_restarts, 1, "restarted");
    TEST_ASSERT_EQ(g_flash["SETUP_PASSWORD"], std::string(OWN_PW), "the new master password is stored");
    TEST_ASSERT(!g_flash.count("SETUP_MODE") || g_flash["SETUP_MODE"] == "0", "and the switch is off");
    TEST_ASSERT(g_flash.count(GlueFixture::idKey()) && g_flash[GlueFixture::idKey()] == GlueFixture::idValue(), "the settings are in flash");
    TEST_ASSERT(setupWorld().stops >= 1, "the setup WiFi was taken down");
    TEST_ASSERT(g_now >= 1500, "not before the grace time: the browser was still being answered");
}

static void runSetupGlueCases() {
    RUN_TEST(a_configured_board_that_is_not_armed_never_touches_the_setup_hardware);
    RUN_TEST(an_armed_board_serves_the_setup_wifi_instead_of_the_serial_prompt_and_restarts_when_exited);
    RUN_TEST(an_armed_board_that_nobody_visits_waits_for_days_and_does_not_start_normally);
    RUN_TEST(a_blank_board_has_the_setup_wifi_open_while_the_serial_prompt_keeps_working);
    RUN_TEST(a_blank_board_can_be_configured_from_the_form_and_the_browser_gets_its_page_first);
}
