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
    TEST_ASSERT(said("These settings need a value (10)"), "the serial prompt asks for the 10 live-view settings");
    TEST_ASSERT_EQ(setupWorld().starts, 1, "and the setup WiFi was open meanwhile");
    TEST_ASSERT_EQ(g_restarts, 1, "restarted once everything was typed");
    TEST_ASSERT(setupWorld().stops >= 1, "with the setup WiFi down");
}

int main() {
    runSetupGlueCases();
    RUN_TEST(a_detector_that_predates_the_always_on_live_view_opens_the_setup_wifi);
    return test::summarize();
}
