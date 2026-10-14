// test_person_settings_glue.cpp — runs the person-detector sketch's ACTUAL
// settings glue (the block between "Settings glue" and "end of settings glue"
// in ESP32_CAM_TFLite_Person.ino) on a desktop, against fakes of the flash
// (Preferences), the serial port, the clock and ESP.restart() — see
// settings_glue_fakes.h. Same idea as test_settings_glue.cpp for the recorder.
//
// run_tests.sh extracts the block just before compiling, so this always tests
// the code that is in the sketch. By hand:
//   sed -n '/Settings glue ──/,/end of settings glue/p' ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/person_settings_glue.inc
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_settings_glue test_person_settings_glue.cpp

#include "framework.h"

#include "settings_glue_fakes.h"

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
using esp32cam_settings::PersonSettings;
static PersonSettings g_cfg;

// The glue's RelaySettingsLink is the real Wi-Fi + HTTP; here it is the scripted fake.
#include "relay_settings_link_fake.h"

// ── the code under test, extracted verbatim from the sketch ─────────────
#include "build/person_settings_glue.inc"

// A fresh power-up: clock at 0, serial quiet. Flash is left alone (it persists).
static void powerUp() {
    g_now = 0; g_incoming.clear(); g_rx.clear(); g_serialOut.clear();
    g_restarts = 0; g_flushes = 0; g_cfg = PersonSettings();
    g_flashBeginOk = true; g_flashWriteOk = true;
    resetLink();
}

static const char* NO_STREAM = "PERSON_GPIO=4;DETECT_THRESH=0.7;CLEAR_THRESH=0.4;LOOP_DELAY_MS=20;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;STREAM_ENABLED=0";

TEST(the_first_boot_stores_the_typed_settings_in_flash_and_restarts) {
    eraseFlash(); powerUp();
    typeAt(300, std::string(NO_STREAM) + "\n");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted once");
    TEST_ASSERT(g_flash["PERSON_GPIO"] == "4" && g_flash["DETECT_THRESH"] == "0.7" && g_flash["STREAM_ENABLED"] == "0", "values are in (fake) flash");
    TEST_ASSERT_EQ((int)g_flash.size(), 8, "just the eight (no live view, so no Wi-Fi settings are asked for)");
    TEST_ASSERT(said("These settings need a value") && said("All settings are stored. Restarting"), "the conversation happened on serial");
    TEST_ASSERT_EQ(g_prefsOpen, 0, "the flash was closed again");
    TEST_ASSERT(g_prefsNamespace == "espcam" && !g_prefsReadOnly, "the espcam namespace, opened read-write");
}

TEST(after_the_reboot_it_waits_five_seconds_then_loads_into_g_cfg) {
    powerUp();
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 0, "no restart");
    TEST_ASSERT(said("Change settings? [y/N]") && g_now >= 5000 && g_now <= 5100, "asked, waited about 5 s of clock time");
    TEST_ASSERT(g_cfg.personGpio == 4 && g_cfg.detectThreshold == 0.7f && g_cfg.clearThreshold == 0.4f && g_cfg.loopDelayMs == 20, "loaded");
    TEST_ASSERT(!g_cfg.streamEnabled && g_cfg.wifi.empty(), "live view off: nothing for the network task to use");
}

TEST(turning_the_live_view_on_later_asks_for_its_settings_and_restarts_when_complete) {
    powerUp();
    typeAt(500, "y\n");
    typeAt(1000, "STREAM_ENABLED=1\n");
    typeAt(1500,
        "WIFI=home:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=s3cret;DETECTOR_ID=det-1;STREAM_USER=viewer;"
        "STREAM_PASS=hunter22;STREAM_PORT=80;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30\n");
    typeAt(2000, "\n");
    setupSettings();
    TEST_ASSERT(said("These settings need a value (13)"), "after switching it on, the 13 live-view settings were asked for");
    TEST_ASSERT_EQ(g_restarts, 1, "restart once everything is stored");
    TEST_ASSERT(g_flash["STREAM_ENABLED"] == "1" && g_flash["STREAM_USER"] == "viewer", "stored");
}

TEST(with_the_live_view_on_g_cfg_gets_the_wifi_list_and_stream_settings) {
    powerUp();
    setupSettings();
    TEST_ASSERT(g_cfg.streamEnabled && g_cfg.wifi.size() == 1 && g_cfg.wifi[0].ssid == "home" && g_cfg.wifi[0].pass == "password1", "wifi");
    TEST_ASSERT(g_cfg.serverHost == "192.168.4.9" && g_cfg.httpPort == 8080 && g_cfg.apiKey == "s3cret" && g_cfg.detectorId == "det-1", "relay");
    TEST_ASSERT(g_cfg.streamUser == "viewer" && g_cfg.streamPass == "hunter22" && g_cfg.streamPort == 80, "stream");
    TEST_ASSERT(!said("hunter22") && !said("s3cret") && !said("password1"), "no secret was printed");
}

TEST(a_threshold_pair_that_breaks_the_rule_is_refused_end_to_end) {
    powerUp();
    typeAt(500, "y\n");
    typeAt(1000, "CLEAR_THRESH=0.9\n");
    typeAt(1500, "\n");
    setupSettings();
    TEST_ASSERT(said("ERROR: CLEAR_THRESH (0.9) must not be higher than DETECT_THRESH (0.7)"), "refused");
    TEST_ASSERT(g_flash["CLEAR_THRESH"] == "0.4" && g_restarts == 0, "flash untouched, no restart");
}

// ── missing settings asked for from the relay ───────────────────────────

static const char* WITH_STREAM =
    "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;STREAM_ENABLED=1;"
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
    "API_KEY=s3cret;DETECTOR_ID=detector-1;STREAM_USER=viewer;STREAM_PASS=hunter22;STREAM_PORT=8088;"
    "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";

static void provisionFlash(const char* line) {
    eraseFlash();
    esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(esp32cam_settings::PERSON_SCHEMA, line);
    for (size_t i = 0; i < c.pairs.size(); ++i) g_flash[c.pairs[i].key] = c.pairs[i].value;
}

TEST(a_detector_missing_a_setting_asks_the_relay_when_nobody_types) {
    provisionFlash(WITH_STREAM); powerUp();
    g_flash.erase("STREAM_MAX_FPS");                     // a firmware update added this one
    g_link.reply(esp32cam_settings::FetchResult::Got, "STREAM_MAX_FPS=8");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted so the new setting takes effect");
    TEST_ASSERT_EQ(g_flash["STREAM_MAX_FPS"], std::string("8"), "the value from the relay is in flash");
    TEST_ASSERT(g_link.fetches == 1 && g_link.needSeen[0] == "STREAM_MAX_FPS", "it told the relay what it was missing");
    TEST_ASSERT(g_linkType == "detector" && g_linkIdKey == "DETECTOR_ID", "as a detector, identified by DETECTOR_ID");
    TEST_ASSERT(g_now >= 5000, "the serial port had its five seconds first");
}

TEST(the_relay_can_not_change_the_detection_thresholds_of_a_working_detector) {
    provisionFlash(WITH_STREAM); powerUp();
    g_flash.erase("STREAM_MAX_FPS");
    g_link.reply(esp32cam_settings::FetchResult::Got, "DETECT_THRESH=0.1;API_KEY=evil;SERVER_HOST=10.6.6.6;STREAM_MAX_FPS=8");
    setupSettings();
    TEST_ASSERT_EQ(g_flash["STREAM_MAX_FPS"], std::string("8"), "the missing one was filled");
    TEST_ASSERT(g_flash["DETECT_THRESH"] == "0.6" && g_flash["API_KEY"] == "s3cret" && g_flash["SERVER_HOST"] == "192.168.4.9",
                "everything that was already valid is untouched");
}

TEST(a_detector_without_the_live_view_has_no_network_settings_so_it_never_tries_wifi) {
    provisionFlash(NO_STREAM); powerUp();
    g_flash.erase("LOOP_DELAY_MS");
    typeAt(60000, "LOOP_DELAY_MS=20\n");
    setupSettings();
    TEST_ASSERT_EQ(g_link.connects, 0, "no Wi-Fi");
    TEST_ASSERT(said("Type the missing settings here"), "it said the serial port is the only way");
    TEST_ASSERT_EQ(g_flash["LOOP_DELAY_MS"], std::string("20"), "the typed value was stored");
}

TEST(a_relay_with_nothing_staged_makes_the_detector_restart_and_try_again) {
    provisionFlash(WITH_STREAM); powerUp();
    g_flash.erase("STREAM_MAX_FPS");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted to try again");
    TEST_ASSERT(g_flash.count("STREAM_MAX_FPS") == 0, "nothing stored");
}

int main() {
    RUN_TEST(the_first_boot_stores_the_typed_settings_in_flash_and_restarts);
    RUN_TEST(after_the_reboot_it_waits_five_seconds_then_loads_into_g_cfg);
    RUN_TEST(turning_the_live_view_on_later_asks_for_its_settings_and_restarts_when_complete);
    RUN_TEST(with_the_live_view_on_g_cfg_gets_the_wifi_list_and_stream_settings);
    RUN_TEST(a_threshold_pair_that_breaks_the_rule_is_refused_end_to_end);
    RUN_TEST(a_detector_missing_a_setting_asks_the_relay_when_nobody_types);
    RUN_TEST(the_relay_can_not_change_the_detection_thresholds_of_a_working_detector);
    RUN_TEST(a_detector_without_the_live_view_has_no_network_settings_so_it_never_tries_wifi);
    RUN_TEST(a_relay_with_nothing_staged_makes_the_detector_restart_and_try_again);
    return test::summarize();
}
