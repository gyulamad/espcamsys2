// test_setup_glue_person.cpp — the DETECTOR's "Settings glue" block with the setup mode (F-21). The cases
// live in setup_glue_cases.h (shared with test_setup_glue_recorder.cpp); the last one is about what is
// special to the detector.
//
// Build & run (run_tests.sh extracts the block first and adds -I for the sketch's folder):
//   sed -n '/Settings glue ──/,/end of settings glue/p' ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/person_settings_glue.inc
//   g++ -std=c++17 -Wall -Wextra -I ../../Arduino/ESP32_CAM_TFLite_Person -o build/test_setup_glue_person test_setup_glue_person.cpp

#include "framework.h"

#include "settings_glue_fakes.h"

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
using esp32cam_settings::PersonSettings;
static PersonSettings g_cfg;

#include "relay_settings_link_fake.h"

#include "build/person_settings_glue.inc"

static void powerUp() {
    g_now = 0; g_incoming.clear(); g_rx.clear(); g_serialOut.clear();
    g_restarts = 0; g_flushes = 0; g_cfg = PersonSettings();
    g_flashBeginOk = true; g_flashWriteOk = true;
    g_serialBaud = 0; g_serialRxBuffer = 0;
    resetLink();
}

static const char* const DETECTION = "PERSON_GPIO=4;DETECT_THRESH=0.7;CLEAR_THRESH=0.4;LOOP_DELAY_MS=20;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0";
static const char* const LIVE_VIEW = "WIFI=home:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=s3cret;DETECTOR_ID=det-1;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";

struct GlueFixture {
    static const esp32cam_settings::Schema& schema() { return esp32cam_settings::PERSON_SCHEMA; }
    static std::string typical() { return std::string(DETECTION) + ";" + LIVE_VIEW; }
    static std::string type() { return "detector"; }
    static std::string idKey() { return "DETECTOR_ID"; }
    static std::string idValue() { return "det-1"; }
};

#include "setup_glue_cases.h"

// A detector that used to run without the live view has only its detection settings. It cannot reach the
// relay, so it opens its setup WiFi, and the serial prompt asks for the rest.
TEST(a_detector_that_predates_the_always_on_live_view_opens_the_setup_wifi) {
    provision(DETECTION);
    g_flash["STREAM_ENABLED"] = "0";
    powerUp(); setupWorld().reset();
    typeAt(300, std::string(LIVE_VIEW) + "\n");
    setupSettings();
    TEST_ASSERT(said("These settings need a value (5)"), "the serial prompt asks for the 5 live-view identity settings (the tuning has defaults)");
    TEST_ASSERT_EQ(setupWorld().starts, 1, "and the setup WiFi was open meanwhile");
    TEST_ASSERT_EQ(g_restarts, 1, "restarted once everything was typed");
    TEST_ASSERT(setupWorld().stops >= 1, "with the setup WiFi down");
}

// The serial port's own settings (F-29 T5c): earlySerialSetup() reads SER_BAUD / SER_RXBUF_B from
// flash before the settings engine runs, so the boot conversation can use the port. On a blank board
// (the one this suite cares about) the defaults are applied.
TEST(the_serial_setup_of_a_blank_board_uses_the_defaults) {
    eraseFlash(); powerUp();
    earlySerialSetup();
    TEST_ASSERT_EQ(g_serialBaud, 115200UL, "SER_BAUD's default");
    TEST_ASSERT_EQ(g_serialRxBuffer, (size_t)2048, "SER_RXBUF_B's default");
}

// F-29 (T5b): the SETUP_* and BOOT_* settings the boot reads reach the boot. A complete board is never
// in setup, so only the serial window shows — with the stored 60 s, not the 5 s default.
TEST(the_detector_setup_and_boot_settings_reach_the_serial_window) {
    provision(std::string(DETECTION) + ";" + LIVE_VIEW +
              ";SETUP_AP_CHAN=6;SETUP_MAX_STA=2;SETUP_RQ_TMO_MS=9999;BOOT_SER_WIN_MS=60000");
    powerUp(); setupWorld().reset();
    setupSettings();
    TEST_ASSERT(said("Type y and Enter within 60 s"), "the serial window is the stored one (BOOT_SER_WIN_MS)");
    TEST_ASSERT_EQ(setupWorld().opens, 0, "a complete board never opens its setup WiFi");
    TEST_ASSERT_EQ(g_restarts, 0, "and it just starts");
    TEST_ASSERT(g_cfg.otaCheckSec == 60 && g_cfg.relayDownMs == 90000, "the T5b defaults loaded with it");
}

// ...and a board that IS in setup hands the stored SETUP_* values to the access point it opens.
TEST(the_detector_setup_settings_reach_the_access_point) {
    provision(std::string(DETECTION) + ";SETUP_AP_CHAN=6;SETUP_MAX_STA=2;SETUP_RQ_TMO_MS=9999");
    powerUp(); setupWorld().reset();
    typeAt(300, std::string(LIVE_VIEW) + "\n");
    setupSettings();
    TEST_ASSERT_EQ(setupWorld().opens, 1, "the setup WiFi opened (the board was missing its live view)");
    TEST_ASSERT_EQ(setupWorld().net.apChannel, 6, "on the stored channel");
    TEST_ASSERT_EQ(setupWorld().net.apMaxStations, 2, "with the stored station count");
    TEST_ASSERT_EQ(setupWorld().net.requestTimeoutMs, (uint32_t)9999, "and the stored request timeout");
    TEST_ASSERT_EQ(g_restarts, 1, "restarted once everything was typed");

}

int main() {
    runSetupGlueCases();
    RUN_TEST(a_detector_that_predates_the_always_on_live_view_opens_the_setup_wifi);
    RUN_TEST(the_serial_setup_of_a_blank_board_uses_the_defaults);
    RUN_TEST(the_detector_setup_and_boot_settings_reach_the_serial_window);
    RUN_TEST(the_detector_setup_settings_reach_the_access_point);

    return test::summarize();
}
