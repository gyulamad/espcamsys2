// test_person_report_logic.cpp — unit tests for what the person detector reports to the relay
// (ESP32_CAM_TFLite_Person/report_logic.h). No ESP32, no Arduino core.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_report_logic test_person_report_logic.cpp

#include "framework.h"

#include <string>

#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"

using namespace person_report;

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

static Config cfg() {
    Config c;
    c.detectorId = "detector-1"; c.fw = "abc 1";
    c.gpioPin = 13; c.darkBelow = 40; c.motionAtLeast = 300; c.holdSec = 10; c.detectAt = 0.6f; c.clearAt = 0.5f;
    return c;
}

static Snapshot snap() {
    Snapshot s;
    s.valid = true; s.seq = 7; s.brightness = 120; s.motion = 812; s.gate = Gate::Active;
    s.hasScore = true; s.score = 0.74f; s.scoreAtMs = 1000; s.detected = true;
    return s;
}

// ── the gate's name ─────────────────────────────────────────────────────

TEST(gate_names_follow_the_scene_state) {
    using person_scene::SceneState;
    TEST_ASSERT(gateFor(SceneState::Dark, 40, 300) == Gate::Dark, "dark");
    TEST_ASSERT(gateFor(SceneState::Idle, 40, 300) == Gate::Still, "still");
    TEST_ASSERT(gateFor(SceneState::Active, 40, 300) == Gate::Active, "active");
    TEST_ASSERT(gateFor(SceneState::Active, 0, 300) == Gate::Active, "one check on is a real gate");
    TEST_ASSERT(gateFor(SceneState::Active, 40, 0) == Gate::Active, "the other one too");
    TEST_ASSERT(gateFor(SceneState::Active, 0, 0) == Gate::Off, "both checks off = the gate is off");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Dark)), std::string("dark"), "name dark");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Still)), std::string("still"), "name still");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Active)), std::string("active"), "name active");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Off)), std::string("off"), "name off");
}

// ── the JSON ────────────────────────────────────────────────────────────

TEST(url_names_the_relay_and_the_detector) {
    TEST_ASSERT_EQ(buildReportUrl("192.168.4.9", 8080, "detector-1"), std::string("http://192.168.4.9:8080/detector/detector-1"), "url");
}

TEST(a_full_report_carries_numbers_thresholds_pin_and_picture) {
    const uint8_t jpeg[] = {0xff, 0xd8, 0xff, 0xd9};
    std::string j = buildReportJson(cfg(), snap(), 1500, "192.168.4.37", -61, 42000, jpeg, sizeof(jpeg));
    TEST_ASSERT_EQ(j, std::string(
        "{\"ip\":\"192.168.4.37\",\"fw\":\"abc 1\",\"uptimeMs\":42000,\"rssi\":-61,"
        "\"gpio\":{\"pin\":13,\"high\":true},"
        "\"scene\":{\"state\":\"active\",\"brightness\":120,\"motion\":812,\"darkBelow\":40,\"motionAtLeast\":300,\"holdS\":10},"
        "\"person\":{\"score\":0.740,\"detectAt\":0.600,\"clearAt\":0.500,\"detected\":true},"
        "\"jpeg\":\"/9j/2Q==\"}"), "exact shape (the relay's parseReport reads exactly this)");
}

TEST(pin_low_and_no_person_and_no_picture) {
    Snapshot s = snap(); s.detected = false;
    std::string j = buildReportJson(cfg(), s, 1500, "10.0.0.2", -70, 5, nullptr, 0);
    TEST_ASSERT(has(j, "\"gpio\":{\"pin\":13,\"high\":false}"), "pin LOW");
    TEST_ASSERT(has(j, "\"detected\":false}"), "no person");
    TEST_ASSERT(!has(j, "jpeg"), "no picture member at all");
    TEST_ASSERT(j[0] == '{' && j[j.size() - 1] == '}', "one object");
    TEST_ASSERT(j.find('\n') == std::string::npos, "no line breaks");
}

TEST(a_stale_or_missing_score_is_null_because_the_model_is_paused) {
    Snapshot s = snap();
    TEST_ASSERT(has(buildReportJson(cfg(), s, 1000 + SCORE_FRESH_MS, "i", 0, 0, nullptr, 0), "\"score\":0.740"), "just fresh enough");
    TEST_ASSERT(has(buildReportJson(cfg(), s, 1000 + SCORE_FRESH_MS + 1, "i", 0, 0, nullptr, 0), "\"score\":null"), "one ms too old");
    s.hasScore = false;
    TEST_ASSERT(has(buildReportJson(cfg(), s, 1000, "i", 0, 0, nullptr, 0), "\"score\":null"), "never had one");
}

TEST(the_score_survives_the_millis_wrap) {
    Snapshot s = snap(); s.scoreAtMs = 0xFFFFFF00u;
    TEST_ASSERT(has(buildReportJson(cfg(), s, 0x100u, "i", 0, 0, nullptr, 0), "\"score\":0.740"), "0x200 ms after, across the wrap");
}

TEST(thresholds_and_gate_state_are_reported_as_configured) {
    Config c = cfg(); c.darkBelow = 0; c.motionAtLeast = 0; c.holdSec = 0;
    Snapshot s = snap(); s.gate = Gate::Off;
    std::string j = buildReportJson(c, s, 1000, "i", 0, 0, nullptr, 0);
    TEST_ASSERT(has(j, "\"state\":\"off\""), "gate off");
    TEST_ASSERT(has(j, "\"darkBelow\":0,\"motionAtLeast\":0,\"holdS\":0"), "checks off");
    s.gate = Gate::Dark; s.brightness = 12;
    j = buildReportJson(cfg(), s, 1000, "i", 0, 0, nullptr, 0);
    TEST_ASSERT(has(j, "\"state\":\"dark\"") && has(j, "\"brightness\":12"), "dark picture");
}

TEST(text_is_escaped_and_scores_are_clamped) {
    Config c = cfg(); c.fw = "a\"b\\c";
    Snapshot s = snap(); s.score = 1.7f; s.scoreAtMs = 1000;
    std::string j = buildReportJson(c, s, 1000, "i", 0, 0, nullptr, 0);
    TEST_ASSERT(has(j, "\"fw\":\"a\\\"b\\\\c\""), "quotes and backslash escaped");
    TEST_ASSERT(has(j, "\"score\":1.000"), "above 1 clamped");
    s.score = -0.2f;
    TEST_ASSERT(has(buildReportJson(c, s, 1000, "i", 0, 0, nullptr, 0), "\"score\":0.000"), "below 0 clamped");
}

// ── when to send ────────────────────────────────────────────────────────

TEST(nothing_is_sent_while_wifi_is_down_or_nothing_was_seen_yet) {
    ReportPolicy p;
    Snapshot s = snap();
    TEST_ASSERT(!p.due(1000, false, s), "Wi-Fi down");
    s.valid = false;
    TEST_ASSERT(!p.due(1000, true, s), "no frame yet");
}

TEST(the_first_report_is_due_at_once) {
    ReportPolicy p;
    TEST_ASSERT(p.due(1000, true, snap()), "first");
}

TEST(reports_are_spaced_by_the_minimum_gap_and_need_something_new) {
    ReportPolicy p(250, 1000, 5000);
    Snapshot s = snap();
    p.onResult(1000, true, s.seq);
    s.seq++;
    TEST_ASSERT(!p.due(1100, true, s), "new frame but too soon");
    TEST_ASSERT(p.due(1250, true, s), "new frame and the gap is over");
    Snapshot same = snap();
    TEST_ASSERT(!p.due(1500, true, same), "same frame as the last report: nothing new");
}

TEST(a_heartbeat_keeps_an_unchanged_detector_online) {
    ReportPolicy p(250, 1000, 5000);
    Snapshot s = snap();
    p.onResult(1000, true, s.seq);
    TEST_ASSERT(!p.due(1999, true, s), "before the heartbeat");
    TEST_ASSERT(p.due(2000, true, s), "heartbeat period over");
}

TEST(a_failed_delivery_is_retried_only_after_the_retry_wait) {
    ReportPolicy p(250, 1000, 5000);
    Snapshot s = snap();
    TEST_ASSERT(p.due(1000, true, s), "due");
    p.onResult(1000, false, s.seq);
    s.seq++;
    TEST_ASSERT(!p.due(1300, true, s), "failed a moment ago");
    TEST_ASSERT(!p.due(5999, true, s), "still waiting");
    TEST_ASSERT(p.due(6000, true, s), "retry wait over");
    p.onResult(6000, true, s.seq);
    TEST_ASSERT(!p.due(6100, true, s), "a success clears the failure and restarts the spacing");
}

TEST(the_spacing_survives_the_millis_wrap) {
    ReportPolicy p(250, 1000, 5000);
    Snapshot s = snap();
    p.onResult(0xFFFFFF00u, true, s.seq);
    s.seq++;
    TEST_ASSERT(p.due(0x00000010u, true, s), "272 ms after, across the wrap: due");
    TEST_ASSERT(!p.due(0xFFFFFF40u, true, s), "64 ms after: too soon");
}

int main() {
    RUN_TEST(gate_names_follow_the_scene_state);
    RUN_TEST(url_names_the_relay_and_the_detector);
    RUN_TEST(a_full_report_carries_numbers_thresholds_pin_and_picture);
    RUN_TEST(pin_low_and_no_person_and_no_picture);
    RUN_TEST(a_stale_or_missing_score_is_null_because_the_model_is_paused);
    RUN_TEST(the_score_survives_the_millis_wrap);
    RUN_TEST(thresholds_and_gate_state_are_reported_as_configured);
    RUN_TEST(text_is_escaped_and_scores_are_clamped);
    RUN_TEST(nothing_is_sent_while_wifi_is_down_or_nothing_was_seen_yet);
    RUN_TEST(the_first_report_is_due_at_once);
    RUN_TEST(reports_are_spaced_by_the_minimum_gap_and_need_something_new);
    RUN_TEST(a_heartbeat_keeps_an_unchanged_detector_online);
    RUN_TEST(a_failed_delivery_is_retried_only_after_the_retry_wait);
    RUN_TEST(the_spacing_survives_the_millis_wrap);
    return test::summarize();
}
