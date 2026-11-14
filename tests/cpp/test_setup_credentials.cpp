// test_setup_credentials.cpp — the optional build-time default master password (F-21): the template
// that people copy, and what setup_logic.h does with the macro it defines.
//
// The template is included BEFORE setup_logic.h, exactly as the sketches do with the git-ignored
// setup_credentials.local.h. (A bad override is a compile error, not a test failure: see the
// static_asserts in setup_logic.h and the two build checks run_tests.sh makes.)
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_credentials test_setup_credentials.cpp

#include "../../Arduino/templates/setup_credentials.example.h"
#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_logic.h"
#include "settings_fakes.h"
#include "framework.h"

using namespace esp32cam_setup;

static const std::string OVERRIDE = SETUP_DEFAULT_PASSWORD_OVERRIDE;

TEST(the_template_is_a_valid_default_password_that_differs_from_the_public_one) {
    TEST_ASSERT(validSetupPassword(OVERRIDE), "the placeholder is a usable WPA2 passphrase (so copying it as it is works)");
    TEST_ASSERT(OVERRIDE != SETUP_PUBLIC_PASSWORD, "and it is not the public built-in password");
}

TEST(the_override_replaces_the_default_a_blank_board_opens_its_wifi_with) {
    MemoryStore st;
    TEST_ASSERT_EQ(std::string(SETUP_DEFAULT_PASSWORD), OVERRIDE, "the default is the override");
    TEST_ASSERT_EQ(setupPassword(esp32cam_settings::RECORDER_SCHEMA, st), OVERRIDE, "a blank board uses it");
    st.set("SETUP_PASSWORD", "short");
    TEST_ASSERT_EQ(setupPassword(esp32cam_settings::RECORDER_SCHEMA, st), OVERRIDE, "so does a board whose stored password is unusable");
}

TEST(a_stored_master_password_still_wins_over_the_override) {
    MemoryStore st;
    st.set("SETUP_PASSWORD", "My-Own-Master-1");
    TEST_ASSERT_EQ(setupPassword(esp32cam_settings::RECORDER_SCHEMA, st), std::string("My-Own-Master-1"), "the owner's choice");
}

TEST(both_the_override_and_the_public_password_count_as_not_chosen_yet) {
    TEST_ASSERT(isDefaultSetupPassword(OVERRIDE), "the build's default must be replaced");
    TEST_ASSERT(isDefaultSetupPassword("Admin1234"), "and so must the public one: an override does not make it private");
    TEST_ASSERT(!isDefaultSetupPassword("My-Own-Master-1"), "anything else is a choice");
}

int main() {
    RUN_TEST(the_template_is_a_valid_default_password_that_differs_from_the_public_one);
    RUN_TEST(the_override_replaces_the_default_a_blank_board_opens_its_wifi_with);
    RUN_TEST(a_stored_master_password_still_wins_over_the_override);
    RUN_TEST(both_the_override_and_the_public_password_count_as_not_chosen_yet);
    return test::summarize();
}
