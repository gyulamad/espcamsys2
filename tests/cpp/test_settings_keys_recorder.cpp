// test_settings_keys_recorder.cpp — the short stored-key table (docs/settings_keys.tsv) against its rules and
// against the Recorder's schema; also proves that the rules really catch a too long key, a duplicate and the
// other mistakes (a rule that never fails would protect nothing).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_keys_recorder test_settings_keys_recorder.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "settings_keys_check.h"

using namespace esp32cam_settings;

static std::vector<std::string> recorderSchemaKeys() {
    std::vector<std::string> v;
    for (size_t i = 0; i < RECORDER_SCHEMA.count; ++i) v.push_back(RECORDER_SCHEMA.keys[i].name);
    return v;
}

static KeyRow row(const char* key, const char* oldName = "OLD", const char* label = "A label", const char* sketch = "both") {
    KeyRow r = { "new", sketch, oldName, key, label, "" };
    return r;
}

static bool mentions(const std::vector<std::string>& problems, const char* what) {
    for (size_t i = 0; i < problems.size(); ++i)
        if (problems[i].find(what) != std::string::npos) return true;
    return false;
}

TEST(the_real_table_follows_the_rules) {
    std::string err;
    const std::vector<KeyRow> rows = loadKeyRows(keysTsvPath(), err);
    TEST_ASSERT(err.empty(), "docs/settings_keys.tsv can be read");
    TEST_ASSERT(!rows.empty(), "docs/settings_keys.tsv has rows");
    const std::vector<std::string> problems = keyTableProblems(rows, NVS_KEY_MAX_LENGTH);
    for (size_t i = 0; i < problems.size(); ++i) std::cerr << "  " << problems[i] << "\n";
    TEST_ASSERT(problems.empty(), "no stored key too long, doubled or malformed; no duplicate; every row has a label");
}

TEST(the_table_matches_the_recorder_schema) {
    std::string err;
    const std::vector<KeyRow> rows = loadKeyRows(keysTsvPath(), err);
    const std::vector<std::string> problems = schemaTableProblems(rows, "rec", recorderSchemaKeys());
    for (size_t i = 0; i < problems.size(); ++i) std::cerr << "  " << problems[i] << "\n";
    TEST_ASSERT(problems.empty(), "every recorder key has a row, and no stored key has gone from the schema");
}

TEST(every_recorder_key_fits_the_flash_limit) {
    bool fits = true;
    for (size_t i = 0; i < RECORDER_SCHEMA.count; ++i)
        if (std::string(RECORDER_SCHEMA.keys[i].name).size() > NVS_KEY_MAX_LENGTH) fits = false;
    TEST_ASSERT(fits, "no recorder schema key is longer than NVS_KEY_MAX_LENGTH");
}

TEST(a_key_of_15_characters_passes_and_16_fails) {
    std::vector<KeyRow> ok(1, row("PUSH_MAX_GAP_MS"));
    std::vector<KeyRow> bad(1, row("PUSH_MAX_GAP_MSX"));
    TEST_ASSERT(ok[0].key.size() == 15 && keyTableProblems(ok, 15).empty(), "exactly 15 characters is allowed");
    TEST_ASSERT(bad[0].key.size() == 16 && mentions(keyTableProblems(bad, 15), "1-15 characters"), "16 characters is refused");
}

TEST(a_duplicate_stored_key_is_refused_per_sketch) {
    std::vector<KeyRow> twice;
    twice.push_back(row("PUSH_GAP_MUL", "OLD_A", "Pause", "rec"));
    twice.push_back(row("PUSH_GAP_MUL", "OLD_B", "Pause", "both"));
    TEST_ASSERT(mentions(keyTableProblems(twice, 15), "stored key used twice in the rec sketch"), "the same key twice in one sketch fails");

    std::vector<KeyRow> separate;   // the same key in two DIFFERENT sketches is fine (CAM_VFLIP, LOG_*)
    separate.push_back(row("CAM_VFLIP", "A", "Flip", "rec"));
    separate.push_back(row("CAM_VFLIP", "B", "Flip", "det"));
    TEST_ASSERT(keyTableProblems(separate, 15).empty(), "one key in the recorder and in the detector is allowed");
}

TEST(a_duplicate_old_name_is_refused) {
    std::vector<KeyRow> rows;
    rows.push_back(row("KEY_A", "SAME_OLD", "A"));
    rows.push_back(row("KEY_B", "SAME_OLD", "B"));
    TEST_ASSERT(mentions(keyTableProblems(rows, 15), "old name \"SAME_OLD\" used twice"), "two keys cannot come from one old name");
}

TEST(malformed_keys_and_missing_parts_are_refused) {
    TEST_ASSERT(!wellFormedKey("lower_case", 15), "lower case is refused");
    TEST_ASSERT(!wellFormedKey("1ST_KEY", 15), "a leading digit is refused");
    TEST_ASSERT(!wellFormedKey("A__B", 15), "a doubled underscore is refused");
    TEST_ASSERT(!wellFormedKey("A_B_", 15), "a trailing underscore is refused");
    TEST_ASSERT(!wellFormedKey("A-B", 15), "a hyphen is refused");
    TEST_ASSERT(!wellFormedKey("", 15), "an empty key is refused");
    TEST_ASSERT(wellFormedKey("Y9_X", 15), "letters, digits and single underscores pass");
    TEST_ASSERT(mentions(keyTableProblems(std::vector<KeyRow>(1, row("KEY_A", "OLD", "")), 15), "label is empty"), "an empty label is refused");
    TEST_ASSERT(mentions(keyTableProblems(std::vector<KeyRow>(1, row("KEY_A", "")), 15), "old name is empty"), "an empty old name is refused");
}

TEST(one_stored_key_has_one_label) {
    std::vector<KeyRow> rows;
    rows.push_back(row("CAM_VFLIP", "A", "Flip the picture", "rec"));
    rows.push_back(row("CAM_VFLIP", "B", "Turn it round", "det"));
    TEST_ASSERT(mentions(keyTableProblems(rows, 15), "one stored key, one label"), "the same key must not mean two things");
}

TEST(a_schema_key_without_a_row_or_a_vanished_stored_key_is_refused) {
    std::vector<KeyRow> rows;
    KeyRow stored = { "stored", "rec", "GONE_KEY", "GONE_KEY", "Gone", "" };
    rows.push_back(stored);
    std::vector<std::string> schema(1, "UNLISTED_KEY");
    const std::vector<std::string> problems = schemaTableProblems(rows, "rec", schema);
    TEST_ASSERT(mentions(problems, "UNLISTED_KEY\" has no row"), "a schema key with no row is refused");
    TEST_ASSERT(mentions(problems, "\"GONE_KEY\" is stored on deployed boards"), "a stored key that left the schema is refused");
}

int main() {
    RUN_TEST(the_real_table_follows_the_rules);
    RUN_TEST(the_table_matches_the_recorder_schema);
    RUN_TEST(every_recorder_key_fits_the_flash_limit);
    RUN_TEST(a_key_of_15_characters_passes_and_16_fails);
    RUN_TEST(a_duplicate_stored_key_is_refused_per_sketch);
    RUN_TEST(a_duplicate_old_name_is_refused);
    RUN_TEST(malformed_keys_and_missing_parts_are_refused);
    RUN_TEST(one_stored_key_has_one_label);
    RUN_TEST(a_schema_key_without_a_row_or_a_vanished_stored_key_is_refused);
    return test::summarize();
}
