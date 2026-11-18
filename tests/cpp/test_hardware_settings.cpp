// test_hardware_settings.cpp — F-29 T3: the camera's Hardware & internals settings (the pin map, the camera
// clock, the frame buffers, the two task stacks, the serial port) and the log delivery period (LOG_PUMP_MS).
// The mirror of the detector's hardware tests (T5c, test_person_settings.cpp); that every meta row names a real
// key once and every default is a valid stored value is proven for the WHOLE of RECORDER_META in
// test_settings_defaults.cpp.
//
// What matters: a board from before T3 must come up exactly as it did (the old hard-coded values), a stored
// value wins, a damaged one is reported and not hidden by its default, out-of-range values are refused when
// typed or changed, and every one of these is an Expert setting that needs a restart and can still be repaired
// from the dashboard (not locked).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_hardware_settings test_hardware_settings.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "settings_fakes.h"
#include "schema_counts.h"

using namespace esp32cam_settings;

// A deployed board's stored settings from before T3: the identity keys, the alarm off and logging ON (so
// the log keys are read too).
static const char* const OLD_BOARD =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;CAMERA_ID=cam2;API_KEY=s3cret;"
    "ALARM_GPIO_PIN=-1;LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;"
    "LOG_FLUSH_SEC=10;LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

// The keys T3 turned into settings, with the values the sketch hard-coded before.
static const char* const T3_KEYS[] = {
    "PIN_PWDN", "PIN_RESET", "PIN_XCLK", "PIN_SIOD", "PIN_SIOC",
    "PIN_Y9", "PIN_Y8", "PIN_Y7", "PIN_Y6", "PIN_Y5", "PIN_Y4", "PIN_Y3", "PIN_Y2",
    "PIN_VSYNC", "PIN_HREF", "PIN_PCLK",
    "CAM_XCLK_HZ", "CAM_FB_COUNT", "STK_LOG_B", "STK_OTA_B", "SER_BAUD", "SER_RXBUF_B", "LOG_PUMP_MS",
};

static bool store(MemoryStore& st, const char* line) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, line);
    if (!c.ok()) return false;
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
    return true;
}

static bool valid(const char* line) { return checkLine(RECORDER_SCHEMA, line).ok(); }
static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

TEST(a_board_from_before_t3_loads_with_the_values_the_sketch_always_used) {
    MemoryStore st;
    TEST_ASSERT(store(st, OLD_BOARD), "an old board's stored settings");
    size_t storedBefore = st.m.size();
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pinPwdn == 32 && s.pinReset == -1 && s.pinXclk == 0 && s.pinSiod == 26 && s.pinSioc == 27, "the control pins");
    TEST_ASSERT(s.pinY9 == 35 && s.pinY8 == 34 && s.pinY7 == 39 && s.pinY6 == 36 &&
                s.pinY5 == 21 && s.pinY4 == 19 && s.pinY3 == 18 && s.pinY2 == 5, "the eight data pins");
    TEST_ASSERT(s.pinVsync == 25 && s.pinHref == 23 && s.pinPclk == 22, "the sync pins");
    TEST_ASSERT(s.camXclkHz == 20000000 && s.camFbCount == 2, "the camera driver");
    TEST_ASSERT(s.stkLogBytes == 8192 && s.stkOtaBytes == 10240, "the task stacks");
    TEST_ASSERT_EQ((int)s.logPumpMs, 250, "the log delivery period");
    TEST_ASSERT_EQ((int)st.m.size(), (int)storedBefore, "loading stored nothing: a default is never written to flash");
}

TEST(the_struct_defaults_match_the_key_defaults) {
    // RecorderSettings() is what g_cfg holds before loadRecorderSettings() runs; it must agree with the table.
    RecorderSettings d;
    MemoryStore st;
    TEST_ASSERT(store(st, OLD_BOARD), "stored");
    RecorderSettings loaded;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, loaded, err), err.c_str());
    TEST_ASSERT(d.pinPwdn == loaded.pinPwdn && d.pinReset == loaded.pinReset && d.pinXclk == loaded.pinXclk &&
                d.pinSiod == loaded.pinSiod && d.pinSioc == loaded.pinSioc && d.pinY9 == loaded.pinY9 &&
                d.pinY8 == loaded.pinY8 && d.pinY7 == loaded.pinY7 && d.pinY6 == loaded.pinY6 &&
                d.pinY5 == loaded.pinY5 && d.pinY4 == loaded.pinY4 && d.pinY3 == loaded.pinY3 &&
                d.pinY2 == loaded.pinY2 && d.pinVsync == loaded.pinVsync && d.pinHref == loaded.pinHref &&
                d.pinPclk == loaded.pinPclk, "pins");
    TEST_ASSERT(d.camXclkHz == loaded.camXclkHz && d.camFbCount == loaded.camFbCount &&
                d.stkLogBytes == loaded.stkLogBytes && d.stkOtaBytes == loaded.stkOtaBytes &&
                d.logPumpMs == loaded.logPumpMs, "driver, stacks, pump");
}

TEST(a_stored_hardware_value_wins_over_the_default) {
    MemoryStore st;
    TEST_ASSERT(store(st, OLD_BOARD), "stored");
    TEST_ASSERT(store(st, "PIN_Y2=25;STK_OTA_B=20480;CAM_FB_COUNT=3;LOG_PUMP_MS=1000;CAM_XCLK_HZ=10000000"), "changed hardware values");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pinY2 == 25 && s.stkOtaBytes == 20480 && s.camFbCount == 3 && s.camXclkHz == 10000000, "the stored values are used");
    TEST_ASSERT_EQ((int)s.logPumpMs, 1000, "the stored log delivery period is used");
}

TEST(a_damaged_stored_hardware_value_is_reported_not_hidden_by_the_default) {
    MemoryStore st;
    TEST_ASSERT(store(st, OLD_BOARD), "stored");
    st.m["PIN_XCLK"] = "banana";                          // behind the rules' back, as flash damage
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(!loadRecorderSettings(st, s, err) && has(err, "PIN_XCLK is invalid"), "refuses, and names the key");
    st.m["PIN_XCLK"] = "0";
    st.m["PIN_Y9"] = "99";                                // a whole number, but outside -1..39
    TEST_ASSERT(!loadRecorderSettings(st, s, err) && has(err, "PIN_Y9 is invalid"), "out of range: refused too");
}

TEST(hardware_values_out_of_range_are_refused_when_typed_or_changed) {
    const char* bad[][2] = { {"PIN_PWDN", "99"}, {"PIN_PWDN", "40"}, {"PIN_Y2", "-2"}, {"PIN_RESET", "-2"},
                             {"CAM_XCLK_HZ", "1999999"}, {"CAM_XCLK_HZ", "40000001"}, {"CAM_FB_COUNT", "0"},
                             {"CAM_FB_COUNT", "5"}, {"STK_LOG_B", "4095"}, {"STK_OTA_B", "8191"},
                             {"STK_OTA_B", "65537"}, {"SER_BAUD", "9599"}, {"SER_RXBUF_B", "100"},
                             {"LOG_PUMP_MS", "49"}, {"LOG_PUMP_MS", "10001"} };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i)
        TEST_ASSERT(!valid((std::string(bad[i][0]) + "=" + bad[i][1]).c_str()), (std::string(bad[i][0]) + "=" + bad[i][1] + " is refused").c_str());
    const char* good[][2] = { {"PIN_RESET", "-1"}, {"PIN_PWDN", "39"}, {"CAM_XCLK_HZ", "20000000"}, {"SER_BAUD", "5000000"},
                              {"STK_OTA_B", "65536"}, {"LOG_PUMP_MS", "50"}, {"LOG_PUMP_MS", "10000"} };
    for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); ++i)
        TEST_ASSERT(valid((std::string(good[i][0]) + "=" + good[i][1]).c_str()), (std::string(good[i][0]) + "=" + good[i][1] + " is accepted").c_str());
}

TEST(the_hardware_settings_are_expert_tier_need_a_restart_and_are_not_locked) {
    std::vector<std::string> locked = recorderLockedKeys();
    for (size_t i = 0; i < sizeof(T3_KEYS) / sizeof(T3_KEYS[0]); ++i) {
        const KeyMeta* m = findMeta(RECORDER_SCHEMA.meta, RECORDER_SCHEMA.metaCount, T3_KEYS[i]);
        const KeyDef* def = findKey(RECORDER_SCHEMA, T3_KEYS[i]);
        TEST_ASSERT(def && def->kind == Kind::Int, (std::string(T3_KEYS[i]) + " is a plain whole number: the board's wiring or a size, not a choice among the pins a user may drive").c_str());
        TEST_ASSERT(m && m->tier == Tier::Expert, (std::string(T3_KEYS[i]) + " is Expert tier").c_str());
        TEST_ASSERT(m && m->apply == Apply::Reboot, (std::string(T3_KEYS[i]) + " needs a restart").c_str());
        bool isLocked = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == T3_KEYS[i]) isLocked = true;
        TEST_ASSERT(!isLocked, (std::string(T3_KEYS[i]) + " is not locked: a wrong pin map breaks the camera, not the relay link, so the dashboard can repair it").c_str());
        std::string cat = m ? m->category : "";
        bool right = std::string(T3_KEYS[i]) == "LOG_PUMP_MS" ? cat == "Logging" : cat == "Hardware & internals";
        TEST_ASSERT(right, (std::string(T3_KEYS[i]) + " is in its category: " + cat).c_str());
    }
    TEST_ASSERT(hasDefault(RECORDER_SCHEMA, "SER_BAUD") && hasDefault(RECORDER_SCHEMA, "SER_RXBUF_B"),
                "the serial settings have defaults (earlySerialSetup reads only defaulted keys)");
}

TEST(the_shared_keys_are_identical_on_both_sketches) {
    // One stored key, one label, one default and one range on the camera and the detector (T5c did the detector):
    // the dashboard and the table in docs/SETTINGS_KEYS.md describe them once.
    // (The detector's schema cannot be included next to the recorder's, so its values are written down here;
    // test_person_settings.cpp pins the same numbers on the other side.)
    struct Shared { const char* key; const char* def; const char* label; long long lo, hi; };
    const Shared shared[] = {
        { "PIN_PWDN", "32", "Camera pin: PWDN", -1, 39 },     { "PIN_RESET", "-1", "Camera pin: RESET", -1, 39 },
        { "PIN_XCLK", "0", "Camera pin: XCLK", -1, 39 },      { "PIN_SIOD", "26", "Camera pin: SIOD", -1, 39 },
        { "PIN_SIOC", "27", "Camera pin: SIOC", -1, 39 },     { "PIN_Y9", "35", "Camera pin: Y9", -1, 39 },
        { "PIN_Y8", "34", "Camera pin: Y8", -1, 39 },         { "PIN_Y7", "39", "Camera pin: Y7", -1, 39 },
        { "PIN_Y6", "36", "Camera pin: Y6", -1, 39 },         { "PIN_Y5", "21", "Camera pin: Y5", -1, 39 },
        { "PIN_Y4", "19", "Camera pin: Y4", -1, 39 },         { "PIN_Y3", "18", "Camera pin: Y3", -1, 39 },
        { "PIN_Y2", "5", "Camera pin: Y2", -1, 39 },          { "PIN_VSYNC", "25", "Camera pin: VSYNC", -1, 39 },
        { "PIN_HREF", "23", "Camera pin: HREF", -1, 39 },     { "PIN_PCLK", "22", "Camera pin: PCLK", -1, 39 },
        { "CAM_XCLK_HZ", "20000000", "Camera clock (Hz)", 2000000, 40000000 },
        { "CAM_FB_COUNT", "2", "Camera frame buffers", 1, 4 },
        { "STK_LOG_B", "8192", "Log task stack (bytes)", 4096, 65536 },
        { "SER_BAUD", "115200", "Serial speed (baud)", 9600, 5000000 },
        { "SER_RXBUF_B", "2048", "Serial receive buffer (bytes)", 256, 65536 },
    };
    for (size_t i = 0; i < sizeof(shared) / sizeof(shared[0]); ++i) {
        const KeyMeta* m = findMeta(RECORDER_SCHEMA.meta, RECORDER_SCHEMA.metaCount, shared[i].key);
        const KeyDef* d = findKey(RECORDER_SCHEMA, shared[i].key);
        TEST_ASSERT(m && d, (std::string(shared[i].key) + " exists").c_str());
        if (!m || !d) continue;
        TEST_ASSERT_EQ(std::string(m->defaultValue), std::string(shared[i].def), (std::string(shared[i].key) + " default").c_str());
        TEST_ASSERT_EQ(std::string(m->label), std::string(shared[i].label), (std::string(shared[i].key) + " label").c_str());
        TEST_ASSERT(d->min == (double)shared[i].lo && d->max == (double)shared[i].hi, (std::string(shared[i].key) + " range").c_str());
    }
}

TEST(the_log_delivery_period_is_only_read_while_logging_is_on) {
    // LOG_PUMP_MS belongs to the log task: with LOG_ENABLED=0 there is no task, so nothing is read or asked.
    MemoryStore st;
    TEST_ASSERT(store(st, "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;CAMERA_ID=cam2;API_KEY=s3cret;ALARM_GPIO_PIN=-1;LOG_ENABLED=0"), "logging off");
    st.m["LOG_PUMP_MS"] = "banana";                       // damage under a switched-off feature is not a problem
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT_EQ((int)s.logPumpMs, 250, "and the default stays");
}

int main() {
    RUN_TEST(a_board_from_before_t3_loads_with_the_values_the_sketch_always_used);
    RUN_TEST(the_struct_defaults_match_the_key_defaults);
    RUN_TEST(a_stored_hardware_value_wins_over_the_default);
    RUN_TEST(a_damaged_stored_hardware_value_is_reported_not_hidden_by_the_default);
    RUN_TEST(hardware_values_out_of_range_are_refused_when_typed_or_changed);
    RUN_TEST(the_hardware_settings_are_expert_tier_need_a_restart_and_are_not_locked);
    RUN_TEST(the_shared_keys_are_identical_on_both_sketches);
    RUN_TEST(the_log_delivery_period_is_only_read_while_logging_is_on);
    return test::summarize();
}
