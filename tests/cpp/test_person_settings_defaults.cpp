// test_person_settings_defaults.cpp — the defaults of the person detector's settings that used to be
// fixed in the code, asked for on every board, or carried by the example template (KeyMeta and
// DefaultingStore in settings_logic.h, the detector's PERSON_META in settings_schema.h). The mirror of
// test_settings_defaults.cpp, which does the same for the recorder.
//
// What matters: a board with an OLD flash (none of the newer settings stored) must keep working with
// exactly the values the sketch used before, a stored value always wins, a default is never written to
// the flash by itself, and a wrong stored value is still reported (a default must not hide damage).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_settings_defaults test_person_settings_defaults.cpp

#include "framework.h"

#include <set>
#include <string>

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/scene_logic.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/motion_baseline.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"
#include "settings_fakes.h"
#include "schema_counts.h"

using namespace esp32cam_settings;

// The settings that say where and who this board is, and the alarm pin: never defaulted.
static const char* const IDENTITY[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "DETECTOR_ID", "PERSON_GPIO" };

static void fillIdentity(MemoryStore& st) {
    st.set("WIFI", "net:password1");
    st.set("SERVER_HOST", "192.168.4.9");
    st.set("HTTP_PORT", "8080");
    st.set("API_KEY", "s3cret");
    st.set("DETECTOR_ID", "detector-1");
    st.set("PERSON_GPIO", "13");
}

TEST(every_meta_row_names_a_real_key_once) {
    std::set<std::string> seen;
    bool allReal = true, unique = true, labelled = true;
    for (size_t i = 0; i < PERSON_META_COUNT; ++i) {
        const KeyMeta& m = PERSON_META[i];
        if (!findKey(PERSON_SCHEMA, m.name)) allReal = false;
        if (!seen.insert(m.name).second) unique = false;
        if (!m.label || !m.label[0] || !m.category || !m.category[0]) labelled = false;
    }
    TEST_ASSERT(allReal, "every meta row is a key of the schema");
    TEST_ASSERT(unique, "no key has two meta rows");
    TEST_ASSERT(labelled, "every row has a label and a category");
}

TEST(every_default_is_a_valid_value_for_its_key) {
    for (size_t i = 0; i < PERSON_META_COUNT; ++i) {
        const KeyMeta& m = PERSON_META[i];
        if (!m.defaultValue) continue;
        const KeyDef* def = findKey(PERSON_SCHEMA, m.name);
        std::string norm, err;
        bool ok = def && validateValue(*def, m.defaultValue, norm, err);
        TEST_ASSERT(ok, (std::string("default of ") + m.name + " is valid: " + err).c_str());
        TEST_ASSERT(ok && norm == m.defaultValue, (std::string("default of ") + m.name + " is already in stored form").c_str());
    }
}

TEST(identity_settings_and_the_alarm_pin_have_no_default) {
    for (size_t i = 0; i < sizeof(IDENTITY) / sizeof(IDENTITY[0]); ++i) {
        const KeyMeta* m = findMeta(PERSON_META, PERSON_META_COUNT, IDENTITY[i]);
        TEST_ASSERT(!m || !m->defaultValue, (std::string(IDENTITY[i]) + " stays required").c_str());
    }
}

TEST(the_ema_percentage_stays_required_while_the_ema_is_switched_on) {
    // MOTION_EMA_PCT is only asked for while MOTION_EMA_LEN is not 0; it has no default, so switching the
    // auto-calibration on still needs it (the same behaviour as before the defaults existed).
    TEST_ASSERT(!hasDefault(PERSON_SCHEMA, "MOTION_EMA_PCT"), "no default");
    MemoryStore st;
    fillIdentity(st);
    st.set("MOTION_EMA_LEN", "3000");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT(ps.size() == 1 && ps[0].key == "MOTION_EMA_PCT" && ps[0].missing, "switching the EMA on asks for the percentage");
}

TEST(defaulting_store_reads_the_default_only_when_nothing_is_stored) {
    MemoryStore flash;
    DefaultingStore st(flash, PERSON_META, PERSON_META_COUNT);
    TEST_ASSERT(st.has("DETECT_THRESH"), "a defaulted key is there");
    TEST_ASSERT_EQ(st.get("DETECT_THRESH"), std::string("0.6"), "its default");
    TEST_ASSERT(!st.has("API_KEY"), "an identity key is not invented");
    flash.set("DETECT_THRESH", "0.75");
    TEST_ASSERT_EQ(st.get("DETECT_THRESH"), std::string("0.75"), "a stored value wins");
    TEST_ASSERT_EQ(flash.badGets, 0, "the flash was only read where something is stored");
}

TEST(a_default_is_never_written_to_flash_by_reading) {
    MemoryStore flash;
    DefaultingStore st(flash, PERSON_META, PERSON_META_COUNT);
    st.get("DETECT_THRESH");
    st.has("MOTION_THRESH");
    TEST_ASSERT(flash.m.empty(), "flash untouched");
    st.set("DETECT_THRESH", "0.9");
    TEST_ASSERT_EQ(flash.m["DETECT_THRESH"], std::string("0.9"), "set goes to flash");
    st.clearAll();
    TEST_ASSERT_EQ(flash.clears, 1, "clearAll goes to flash");
}

TEST(an_old_flash_with_only_the_identity_loads_with_the_template_values) {
    // What a board had before the defaults existed: the identity (and, before the scene gate, not even
    // that). Nothing else stored: the defaults are the values the example template always carried.
    MemoryStore flash;
    fillIdentity(flash);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(flash, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.6f && s.clearThreshold == 0.5f && s.loopDelayMs == 10, "detection values");
    TEST_ASSERT(s.darkThreshold == 40 && s.motionThreshold == 300 && s.motionHoldSec == 10, "scene gate values");
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(0, 0, 96, 96), "the whole picture watched");
    TEST_ASSERT(s.motionEmaLength == 0, "auto-calibration off");
    TEST_ASSERT(s.streamMaxFps == 10 && s.streamJpegQuality == 80 && s.streamWriteTimeoutSec == 3, "stream tuning");
    TEST_ASSERT(s.announceHeartbeatSec == 600 && s.announceRetrySec == 30, "announce timing");
    TEST_ASSERT(flash.m.size() == 6, "loading stored nothing");
}

TEST(the_former_constants_are_the_defaults_of_the_new_keys) {
    MemoryStore flash;
    fillIdentity(flash);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(flash, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.darkHysteresis == 5, "DARK_HYSTERESIS was 5");
    TEST_ASSERT(s.scoreFreshMs == 1500, "SCORE_FRESH_MS was 1500");
    TEST_ASSERT(s.motionClipFactor == 2.0, "CLIP_FACTOR was 2.0");
    TEST_ASSERT(s.streamConnectTimeoutMs == 4000, "UplinkConfig.connectTimeoutMs was 4000");
    TEST_ASSERT(s.streamAnswerTimeoutMs == 5000, "UplinkConfig.answerTimeoutMs was 5000");
    TEST_ASSERT(s.streamHeartbeatMs == 1000, "UplinkConfig.heartbeatMs was 1000");
    TEST_ASSERT(s.announceFirstRetrySec == 2, "UplinkConfig.retryFirstMs was 2000");
    TEST_ASSERT(!s.camVflip && !s.camHmirror, "set_vflip(0) and set_hmirror(0)");
}

TEST(a_stored_value_wins_over_the_default_when_loading) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.set("DARK_THRESH", "20");
    flash.set("STREAM_MAX_FPS", "5");
    flash.set("MOTION_CLIP", "3.5");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(flash, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.darkThreshold == 20 && s.streamMaxFps == 5, "stored values used");
    TEST_ASSERT(s.motionClipFactor == 3.5, "a stored float is used as typed");
}

TEST(a_damaged_stored_value_is_still_reported_not_hidden_by_the_default) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.set("MOTION_THRESH", "banana");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(!loadPersonSettings(flash, s, err), "refuses");
    TEST_ASSERT(err.find("MOTION_THRESH") != std::string::npos, "names the key");
}

TEST(a_missing_identity_key_still_stops_the_board) {
    MemoryStore flash;
    fillIdentity(flash);
    flash.m.erase("DETECTOR_ID");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(!loadPersonSettings(flash, s, err), "refuses");
    TEST_ASSERT(err.find("DETECTOR_ID") != std::string::npos, "names the key");
}

TEST(the_defaults_reach_the_scene_gate_and_the_report_config) {
    // The values the sketch hands to the pure logic (configureScene, the UplinkConfig) are the loaded
    // settings, so the defaults must arrive there exactly.
    MemoryStore flash;
    fillIdentity(flash);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(flash, s, err), ("loads: " + err).c_str());

    person_scene::SceneConfig scene;
    scene.darkBelow = s.darkThreshold;
    scene.darkHysteresis = s.darkHysteresis;
    scene.motionAtLeast = s.motionThreshold;
    scene.holdMs = s.motionHoldSec * 1000UL;
    scene.motionEmaFrames = s.motionEmaLength;
    scene.motionEmaPercent = s.motionEmaPercent;
    scene.motionClipFactor = s.motionClipFactor;
    person_scene::SceneGate gate(scene);
    TEST_ASSERT(gate.update(0, []{ person_scene::SceneReading r; r.brightness = 39; r.motion = 9999; r.hasPrevious = true; return r; }(),
                            false).state == person_scene::SceneState::Dark, "dark below the default 40");
    TEST_ASSERT(gate.update(10, []{ person_scene::SceneReading r; r.brightness = 44; r.motion = 9999; r.hasPrevious = true; return r; }(),
                            false).state == person_scene::SceneState::Dark, "44 is still dark (the default hysteresis 5 wants 45)");
    TEST_ASSERT(gate.update(20, []{ person_scene::SceneReading r; r.brightness = 45; r.motion = 9999; r.hasPrevious = true; return r; }(),
                            false).state == person_scene::SceneState::Active, "45 = 40 + 5 is light again, and motion 9999 >= the default 300");

    person_report::Config report;
    report.scoreFreshMs = s.scoreFreshMs;
    TEST_ASSERT_EQ((int)report.scoreFreshMs, 1500, "the report carries the default freshness");
}

TEST(out_of_range_values_are_refused) {
    const char* bad[][2] = { {"DARK_HYST", "256"}, {"SCORE_FRESH_MS", "99"}, {"MOTION_CLIP", "2.0."},
                             {"MOTION_CLIP", "0.5"}, {"STREAM_CONN_MS", "499"}, {"STREAM_ANS_MS", "60001"},
                             {"STREAM_BEAT_MS", "99"}, {"ANN_FIRST_S", "0"}, {"CAM_VFLIP", "2"} };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        MemoryStore flash;
        fillIdentity(flash);
        flash.set(bad[i][0], bad[i][1]);
        PersonSettings s;
        std::string err;
        TEST_ASSERT(!loadPersonSettings(flash, s, err), (std::string(bad[i][0]) + "=" + bad[i][1] + " is refused").c_str());
    }
}

TEST(the_dashboard_may_queue_a_calibration_change_of_a_defaulted_key) {
    // The CALIBRATE page sends a change line to a board that never stored the key: the default is what it
    // holds, so the same value is no change and another one is applied (the same rule as the recorder's
    // PUSH_FAST_MS/PUSH_SLOW_MS test).
    MemoryStore flash;
    fillIdentity(flash);
    DefaultingStore board(flash, PERSON_META, PERSON_META_COUNT);   // defaults: detect 0.6
    ChangeResult same = applyChangeLine(PERSON_SCHEMA, board, "DETECT_THRESH=0.6", personLockedKeys());
    TEST_ASSERT(same.ok() && same.changed.empty(), "giving the default again changes nothing");
    TEST_ASSERT(!flash.m.count("DETECT_THRESH"), "nothing stored");
    ChangeResult up = applyChangeLine(PERSON_SCHEMA, board, "DETECT_THRESH=0.8", personLockedKeys());
    TEST_ASSERT(up.ok() && !up.changed.empty(), "another value is a change");
    TEST_ASSERT_EQ(flash.m["DETECT_THRESH"], std::string("0.8"), "stored");
    // CLEAR_THRESH above the (default) detect value is still refused, with both named.
    ChangeResult bad = applyChangeLine(PERSON_SCHEMA, board, "CLEAR_THRESH=0.9", personLockedKeys());
    TEST_ASSERT(!bad.ok(), "refused");
    TEST_ASSERT(!bad.errors.empty() && bad.errors[0].find("CLEAR_THRESH") != std::string::npos
                && bad.errors[0].find("DETECT_THRESH") != std::string::npos, "names both");
    TEST_ASSERT(!flash.m.count("CLEAR_THRESH"), "nothing stored");
}

int main() {
    RUN_TEST(every_meta_row_names_a_real_key_once);
    RUN_TEST(every_default_is_a_valid_value_for_its_key);
    RUN_TEST(identity_settings_and_the_alarm_pin_have_no_default);
    RUN_TEST(the_ema_percentage_stays_required_while_the_ema_is_switched_on);
    RUN_TEST(defaulting_store_reads_the_default_only_when_nothing_is_stored);
    RUN_TEST(a_default_is_never_written_to_flash_by_reading);
    RUN_TEST(an_old_flash_with_only_the_identity_loads_with_the_template_values);
    RUN_TEST(the_former_constants_are_the_defaults_of_the_new_keys);
    RUN_TEST(a_stored_value_wins_over_the_default_when_loading);
    RUN_TEST(a_damaged_stored_value_is_still_reported_not_hidden_by_the_default);
    RUN_TEST(a_missing_identity_key_still_stops_the_board);
    RUN_TEST(the_defaults_reach_the_scene_gate_and_the_report_config);
    RUN_TEST(out_of_range_values_are_refused);
    RUN_TEST(the_dashboard_may_queue_a_calibration_change_of_a_defaulted_key);
    return test::summarize();
}
