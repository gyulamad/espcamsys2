// test_recorder_connection_settings.cpp — F-29 T2: the Recorder's update, relay-search, settings-sync, setup-WiFi and
// boot settings (OTA_*, RF_*, SYNC_*, SETUP_*, BOOT_*): the same keys, ranges and defaults as the detector's (T5b).
//
// What this proves: each default is the value the code had before it became a setting; the shared headers' own
// defaults (what a sketch that passes nothing gets) agree with the schema; a blank board is not asked for any of
// them and an updated board loads exactly the old values (upgrade path: a key that stays required is still
// demanded); a stored value is used; the ranges, the two "lowest <= highest" rules and the locked switches
// protect the board from a bad change from the dashboard; the boot waits and the setup tuning are readable
// before the full settings can be loaded.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_recorder_connection_settings test_recorder_connection_settings.cpp

#include "framework.h"

#include <string>

#include "../../Arduino/ESP32_CAM_Recorder/ota_logic.h"
#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_boot.h"
#include "settings_fakes.h"
#include "schema_counts.h"

using namespace esp32cam_settings;

static void fillIdentity(MemoryStore& st) {
    st.set("WIFI", "net:password1");
    st.set("SERVER_HOST", "192.168.4.9");
    st.set("PUSH_PORT", "8081");
    st.set("HTTP_PORT", "8080");
    st.set("CAMERA_ID", "cam2");
    st.set("API_KEY", "s3cret");
    st.set("ALARM_GPIO_PIN", "-1");
    st.set("LOG_ENABLED", "0");
}

// Every setting F-29 T2 added to the Recorder: the value the code had before, and where the page shows it.
struct T2Key { const char* name; const char* oldValue; const char* category; };
static const T2Key T2_KEYS[] = {
    { "OTA_ENABLED", "1", "Updates & sync" },        { "OTA_CHECK_S", "60", "Updates & sync" },
    { "OTA_RETRY_S", "300", "Updates & sync" },      { "OTA_VER_MAX_B", "256", "Updates & sync" },
    { "OTA_FW_MIN_B", "102400", "Updates & sync" },  { "OTA_FW_MAX_B", "2097152", "Updates & sync" },
    { "OTA_VER_IDLE_MS", "5000", "Updates & sync" }, { "OTA_DL_IDLE_MS", "15000", "Updates & sync" },
    { "SYNC_ENABLED", "1", "Updates & sync" },       { "SYNC_FIRST_S", "20", "Updates & sync" },
    { "SYNC_CHECK_S", "30", "Updates & sync" },
    { "RF_ENABLED", "1", "Connection" },             { "RF_PORT", "8082", "Connection" },
    { "RF_FIRST_S", "10", "Connection" },            { "RF_OK_S", "60", "Connection" },
    { "RF_RETRY_MIN_S", "15", "Connection" },        { "RF_RETRY_MAX_S", "300", "Connection" },
    { "BOOT_WIFI_MS", "20000", "Connection" },       { "BOOT_RELAY_MS", "30000", "Connection" },
    { "BOOT_POLL_MS", "5000", "Connection" },
    { "SETUP_RETRY_MS", "5000", "Setup & security" },{ "SETUP_GRACE_MS", "1500", "Setup & security" },
    { "SETUP_AP_CHAN", "1", "Setup & security" },    { "SETUP_MAX_STA", "4", "Setup & security" },
    { "SETUP_RQ_TMO_MS", "10000", "Setup & security" }, { "BOOT_SER_WIN_MS", "5000", "Setup & security" },
};
static const size_t T2_COUNT = sizeof(T2_KEYS) / sizeof(T2_KEYS[0]);

static std::string who(const char* name, const char* what) { return std::string(name) + ": " + what; }

TEST(every_new_setting_has_the_old_value_as_its_default_a_label_a_group_and_needs_a_restart) {
    for (size_t i = 0; i < T2_COUNT; ++i) {
        const char* n = T2_KEYS[i].name;
        const KeyDef* def = findKey(RECORDER_SCHEMA, n);
        const KeyMeta* m = findMeta(RECORDER_SCHEMA.meta, RECORDER_SCHEMA.metaCount, n);
        TEST_ASSERT(def != nullptr, who(n, "is a key of the schema").c_str());
        TEST_ASSERT(m && m->defaultValue, who(n, "has a default").c_str());
        if (!def || !m || !m->defaultValue) continue;
        TEST_ASSERT_EQ(std::string(m->defaultValue), std::string(T2_KEYS[i].oldValue), who(n, "default = the old value").c_str());
        TEST_ASSERT(m->label && m->label[0], who(n, "has a label").c_str());
        TEST_ASSERT_EQ(std::string(m->category), std::string(T2_KEYS[i].category), who(n, "group").c_str());
        TEST_ASSERT(m->apply == Apply::Reboot, who(n, "is read at boot: Apply::Reboot").c_str());
        std::string err;
        TEST_ASSERT(validateStored(*def, m->defaultValue, err), who(n, ("the default passes its own validation: " + err).c_str()).c_str());
    }
}

TEST(the_shared_headers_own_defaults_agree_with_the_schema) {
    // What a sketch that passes nothing to OtaUpdater / SetupBoot gets (the detector until T5b) must equal the schema's
    // default, or the two copies of the same number would drift apart.
    esp32cam_ota::OtaTiming t = esp32cam_ota::defaultTiming();
    esp32cam_ota::OtaLimits l = esp32cam_ota::defaultOtaLimits();
    esp32cam_setup::SetupOptions o;
    MemoryStore blank;
    DefaultingStore defaults(blank, RECORDER_META, RECORDER_META_COUNT);
    TEST_ASSERT_EQ((long long)t.checkMs, storedInt(defaults, "OTA_CHECK_S") * 1000, "OTA check interval");
    TEST_ASSERT_EQ((long long)t.retryMs, storedInt(defaults, "OTA_RETRY_S") * 1000, "OTA retry interval");
    TEST_ASSERT_EQ((long long)l.versionReplyMaxBytes, storedInt(defaults, "OTA_VER_MAX_B"), "OTA version reply bound");
    TEST_ASSERT_EQ((long long)l.firmwareMinBytes, storedInt(defaults, "OTA_FW_MIN_B"), "OTA smallest firmware");
    TEST_ASSERT_EQ((long long)l.firmwareMaxBytes, storedInt(defaults, "OTA_FW_MAX_B"), "OTA largest firmware");
    TEST_ASSERT_EQ((long long)l.versionReplyIdleMs, storedInt(defaults, "OTA_VER_IDLE_MS"), "OTA version idle");
    TEST_ASSERT_EQ((long long)l.downloadIdleMs, storedInt(defaults, "OTA_DL_IDLE_MS"), "OTA download idle");
    TEST_ASSERT_EQ((long long)o.retryMs, storedInt(defaults, "SETUP_RETRY_MS"), "setup retry");
    TEST_ASSERT_EQ((long long)o.graceMs, storedInt(defaults, "SETUP_GRACE_MS"), "setup grace");
    TEST_ASSERT_EQ((long long)o.net.apChannel, storedInt(defaults, "SETUP_AP_CHAN"), "setup channel");
    TEST_ASSERT_EQ((long long)o.net.apMaxStations, storedInt(defaults, "SETUP_MAX_STA"), "setup phones");
    TEST_ASSERT_EQ((long long)o.net.requestTimeoutMs, storedInt(defaults, "SETUP_RQ_TMO_MS"), "setup request timeout");
    RecorderSettings s;   // and the typed struct's own defaults
    TEST_ASSERT(s.otaEnabled && (long long)s.otaCheckSec == storedInt(defaults, "OTA_CHECK_S") &&
                (long long)s.otaFwMaxBytes == storedInt(defaults, "OTA_FW_MAX_B") && (long long)s.otaDlIdleMs == storedInt(defaults, "OTA_DL_IDLE_MS"), "RecorderSettings OTA defaults");
    TEST_ASSERT(s.relayFindEnabled && (long long)s.relayFindPort == storedInt(defaults, "RF_PORT") &&
                (long long)s.relayFindRetryMaxSec == storedInt(defaults, "RF_RETRY_MAX_S"), "RecorderSettings relay search defaults");
    TEST_ASSERT(s.syncEnabled && (long long)s.syncFirstSec == storedInt(defaults, "SYNC_FIRST_S") &&
                (long long)s.syncCheckSec == storedInt(defaults, "SYNC_CHECK_S"), "RecorderSettings sync defaults");
}

TEST(a_blank_board_is_not_asked_for_any_of_them_and_an_updated_board_loads_the_old_values) {
    MemoryStore blank;
    std::vector<Problem> problems = findProblems(RECORDER_SCHEMA, blank);
    for (size_t i = 0; i < problems.size(); ++i)
        for (size_t k = 0; k < T2_COUNT; ++k)
            TEST_ASSERT(problems[i].key != T2_KEYS[k].name, (problems[i].key + " is not asked for").c_str());

    // The upgrade path: a board configured before F-29 (only the settings it already had) loads, with the old values.
    MemoryStore old; fillIdentity(old);
    RecorderSettings cfg; std::string err;
    TEST_ASSERT(loadRecorderSettings(old, cfg, err), ("an old configuration loads: " + err).c_str());
    TEST_ASSERT(cfg.otaEnabled && cfg.otaCheckSec == 60 && cfg.otaRetrySec == 300 && cfg.otaVerMaxBytes == 256 &&
                cfg.otaFwMinBytes == 102400 && cfg.otaFwMaxBytes == 2097152 && cfg.otaVerIdleMs == 5000 && cfg.otaDlIdleMs == 15000, "old OTA values");
    TEST_ASSERT(cfg.relayFindEnabled && cfg.relayFindPort == 8082 && cfg.relayFindFirstSec == 10 && cfg.relayFindOkSec == 60 &&
                cfg.relayFindRetryMinSec == 15 && cfg.relayFindRetryMaxSec == 300, "old relay search values");
    TEST_ASSERT(cfg.syncEnabled && cfg.syncFirstSec == 20 && cfg.syncCheckSec == 30, "old sync values");
    TEST_ASSERT(old.m.size() == 8, "and loading stored nothing");

    // A setting that stays required is still demanded (decision 10): the missing-key example is API_KEY.
    MemoryStore noKey = old;
    noKey.m.erase("API_KEY");
    RecorderSettings c2; std::string err2;
    TEST_ASSERT(!loadRecorderSettings(noKey, c2, err2) && err2.find("API_KEY") != std::string::npos, "a board without API_KEY does not load, whatever the defaults");
}

TEST(a_stored_value_is_used) {
    MemoryStore st; fillIdentity(st);
    st.set("OTA_CHECK_S", "120"); st.set("OTA_FW_MAX_B", "3000000"); st.set("OTA_ENABLED", "0");
    st.set("RF_PORT", "9000"); st.set("RF_ENABLED", "0"); st.set("RF_RETRY_MAX_S", "600");
    st.set("SYNC_CHECK_S", "45"); st.set("SYNC_FIRST_S", "5");
    RecorderSettings cfg; std::string err;
    TEST_ASSERT(loadRecorderSettings(st, cfg, err), ("loads: " + err).c_str());
    TEST_ASSERT(!cfg.otaEnabled && cfg.otaCheckSec == 120 && cfg.otaFwMaxBytes == 3000000, "OTA values");
    TEST_ASSERT(!cfg.relayFindEnabled && cfg.relayFindPort == 9000 && cfg.relayFindRetryMaxSec == 600, "relay search values");
    TEST_ASSERT(cfg.syncCheckSec == 45 && cfg.syncFirstSec == 5, "sync values");
    TEST_ASSERT(cfg.otaRetrySec == 300 && cfg.relayFindOkSec == 60, "the ones not stored keep their default");
}

TEST(the_boot_waits_and_the_setup_tuning_are_readable_before_the_full_settings_load) {
    // What the sketch's setupSettings() does: a DefaultingStore over the raw flash, on a board that is blank or incomplete.
    MemoryStore flash;
    DefaultingStore defaults(flash, RECORDER_SCHEMA.meta, RECORDER_SCHEMA.metaCount);
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_SER_WIN_MS"), 5000LL, "serial window default");
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_WIFI_MS"), 20000LL, "Wi-Fi wait default");
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_RELAY_MS"), 30000LL, "relay wait default");
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_POLL_MS"), 5000LL, "poll default");
    flash.set("BOOT_SER_WIN_MS", "8000");
    flash.set("SETUP_AP_CHAN", "11");
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_SER_WIN_MS"), 8000LL, "a stored serial window is used");
    TEST_ASSERT_EQ(storedInt(defaults, "SETUP_AP_CHAN"), 11LL, "a stored channel is used");
    TEST_ASSERT_EQ(storedInt(defaults, "BOOT_WIFI_MS"), 20000LL, "the others stay default");
}

TEST(values_outside_their_range_are_refused_and_the_edges_are_accepted) {
    const char* bad[][2] = {
        {"OTA_CHECK_S", "4"}, {"OTA_CHECK_S", "86401"}, {"OTA_VER_MAX_B", "63"}, {"OTA_FW_MIN_B", "1048577"},
        {"OTA_FW_MAX_B", "65535"}, {"OTA_FW_MAX_B", "4194305"}, {"OTA_VER_IDLE_MS", "99"}, {"OTA_DL_IDLE_MS", "120001"},
        {"RF_PORT", "0"}, {"RF_PORT", "65536"}, {"RF_FIRST_S", "0"}, {"RF_RETRY_MIN_S", "3601"},
        {"SYNC_FIRST_S", "0"}, {"SYNC_CHECK_S", "86401"},
        {"SETUP_AP_CHAN", "0"}, {"SETUP_AP_CHAN", "14"}, {"SETUP_MAX_STA", "0"}, {"SETUP_MAX_STA", "9"},
        {"SETUP_RQ_TMO_MS", "999"}, {"SETUP_RETRY_MS", "99"}, {"SETUP_GRACE_MS", "60001"},
        {"BOOT_SER_WIN_MS", "60001"}, {"BOOT_WIFI_MS", "999"}, {"BOOT_RELAY_MS", "300001"}, {"BOOT_POLL_MS", "499"},
        {"OTA_ENABLED", "2"}, {"RF_ENABLED", "maybe"},
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        const CheckedLine c = checkLine(RECORDER_SCHEMA, std::string(bad[i][0]) + "=" + bad[i][1]);
        TEST_ASSERT(!c.ok(), (std::string(bad[i][0]) + "=" + bad[i][1] + " is refused").c_str());
    }
    const char* good[][2] = { {"OTA_CHECK_S", "5"}, {"RF_PORT", "65535"}, {"SETUP_AP_CHAN", "13"}, {"SETUP_MAX_STA", "8"},
                              {"BOOT_SER_WIN_MS", "0"}, {"SYNC_CHECK_S", "86400"}, {"OTA_FW_MIN_B", "0"} };
    for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); ++i) {
        const CheckedLine c = checkLine(RECORDER_SCHEMA, std::string(good[i][0]) + "=" + good[i][1]);
        TEST_ASSERT(c.ok(), (std::string(good[i][0]) + "=" + good[i][1] + " is accepted").c_str());
    }
}

// The OTA switches and size bounds go through the same rules as the detector's: checkCrossRules is what the serial path,
// the setup form and the dashboard path all use.
static std::vector<std::string> crossErrors(const std::vector<Pair>& diff) {
    MemoryStore flash; fillIdentity(flash);
    DefaultingStore board(flash, RECORDER_META, RECORDER_META_COUNT);   // defaults: firmware 100 KB .. 2 MB, retry 15 .. 300 s
    std::vector<std::string> errors;
    checkCrossRules(RECORDER_SCHEMA, board, diff, errors);
    return errors;
}
static Pair pair(const char* k, const char* v) { Pair p; p.key = k; p.value = v; return p; }

TEST(the_two_lowest_to_highest_rules_refuse_a_bad_pair_and_accept_a_good_one) {
    std::vector<Pair> d1(1, pair("OTA_FW_MIN_B", "3000000"));
    std::vector<std::string> e1 = crossErrors(d1);
    TEST_ASSERT(!e1.empty() && e1[0].find("OTA_FW_MIN_B") != std::string::npos && e1[0].find("OTA_FW_MAX_B") != std::string::npos,
                "a firmware minimum above the (default) maximum is refused, naming both");
    std::vector<Pair> d2(1, pair("OTA_FW_MAX_B", "65536"));
    TEST_ASSERT(!crossErrors(d2).empty(), "a maximum below the (default) minimum is refused");
    std::vector<Pair> d3;
    d3.push_back(pair("OTA_FW_MIN_B", "300000")); d3.push_back(pair("OTA_FW_MAX_B", "400000"));
    TEST_ASSERT(crossErrors(d3).empty(), "both together, in a valid order, is fine");
    std::vector<Pair> d4;
    d4.push_back(pair("OTA_FW_MIN_B", "200000")); d4.push_back(pair("OTA_FW_MAX_B", "200000"));
    TEST_ASSERT(crossErrors(d4).empty(), "a minimum equal to the maximum is allowed");
    std::vector<Pair> d5(1, pair("RF_RETRY_MIN_S", "400"));
    std::vector<std::string> e5 = crossErrors(d5);
    TEST_ASSERT(!e5.empty() && e5[0].find("RF_RETRY_MAX_S") != std::string::npos, "a shortest wait above the (default) longest is refused");

    MemoryStore flash; fillIdentity(flash);   // through the dashboard path too (RF_* are not locked)
    DefaultingStore board(flash, RECORDER_META, RECORDER_META_COUNT);
    ChangeResult r = applyChangeLine(RECORDER_SCHEMA, board, "RF_RETRY_MAX_S=10", recorderLockedKeys());
    TEST_ASSERT(!r.ok() && !flash.m.count("RF_RETRY_MAX_S"), "a longest wait below the (default) shortest is refused, nothing stored");
    ChangeResult both = applyChangeLine(RECORDER_SCHEMA, board, "RF_RETRY_MIN_S=5;RF_RETRY_MAX_S=10", recorderLockedKeys());
    TEST_ASSERT(both.ok() && flash.m["RF_RETRY_MAX_S"] == "10", "both together, in a valid order, is stored");
}

TEST(the_update_and_sync_switches_are_serial_only_but_the_rest_can_be_tuned_from_the_dashboard) {
    const std::vector<std::string> keys = recorderLockedKeys();
    bool ota = false, sync = false, rf = false;
    for (size_t k = 0; k < keys.size(); ++k) { ota |= keys[k] == "OTA_ENABLED"; sync |= keys[k] == "SYNC_ENABLED"; rf |= keys[k] == "RF_ENABLED"; }
    TEST_ASSERT(ota && sync, "OTA_ENABLED and SYNC_ENABLED are locked (the detector locks the same two)");
    TEST_ASSERT(!rf, "RF_ENABLED is not: a resilience switch the dashboard may turn off and back on (as on the detector)");

    MemoryStore flash; fillIdentity(flash);
    DefaultingStore board(flash, RECORDER_META, RECORDER_META_COUNT);
    ChangeResult off = applyChangeLine(RECORDER_SCHEMA, board, "SYNC_ENABLED=0", recorderLockedKeys());
    TEST_ASSERT(!off.ok() && !flash.m.count("SYNC_ENABLED"), "the dashboard cannot switch the sync off: it would lock itself out");
    ChangeResult update = applyChangeLine(RECORDER_SCHEMA, board, "OTA_ENABLED=0", recorderLockedKeys());
    TEST_ASSERT(!update.ok() && !flash.m.count("OTA_ENABLED"), "nor switch the updates off");
    ChangeResult tune = applyChangeLine(RECORDER_SCHEMA, board, "OTA_CHECK_S=120;SYNC_CHECK_S=45;RF_ENABLED=0;BOOT_SER_WIN_MS=8000", recorderLockedKeys());
    TEST_ASSERT(tune.ok() && flash.m["OTA_CHECK_S"] == "120" && flash.m["RF_ENABLED"] == "0" && flash.m["BOOT_SER_WIN_MS"] == "8000", "but the timings are for the dashboard to tune");
}

int main() {
    RUN_TEST(every_new_setting_has_the_old_value_as_its_default_a_label_a_group_and_needs_a_restart);
    RUN_TEST(the_shared_headers_own_defaults_agree_with_the_schema);
    RUN_TEST(a_blank_board_is_not_asked_for_any_of_them_and_an_updated_board_loads_the_old_values);
    RUN_TEST(a_stored_value_is_used);
    RUN_TEST(the_boot_waits_and_the_setup_tuning_are_readable_before_the_full_settings_load);
    RUN_TEST(values_outside_their_range_are_refused_and_the_edges_are_accepted);
    RUN_TEST(the_two_lowest_to_highest_rules_refuse_a_bad_pair_and_accept_a_good_one);
    RUN_TEST(the_update_and_sync_switches_are_serial_only_but_the_rest_can_be_tuned_from_the_dashboard);
    return test::summarize();
}
