// test_settings_keys_person.cpp — the short stored-key table (docs/settings_keys.tsv) against the Detector's schema.
// The rules themselves are proven in test_settings_keys_recorder.cpp (settings_keys_check.h is shared).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_keys_person test_settings_keys_person.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "settings_keys_check.h"

using namespace esp32cam_settings;

static std::vector<std::string> personSchemaKeys() {
    std::vector<std::string> v;
    for (size_t i = 0; i < PERSON_SCHEMA.count; ++i) v.push_back(PERSON_SCHEMA.keys[i].name);
    return v;
}

TEST(the_table_matches_the_detector_schema) {
    std::string err;
    const std::vector<KeyRow> rows = loadKeyRows(keysTsvPath(), err);
    TEST_ASSERT(err.empty(), "docs/settings_keys.tsv can be read");
    const std::vector<std::string> problems = schemaTableProblems(rows, "det", personSchemaKeys());
    for (size_t i = 0; i < problems.size(); ++i) std::cerr << "  " << problems[i] << "\n";
    TEST_ASSERT(problems.empty(), "every detector key has a row, and no stored key has gone from the schema");
}

TEST(every_detector_key_fits_the_flash_limit) {
    bool fits = true;
    for (size_t i = 0; i < PERSON_SCHEMA.count; ++i)
        if (std::string(PERSON_SCHEMA.keys[i].name).size() > NVS_KEY_MAX_LENGTH) fits = false;
    TEST_ASSERT(fits, "no detector schema key is longer than NVS_KEY_MAX_LENGTH");
}

int main() {
    RUN_TEST(the_table_matches_the_detector_schema);
    RUN_TEST(every_detector_key_fits_the_flash_limit);
    return test::summarize();
}
