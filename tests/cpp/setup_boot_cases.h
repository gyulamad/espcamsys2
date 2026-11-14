// setup_boot_cases.h — the tests of SetupBoot and SettingsSetupStore (setup_boot.h), written once and run
// against each sketch's real key table by test_setup_boot_recorder.cpp and test_setup_boot_person.cpp
// (two files, not one: both sketch folders hold their own copy of settings_logic.h, and one program
// cannot include both copies).
//
// The including file first includes its sketch's settings_schema.h, setup_boot.h and settings_fakes.h,
// defines
//
//     struct BootFixture { ... };           // what is specific to that sketch, see the Recorder's
//
// and then includes this header and calls runSetupBootCases() from main().
//
// What matters most here: a board that is NOT in setup must be left completely alone (nothing built,
// nothing asked of the hardware), a board that IS in setup must never fall back to normal operation
// by itself, and the password must never be printed.

#pragma once

#include "framework.h"
#include "setup_boot_fakes.h"

#include <string>
#include <vector>

using namespace esp32cam_setup;

static const char* const OWN_PASSWORD = "My-Own-Master-1";
static const char* const TOKEN_VALUE  = "0123456789abcdef0123456789abcdef";

static void load(MemoryStore& st, const std::string& line) {
    esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(BootFixture::schema(), line);
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
}

static MemoryStore configured() {
    MemoryStore st;
    load(st, BootFixture::typical());
    return st;
}

static bool phone(const std::string& method, const std::string& target, const std::string& body, int& status) {
    if (!setupWorld().handler) return false;
    status = setupWorld().handler(method, target, body).status;
    return true;
}

// Runs the session `steps` times, a second apart, starting at `*now`.
static SetupStep run(SetupBoot& boot, uint32_t* now, int steps = 3) {
    SetupStep r = SetupStep::Running;
    for (int i = 0; i < steps; ++i) { r = boot.step(*now); *now += 1000; }
    return r;
}

// ── a board that is not in setup is left completely alone ───────────────

TEST(a_configured_board_that_is_not_armed_is_not_in_setup_and_nothing_is_touched) {
    setupWorld().reset();
    MemoryStore st = configured();
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(!boot.active() && !boot.armed(), "not in setup");
    TEST_ASSERT(boot.step(1) == SetupStep::Proceed && boot.step(4000000000u) == SetupStep::Proceed, "Proceed, always");
    boot.stop();
    TEST_ASSERT_EQ(setupWorld().touched(), 0, "the hardware was not asked for anything: no address, no token, no access point, no log");
    TEST_ASSERT(!st.has("SETUP_MODE") && !st.has("SETUP_PASSWORD"), "and nothing was written");
}

TEST(a_switch_that_is_off_or_damaged_does_not_arm_the_board) {
    const char* values[] = { "0", "no", "off", "false", "", "2", "1 ", "garbage" };
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        setupWorld().reset();
        MemoryStore st = configured();
        st.set("SETUP_MODE", values[i]);
        FakeSetupHardware hw;
        SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
        TEST_ASSERT(!boot.active(), (std::string("SETUP_MODE=\"") + values[i] + "\" is not armed").c_str());
        TEST_ASSERT_EQ(setupWorld().touched(), 0, "and the hardware is not asked for anything");
    }
}

TEST(every_spelling_of_on_arms_the_board) {
    // Kind::Bool accepts these (settings_logic.h), and so does setupReason(): the switch means what it means everywhere.
    const char* values[] = { "1", "yes", "true", "on", "YES", "On" };
    for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        setupWorld().reset();
        MemoryStore st = configured();
        st.set("SETUP_MODE", values[i]);
        FakeSetupHardware hw;
        SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
        TEST_ASSERT(boot.armed(), (std::string("SETUP_MODE=\"") + values[i] + "\" arms the board").c_str());
    }
}

TEST(a_board_missing_a_setting_it_can_get_from_the_relay_is_not_in_setup) {
    // Remote fill (settings_logic.h) fills such a gap from the relay: it must keep doing so, not open a WiFi.
    setupWorld().reset();
    MemoryStore st = configured();
    st.m.erase(BootFixture::changeKey());
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(!boot.active(), "it can still reach the relay, so it is not in setup");
    TEST_ASSERT_EQ(setupWorld().touched(), 0, "and nothing is touched");
}

// ── a board that is in setup ────────────────────────────────────────────

TEST(a_blank_board_is_in_setup_but_not_armed) {
    setupWorld().reset();
    MemoryStore st;
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(boot.active() && !boot.armed(), "a blank board is in setup, and does not need arming");
}

TEST(a_board_that_cannot_reach_the_relay_is_in_setup) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.m.erase("WIFI");
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(boot.active() && !boot.armed(), "without its WiFi it cannot reach the relay: in setup");
}

TEST(a_configured_board_with_the_switch_on_is_armed) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.set("SETUP_MODE", "1");
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(boot.active() && boot.armed(), "armed");
}

TEST(the_setup_wifi_is_named_after_the_type_and_the_mac_and_uses_the_master_password) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.set("SETUP_MODE", "1");
    st.set("SETUP_PASSWORD", OWN_PASSWORD);
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    uint32_t now = 0;
    TEST_ASSERT(boot.step(now) == SetupStep::Running, "running");
    TEST_ASSERT_EQ(setupWorld().ssid, std::string("espcamsys2-") + BootFixture::type() + "-d4e5f6", "named after the type and the last three MAC bytes");
    TEST_ASSERT_EQ(setupWorld().password, std::string(OWN_PASSWORD), "the stored master password");
    TEST_ASSERT_EQ(setupWorld().opens, 1, "one access point");
    TEST_ASSERT_EQ(setupWorld().macCalls, 1, "the address was asked once");
    TEST_ASSERT_EQ(setupWorld().tokenCalls, 1, "and so was the token");
}

TEST(without_a_stored_master_password_the_built_in_default_is_used_and_a_bad_stored_one_is_ignored) {
    const char* stored[] = { nullptr, "short", "has\ttab-in-it", "0123456789012345678901234567890123456789012345678901234567890123" };
    for (size_t i = 0; i < sizeof(stored) / sizeof(stored[0]); ++i) {
        setupWorld().reset();
        MemoryStore st;   // blank
        if (stored[i]) st.set("SETUP_PASSWORD", stored[i]);
        FakeSetupHardware hw;
        SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
        boot.step(0);
        TEST_ASSERT_EQ(setupWorld().password, std::string(SETUP_DEFAULT_PASSWORD), "the default (a damaged password must never leave the board without a setup WiFi)");
    }
}

TEST(an_unusable_mac_gives_a_fixed_name_and_the_board_still_opens_its_wifi) {
    const char* macs[] = { "", "not a mac", "AA:BB:CC:D4:E5", "AA:BB:CC:D4:E5:GG" };
    for (size_t i = 0; i < sizeof(macs) / sizeof(macs[0]); ++i) {
        setupWorld().reset();
        setupWorld().mac = macs[i];
        MemoryStore st;
        FakeSetupHardware hw;
        SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
        TEST_ASSERT(boot.step(0) == SetupStep::Running, "running");
        TEST_ASSERT_EQ(setupWorld().ssid, std::string(SETUP_FALLBACK_SSID), "a fixed, valid name");
        TEST_ASSERT(setupWorld().logged("MAC address"), "and the log says why");
    }
}

TEST(the_password_is_never_printed) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.set("SETUP_MODE", "1");
    st.set("SETUP_PASSWORD", OWN_PASSWORD);
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    setupWorld().failStarts = 1;
    uint32_t now = 0;
    run(boot, &now, 20);
    TEST_ASSERT(!setupWorld().logs.empty(), "the session logged");
    TEST_ASSERT(!setupWorld().logged(OWN_PASSWORD), "but never the password");
    TEST_ASSERT(setupWorld().logged(std::string("espcamsys2-") + BootFixture::type()), "the network name is logged");
}

TEST(a_failing_access_point_is_retried_and_never_ends_the_setup) {
    setupWorld().reset();
    setupWorld().failStarts = 3;
    MemoryStore st;
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    bool proceeded = false;
    uint32_t now = 0;
    for (int i = 0; i < 60; ++i) { if (boot.step(now) == SetupStep::Proceed) proceeded = true; now += 1000; }
    TEST_ASSERT(!proceeded, "never Proceed: a board that was asked for setup does not quietly go back to normal");
    TEST_ASSERT_EQ(setupWorld().starts, 4, "three failures, then it comes up");
    TEST_ASSERT(setupWorld().polls > 0, "and then it serves");
}

// ── the form, the session and the store, wired together ─────────────────

TEST(the_access_point_answers_with_this_boots_form_and_exit_ends_the_setup) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.set("SETUP_MODE", "1");
    st.set("SETUP_PASSWORD", OWN_PASSWORD);
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    uint32_t now = 0;
    run(boot, &now, 2);
    int status = 0;
    TEST_ASSERT(phone("GET", "/", "", status) && status == 200, "the form is served");
    TEST_ASSERT(phone("GET", "/no-such-page", "", status) && status == 404, "and other pages are not");
    TEST_ASSERT(phone("POST", "/exit", "csrf=wrong", status) && status == 403, "a wrong token is refused");
    TEST_ASSERT(run(boot, &now, 5) == SetupStep::Running && st.get("SETUP_MODE") == "1", "and the board is still in setup, the switch still on");

    TEST_ASSERT(phone("POST", "/exit", std::string("csrf=") + TOKEN_VALUE, status) && status == 200, "the right token: 'Exit setup mode' is answered");
    TEST_ASSERT_EQ(st.get("SETUP_MODE"), std::string("0"), "the switch is off in the store");
    uint32_t t = now;
    TEST_ASSERT(boot.step(t) == SetupStep::Running, "the page still gets delivered");
    TEST_ASSERT(boot.step(t + SETUP_RESTART_GRACE_MS) == SetupStep::Restart, "then Restart");
    TEST_ASSERT_EQ(setupWorld().stops, 1, "the access point was taken down, once");
    TEST_ASSERT(boot.step(t + 99999) == SetupStep::Restart, "and it stays Restart");
}

TEST(a_blank_board_cannot_exit_setup_without_configuring) {
    setupWorld().reset();
    MemoryStore st;
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    uint32_t now = 0;
    run(boot, &now, 2);
    int status = 0;
    TEST_ASSERT(phone("POST", "/exit", std::string("csrf=") + TOKEN_VALUE, status) && status != 200, "no way out of setup for a board with nothing to run on");
    TEST_ASSERT(run(boot, &now, 5) == SetupStep::Running, "it stays in setup");
}

TEST(a_session_that_is_dropped_takes_the_access_point_down) {
    setupWorld().reset();
    MemoryStore st;
    FakeSetupHardware hw;
    {
        SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
        boot.step(0);
        TEST_ASSERT_EQ(setupWorld().stops, 0, "still up");
    }
    TEST_ASSERT_EQ(setupWorld().stops, 1, "going out of scope (the serial conversation got there first) leaves WiFi clean");
}

// ── SETUP_MODE = 0, for real ────────────────────────────────────────────

TEST(the_store_adapter_switches_the_setup_mode_off_only_when_it_has_to) {
    {   // never set: nothing to do, nothing written
        MemoryStore st = configured();
        SettingsSetupStore clear(BootFixture::schema(), st);
        size_t n = st.m.size();
        TEST_ASSERT(clear.clearSetupMode() && st.m.size() == n && !st.has("SETUP_MODE"), "absent: succeeds without writing");
    }
    {   // already 0
        MemoryStore st = configured();
        st.set("SETUP_MODE", "0");
        SettingsSetupStore clear(BootFixture::schema(), st);
        st.failWrites = true;   // a write would fail: it must not even try
        TEST_ASSERT(clear.clearSetupMode(), "already 0: succeeds without writing");
    }
    {   // on
        MemoryStore st = configured();
        st.set("SETUP_MODE", "1");
        SettingsSetupStore clear(BootFixture::schema(), st);
        TEST_ASSERT(clear.clearSetupMode() && st.get("SETUP_MODE") == "0", "on: written as 0");
    }
    {   // damaged
        MemoryStore st = configured();
        st.set("SETUP_MODE", "garbage");
        SettingsSetupStore clear(BootFixture::schema(), st);
        TEST_ASSERT(clear.clearSetupMode() && st.get("SETUP_MODE") == "0", "damaged: replaced by 0");
    }
    {   // the flash refuses the write: the session must hear about it (and not restart)
        MemoryStore st = configured();
        st.set("SETUP_MODE", "1");
        SettingsSetupStore clear(BootFixture::schema(), st);
        st.failWrites = true;
        TEST_ASSERT(!clear.clearSetupMode() && st.get("SETUP_MODE") == "1", "a failed write is reported");
    }
}

TEST(the_session_does_not_restart_while_the_switch_cannot_be_stored) {
    setupWorld().reset();
    MemoryStore st = configured();
    st.set("SETUP_MODE", "1");
    st.set("SETUP_PASSWORD", OWN_PASSWORD);
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    uint32_t now = 0;
    run(boot, &now, 2);
    int status = 0;
    phone("POST", "/exit", std::string("csrf=") + TOKEN_VALUE, status);   // the form clears it in memory...
    st.set("SETUP_MODE", "1");                                           // ...but the flash did not keep it
    st.failWrites = true;
    bool restarted = false;
    for (int i = 0; i < 30; ++i) { if (run(boot, &now, 1) == SetupStep::Restart) restarted = true; }
    TEST_ASSERT(!restarted, "restarting now would put the board straight back into setup");
    st.failWrites = false;
    for (int i = 0; i < 30; ++i) { if (run(boot, &now, 1) == SetupStep::Restart) restarted = true; }
    TEST_ASSERT(restarted && st.get("SETUP_MODE") == "0", "once the flash works again it is switched off and the board restarts");
}

static void runSetupBootCases() {
    RUN_TEST(a_configured_board_that_is_not_armed_is_not_in_setup_and_nothing_is_touched);
    RUN_TEST(a_switch_that_is_off_or_damaged_does_not_arm_the_board);
    RUN_TEST(every_spelling_of_on_arms_the_board);
    RUN_TEST(a_board_missing_a_setting_it_can_get_from_the_relay_is_not_in_setup);
    RUN_TEST(a_blank_board_is_in_setup_but_not_armed);
    RUN_TEST(a_board_that_cannot_reach_the_relay_is_in_setup);
    RUN_TEST(a_configured_board_with_the_switch_on_is_armed);
    RUN_TEST(the_setup_wifi_is_named_after_the_type_and_the_mac_and_uses_the_master_password);
    RUN_TEST(without_a_stored_master_password_the_built_in_default_is_used_and_a_bad_stored_one_is_ignored);
    RUN_TEST(an_unusable_mac_gives_a_fixed_name_and_the_board_still_opens_its_wifi);
    RUN_TEST(the_password_is_never_printed);
    RUN_TEST(a_failing_access_point_is_retried_and_never_ends_the_setup);
    RUN_TEST(the_access_point_answers_with_this_boots_form_and_exit_ends_the_setup);
    RUN_TEST(a_blank_board_cannot_exit_setup_without_configuring);
    RUN_TEST(a_session_that_is_dropped_takes_the_access_point_down);
    RUN_TEST(the_store_adapter_switches_the_setup_mode_off_only_when_it_has_to);
    RUN_TEST(the_session_does_not_restart_while_the_switch_cannot_be_stored);
}
