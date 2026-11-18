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
#include "settings_fakes.h"
#include "schema_counts.h"

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

// The detection settings all have defaults (PERSON_META): a blank board is asked only for the live
// view's identity. This is what a blank board's owner actually types: the identity line, the tuning
// comes with the defaults and is changed later from the dashboard.
static const char* IDENTITY =
    "WIFI=extender-1:password1:extender-2:pass\\;word2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
    "API_KEY=s3cret;DETECTOR_ID=detector-1";

// The detection settings, then the live view's: every setting stored, as the template keeps them.
static const char* DETECTION =
    "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0";
static const char* LIVE_VIEW =
    "STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30";

// A complete configuration, as one line.
static const std::string COMPLETE = std::string(DETECTION) + ";" + std::string(IDENTITY) + ";" + LIVE_VIEW;

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
        if (d.cond == Cond::Always || d.cond == Cond::Optional) {
            TEST_ASSERT(d.condKey == nullptr && d.condValue == nullptr, (name + ": no controller").c_str());
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

TEST(the_example_person_template_is_a_valid_complete_configuration) {
    std::string here = __FILE__;
    std::string dir = here.substr(0, here.find_last_of("/\\") + 1);
    const char* file = "example.person.template.txt";
    // EVERY setting except MOTION_EMA_PCT (the template keeps the motion auto-calibration off with
    // MOTION_EMA_LEN=0, and then its percentage is not asked for) and the optional pair SETUP_MODE /
    // SETUP_PASSWORD (a password placeholder in a template would become a real one).
    const size_t expected = PERSON_SCHEMA.count - 3;
    std::ifstream f(dir + "../../Arduino/templates/" + file);
    std::string line;
    TEST_ASSERT(static_cast<bool>(std::getline(f, line)), (std::string(file) + ": can be read").c_str());
    MemoryStore st;
    std::vector<std::string> errs = storeLine(st, line);
    for (size_t e = 0; e < errs.size(); ++e) TEST_ASSERT(false, errs[e].c_str());
    TEST_ASSERT(errs.empty(), (std::string(file) + ": is valid input").c_str());
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), (std::string(file) + ": completes the configuration").c_str());
    TEST_ASSERT_EQ((int)st.m.size(), (int)expected, (std::string(file) + ": sets exactly the settings it should").c_str());

    // And every value it carries for a defaulted setting IS that default: the template doubles as the
    // example of what a board that stored nothing runs with, so a default that drifts from it would say
    // one thing in the README's table and do another on the board.
    for (size_t i = 0; i < PERSON_META_COUNT; ++i) {
        if (!PERSON_META[i].defaultValue) continue;
        std::map<std::string, std::string>::const_iterator it = st.m.find(PERSON_META[i].name);
        if (it != st.m.end())
            TEST_ASSERT_EQ(it->second, std::string(PERSON_META[i].defaultValue),
                           ((std::string(file) + ": ") + PERSON_META[i].name + " carries its default").c_str());
    }
}

// ── what is needed when ─────────────────────────────────────────────────

TEST(a_blank_detector_is_asked_only_for_the_settings_without_a_default_and_the_flash_is_only_read_where_a_value_exists) {
    MemoryStore st;
    // The identity (WIFI, SERVER_HOST, HTTP_PORT, API_KEY, DETECTOR_ID) and the alarm pin (PERSON_GPIO):
    // 6 settings, none of them defaulted. Everything else - the thresholds, the scene gate, the motion
    // area, the auto-calibration switch, the stream tuning - has a default and is not asked for.
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT_EQ((int)ps.size(), (int)requiredKeyCount(PERSON_SCHEMA), "the settings without a default are listed on a blank board");
    TEST_ASSERT_EQ((int)ps.size(), 6, "six of them: the identity five and the alarm pin");
    TEST_ASSERT(listed(ps, "WIFI") && listed(ps, "SERVER_HOST") && listed(ps, "HTTP_PORT") && listed(ps, "API_KEY") && listed(ps, "DETECTOR_ID"), "the identity");
    TEST_ASSERT(listed(ps, "PERSON_GPIO"), "the alarm pin (wiring, no default)");
    TEST_ASSERT(!listed(ps, "DETECT_THRESH") && !listed(ps, "DARK_THRESH") && !listed(ps, "MOTION_X1") && !listed(ps, "STREAM_MAX_FPS"), "no defaulted setting is asked for");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(the_live_view_identity_settings_are_always_required) {
    MemoryStore st;
    TEST_ASSERT(store(st, DETECTION), "the twelve detection settings are stored");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT_EQ((int)ps.size(), 5, "the board is NOT complete without the live view: the identity settings are needed");
    TEST_ASSERT(listed(ps, "WIFI") && listed(ps, "API_KEY") && listed(ps, "DETECTOR_ID") && listed(ps, "SERVER_HOST") && listed(ps, "HTTP_PORT"), "including Wi-Fi, the relay and the detector's name");
    TEST_ASSERT(!listed(ps, "PERSON_GPIO") && !listed(ps, "DETECT_THRESH"), "but not the detection ones (the pin is stored, the thresholds have defaults)");
    bool allMissing = true;
    for (size_t i = 0; i < ps.size(); ++i) if (!ps[i].missing) allMissing = false;
    TEST_ASSERT(allMissing, "reported as not set");
    TEST_ASSERT(store(st, IDENTITY), "the live view's identity settings are stored");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "and then the board is complete: the stream tuning all has defaults");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(the_old_stream_switch_is_gone_and_a_board_that_still_has_it_stored_ignores_it) {
    // STREAM_ENABLED used to switch the live view off for a detector without Wi-Fi. There is no such detector any
    // more: the key is not in the table, and a board that still has it in flash must neither be asked about it
    // nor read it (like the LAN server's old settings below).
    TEST_ASSERT(!valid("STREAM_ENABLED=1") && !valid("STREAM_ENABLED=0"), "no longer a setting");
    CheckedLine c = checkLine(PERSON_SCHEMA, "STREAM_ENABLED=1");
    TEST_ASSERT(!c.errors.empty() && has(c.errors[0], "STREAM_ENABLED"), "a line that still has it says which key is no longer known");
    for (size_t i = 0; i < PERSON_SCHEMA.count; ++i) TEST_ASSERT(std::string(PERSON_SCHEMA.keys[i].name) != "STREAM_ENABLED", "not in the table");

    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "stored");
    st.set("STREAM_ENABLED", "1");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "still complete with it left in flash");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.serverHost == "192.168.4.9" && s.detectorId == "detector-1", "and loads as before");

    // A board that was run with it OFF never had the live view's identity settings: after the update it
    // is incomplete, and says what it needs (only what has no default: the identity, not the stream tuning).
    MemoryStore off;
    TEST_ASSERT(store(off, DETECTION), "detection settings only");
    off.set("STREAM_ENABLED", "0");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, off);
    TEST_ASSERT_EQ((int)ps.size(), 5, "it needs the 5 live-view identity settings (the tuning ones have defaults)");
    TEST_ASSERT(listed(ps, "WIFI") && listed(ps, "SERVER_HOST") && listed(ps, "HTTP_PORT") && listed(ps, "API_KEY") && listed(ps, "DETECTOR_ID"), "all five named");
    TEST_ASSERT(!loadPersonSettings(off, s, err) && has(err, "WIFI is not set"), "and does not load without them");
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

TEST(a_board_that_predates_the_scene_gate_is_complete_and_uses_the_default_gate_values) {
    MemoryStore st;
    TEST_ASSERT(store(st, std::string("PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;") + IDENTITY), "an old five-setting configuration is stored");
    // What a firmware update to this version leaves behind: the scene gate's three, the motion area's four
    // and the auto-calibration's switch are no longer asked for - their defaults are what the template
    // always carried, so the board keeps working exactly as its owner configured it by hand.
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.darkThreshold == 40 && s.motionThreshold == 300 && s.motionHoldSec == 10, "the scene gate's defaults");
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(0, 0, 96, 96), "the whole picture watched");
    TEST_ASSERT_EQ((int)s.motionEmaLength, 0, "auto-calibration off");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "the board is complete");
    TEST_ASSERT_EQ(st.badGets, 0, "and the defaults were not written to the flash");
}

TEST(a_board_from_before_the_motion_area_runs_on_the_default_whole_picture_area) {
    MemoryStore st;
    TEST_ASSERT(store(st, std::string("PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;") + IDENTITY), "the previous version's configuration is stored");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(0, 0, 96, 96), "the area's corners default to the whole picture");
    TEST_ASSERT_EQ((int)s.motionEmaLength, 0, "the auto-calibration defaults to off");
    // Narrowing the area is still a change the dashboard makes - the four numbers stay settings.
    TEST_ASSERT(store(st, "MOTION_X0=20;MOTION_Y0=30;MOTION_X1=70;MOTION_Y1=80"), "a narrowed area is accepted");
    TEST_ASSERT(loadPersonSettings(st, s, err) && s.motionArea == person_scene::MotionArea(20, 30, 70, 80), "and loads");
}

TEST(loop_delay_and_stream_tuning_ranges) {
    TEST_ASSERT(valid("LOOP_DELAY_MS=0") && valid("LOOP_DELAY_MS=1000") && !valid("LOOP_DELAY_MS=1001") && !valid("LOOP_DELAY_MS=-1"), "loop delay 0..1000");
    TEST_ASSERT(valid("STREAM_MAX_FPS=1") && valid("STREAM_MAX_FPS=30") && !valid("STREAM_MAX_FPS=0") && !valid("STREAM_MAX_FPS=31"), "fps 1..30 (0 would divide by zero)");
    TEST_ASSERT(valid("STREAM_JPEG_Q=1") && valid("STREAM_JPEG_Q=100") && !valid("STREAM_JPEG_Q=0") && !valid("STREAM_JPEG_Q=101"), "jpeg quality 1..100");
    TEST_ASSERT(valid("STREAM_WR_TMO_S=1") && !valid("STREAM_WR_TMO_S=0") && !valid("STREAM_WR_TMO_S=61"), "write timeout 1..60");
    TEST_ASSERT(valid("HTTP_PORT=80") && valid("HTTP_PORT=65535") && !valid("HTTP_PORT=0") && !valid("HTTP_PORT=65536"), "the relay's port");
    TEST_ASSERT(valid("ANN_HEARTBEAT=1") && !valid("ANN_HEARTBEAT=0") && valid("ANN_RETRY=30") && !valid("ANN_RETRY=0"), "announce timing");
}

TEST(the_lan_servers_settings_are_gone_the_live_view_is_pushed_to_the_relay) {
    // The detector used to serve its picture to a viewer on the LAN (user, password, port). It now connects
    // OUT to the relay, which may be behind a NAT router, and pushes the picture up — so nothing is served.
    TEST_ASSERT(!valid("STREAM_USER=viewer"), "no stream user");
    TEST_ASSERT(!valid("STREAM_PASS=hunter22"), "no stream password");
    TEST_ASSERT(!valid("STREAM_PORT=8088"), "no stream port");
    CheckedLine c = checkLine(PERSON_SCHEMA, "STREAM_PORT=8088");
    TEST_ASSERT(!c.errors.empty() && has(c.errors[0], "STREAM_PORT"), "an old settings line says which key is no longer known");
    for (size_t i = 0; i < PERSON_SCHEMA.count; ++i) {
        std::string k = PERSON_SCHEMA.keys[i].name;
        TEST_ASSERT(k != "STREAM_USER" && k != "STREAM_PASS" && k != "STREAM_PORT", ("not in the table: " + k).c_str());
    }
}

TEST(a_board_that_still_has_the_old_server_settings_stored_is_not_asked_for_anything) {
    // After a firmware update the flash still holds STREAM_USER/STREAM_PASS/STREAM_PORT: they must neither
    // make the board "incomplete" (it would wait for a cable) nor be read.
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "stored");
    st.set("STREAM_USER", "viewer");
    st.set("STREAM_PASS", "hunter22");
    st.set("STREAM_PORT", "8088");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "still complete");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.serverHost == "192.168.4.9" && s.detectorId == "detector-1", "and loads as before");
}

// ── the threshold rule ──────────────────────────────────────────────────

TEST(clear_threshold_must_not_exceed_the_detect_threshold) {
    MemoryStore st;
    store(st, COMPLETE);                                   // detect 0.6, clear 0.5
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
    // The default detect threshold (0.6) is in force even on a blank board, so a clear threshold above it
    // is refused at once - the days of "the other value isn't known yet" ended with the defaults.
    TEST_ASSERT(!store(blank, "CLEAR_THRESH=0.9"), "on a blank board the default detect value (0.6) already forbids a higher clear value");
    TEST_ASSERT(store(blank, "CLEAR_THRESH=0.5"), "a lower one is fine");
}

TEST(the_threshold_rule_works_in_the_boot_conversation) {
    MemoryStore st;
    ScriptConsole con;
    store(st, COMPLETE);
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

// ── the motion area ─────────────────────────────────────────────────────

TEST(each_motion_area_number_is_a_whole_number_from_0_to_96) {
    TEST_ASSERT(valid("MOTION_X0=0") && valid("MOTION_Y0=50") && valid("MOTION_X1=96") && valid("MOTION_Y1=96"), "in range");
    TEST_ASSERT(!valid("MOTION_X0=-1") && !valid("MOTION_X1=97") && !valid("MOTION_Y0=-5") && !valid("MOTION_Y1=1000"), "outside the picture");
    TEST_ASSERT(!valid("MOTION_X0=1.5") && !valid("MOTION_Y1=abc") && !valid("MOTION_X1=") && !valid("MOTION_Y0=12px"), "not whole numbers");
}

TEST(the_motion_area_settings_have_flash_safe_names_and_can_be_changed_from_the_dashboard) {
    const char* names[] = { "MOTION_X0", "MOTION_Y0", "MOTION_X1", "MOTION_Y1" };
    std::vector<std::string> locked = personLockedKeys();
    for (int i = 0; i < 4; ++i) {
        const KeyDef* d = findKey(PERSON_SCHEMA, names[i]);
        TEST_ASSERT(d != nullptr && d->kind == Kind::Int && d->cond == Cond::Always, (std::string(names[i]) + ": an always-needed whole number").c_str());
        bool isLocked = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == names[i]) isLocked = true;
        TEST_ASSERT(!isLocked, (std::string(names[i]) + ": not locked - the dashboard's picture edits it").c_str());
    }
}

TEST(the_four_motion_area_numbers_must_make_a_usable_area) {
    MemoryStore st;
    store(st, COMPLETE);                                   // 0,0 - 96,96
    TEST_ASSERT(store(st, "MOTION_X0=20;MOTION_Y0=30;MOTION_X1=70;MOTION_Y1=80"), "a good area, all four together");
    TEST_ASSERT(store(st, "MOTION_X1=30"), "a single edge may move while the result stays usable (20..30 = 10 wide)");
    std::vector<std::string> e = storeLine(st, "MOTION_X1=29");
    TEST_ASSERT(anyError(e, "at least 10 pixels") && anyError(e, "in one line"), "9 wide: refused, with the way out");
    TEST_ASSERT(anyError(e, "MOTION_X0/Y0/X1/Y1 (20,30,29,80)"), "and the message shows the four numbers it judged");
    TEST_ASSERT(st.m["MOTION_X1"] == "30", "and nothing was stored");
    e = storeLine(st, "MOTION_X0=40");
    TEST_ASSERT(!e.empty() && st.m["MOTION_X0"] == "20", "the left edge past the right one: refused");
    TEST_ASSERT(store(st, "MOTION_X0=40;MOTION_X1=90"), "both together move the area: each alone would clash with the stored one");
    e = storeLine(st, "MOTION_Y1=35");
    TEST_ASSERT(anyError(e, "at least 10 pixels"), "too low (30..35)");
    TEST_ASSERT(store(st, "MOTION_Y0=0;MOTION_Y1=96"), "the full height again");
    TEST_ASSERT(store(st, "MOTION_X0=86;MOTION_Y0=86;MOTION_X1=96;MOTION_Y1=96"), "the smallest area, in a corner");
}

TEST(the_motion_area_rule_waits_until_a_number_breaks_the_area_and_leaves_the_threshold_rule_working) {
    MemoryStore blank;
    // The default area (0,0 - 96,96) is in force even on a blank board, so a single bad edge is caught at
    // once: the rule judges the line's values against the defaults for the other three.
    std::vector<std::string> e = storeLine(blank, "MOTION_X1=5");
    TEST_ASSERT(!e.empty() && anyError(e, "at least 10 pixels") && anyError(e, "MOTION_X0/Y0/X1/Y1 (0,0,5,96)"), "the bad edge is judged against the default area");
    TEST_ASSERT(!blank.m.count("MOTION_X1"), "and it is not stored");
    TEST_ASSERT(store(blank, "MOTION_X0=50"), "a good edge alone is accepted (0,50 - 96,96 is usable)");

    MemoryStore st;
    store(st, COMPLETE);
    e = storeLine(st, "CLEAR_THRESH=0.7");
    TEST_ASSERT(anyError(e, "CLEAR_THRESH (0.7) must not be higher than DETECT_THRESH (0.6)"), "the threshold rule still applies");
    e = storeLine(st, "CLEAR_THRESH=0.7;MOTION_X1=5");
    TEST_ASSERT(e.size() == 1 && anyError(e, "CLEAR_THRESH"), "when both rules are broken the first is reported (one message at a time)");
}

TEST(the_motion_area_loads_into_the_typed_settings) {
    MemoryStore st;
    store(st, COMPLETE);
    TEST_ASSERT(store(st, "MOTION_X0=10;MOTION_Y0=20;MOTION_X1=60;MOTION_Y1=90"), "an area is stored");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(10, 20, 60, 90), "loaded as left, top, right, bottom");
    st.m["MOTION_X0"] = "200";                              // damaged in flash behind the rules' back
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "MOTION_X0 is invalid"), "a stored number out of range is named and refuses the load");
    st.m["MOTION_X0"] = "95";                               // in range on its own, but no area together with the others
    TEST_ASSERT(loadPersonSettings(st, s, err), "each number alone is fine, so it loads (the rule only runs when a line is typed)...");
    std::string why;
    TEST_ASSERT(!person_scene::motionAreaUsable(s.motionArea, person_scene::FRAME_SIZE, person_scene::FRAME_SIZE, why),
                "...and the sketch's sampler then refuses that area and watches the whole picture (see configureScene)");
}

// ── the motion auto-calibration (motion_baseline.h) ─────────────────────

TEST(the_motion_ema_settings_are_whole_numbers_in_their_ranges_and_zero_length_switches_it_off) {
    TEST_ASSERT(valid("MOTION_EMA_LEN=0") && valid("MOTION_EMA_LEN=3000") && valid("MOTION_EMA_LEN=100000"), "length 0 (off) .. 100000 frames");
    TEST_ASSERT(!valid("MOTION_EMA_LEN=100001") && !valid("MOTION_EMA_LEN=-1") && !valid("MOTION_EMA_LEN=") && !valid("MOTION_EMA_LEN=1.5") && !valid("MOTION_EMA_LEN=long"),
                "outside / empty / not a whole number");
    TEST_ASSERT(valid("MOTION_EMA_PCT=0") && valid("MOTION_EMA_PCT=30") && valid("MOTION_EMA_PCT=1000"), "percentage 0 .. 1000");
    TEST_ASSERT(!valid("MOTION_EMA_PCT=1001") && !valid("MOTION_EMA_PCT=-30") && !valid("MOTION_EMA_PCT=") && !valid("MOTION_EMA_PCT=30%") && !valid("MOTION_EMA_PCT=0.3"),
                "outside / empty / not a whole number");
}

TEST(the_ema_percentage_is_only_asked_for_while_the_ema_is_on) {
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "a complete configuration with MOTION_EMA_LEN=0");
    TEST_ASSERT(!st.m.count("MOTION_EMA_PCT"), "it holds no percentage");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "and needs none while the EMA is off");

    TEST_ASSERT(store(st, "MOTION_EMA_LEN=3000"), "switching the EMA on...");
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT(ps.size() == 1 && listed(ps, "MOTION_EMA_PCT") && ps[0].missing, "...makes exactly the percentage needed, as not set");
    TEST_ASSERT(store(st, "MOTION_EMA_PCT=30"), "30 is accepted");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "complete again");

    TEST_ASSERT(store(st, "MOTION_EMA_LEN=0"), "switching it off again...");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "...needs nothing more (the stored percentage just stays)");
}

TEST(a_stored_ema_percentage_out_of_range_is_named_only_while_the_ema_is_on) {
    MemoryStore st;
    store(st, COMPLETE);
    st.m["MOTION_EMA_PCT"] = "5000";   // damaged in flash behind the rules' back
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "unused while MOTION_EMA_LEN=0: nobody is bothered by it");
    st.m["MOTION_EMA_LEN"] = "3000";
    std::vector<Problem> ps = findProblems(PERSON_SCHEMA, st);
    TEST_ASSERT(ps.size() == 1 && ps[0].key == "MOTION_EMA_PCT" && !ps[0].missing, "in use it is reported as invalid, not as missing");
}

TEST(the_ema_settings_load_into_the_typed_copy_and_off_keeps_the_threshold_fixed) {
    MemoryStore st;
    store(st, COMPLETE);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT_EQ((int)s.motionEmaLength, 0, "length 0 = off (the original behaviour)");
    TEST_ASSERT_EQ((int)s.motionEmaPercent, 30, "the percentage is the default 30 when none is stored");

    st.m["MOTION_EMA_PCT"] = "80";   // left over from an earlier try
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT_EQ((int)s.motionEmaPercent, 30, "a stored percentage is not read while the EMA is off");

    TEST_ASSERT(store(st, "MOTION_EMA_LEN=3000;MOTION_EMA_PCT=50"), "EMA on, 50% above the average");
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT_EQ((int)s.motionEmaLength, 3000, "length loaded");
    TEST_ASSERT_EQ((int)s.motionEmaPercent, 50, "percentage loaded");

    st.m.erase("MOTION_EMA_PCT");
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "MOTION_EMA_PCT is not set"), "EMA on without its percentage: refused, and named");
}

// ── the conversation on a blank detector ────────────────────────────────

TEST(a_blank_detector_is_configured_with_one_line_and_restarts) {
    MemoryStore st;
    ScriptConsole con;
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    con.in = COMPLETE + "\n";
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; t < 200 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Restart, "restart after all the settings");
    TEST_ASSERT(con.said("These settings need a value (" + std::to_string(requiredKeyCount(PERSON_SCHEMA)) + ")"), "first it asked for the settings without a default");
    TEST_ASSERT(con.said("WIFI - ") && con.said("DETECTOR_ID - "), "the identity ones, with their help text");
    TEST_ASSERT(!con.said("DETECT_THRESH - "), "not a defaulted one");
}

TEST(secrets_of_the_live_view_are_masked_when_the_settings_are_shown) {
    MemoryStore st;
    ScriptConsole con;
    store(st, COMPLETE);
    BootConfigFlow flow(PERSON_SCHEMA, st, con, 5000);
    flow.step(1000);
    TEST_ASSERT(con.said("API_KEY=********") && con.said("WIFI=extender-1:****:extender-2:****"), "masked");
    TEST_ASSERT(!con.said("s3cret") && !con.said("password1"), "no secret on the serial port");
    TEST_ASSERT(con.said("DETECTOR_ID=detector-1") && con.said("DETECT_THRESH=0.6"), "ordinary values shown");
}

// ── typed settings ──────────────────────────────────────────────────────

TEST(settings_load_into_typed_fields) {
    MemoryStore st;
    store(st, COMPLETE);
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.6f && s.clearThreshold == 0.5f && s.loopDelayMs == 10, "detection");
    TEST_ASSERT(s.darkThreshold == 40 && s.motionThreshold == 300 && s.motionHoldSec == 10, "scene gate");
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(0, 0, 96, 96), "motion area");
    TEST_ASSERT(s.wifi.size() == 2 && s.wifi[1].pass == "pass;word2", "wifi, decoded");
    TEST_ASSERT(s.serverHost == "192.168.4.9" && s.httpPort == 8080 && s.apiKey == "s3cret" && s.detectorId == "detector-1", "relay");
    TEST_ASSERT(s.streamMaxFps == 10 && s.streamJpegQuality == 80 && s.streamWriteTimeoutSec == 3, "stream tuning");
    TEST_ASSERT(s.announceHeartbeatSec == 600 && s.announceRetrySec == 30, "announce timing");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(the_documented_typical_values_are_the_defaults_of_the_struct_the_glue_test_relies_on) {
    PersonSettings s;
    TEST_ASSERT(s.personGpio == 13 && s.detectThreshold == 0.60f && s.clearThreshold == 0.50f && s.loopDelayMs == 10,
                "test_person_detect_glue.cpp is written around these values");
    // The scene gate is ON with the template's usual values, so that test switches it per case (sceneGate()).
    TEST_ASSERT(s.darkThreshold == 40 && s.motionThreshold == 300 && s.motionHoldSec == 10,
                "the gate's defaults are the template's values");
    TEST_ASSERT(s.motionArea == person_scene::MotionArea(0, 0, 96, 96), "and the whole picture watched for motion");
}

TEST(loading_refuses_missing_or_invalid_settings_and_says_which) {
    MemoryStore st;
    PersonSettings s;
    std::string err;
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "PERSON_GPIO is not set"), "blank board");
    store(st, COMPLETE);
    st.m["STREAM_MAX_FPS"] = "0";
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "STREAM_MAX_FPS is invalid"), "an invalid stored value");
}

// ── Hardware & internals (F-29 T5c): pin map, camera driver, task stacks, boot restart ──
// (That every meta row names a real key once and every default is a valid stored value is proven for
// the WHOLE of PERSON_META in test_person_settings_defaults.cpp — T5a's mirror of the recorder's
// test_settings_defaults.cpp; the tests here are the ones specific to the hardware group.)

// The keys T5c turned into settings, with the values the sketch hard-coded before.
static const char* const T5C_KEYS[] = {
    "PIN_PWDN", "PIN_RESET", "PIN_XCLK", "PIN_SIOD", "PIN_SIOC",
    "PIN_Y9", "PIN_Y8", "PIN_Y7", "PIN_Y6", "PIN_Y5", "PIN_Y4", "PIN_Y3", "PIN_Y2",
    "PIN_VSYNC", "PIN_HREF", "PIN_PCLK",
    "CAM_XCLK_HZ", "CAM_FB_COUNT", "CAM_INIT_TRIES", "STK_LOG_B", "STK_NET_B",
    "SER_BAUD", "SER_RXBUF_B", "BOOT_FAIL_MS",
};

TEST(a_board_from_before_t5c_loads_with_the_values_the_sketch_always_used) {
    // A deployed board holds only what the settings engine asked for before F-29 T5c: the detection
    // and live-view keys below (COMPLETE), nothing of the hardware group. It must come up unchanged.
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "an old board's stored settings");
    size_t storedBefore = st.m.size();
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pinPwdn == 32 && s.pinReset == -1 && s.pinXclk == 0 && s.pinSiod == 26 && s.pinSioc == 27, "the control pins");
    TEST_ASSERT(s.pinY9 == 35 && s.pinY8 == 34 && s.pinY7 == 39 && s.pinY6 == 36 &&
                s.pinY5 == 21 && s.pinY4 == 19 && s.pinY3 == 18 && s.pinY2 == 5, "the eight data pins");
    TEST_ASSERT(s.pinVsync == 25 && s.pinHref == 23 && s.pinPclk == 22, "the sync pins");
    TEST_ASSERT(s.camXclkHz == 20000000 && s.camFbCount == 2 && s.camInitTries == 3, "the camera driver");
    TEST_ASSERT(s.stkLogBytes == 8192 && s.stkNetBytes == 16384, "the task stacks");
    TEST_ASSERT(s.bootFailRestartMs == 30000, "the restart after a failed start");
    TEST_ASSERT_EQ((int)st.m.size(), (int)storedBefore, "loading stored nothing: a default is never written to flash");
}

TEST(a_stored_hardware_value_wins_over_the_default) {
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "stored");
    TEST_ASSERT(store(st, "PIN_Y2=25;STK_NET_B=20480;SER_BAUD=9600;BOOT_FAIL_MS=60000"), "changed hardware values");
    PersonSettings s;
    std::string err;
    TEST_ASSERT(loadPersonSettings(st, s, err), ("loads: " + err).c_str());
    TEST_ASSERT(s.pinY2 == 25 && s.stkNetBytes == 20480 && s.bootFailRestartMs == 60000, "the stored values are used");
}

TEST(a_damaged_stored_hardware_value_is_reported_not_hidden_by_the_default) {
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "stored");
    st.m["PIN_XCLK"] = "banana";                          // behind the rules' back, as flash damage
    PersonSettings s;
    std::string err;
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "PIN_XCLK is invalid"), "refuses, and names the key");
    st.m["PIN_XCLK"] = "0";
    st.m["PIN_Y9"] = "99";                                // a whole number, but outside 0..39
    TEST_ASSERT(!loadPersonSettings(st, s, err) && has(err, "PIN_Y9 is invalid"), "out of range: refused too");
}

TEST(hardware_values_out_of_range_are_refused_when_typed_or_changed) {
    const char* bad[][2] = { {"PIN_PWDN", "99"}, {"PIN_PWDN", "40"}, {"PIN_Y2", "-2"}, {"PIN_RESET", "-2"},
                             {"CAM_XCLK_HZ", "1999999"}, {"CAM_XCLK_HZ", "40000001"}, {"CAM_FB_COUNT", "0"},
                             {"CAM_FB_COUNT", "5"}, {"CAM_INIT_TRIES", "0"}, {"STK_LOG_B", "4095"},
                             {"STK_NET_B", "8191"}, {"SER_BAUD", "9599"}, {"SER_RXBUF_B", "100"},
                             {"BOOT_FAIL_MS", "999"} };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i)
        TEST_ASSERT(!valid((std::string(bad[i][0]) + "=" + bad[i][1]).c_str()), (std::string(bad[i][0]) + "=" + bad[i][1] + " is refused").c_str());
    const char* good[][2] = { {"PIN_RESET", "-1"}, {"PIN_PWDN", "39"}, {"CAM_XCLK_HZ", "20000000"},
                              {"SER_BAUD", "5000000"}, {"STK_NET_B", "65536"}, {"BOOT_FAIL_MS", "3600000"} };
    for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); ++i)
        TEST_ASSERT(valid((std::string(good[i][0]) + "=" + good[i][1]).c_str()), (std::string(good[i][0]) + "=" + good[i][1] + " is accepted").c_str());
}

TEST(the_hardware_settings_are_expert_tier_need_a_restart_and_are_not_locked) {
    std::vector<std::string> locked = personLockedKeys();
    for (size_t i = 0; i < sizeof(T5C_KEYS) / sizeof(T5C_KEYS[0]); ++i) {
        const KeyMeta* m = findMeta(PERSON_SCHEMA.meta, PERSON_SCHEMA.metaCount, T5C_KEYS[i]);
        const KeyDef* def = findKey(PERSON_SCHEMA, T5C_KEYS[i]);
        TEST_ASSERT(def && def->kind == Kind::Int, (std::string(T5C_KEYS[i]) + " is a plain whole number: the board's wiring, not a choice among the pins a user may drive").c_str());
        TEST_ASSERT(m && m->tier == Tier::Expert, (std::string(T5C_KEYS[i]) + " is Expert tier").c_str());
        TEST_ASSERT(m && m->apply == Apply::Reboot, (std::string(T5C_KEYS[i]) + " needs a restart").c_str());
        TEST_ASSERT(m && std::string(m->category) == "Hardware & internals", (std::string(T5C_KEYS[i]) + " is in Hardware & internals").c_str());
        bool isLocked = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == T5C_KEYS[i]) isLocked = true;
        TEST_ASSERT(!isLocked, (std::string(T5C_KEYS[i]) + " is not locked: a wrong pin map breaks the camera, not the relay link, so the dashboard can repair it").c_str());
    }
    // The serial port's two settings are also keys, though the sketch reads them before the settings
    // engine runs (earlySerialSetup in the .ino): they are validated and defaulted like every other.
    TEST_ASSERT(hasDefault(PERSON_SCHEMA, "SER_BAUD") && hasDefault(PERSON_SCHEMA, "SER_RXBUF_B"), "the serial settings have defaults");
    TEST_ASSERT(valid("SER_BAUD=115200") && valid("SER_RXBUF_B=2048") && !valid("SER_BAUD=8") && !valid("SER_BAUD=6000000"), "and are range-checked");
}

// ── the setup settings (F-21): the same two as the recorder ─────────────

TEST(the_detector_defines_the_two_setup_settings_as_designed) {
    const KeyDef* mode = findKey(PERSON_SCHEMA, "SETUP_MODE");
    const KeyDef* pw = findKey(PERSON_SCHEMA, "SETUP_PASSWORD");
    TEST_ASSERT(mode && mode->kind == Kind::Bool && mode->cond == Cond::Optional, "SETUP_MODE: an optional switch");
    TEST_ASSERT(pw && pw->kind == Kind::Secret && pw->cond == Cond::Optional && pw->min == 8 && pw->max == 63, "SETUP_PASSWORD: an optional secret, 8 to 63 characters");
    std::vector<std::string> locked = personLockedKeys();
    bool modeLocked = false, pwLocked = false;
    for (size_t i = 0; i < locked.size(); ++i) { if (locked[i] == "SETUP_MODE") modeLocked = true; if (locked[i] == "SETUP_PASSWORD") pwLocked = true; }
    TEST_ASSERT(!modeLocked, "SETUP_MODE can be switched from the dashboard");
    TEST_ASSERT(pwLocked, "SETUP_PASSWORD is serial-only / setup-form-only");
}

TEST(a_detector_deployed_before_the_feature_is_complete_and_can_be_armed) {
    MemoryStore st;
    TEST_ASSERT(store(st, COMPLETE), "a configuration without the setup settings");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "complete");
    TEST_ASSERT_EQ(st.badGets, 0, "the absent optional settings are never read");
    ChangeResult r = applyChangeLine(PERSON_SCHEMA, st, "SETUP_MODE=1", personLockedKeys());
    TEST_ASSERT(r.ok() && st.m["SETUP_MODE"] == "1", "the dashboard may arm it");
    TEST_ASSERT(findProblems(PERSON_SCHEMA, st).empty(), "still complete");
    TEST_ASSERT(!applyChangeLine(PERSON_SCHEMA, st, "SETUP_PASSWORD=attacker-chosen-pw", personLockedKeys()).ok(), "but not choose the password");
}

int main() {
    RUN_TEST(the_person_schema_is_consistent);
    RUN_TEST(the_example_person_template_is_a_valid_complete_configuration);
    RUN_TEST(a_blank_detector_is_asked_only_for_the_settings_without_a_default_and_the_flash_is_only_read_where_a_value_exists);
    RUN_TEST(the_live_view_identity_settings_are_always_required);
    RUN_TEST(the_scene_gate_settings_are_numbers_in_their_ranges_and_zero_switches_a_check_off);
    RUN_TEST(a_board_that_predates_the_scene_gate_is_complete_and_uses_the_default_gate_values);
    RUN_TEST(a_board_from_before_the_motion_area_runs_on_the_default_whole_picture_area);
    RUN_TEST(the_old_stream_switch_is_gone_and_a_board_that_still_has_it_stored_ignores_it);
    RUN_TEST(the_output_gpio_must_be_a_pin_the_board_leaves_free);
    RUN_TEST(thresholds_are_scores_between_0_01_and_1);
    RUN_TEST(loop_delay_and_stream_tuning_ranges);
    RUN_TEST(the_lan_servers_settings_are_gone_the_live_view_is_pushed_to_the_relay);
    RUN_TEST(a_board_that_still_has_the_old_server_settings_stored_is_not_asked_for_anything);
    RUN_TEST(clear_threshold_must_not_exceed_the_detect_threshold);
    RUN_TEST(the_threshold_rule_works_in_the_boot_conversation);
    RUN_TEST(each_motion_area_number_is_a_whole_number_from_0_to_96);
    RUN_TEST(the_motion_area_settings_have_flash_safe_names_and_can_be_changed_from_the_dashboard);
    RUN_TEST(the_four_motion_area_numbers_must_make_a_usable_area);
    RUN_TEST(the_motion_area_rule_waits_until_a_number_breaks_the_area_and_leaves_the_threshold_rule_working);
    RUN_TEST(the_motion_area_loads_into_the_typed_settings);
    RUN_TEST(the_motion_ema_settings_are_whole_numbers_in_their_ranges_and_zero_length_switches_it_off);
    RUN_TEST(the_ema_percentage_is_only_asked_for_while_the_ema_is_on);
    RUN_TEST(a_stored_ema_percentage_out_of_range_is_named_only_while_the_ema_is_on);
    RUN_TEST(the_ema_settings_load_into_the_typed_copy_and_off_keeps_the_threshold_fixed);
    RUN_TEST(a_blank_detector_is_configured_with_one_line_and_restarts);
    RUN_TEST(secrets_of_the_live_view_are_masked_when_the_settings_are_shown);
    RUN_TEST(settings_load_into_typed_fields);
    RUN_TEST(the_documented_typical_values_are_the_defaults_of_the_struct_the_glue_test_relies_on);
    RUN_TEST(loading_refuses_missing_or_invalid_settings_and_says_which);
    RUN_TEST(a_board_from_before_t5c_loads_with_the_values_the_sketch_always_used);
    RUN_TEST(a_stored_hardware_value_wins_over_the_default);
    RUN_TEST(a_damaged_stored_hardware_value_is_reported_not_hidden_by_the_default);
    RUN_TEST(hardware_values_out_of_range_are_refused_when_typed_or_changed);
    RUN_TEST(the_hardware_settings_are_expert_tier_need_a_restart_and_are_not_locked);
    RUN_TEST(the_detector_defines_the_two_setup_settings_as_designed);
    RUN_TEST(a_detector_deployed_before_the_feature_is_complete_and_can_be_armed);
    return test::summarize();
}
