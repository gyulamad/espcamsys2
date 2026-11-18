// test_setup_password_person.cpp — T4 (F-29): the setup WiFi's master password against the PERSON DETECTOR's
// real key table, with the built-in default (no override). The cases live in setup_password_cases.h (shared
// with test_setup_password_recorder.cpp, which runs with a private build-time default).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_password_person test_setup_password_person.cpp

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/setup_form.h"

using namespace esp32cam_settings;

struct PasswordFixture {
    static const Schema& schema() { return esp32cam_settings::PERSON_SCHEMA; }
    static std::string typical() {
        return "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;"
               "MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0;"
               "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
               "API_KEY=s3cret;DETECTOR_ID=detector-1;"
               "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";
    }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::personRemotePrerequisites(); }
    static std::vector<std::string> locked() { return esp32cam_settings::personLockedKeys(); }
};

#include "setup_password_cases.h"

static_assert(sizeof(SETUP_DEFAULT_PASSWORD) == sizeof(SETUP_PUBLIC_PASSWORD), "this program runs with the built-in default");

int main() {
    runSetupPasswordCases();
    return test::summarize();
}
