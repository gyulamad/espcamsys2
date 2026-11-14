// test_setup_glue_recorder.cpp — the RECORDER's "Settings glue" block with the setup mode (F-21). The
// cases live in setup_glue_cases.h (shared with test_setup_glue_person.cpp).
//
// Build & run (run_tests.sh extracts the block first and adds -I for the sketch's folder):
//   sed -n '/Settings glue ──/,/end of settings glue/p' ../../Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino > build/settings_glue.inc
//   g++ -std=c++17 -Wall -Wextra -I ../../Arduino/ESP32_CAM_Recorder -o build/test_setup_glue_recorder test_setup_glue_recorder.cpp

#include "framework.h"

#include "settings_glue_fakes.h"

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
using esp32cam_settings::RecorderSettings;
static RecorderSettings g_cfg;

#include "relay_settings_link_fake.h"

#include "build/settings_glue.inc"

static void powerUp() {
    g_now = 0; g_incoming.clear(); g_rx.clear(); g_serialOut.clear();
    g_restarts = 0; g_flushes = 0; g_cfg = RecorderSettings();
    g_flashBeginOk = true; g_flashWriteOk = true;
    resetLink();
}

struct GlueFixture {
    static const esp32cam_settings::Schema& schema() { return esp32cam_settings::RECORDER_SCHEMA; }
    static std::string typical() {
        return "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
               "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63;SIZE_DROP=1;"
               "ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
               "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
               "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";
    }
    static std::string type() { return "recorder"; }
    static std::string idKey() { return "CAMERA_ID"; }
    static std::string idValue() { return "cam2"; }
};

#include "setup_glue_cases.h"

int main() {
    runSetupGlueCases();
    return test::summarize();
}
