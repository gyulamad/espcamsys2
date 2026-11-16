// test_settings_defaults.cpp — the defaults of settings that used to be fixed in the code (KeyMeta and
// DefaultingStore in settings_logic.h, the Recorder's RECORDER_META in settings_schema.h).
//
// What matters: a board with an OLD flash (none of the newer settings stored) must keep working with
// exactly the values the sketch used before, a stored value always wins, a default is never written to the
// flash by itself, and a wrong stored value is still reported (a default must not hide damage).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_defaults test_settings_defaults.cpp

#include "framework.h"

#include <set>
#include <string>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "settings_fakes.h"

using namespace esp32cam_settings;

// The five settings that say where and who this board is: never defaulted.
static const char* const IDENTITY[] = { "WIFI", "SERVER_HOST", "PUSH_PORT", "HTTP_PORT", "CAMERA_ID", "API_KEY" };

static void fillIdentity(MemoryStore& st) {
    st.set("WIFI", "net:password1");
    st.set("SERVER_HOST", "192.168.4.9");
    st.set("PUSH_PORT", "8081");
    st.set("HTTP_PORT", "8080");
    st.set("CAMERA_ID", "cam2");
    st.set("API_KEY", "s3cret");
    st.set("ALARM_GPIO_PIN", "-1");
    st.set("LOG_ENABLED", "0");
}

TEST(every_meta_row_names_a_real_key_once) {
    std::set<std::string> seen;
    bool allReal = true, unique = true, labelled = true;
    for (size_t i = 0; i < RECORDER_META_COUNT; ++i) {
        const KeyMeta& m = RECORDER_META[i];
        if (!findKey(RECORDER_SCHEMA, m.name)) allReal = false;
        if (!seen.insert(m.name).second) unique = false;
        if (!m.label || !m.label[0] || !m.category || !m.category[0]) labelled = false;
    }
    TEST_ASSERT(allReal, "every meta row is a key of the schema");
    TEST_ASSERT(unique, "no key has two meta rows");
    TEST_ASSERT(labelled, "every row has a label and a category");
}

TEST(every_default_is_a_valid_value_for_its_key) {
    for (size_t i = 0; i < RECORDER_META_COUNT; ++i) {
        const KeyMeta& m = RECORDER_META[i];
        if (!m.defaultValue) continue;
        const KeyDef* def = findKey(RECORDER_SCHEMA, m.name);
        std::string norm, err;
        bool ok = def && validateValue(*def, m.defaultValue, norm, err);
        TEST_ASSERT(ok, (std::string("default of ") + m.name + " is valid: " + err).c_str());
        TEST_ASSERT(ok && norm == m.defaultValue, (std::string("default of ") + m.name + " is already in stored form").c_str());
    }
}

TEST(identity_and_safety_settings_have_no_default) {
    for (size_t i = 0; i < sizeof(IDENTITY) / sizeof(IDENTITY[0]); ++i) {
        const KeyMeta* m = findMeta(RECORDER_META, RECORDER_META_COUNT, IDENTITY[i]);
        TEST_ASSERT(!m || !m->defaultValue, (std::string(IDENTITY[i]) + " stays required").c_str());
    }
    TEST_ASSERT(!findMeta(RECORDER_META, RECORDER_META_COUNT, "ALARM_GPIO_PIN"), "ALARM_GPIO_PIN stays required");
    TEST_ASSERT(!findMeta(RECORDER_META, RECORDER_META_COUNT, "LOG_ENABLED"), "LOG_ENABLED stays required");
}

TEST(defaulting_store_reads_the_default_only_when_nothing_is_stored) {
    MemoryStore flash;
    DefaultingStore st(flash, RECORDER_META, RECORDER_META_COUNT);
    TEST_ASSERT(st.has("PUSH_GAP_MUL"), "a defaulted key is there");
    TEST_ASSERT_EQ(st.get("PUSH_GAP_MUL"), std::string("1.5"), "its default");
    TEST_ASSERT(!st.has("API_KEY"), "an identity key is not invented");
    flash.set("PUSH_GAP_MUL", "2");
    TEST_ASSERT_EQ(st.get("PUSH_GAP_MUL"), std::string("2"), "a stored value wins");
    TEST_ASSERT_EQ(flash.badGets, 0, "the flash was only read where something is stored");
}

TEST(a_default_is_never_written_to_flash_by_reading) {
    MemoryStore flash;
    DefaultingStore st(flash, RECORDER_META, RECORDER_META_COUNT);
    st.get("PUSH_GAP_MUL");
    st.has("LOG_HEARTBEAT");
    TEST_ASSERT(flash.m.empty(), "flash untouched");
    st.set("PUSH_GAP_MUL", "3");
    TEST_ASSERT_EQ(flash.m["PUSH_GAP_MUL"], std::string("3"), "set goes to flash");
    st.clearAll();
    TEST_ASSERT_EQ(flash.clears, 1, "clearAll goes to flash");
}

TEST(an_old_flash_without_the_tuning_settings_still_loads_with_the_old_values) {
    MemoryStore flash;
    fillIdentity(flash);                    // nothing else: what a board had before the settings existed
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(flash, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pushGapMul == 1.5f, "gap 1.5");
    TEST_ASSERT(s.jpegQualityDrop && s.jpegQualityMin == 12 && s.jpegQualityMax == 63, "quality 12..63");
    TEST_ASSERT(s.frameSizeDrop, "size drop on");
    TEST_ASSERT(flash.m.size() == 8, "loading stored nothing");
}

TEST(a_stored_value_wins_over_the_default_when_loading) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.set("PUSH_GAP_MUL", "2.5");
    flash.set("JPEG_Q_MIN", "20");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(flash, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pushGapMul == 2.5f && s.jpegQualityMin == 20, "stored values used");
}

TEST(a_damaged_stored_value_is_still_reported_not_hidden_by_the_default) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.set("PUSH_GAP_MUL", "banana");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(!loadRecorderSettings(flash, s, err), "refuses");
    TEST_ASSERT(err.find("PUSH_GAP_MUL") != std::string::npos, "names the key");
}

TEST(a_missing_identity_key_still_stops_the_board) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.m.erase("API_KEY");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(!loadRecorderSettings(flash, s, err), "refuses");
    TEST_ASSERT(err.find("API_KEY") != std::string::npos, "names the key");
}

int main() {
    RUN_TEST(every_meta_row_names_a_real_key_once);
    RUN_TEST(every_default_is_a_valid_value_for_its_key);
    RUN_TEST(identity_and_safety_settings_have_no_default);
    RUN_TEST(defaulting_store_reads_the_default_only_when_nothing_is_stored);
    RUN_TEST(a_default_is_never_written_to_flash_by_reading);
    RUN_TEST(an_old_flash_without_the_tuning_settings_still_loads_with_the_old_values);
    RUN_TEST(a_stored_value_wins_over_the_default_when_loading);
    RUN_TEST(a_damaged_stored_value_is_still_reported_not_hidden_by_the_default);
    RUN_TEST(a_missing_identity_key_still_stops_the_board);
    return test::summarize();
}
