// test_person_settings.cpp — unit tests for the person-detector sketch's key
// table and typed loader (ESP32_CAM_TFLite_Person/settings_schema.h), on top of
// the shared settings engine (settings_logic.h, tested in
// test_settings_logic.cpp). No ESP32, no Arduino core.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_settings test_person_settings.cpp

#include "framework.h"

#include <fstream>
#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/stream_logic.h"
#include "settings_fakes.h"

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

// A complete configuration with the live view ON, as one line.
static const char* WITH_STREAM =
    "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;STREAM_ENABLED=1;"
    "WIFI=extender-1:password1:extender-2:pass\\;word2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
    "API_KEY=s3cret;DETECTOR_ID=detector-1;STREAM_USER=viewer;STREAM_PASS=hunter22;STREAM_PORT=8088;"
    "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";

// The minimal one: no live view, no Wi-Fi.
static const char* NO_STREAM = "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;STREAM_ENABLED=0";

// Stores a line the way the conversation does (including the cross-setting rule).
static std::vector<std::string> storeLine(MemoryStore& st, const std::string& line) {
    CheckedLine c = checkLine(PERSON_SCHEMA, line);
    if (c.ok()) checkCrossRules(PERSON_SCHEMA, st, c.pairs, c.errors);
    if (c.ok()) for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
    return c.errors;
}
static bool store(MemoryStore& st, const std::string& line) { return storeLine(st, line).empty(); }

static bool valid(const std::string& line) { return checkLine(PERSON_SCHEMA, line).ok(); }

static bool anyError(const std::vector<std::string>& errs, const char* part) {
    for (size_t i = 0; i < errs.size(); ++i) if (has(errs[i], part)) return true;
    return false;
}

static bool listed(const std::vector<Problem>& ps, const char* key) {
    for (size_t i = 0; i < ps.size(); ++i) if (ps[i].key == key) return true;
    return false;
}

// ── the key table ───────────────────────────────────────────────────────

TEST(the_person_schema_is_consistent) {
    for (size_t i = 0; i < PERSON_SCHEMA.count; ++i) {
        const KeyDef& d = PERSON_SCHEMA.keys[i];
        std::string name = d.name;
        TEST_ASSERT(name.size() >= 1 && name.size() <= NVS_KEY_MAX_LENGTH, (name + ": flash keys are at most 15 characters").c_str());
        bool chars = true;
        for (size_t k = 0; k < name.size(); ++k) if (!isKeyChar(name[k])) chars = false;
        TEST_ASSERT(chars, (name + ": only A-Z 0-9 _").c_str());
        for (size_t j = 0; j < i; ++j) TEST_ASSERT(name != PERSON_SCHEMA.keys[j].name, (name + ": names are unique").c_str());
        TEST_ASSERT(d.help && d.help[0], (name + ": has help text").c_str());
        if (d.kind == Kind::Int || d.kind == Kind::Float) TEST_ASSERT(d.min < d.max, (name + ": range is sane").c_str());
        if (d.cond == Cond::Always) {
            TEST_ASSERT(d.condKey == nullptr, (name + ": no controller").c_str());
        } else {
            const KeyDef* ctl = d.condKey ? findKey(PERSON_SCHEMA, d.condKey) : nullptr;
            TEST_ASSERT(ctl != nullptr && d.condValue != nullptr, (name + ": its controlling setting exists").c_str());
            TEST_ASSERT(ctl && ctl->cond == Cond::Always, (name + ": the controller is always required (no chains)").c_str());
            std::string norm, err;
            TEST_ASSERT(ctl && validateValue(*ctl, d.condValue, norm, err) && norm == d.condValue, (name + ": condition value is canonical").c_str());
        }
    }
    TEST_ASSERT(PERSON_SCHEMA.crossCheck != nullptr, "the threshold rule is registered");
}

TEST(the_two_example_templates_are_valid_complete_configurations) {
    std::string here = __FILE__;
    std::string dir = here.substr(0, here.find_last_of("/\\") + 1);
    const char* files[] = { "example.person.template.txt", "example.person-no-wifi.template.txt" };
    const size_t expected[] = { PERSON_SCHEMA.count, 8 };
    for (size_t i = 0; i < 2; ++i) {
        std::ifstream f(dir + "../../Arduino/templates/" + files[i]);
        std::string line;
        TEST_ASSERT(static_cast<bool>(std::getline(f, line)), (std::string(files[i]) + ": can be read").c_str());
        MemoryStore st;
        std::vector<std::string> errs = storeLine(st, line);
        for (size_t e = 0; e < errs.size(); ++e) TEST_ASSERT(false, errs[e].c_str());
        TEST_ASSERT(errs.empty(), (std::string(files[i]) + ": is valid input").c_str());
        TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), (std::string(files[i]) + ": completes the configuration").c_str());
        TEST_ASSERT_EQ((int)st.m.size(), (int)expected[i], (std::string(files[i]) + ": sets exactly the settings it should").c_str());
    }
}

// ── what is needed when ─────────────────────────────────────────────────

TEST(a_blank_detector_needs_every_setting_and_the_flash_is_only_read_where_a_value_exists) {
    MemoryStore st;
    TEST_ASSERT_EQ((int)findProblems(PERSON_SCHEMA, st).size(), (int)PERSON_SCHEMA.count, "everything is listed on a blank board");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(with_the_live_view_off_only_eight_settings_are_needed_and_no_wifi_is_asked_for) {
    MemoryStore st;
    TEST_ASSERT(store(st, NO_STREAM), "stored");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "complete with just those eight");
    TEST_ASSERT_EQ((int)st.m.size(), 8, "exactly eight stored");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(turning_the_live_view_on_asks_for_the_whole_live_view_group_and_nothing_else) {
    MemoryStore st;
    store(st, NO_STREAM);
    store(st, "STREAM_ENABLED=1");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT_EQ((int)ps.size(), 13, "the 13 live-view settings");
    TEST_ASSERT(listed(ps, "WIFI") && listed(ps, "STREAM_PASS") && listed(ps, "ANN_RETRY") && listed(ps, "DETECTOR_ID"), "including Wi-Fi and the password");
    TEST_ASSERT(!listed(ps, "PERSON_GPIO") && !listed(ps, "DETECT_THRESH"), "but not the detection ones");
    store(st, "STREAM_ENABLED=0");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "turning it off again needs nothing");
}

// ── values ──────────────────────────────────────────────────────────────

TEST(the_output_gpio_must_be_a_pin_the_board_leaves_free) {
    TEST_ASSERT(valid("PERSON_GPIO=13") && valid("PERSON_GPIO=4") && valid("PERSON_GPIO=2"), "free pins");
    TEST_ASSERT(!valid("PERSON_GPIO=12") && !valid("PERSON_GPIO=0") && !valid("PERSON_GPIO=-1") && !valid("PERSON_GPIO=16"), "reserved pins, and no 'off' value");
}

TEST(thresholds_are_scores_between_0_01_and_1) {
    TEST_ASSERT(valid("DETECT_THRESH=0.6") && valid("DETECT_THRESH=1") && valid("DETECT_THRESH=0.01"), "in range");
    TEST_ASSERT(!valid("DETECT_THRESH=0") && !valid("DETECT_THRESH=1.01") && !valid("DETECT_THRESH=-0.5") && !valid("DETECT_THRESH=60%"), "outside / not numbers");
    TEST_ASSERT(!valid("CLEAR_THRESH=abc") && !valid("CLEAR_THRESH="), "garbage");
}

TEST(the_scene_gate_settings_are_numbers_in_their_ranges_and_zero_switches_a_check_off) {
    TEST_ASSERT(valid("DARK_THRESH=0") && valid("DARK_THRESH=40") && valid("DARK_THRESH=255"), "darkness 0..255 (0 = off)");
    TEST_ASSERT(!valid("DARK_THRESH=256") && !valid("DARK_THRESH=-1") && !valid("DARK_THRESH=dark") && !valid("DARK_THRESH=12.5"), "outside / not whole numbers");
    TEST_ASSERT(valid("MOTION_THRESH=0") && valid("MOTION_THRESH=300") && valid("MOTION_THRESH=1000000"), "motion 0 (off) .. 1000000");
    TEST_ASSERT(!valid("MOTION_THRESH=1000001") && !valid("MOTION_THRESH=-5") && !valid("MOTION_THRESH="), "outside / empty");
    TEST_ASSERT(valid("MOTION_HOLD_S=0") && valid("MOTION_HOLD_S=3600") && !valid("MOTION_HOLD_S=3601") && !valid("MOTION_HOLD_S=-1"), "hold 0..3600 s");
}

TEST(the_scene_gate_settings_are_always_asked_for_also_with_the_live_view_off) {
    MemoryStore st;
    TEST_ASSERT(store(st, "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;STREAM_ENABLED=0"), "an old five-setting configuration is stored");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT_EQ((int)ps.size(), 3, "exactly the three new ones are missing (what a firmware update to this version leaves behind)");
    TEST_ASSERT(listed(ps, "DARK_THRESH") && listed(ps, "MOTION_THRESH") && listed(ps, "MOTION_HOLD_S"), "namely these");
    TEST_ASSERT(ps[0].missing && ps[1].missing && ps[2].missing, "reported as not set, not as invalid");
}

TEST(loop_delay_and_stream_tuning_ranges) {
    TEST_ASSERT(valid("LOOP_DELAY_MS=0") && valid("LOOP_DELAY_MS=1000") && !valid("LOOP_DELAY_MS=1001") && !valid("LOOP_DELAY_MS=-1"), "loop delay 0..1000");
    TEST_ASSERT(valid("STREAM_MAX_FPS=1") && valid("STREAM_MAX_FPS=30") && !valid("STREAM_MAX_FPS=0") && !valid("STREAM_MAX_FPS=31"), "fps 1..30 (0 would divide by zero)");
    TEST_ASSERT(valid("STREAM_JPEG_Q=1") && valid("STREAM_JPEG_Q=100") && !valid("STREAM_JPEG_Q=0") && !valid("STREAM_JPEG_Q=101"), "jpeg quality 1..100");
    TEST_ASSERT(valid("STREAM_WR_TMO_S=1") && !valid("STREAM_WR_TMO_S=0") && !valid("STREAM_WR_TMO_S=61"), "write timeout 1..60");
    TEST_ASSERT(valid("STREAM_PORT=80") && valid("STREAM_PORT=65535") && !valid("STREAM_PORT=0") && !valid("STREAM_PORT=65536"), "port");
    TEST_ASSERT(valid("ANN_HEARTBEAT=1") && !valid("ANN_HEARTBEAT=0") && valid("ANN_RETRY=30") && !valid("ANN_RETRY=0"), "announce timing");
}

TEST(stream_credentials_that_the_settings_accept_are_always_usable_by_the_sketch) {
    // The sketch refuses to serve with credentials person_stream::credentialsUsable
    // rejects. The settings must never let such a pair in (the user would see
    // "Live view OFF" at run time instead of an error when typing it).
    const char* users[] = { "viewer", "a", "Cam_1.garage-2" };
    for (size_t u = 0; u < 3; ++u) {
        CheckedLine c = checkLine(PERSON_SCHEMA, std::string("STREAM_USER=") + users[u]);
        TEST_ASSERT(c.ok() && person_stream::credentialsUsable(c.pairs[0].value.c_str(), "hunter22"), users[u]);
    }
    TEST_ASSERT(!valid("STREAM_USER=a:b"), "a ':' in the user name can't be sent in Basic auth: refused when typed");
    TEST_ASSERT(!valid("STREAM_USER="), "empty user");
    TEST_ASSERT(!valid("STREAM_PASS=change-me") && !valid("STREAM_PASS="), "the template password and an empty one");
    TEST_ASSERT(person_stream::credentialsUsable("viewer", "hunter22"), "and an accepted pair is usable");
    CheckedLine odd = checkLine(PERSON_SCHEMA, "STREAM_PASS=p@ss w0rd\\;\\:\\\\");
    TEST_ASSERT(odd.ok() && odd.pairs[0].value == "p@ss w0rd;:\\", "a password may contain special characters (escaped when typed)");
    TEST_ASSERT(person_stream::credentialsUsable("viewer", odd.pairs[0].value.c_str()), "and is usable");
}

// ── the threshold rule ──────────────────────────────────────────────────

TEST(clear_threshold_must_not_exceed_the_detect_threshold) {
    MemoryStore st;
    store(st, NO_STREAM);                                   // detect 0.6, clear 0.5
    TEST_ASSERT(store(st, "CLEAR_THRESH=0.6"), "equal is allowed (clears as soon as it drops below)");
    TEST_ASSERT(store(st, "CLEAR_THRESH=0.3"), "lower is fine");
    std::vector<std::string> e = storeLine(st, "CLEAR_THRESH=0.7");
    TEST_ASSERT(anyError(e, "CLEAR_THRESH (0.7) must not be higher than DETECT_THRESH (0.6)") && anyError(e, "in one line"), "higher than the stored detect value: refused, with the way out");
    TEST_ASSERT(st.m["CLEAR_THRESH"] == "0.3", "and nothing was stored");
    e = storeLine(st, "DETECT_THRESH=0.2");
    TEST_ASSERT(anyError(e, "must not be higher than DETECT_THRESH (0.2)"), "lowering the detect value below the stored clear value: refused too");
    TEST_ASSERT(store(st, "DETECT_THRESH=0.9;CLEAR_THRESH=0.8"), "both together, raising them");
    TEST_ASSERT(store(st, "DETECT_THRESH=0.2;CLEAR_THRESH=0.1"), "both together, lowering them: each alone would clash with the stored one");
    TEST_ASSERT(st.m["DETECT_THRESH"] == "0.2" && st.m["CLEAR_THRESH"] == "0.1", "stored");
    MemoryStore blank;
    TEST_ASSERT(store(blank, "CLEAR_THRESH=0.9"), "on a blank board the other value isn't known yet: no complaint");
    TEST_ASSERT(!store(blank, "DETECT_THRESH=0.5"), "...but entering the detect value then reveals it");
}

TEST(the_threshold_rule_works_in_the_boot_conversation) {
    MemoryStore st;
    ScriptConsole con;
    store(st, WITH_STREAM);
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    con.in = "y\nDETECT_THRESH=0.4\n";
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; t < 200 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Running && con.said("ERROR: CLEAR_THRESH (0.5) must not be higher than DETECT_THRESH (0.4)"), "refused with a clear message");
    TEST_ASSERT(st.m["DETECT_THRESH"] == "0.6", "nothing stored");
    con.in += "DETECT_THRESH=0.4;CLEAR_THRESH=0.3\n\n";
    for (uint32_t t = 200; t < 400 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Restart && st.m["DETECT_THRESH"] == "0.4" && st.m["CLEAR_THRESH"] == "0.3", "both together are accepted; empty line saves and restarts");
}

// ── the conversation on a blank detector ────────────────────────────────

TEST(a_blank_detector_is_configured_with_one_line_and_restarts) {
    MemoryStore st;
    ScriptConsole con;
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    con.in = std::string(NO_STREAM) + "\n";
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; t < 200 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Restart, "restart after the eight settings");
    TEST_ASSERT(con.said("These settings need a value (" + std::to_string(PERSON_SCHEMA.count) + ")"), "first it asked for all of them");
    TEST_ASSERT(con.said("STREAM_ENABLED - ") && con.said("DETECT_THRESH - "), "with their help text");
}

TEST(secrets_of_the_live_view_are_masked_when_the_settings_are_shown) {
    MemoryStore st;
    ScriptConsole con;
    store(st, WITH_STREAM);
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    flow.step(1000);
    TEST_ASSERT(con.said("STREAM_PASS=********") && con.said("API_KEY=********") && con.said("WIFI=extender-1:****:extender-2:****"), "masked");
    TEST_ASSERT(!con.said("hunter22") && !con.said("s3cret") && !con.said("password1"), "no secret on the serial port");
    TEST_ASSERT(con.said("STREAM_USER=viewer") && con.said("DETECT_THRESH=0.6"), "ordinary values shown");
}

TEST(a_detector_without_wifi_shows_the_live_view_settings_as_not_used) {
    MemoryStore st;
    ScriptConsole con;
    store(st, NO_STREAM);
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    flow.step(1000);
    TEST_ASSERT(con.said("WIFI=<not set>   (not used)") && con.said("STREAM_PASS=<not set>   (not used)"), "marked as not used, not as required");
    TEST_ASSERT(con.said("Change settings? [y/N]"), "complete, so it just offers the 5 s window");
}

// ── typed settings ──────────────────────────────────────────────────────

TEST(settings_load_into_typed_fields_with_the_live_view_on) {
    MemoryStore st;
    store(st, WITH_STREAM);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.6f && s.clearThreshold == 0.5f && s.loopDelayMs == 10, "detection");
    TEST_ASSERT(s.darkThreshold == 40 && s.motionThreshold == 300 && s.motionHoldSec == 10, "scene gate");
    TEST_ASSERT(s.streamEnabled && s.wifi.size() == 2 && s.wifi[1].pass == "pass;word2", "wifi, decoded");
    TEST_ASSERT(s.serverHost == "192.168.4.9" && s.httpPort == 8080 && s.apiKey == "s3cret" && s.detectorId == "detector-1", "relay");
    TEST_ASSERT(s.streamUser == "viewer" && s.streamPass == "hunter22" && s.streamPort == 8088, "stream login and port");
    TEST_ASSERT(s.streamMaxFps == 10 && s.streamJpegQuality == 80 && s.streamWriteTimeoutSec == 3, "stream tuning");
    TEST_ASSERT(s.announceHeartbeatSec == 600 && s.announceRetrySec == 30, "announce timing");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(with_the_live_view_off_the_stream_fields_keep_neutral_values) {
    MemoryStore st;
    store(st, NO_STREAM);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(!s.streamEnabled && s.wifi.empty() && s.serverHost.empty(), "no live view");
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.6f && s.clearThreshold == 0.5f, "detection still loaded");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(the_documented_typical_values_are_the_defaults_of_the_struct_the_glue_test_relies_on) {
    PersonSettings s;
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.60f && s.clearThreshold == 0.50f && s.loopDelayMs == 10,
                "test_person_detect_glue.cpp is written around these values");
    TEST_ASSERT(s.darkThreshold == 0 && s.motionThreshold == 0 && s.motionHoldSec == 0,
                "and with the scene gate off, so that test sees every frame");
}

TEST(loading_refuses_missing_or_invalid_settings_and_says_which) {
    MemoryStore st;
    PersonSettings s;
    std::string err;
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "PERSON_GPIO is not set"), "blank board");
    store(st, WITH_STREAM);
    st.m["STREAM_MAX_FPS"] = "0";
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "STREAM_MAX_FPS is invalid"), "an invalid stored value");
}

int main() {
    RUN_TEST(the_person_schema_is_consistent);
    RUN_TEST(the_two_example_templates_are_valid_complete_configurations);
    RUN_TEST(a_blank_detector_needs_every_setting_and_the_flash_is_only_read_where_a_value_exists);
    RUN_TEST(with_the_live_view_off_only_eight_settings_are_needed_and_no_wifi_is_asked_for);
    RUN_TEST(the_scene_gate_settings_are_numbers_in_their_ranges_and_zero_switches_a_check_off);
    RUN_TEST(the_scene_gate_settings_are_always_asked_for_also_with_the_live_view_off);
    RUN_TEST(turning_the_live_view_on_asks_for_the_whole_live_view_group_and_nothing_else);
    RUN_TEST(the_output_gpio_must_be_a_pin_the_board_leaves_free);
    RUN_TEST(thresholds_are_scores_between_0_01_and_1);
    RUN_TEST(loop_delay_and_stream_tuning_ranges);
    RUN_TEST(stream_credentials_that_the_settings_accept_are_always_usable_by_the_sketch);
    RUN_TEST(clear_threshold_must_not_exceed_the_detect_threshold);
    RUN_TEST(the_threshold_rule_works_in_the_boot_conversation);
    RUN_TEST(a_blank_detector_is_configured_with_one_line_and_restarts);
    RUN_TEST(secrets_of_the_live_view_are_masked_when_the_settings_are_shown);
    RUN_TEST(a_detector_without_wifi_shows_the_live_view_settings_as_not_used);
    RUN_TEST(settings_load_into_typed_fields_with_the_live_view_on);
    RUN_TEST(with_the_live_view_off_the_stream_fields_keep_neutral_values);
    RUN_TEST(the_documented_typical_values_are_the_defaults_of_the_struct_the_glue_test_relies_on);
    RUN_TEST(loading_refuses_missing_or_invalid_settings_and_says_which);
    return test::summarize();
}
