// test_setup_logic.cpp — unit tests for setup_logic.h (F-21 S2): when a board
// opens its own setup WiFi, what that WiFi is called, and which password
// protects it. No ESP32: the flash is an in-memory fake.
//
// The schema here is a small stand-in carrying the five settings a board needs
// to reach the relay plus SETUP_MODE / SETUP_PASSWORD, so these tests do not
// depend on S1 (the real schema keys). Only kinds and names matter to the logic.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_logic test_setup_logic.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/setup_logic.h"
#include "settings_fakes.h"

using namespace esp32cam_setup;

static const KeyDef KEYS[] = {
    { "WIFI",           Kind::Wifi,   0, 0,     Cond::Always, nullptr, nullptr, "wifi" },
    { "SERVER_HOST",    Kind::Host,   0, 0,     Cond::Always, nullptr, nullptr, "host" },
    { "HTTP_PORT",      Kind::Int,    1, 65535, Cond::Always, nullptr, nullptr, "port" },
    { "API_KEY",        Kind::Secret, 0, 0,     Cond::Always, nullptr, nullptr, "key" },
    { "CAMERA_ID",      Kind::Id,     0, 0,     Cond::Always, nullptr, nullptr, "id" },
    { "SETUP_MODE",     Kind::Bool,   0, 0,     Cond::Always, nullptr, nullptr, "switch" },
    { "SETUP_PASSWORD", Kind::Secret, 0, 0,     Cond::Always, nullptr, nullptr, "master password" },
};
static const Schema SCHEMA = { KEYS, sizeof(KEYS) / sizeof(KEYS[0]), nullptr };
// A schema from an older firmware that has neither new key.
static const Schema OLD_SCHEMA = { KEYS, 5, nullptr };

static std::vector<std::string> prereq() {
    static const char* const k[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "CAMERA_ID" };
    return std::vector<std::string>(k, k + 5);
}

static void configured(MemoryStore& st) {
    st.m["WIFI"] = "home:password1";
    st.m["SERVER_HOST"] = "192.168.4.9";
    st.m["HTTP_PORT"] = "8080";
    st.m["API_KEY"] = "s3cret";
    st.m["CAMERA_ID"] = "cam2";
}

// ── constants ───────────────────────────────────────────────────────────

TEST(the_default_password_is_the_documented_one_and_a_valid_wpa2_passphrase) {
    TEST_ASSERT_EQ(std::string(SETUP_DEFAULT_PASSWORD), std::string("Admin1234"), "documented default");
    TEST_ASSERT(validSetupPassword(SETUP_DEFAULT_PASSWORD), "valid as WPA2");
    TEST_ASSERT(isDefaultSetupPassword("Admin1234"), "recognised");
    TEST_ASSERT(!isDefaultSetupPassword("admin1234"), "case matters");
    TEST_ASSERT(!isDefaultSetupPassword("Admin12345"), "exact match only");
}

TEST(the_access_point_constants) {
    TEST_ASSERT_EQ(std::string(SETUP_AP_IP), std::string("192.168.4.1"), "ESP32 default AP address");
    TEST_ASSERT_EQ(SETUP_RESTART_GRACE_MS, 1500u, "grace before restart");
}

// ── setupReason ─────────────────────────────────────────────────────────

TEST(a_blank_board_is_unconfigured) {
    MemoryStore st;
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::Unconfigured, "nothing stored");
    TEST_ASSERT_EQ(st.badGets, 0, "only existing keys were read");
}

TEST(a_configured_board_without_the_switch_runs_normally) {
    MemoryStore st; configured(st);
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::None, "no SETUP_MODE");
    TEST_ASSERT(setupReason(OLD_SCHEMA, st, prereq()) == SetupReason::None, "older firmware without the key");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of a missing key");
}

TEST(the_switch_on_arms_a_configured_board) {
    const char* on[] = { "1", "yes", "true", "on" };
    for (size_t i = 0; i < 4; ++i) {
        MemoryStore st; configured(st);
        st.m["SETUP_MODE"] = on[i];
        TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::Armed, std::string("armed by ") + on[i]);
    }
}

TEST(the_switch_off_leaves_it_running) {
    MemoryStore st; configured(st);
    st.m["SETUP_MODE"] = "0";
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::None, "SETUP_MODE=0");
}

TEST(a_damaged_switch_is_not_armed) {
    const char* bad[] = { "", "banana", "2", "1;", "\x01", "1 1" };
    for (size_t i = 0; i < 6; ++i) {
        MemoryStore st; configured(st);
        st.m["SETUP_MODE"] = bad[i];
        TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::None, std::string("damaged value #") + std::to_string(i));
    }
}

TEST(a_key_that_is_not_in_the_schema_cannot_arm_the_board) {
    MemoryStore st; configured(st);
    st.m["SETUP_MODE"] = "1";
    TEST_ASSERT(setupReason(OLD_SCHEMA, st, prereq()) == SetupReason::None, "schema without SETUP_MODE ignores flash");
}

TEST(unconfigured_wins_over_armed) {
    MemoryStore st; configured(st);
    st.m["SETUP_MODE"] = "1";
    st.m.erase("API_KEY");
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::Unconfigured, "missing prerequisite");
}

TEST(a_damaged_prerequisite_makes_the_board_unconfigured) {
    MemoryStore st; configured(st);
    st.m["HTTP_PORT"] = "banana";
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::Unconfigured, "invalid stored port");
}

TEST(only_the_prerequisites_decide_configured) {
    MemoryStore st; configured(st);
    st.m["SETUP_PASSWORD"] = "garbage";   // irrelevant to reaching the relay
    TEST_ASSERT(setupReason(SCHEMA, st, prereq()) == SetupReason::None, "other settings don't matter");
}

TEST(an_empty_prerequisite_list_means_unconfigured) {
    MemoryStore st; configured(st);
    TEST_ASSERT(setupReason(SCHEMA, st, std::vector<std::string>()) == SetupReason::Unconfigured, "same rule as remoteFillPossible");
}

// ── setupSsid ───────────────────────────────────────────────────────────

static std::string ssid(const std::string& type, const std::string& mac) {
    std::string out = "untouched";
    return setupSsid(type, mac, out) ? out : "REFUSED:" + out;
}

TEST(the_ssid_has_the_type_and_the_last_three_mac_bytes_in_lowercase) {
    TEST_ASSERT_EQ(ssid("recorder", "AA:BB:CC:D4:E5:F6"), std::string("espcamsys2-recorder-d4e5f6"), "colon form");
    TEST_ASSERT_EQ(ssid("detector", "aa-bb-cc-d4-e5-f6"), std::string("espcamsys2-detector-d4e5f6"), "dash form");
    TEST_ASSERT_EQ(ssid("recorder", "AABBCCD4E5F6"), std::string("espcamsys2-recorder-d4e5f6"), "plain form");
    TEST_ASSERT_EQ(ssid("detector", "00:00:00:00:00:0A"), std::string("espcamsys2-detector-00000a"), "leading zeros kept");
}

TEST(the_ssid_fits_and_uses_only_the_allowed_characters) {
    std::string out;
    TEST_ASSERT(setupSsid("recorder", "AA:BB:CC:D4:E5:F6", out), "ok");
    TEST_ASSERT(out.size() <= SSID_MAX, "at most 32 bytes");
    bool clean = true;
    for (size_t i = 0; i < out.size(); ++i) {
        char c = out[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) clean = false;
    }
    TEST_ASSERT(clean, "only [a-z0-9-]");
}

TEST(an_unknown_or_odd_type_is_refused) {
    const char* bad[] = { "", "camera", "Recorder", "recorder ", "recorder-", "../x", "detector\n" };
    for (size_t i = 0; i < 7; ++i) {
        TEST_ASSERT(ssid(bad[i], "AA:BB:CC:D4:E5:F6").rfind("REFUSED", 0) == 0, std::string("type #") + std::to_string(i));
    }
}

TEST(a_bad_mac_is_refused_and_the_output_is_left_alone) {
    const std::string bad[] = {
        "", "AA:BB:CC:D4:E5", "AA:BB:CC:D4:E5:F6:07", "AA:BB:CC:D4:E5:GG", "AABBCCD4E5F",
        "AABBCCD4E5F6A", "AA:BB:CC-D4:E5:F6", "AA.BB.CC.D4.E5.F6", "AA:::::BBCCDDEEFF",
        "AABB:CC:DD:EE:FF", ":AA:BB:CC:D4:E5:F6", "AA:BB:CC:D4:E5:F6:", "AA BB CC D4 E5 F6",
        "AA:BB:CC:D4:E5:F\n", std::string("AABBCCD4E5F\0", 12)
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        TEST_ASSERT_EQ(ssid("recorder", bad[i]), std::string("REFUSED:untouched"), std::string("mac #") + std::to_string(i));
    }
}

// ── setupPassword ───────────────────────────────────────────────────────

TEST(without_a_stored_password_the_default_is_used) {
    MemoryStore st;
    TEST_ASSERT_EQ(setupPassword(SCHEMA, st), std::string("Admin1234"), "blank board");
    TEST_ASSERT_EQ(setupPassword(OLD_SCHEMA, st), std::string("Admin1234"), "schema without the key");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of a missing key");
}

TEST(a_valid_stored_password_is_used) {
    MemoryStore st;
    st.m["SETUP_PASSWORD"] = "my own passphrase!";
    TEST_ASSERT_EQ(setupPassword(SCHEMA, st), std::string("my own passphrase!"), "stored wins");
    st.m["SETUP_PASSWORD"] = "12345678";
    TEST_ASSERT_EQ(setupPassword(SCHEMA, st), std::string("12345678"), "8 characters is the minimum");
    st.m["SETUP_PASSWORD"] = std::string(63, 'x');
    TEST_ASSERT_EQ(setupPassword(SCHEMA, st), std::string(63, 'x'), "63 characters is the maximum");
}

TEST(a_password_that_is_not_a_valid_passphrase_falls_back_to_the_default) {
    const std::string bad[] = {
        "", "short", "1234567", std::string(64, 'x'), "change-me", "tab\there1", "ünïcödé-pass",
        std::string("nul\0inside", 10), "new\nline123"
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        MemoryStore st;
        st.m["SETUP_PASSWORD"] = bad[i];
        std::string pw = setupPassword(SCHEMA, st);
        TEST_ASSERT_EQ(pw, std::string("Admin1234"), std::string("fallback for #") + std::to_string(i));
    }
}

TEST(the_result_is_always_a_valid_wpa2_passphrase) {
    const std::string stored[] = { "", "x", "good passphrase", std::string(200, 'y'), "\x7f" "controlchars" };
    for (size_t i = 0; i < sizeof(stored) / sizeof(stored[0]); ++i) {
        MemoryStore st;
        st.m["SETUP_PASSWORD"] = stored[i];
        TEST_ASSERT(validSetupPassword(setupPassword(SCHEMA, st)), std::string("valid for #") + std::to_string(i));
    }
}

TEST(validSetupPassword_boundaries) {
    TEST_ASSERT(!validSetupPassword(std::string(7, 'a')), "7 too short");
    TEST_ASSERT(validSetupPassword(std::string(8, 'a')), "8 ok");
    TEST_ASSERT(validSetupPassword(std::string(63, 'a')), "63 ok");
    TEST_ASSERT(!validSetupPassword(std::string(64, 'a')), "64 too long");
    TEST_ASSERT(validSetupPassword("with space ~!"), "space and ~ are printable");
    TEST_ASSERT(!validSetupPassword("12345678\x7f"), "DEL is not printable");
    TEST_ASSERT(!validSetupPassword("12345678\xc3\xa9"), "non-ASCII");
}

int main() {
    RUN_TEST(the_default_password_is_the_documented_one_and_a_valid_wpa2_passphrase);
    RUN_TEST(the_access_point_constants);
    RUN_TEST(a_blank_board_is_unconfigured);
    RUN_TEST(a_configured_board_without_the_switch_runs_normally);
    RUN_TEST(the_switch_on_arms_a_configured_board);
    RUN_TEST(the_switch_off_leaves_it_running);
    RUN_TEST(a_damaged_switch_is_not_armed);
    RUN_TEST(a_key_that_is_not_in_the_schema_cannot_arm_the_board);
    RUN_TEST(unconfigured_wins_over_armed);
    RUN_TEST(a_damaged_prerequisite_makes_the_board_unconfigured);
    RUN_TEST(only_the_prerequisites_decide_configured);
    RUN_TEST(an_empty_prerequisite_list_means_unconfigured);
    RUN_TEST(the_ssid_has_the_type_and_the_last_three_mac_bytes_in_lowercase);
    RUN_TEST(the_ssid_fits_and_uses_only_the_allowed_characters);
    RUN_TEST(an_unknown_or_odd_type_is_refused);
    RUN_TEST(a_bad_mac_is_refused_and_the_output_is_left_alone);
    RUN_TEST(without_a_stored_password_the_default_is_used);
    RUN_TEST(a_valid_stored_password_is_used);
    RUN_TEST(a_password_that_is_not_a_valid_passphrase_falls_back_to_the_default);
    RUN_TEST(the_result_is_always_a_valid_wpa2_passphrase);
    RUN_TEST(validSetupPassword_boundaries);
    return test::summarize();
}
