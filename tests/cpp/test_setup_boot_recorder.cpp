// test_setup_boot_recorder.cpp — the setup boot (setup_boot.h) against the RECORDER's real key table.
// The cases live in setup_boot_cases.h (shared with test_setup_boot_person.cpp).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_boot_recorder test_setup_boot_recorder.cpp

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_boot.h"
#include "settings_fakes.h"   // after the settings engine: its fakes derive from it

// What differs between the sketches: a complete configuration, the relay prerequisites, the relay's word
// for the board, and a setting that can be missing without the board losing the relay.
struct BootFixture {
    static const esp32cam_settings::Schema& schema() { return esp32cam_settings::RECORDER_SCHEMA; }
    static std::string typical() {
        return "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
               "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63;SIZE_DROP=1;"
               "ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
               "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
               "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";
    }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::recorderRemotePrerequisites(); }
    static const char* type() { return "recorder"; }
    static std::string changeKey() { return "PUSH_GAP_MUL"; }
};

#include "setup_boot_cases.h"

int main() {
    runSetupBootCases();
    return test::summarize();
}
