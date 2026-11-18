// test_setup_password_recorder.cpp — T4 (F-29): the setup WiFi's master password against the RECORDER's real
// key table, WITH a private build-time default (the git-ignored setup_credentials.local.h, here the template
// that people copy). The cases live in setup_password_cases.h (shared with test_setup_password_person.cpp,
// which runs with the built-in default).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_password_recorder test_setup_password_recorder.cpp

#include "../../Arduino/templates/setup_credentials.example.h"   // before setup_logic.h, as the sketches do
#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_form.h"

using namespace esp32cam_settings;

struct PasswordFixture {
    static const Schema& schema() { return esp32cam_settings::RECORDER_SCHEMA; }
    static std::string typical() {
        return "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
               "CAMERA_ID=cam2;API_KEY=s3cret;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
               "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
               "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";
    }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::recorderRemotePrerequisites(); }
    static std::vector<std::string> locked() { return esp32cam_settings::recorderLockedKeys(); }
};

#include "setup_password_cases.h"

static_assert(sizeof(SETUP_DEFAULT_PASSWORD) != sizeof(SETUP_PUBLIC_PASSWORD) ||
              std::string(SETUP_DEFAULT_PASSWORD) != std::string(SETUP_PUBLIC_PASSWORD),
              "this program must run with the build-time override, not the public default");

int main() {
    runSetupPasswordCases();
    return test::summarize();
}
