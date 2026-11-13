// test_setup_form_recorder.cpp — the on-device setup form (setup_form.h) against the RECORDER's
// real key table. The cases live in setup_form_cases.h (shared with test_setup_form_person.cpp).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_form_recorder test_setup_form_recorder.cpp

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_form.h"

using namespace esp32cam_settings;
using namespace esp32cam_setup;

// What differs between the sketches: a complete configuration and a few settings to poke at.
struct SetupFixture {
    static const Schema& schema() { return esp32cam_settings::RECORDER_SCHEMA; }
    static std::string typical() {
        return "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
               "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63;SIZE_DROP=1;"
               "ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
               "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
               "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";
    }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::recorderRemotePrerequisites(); }
    static std::vector<std::string> locked() { return esp32cam_settings::recorderLockedKeys(); }
    static std::string idKey() { return "CAMERA_ID"; }
    static std::string hostKey() { return "SERVER_HOST"; }
    static std::string hostValue() { return "192.168.4.9"; }
    static std::string wifiSsid() { return "extender-1"; }
    // a setting that is neither locked nor part of a cross rule, stored in typical()
    static std::string changeKey() { return "PUSH_GAP_MUL"; }
    static std::string changeOld() { return "1.5"; }
    static std::string changeNew() { return "2"; }
    // a value that breaks a cross-setting rule against typical(): JPEG_Q_MIN (12) must not exceed JPEG_Q_MAX
    static std::string ruleKey() { return "JPEG_Q_MAX"; }
    static std::string ruleBadValue() { return "5"; }
};

#include "setup_form_cases.h"

int main() {
    runSetupFormCases();
    return test::summarize();
}
