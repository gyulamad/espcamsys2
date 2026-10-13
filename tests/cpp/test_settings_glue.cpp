// test_settings_glue.cpp — runs the sketch's ACTUAL settings glue (the block
// between "Settings glue" and "end of settings glue" in
// ESP32_CAM_Recorder.ino) on a desktop, against fakes of the things it touches:
// the flash (Preferences), the serial port, the clock and ESP.restart().
//
// What this proves that test_settings_logic.cpp can't: that the glue wires the
// engine to those four things correctly — keys really go to flash and survive
// a "reboot", the 5 s window is measured with millis() while delay() passes
// time, a restart is requested exactly when settings changed, and the loaded
// settings land in g_cfg.
//
// run_tests.sh extracts the block just before compiling, so this always tests
// the code that is in the sketch. By hand:
//   sed -n '/Settings glue ──/,/end of settings glue/p' ../../Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino > build/settings_glue.inc
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_glue test_settings_glue.cpp

#include "framework.h"

#include "settings_glue_fakes.h"

// ── the sketch's own pieces the block depends on ────────────────────────

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
using esp32cam_settings::RecorderSettings;
static RecorderSettings g_cfg;

// The glue's RelaySettingsLink is the real Wi-Fi + HTTP; here it is the scripted fake.
#include "relay_settings_link_fake.h"

// ── the code under test, extracted verbatim from the sketch ─────────────
#include "build/settings_glue.inc"

// ── helpers ─────────────────────────────────────────────────────────────

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

// A fresh power-up: clock at 0, serial quiet. Flash is left alone (it persists).
static void powerUp() {
    g_now = 0; g_incoming.clear(); g_rx.clear(); g_serialOut.clear();
    g_restarts = 0; g_flushes = 0; g_cfg = RecorderSettings();
    g_flashBeginOk = true; g_flashWriteOk = true;
    resetLink();
}
// ── tests ───────────────────────────────────────────────────────────────

TEST(the_first_boot_of_a_blank_board_stores_what_is_typed_in_flash_and_restarts) {
    eraseFlash(); powerUp();
    typeAt(300, std::string(TYPICAL) + "\n");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted once, after the settings were stored");
    TEST_ASSERT(g_flushes >= 1 && g_now >= 500, "the serial port was flushed and given time before the restart");
    TEST_ASSERT(g_flash["CAMERA_ID"] == "cam2" && g_flash["PUSH_PORT"] == "8081", "values are in (fake) flash");
    TEST_ASSERT_EQ((int)g_flash.size(), (int)esp32cam_settings::RECORDER_SCHEMA.count, "all of them");
    TEST_ASSERT(said("These settings need a value") && said("All settings are stored. Restarting"), "the conversation happened on serial");
    TEST_ASSERT_EQ(g_prefsOpen, 0, "the flash was closed again");
    TEST_ASSERT(g_prefsNamespace == "espcam" && !g_prefsReadOnly, "the espcam namespace, opened read-write");
}

TEST(after_the_reboot_it_waits_five_seconds_then_loads_the_settings_and_carries_on) {
    powerUp();                     // same flash as before: the settings survived
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 0, "no restart");
    TEST_ASSERT(said("Change settings? [y/N]"), "it asked");
    TEST_ASSERT(g_now >= 5000 && g_now <= 5100, "and waited for about 5 seconds of clock time");
    TEST_ASSERT(g_cfg.cameraId == "cam2" && g_cfg.serverHost == "192.168.4.9" && g_cfg.pushPort == 8081, "g_cfg is loaded");
    TEST_ASSERT(g_cfg.wifi.size() == 1 && g_cfg.wifi[0].ssid == "extender-1" && g_cfg.alarmGpioPin == 13 && g_cfg.logEnabled, "all of it");
    TEST_ASSERT(said("CAMERA_ID=cam2") && !said("s3cret") && !said("password1"), "settings shown, secrets masked");
}

TEST(typing_y_within_the_window_lets_the_user_change_a_setting_and_restarts) {
    powerUp();
    typeAt(1000, "y\n");
    typeAt(2000, "CAMERA_ID=cam7\n");
    typeAt(2500, "\n");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted because something changed");
    TEST_ASSERT(g_flash["CAMERA_ID"] == "cam7", "the new value is in flash");
    TEST_ASSERT(g_now < 5000, "settings mode has no 5 s limit: it ended when the user finished, not on a timer");
    TEST_ASSERT(g_cfg.cameraId.empty(), "g_cfg is not loaded on this path: the board restarts and loads on the next boot");
}

TEST(typing_y_and_then_nothing_changed_just_carries_on) {
    powerUp();
    typeAt(500, "y\n");
    typeAt(900, "\n");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 0, "no restart without a change");
    TEST_ASSERT(g_cfg.cameraId == "cam7", "settings loaded (the value changed in the previous test)");
}

TEST(settings_mode_can_take_as_long_as_the_user_needs) {
    powerUp();
    typeAt(1000, "y\n");
    typeAt(120000, "PUSH_PORT=9100\n");   // two minutes later
    typeAt(121000, "exit\n");
    setupSettings();
    TEST_ASSERT(g_restarts == 1 && g_flash["PUSH_PORT"] == "9100", "still worked");
}

TEST(a_new_setting_missing_from_flash_is_asked_for_even_though_the_rest_is_there) {
    powerUp();
    g_flash.erase("LOG_LOW_HEAP");   // as after upgrading to firmware with one more key
    typeAt(500, "LOG_LOW_HEAP=20000\n");
    setupSettings();
    TEST_ASSERT(said("These settings need a value (1)") && said("LOG_LOW_HEAP"), "only that one is asked for");
    TEST_ASSERT(g_restarts == 1 && g_flash["LOG_LOW_HEAP"] == "20000", "stored, restarted");
}

TEST(a_flash_that_cannot_be_opened_is_reported) {
    // (The fake still serves the stored values, so the boot goes on after the
    // window: only the warning is under test.)
    powerUp();
    g_flashBeginOk = false;
    setupSettings();
    TEST_ASSERT(said("could not be opened"), "the warning is printed");
}

TEST(a_flash_write_that_fails_is_reported_and_does_not_restart) {
    powerUp();
    g_flashWriteOk = false;
    typeAt(500, "y\n");
    typeAt(1000, "CAMERA_ID=cam9\n");
    typeAt(1500, "\n");
    setupSettings();
    TEST_ASSERT(said("ERROR: could not write CAMERA_ID to flash"), "reported");
    TEST_ASSERT_EQ(g_restarts, 0, "nothing was changed, so no restart");
    TEST_ASSERT(g_flash["CAMERA_ID"] == "cam7", "flash untouched");
}

TEST(erasing_clears_the_flash_namespace) {
    powerUp();
    typeAt(500, "y\n");
    typeAt(1000, "erase\n");
    typeAt(1500, "ERASE\n");
    typeAt(2000, std::string(TYPICAL) + "\n");
    setupSettings();
    TEST_ASSERT(said("All settings erased"), "erased");
    TEST_ASSERT(g_restarts == 1 && g_flash["CAMERA_ID"] == "cam2", "everything re-entered, then restart");
}

TEST(the_serial_console_reports_no_input_without_blocking) {
    powerUp();
    SerialConsole c;
    TEST_ASSERT_EQ(c.read(), -1, "nothing waiting: -1 at once");
    typeAt(0, "ab");
    TEST_ASSERT(c.read() == 'a' && c.read() == 'b' && c.read() == -1, "bytes come out in order");
    c.println("hello");
    TEST_ASSERT(!g_serialOut.empty() && g_serialOut.back() == "hello", "lines go to the serial port");
}

// ── missing settings asked for from the relay ───────────────────────────

// A complete board, as flash would hold it after the first provisioning.
static void provisionFlash() {
    eraseFlash();
    esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(esp32cam_settings::RECORDER_SCHEMA, TYPICAL);
    for (size_t i = 0; i < c.pairs.size(); ++i) g_flash[c.pairs[i].key] = c.pairs[i].value;
}

TEST(a_board_missing_a_setting_asks_the_relay_when_nobody_types) {
    provisionFlash(); powerUp();
    g_flash.erase("LOG_LOW_HEAP");                       // a firmware update added this one
    g_link.reply(esp32cam_settings::FetchResult::Got, "LOG_LOW_HEAP=20000");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted so the new setting takes effect");
    TEST_ASSERT_EQ(g_flash["LOG_LOW_HEAP"], std::string("20000"), "the value from the relay is in flash");
    TEST_ASSERT(g_link.fetches == 1 && g_link.needSeen[0] == "LOG_LOW_HEAP", "it told the relay what it was missing");
    TEST_ASSERT(g_linkType == "recorder" && g_linkIdKey == "CAMERA_ID", "as a recorder, identified by CAMERA_ID");
    TEST_ASSERT(g_now >= 5000, "the serial port had its five seconds first");
    TEST_ASSERT(said("Asking the relay") && said("Stored 1 setting(s)"), "and the serial log says what happened");
    TEST_ASSERT_EQ(g_prefsOpen, 0, "the flash was closed again");
}

TEST(a_relay_with_nothing_staged_makes_the_board_restart_and_try_again) {
    provisionFlash(); powerUp();
    g_flash.erase("LOG_LOW_HEAP");
    setupSettings();
    TEST_ASSERT_EQ(g_restarts, 1, "restarted to try again");
    TEST_ASSERT(g_flash.count("LOG_LOW_HEAP") == 0, "nothing was stored");
    TEST_ASSERT(g_now >= 35000 && g_now <= 36000, "after 5 s of serial and 30 s of waiting");
    TEST_ASSERT(said("no settings staged"), "it said what it was waiting for");
}

TEST(typing_a_value_on_serial_means_the_relay_is_not_asked) {
    provisionFlash(); powerUp();
    g_flash.erase("LOG_LOW_HEAP");
    typeAt(1000, "LOG_LOW_HEAP=25000\n");
    setupSettings();
    TEST_ASSERT_EQ(g_flash["LOG_LOW_HEAP"], std::string("25000"), "the typed value is stored");
    TEST_ASSERT(g_link.connects == 0 && g_link.fetches == 0, "Wi-Fi was never started");
}

TEST(a_blank_board_never_tries_wifi_it_has_no_wifi_settings_to_try) {
    eraseFlash(); powerUp();
    typeAt(60000, std::string(TYPICAL) + "\n");           // a person arrives a minute later
    setupSettings();
    TEST_ASSERT_EQ(g_link.connects, 0, "no Wi-Fi");
    TEST_ASSERT(said("Type the missing settings here"), "it told the person it can only be done here");
    TEST_ASSERT_EQ(g_restarts, 1, "and restarted once, after they typed the settings in");
}

TEST(a_board_that_is_complete_never_touches_the_relay) {
    provisionFlash(); powerUp();
    setupSettings();
    TEST_ASSERT(g_link.connects == 0 && g_link.fetches == 0 && g_restarts == 0, "just the window, then it carries on");
    TEST_ASSERT(g_cfg.cameraId == "cam2", "settings loaded");
}

int main() {
    RUN_TEST(the_first_boot_of_a_blank_board_stores_what_is_typed_in_flash_and_restarts);
    RUN_TEST(after_the_reboot_it_waits_five_seconds_then_loads_the_settings_and_carries_on);
    RUN_TEST(typing_y_within_the_window_lets_the_user_change_a_setting_and_restarts);
    RUN_TEST(typing_y_and_then_nothing_changed_just_carries_on);
    RUN_TEST(settings_mode_can_take_as_long_as_the_user_needs);
    RUN_TEST(a_new_setting_missing_from_flash_is_asked_for_even_though_the_rest_is_there);
    RUN_TEST(a_flash_that_cannot_be_opened_is_reported);
    RUN_TEST(a_flash_write_that_fails_is_reported_and_does_not_restart);
    RUN_TEST(erasing_clears_the_flash_namespace);
    RUN_TEST(the_serial_console_reports_no_input_without_blocking);
    RUN_TEST(a_board_missing_a_setting_asks_the_relay_when_nobody_types);
    RUN_TEST(a_relay_with_nothing_staged_makes_the_board_restart_and_try_again);
    RUN_TEST(typing_a_value_on_serial_means_the_relay_is_not_asked);
    RUN_TEST(a_blank_board_never_tries_wifi_it_has_no_wifi_settings_to_try);
    RUN_TEST(a_board_that_is_complete_never_touches_the_relay);
    return test::summarize();
}
