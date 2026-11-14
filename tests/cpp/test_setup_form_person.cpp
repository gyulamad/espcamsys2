// test_setup_form_person.cpp — the on-device setup form (setup_form.h) against the PERSON
// DETECTOR's real key table. The cases live in setup_form_cases.h (shared with
// test_setup_form_recorder.cpp).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_form_person test_setup_form_person.cpp

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/setup_form.h"

using namespace esp32cam_settings;
using namespace esp32cam_setup;

struct SetupFixture {
    static const Schema& schema() { return esp32cam_settings::PERSON_SCHEMA; }
    static std::string typical() {
        // every setting, including the ones that reach the relay
        return "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;"
               "MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0;"
               "WIFI=extender-1:password1:extender-2:pass\\;word2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
               "API_KEY=s3cret;DETECTOR_ID=detector-1;"
               "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";
    }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::personRemotePrerequisites(); }
    static std::vector<std::string> locked() { return esp32cam_settings::personLockedKeys(); }
    static std::string idKey() { return "DETECTOR_ID"; }
    static std::string hostKey() { return "SERVER_HOST"; }
    static std::string hostValue() { return "192.168.4.9"; }
    static std::string wifiSsid() { return "extender-1"; }
    static std::string changeKey() { return "LOOP_DELAY_MS"; }
    static std::string changeOld() { return "10"; }
    static std::string changeNew() { return "20"; }
    // CLEAR_THRESH (0.5) must not exceed DETECT_THRESH (0.6)
    static std::string ruleKey() { return "CLEAR_THRESH"; }
    static std::string ruleBadValue() { return "0.9"; }
};

#include "setup_form_cases.h"

int main() {
    runSetupFormCases();
    return test::summarize();
}
