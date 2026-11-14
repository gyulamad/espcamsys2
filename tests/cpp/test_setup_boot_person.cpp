// test_setup_boot_person.cpp — the setup boot (setup_boot.h) against the DETECTOR's real key table.
// The cases live in setup_boot_cases.h (shared with test_setup_boot_recorder.cpp); the two at the end
// are about what is special to the detector.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_boot_person test_setup_boot_person.cpp

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/setup_boot.h"
#include "settings_fakes.h"   // after the settings engine: its fakes derive from it

static const char* const DETECTION =
    "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;"
    "MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0";
static const char* const LIVE_VIEW =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=s3cret;DETECTOR_ID=detector-1;"
    "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";

struct BootFixture {
    static const esp32cam_settings::Schema& schema() { return esp32cam_settings::PERSON_SCHEMA; }
    static std::string typical() { return std::string(DETECTION) + ";" + LIVE_VIEW; }
    static std::vector<std::string> prerequisites() { return esp32cam_settings::personRemotePrerequisites(); }
    static const char* type() { return "detector"; }
    static std::string changeKey() { return "LOOP_DELAY_MS"; }
};

#include "setup_boot_cases.h"

// The detector's live view is not optional, so a detector with only its detection settings (what used to
// run with the old STREAM_ENABLED=0) is NOT a configured board: it cannot reach the relay.
TEST(a_detector_that_has_only_its_detection_settings_is_in_setup) {
    setupWorld().reset();
    MemoryStore st;
    load(st, DETECTION);
    st.set("STREAM_ENABLED", "0");   // left behind by the old firmware, ignored
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(boot.active() && !boot.armed(), "it has no way to reach the relay: in setup (and the serial prompt asks for the rest)");
}

TEST(a_complete_detector_is_never_in_setup_by_itself) {
    setupWorld().reset();
    MemoryStore st;
    load(st, BootFixture::typical());
    st.set("STREAM_ENABLED", "1");   // an old board that still has it in flash
    FakeSetupHardware hw;
    SetupBoot boot(BootFixture::schema(), st, BootFixture::prerequisites(), BootFixture::type(), hw);
    TEST_ASSERT(!boot.active(), "a working detector keeps working");
    TEST_ASSERT_EQ(setupWorld().touched(), 0, "and the hardware is not touched");
}

int main() {
    runSetupBootCases();
    RUN_TEST(a_detector_that_has_only_its_detection_settings_is_in_setup);
    RUN_TEST(a_complete_detector_is_never_in_setup_by_itself);
    return test::summarize();
}
