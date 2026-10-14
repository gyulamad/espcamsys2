// test_person_scene_logic.cpp — unit tests for the person detector's darkness +
// motion gate (ESP32_CAM_TFLite_Person/scene_logic.h). No ESP32, no Arduino core.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_scene_logic test_person_scene_logic.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_TFLite_Person/scene_logic.h"

using namespace person_scene;

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

static const int W = 96, H = 96;

static std::vector<uint8_t> frame(uint8_t gray) { return std::vector<uint8_t>(W * H, gray); }

// ── the sampler: which pixels, and what is measured ─────────────────────

TEST(a_96x96_frame_is_sampled_at_every_10th_pixel_in_both_directions_100_samples) {
    SceneSampler s(W, H);
    TEST_ASSERT_EQ((int)s.sampleCount(), 100, "x = 0,10..90 and y = 0,10..90");
    SceneSampler odd(25, 11);
    TEST_ASSERT_EQ((int)odd.sampleCount(), 3 * 2, "x = 0,10,20 and y = 0,10");
}

TEST(brightness_is_the_average_gray_of_the_sample_pixels_only) {
    SceneSampler s(W, H);
    TEST_ASSERT_EQ(s.analyze(frame(0).data()).brightness, 0, "black");
    TEST_ASSERT_EQ(s.analyze(frame(255).data()).brightness, 255, "white");
    TEST_ASSERT_EQ(s.analyze(frame(77).data()).brightness, 77, "flat gray");

    // Pixels that are not on the 10x10 grid do not count.
    std::vector<uint8_t> f = frame(100);
    for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) if (x % 10 != 0 || y % 10 != 0) f[y * W + x] = 255;
    TEST_ASSERT_EQ(s.analyze(f.data()).brightness, 100, "only the grid pixels are looked at");

    // Half the samples at 0 and half at 200 -> 100.
    std::vector<uint8_t> g = frame(0);
    for (int y = 0; y < H; y += 10) for (int x = 0; x < W; x += 10) if (y < 50) g[y * W + x] = 200;
    TEST_ASSERT_EQ(s.analyze(g.data()).brightness, 100, "average of the samples");
}

TEST(brightness_is_rounded_to_the_nearest_whole_value) {
    SceneSampler s(W, H);
    std::vector<uint8_t> f = frame(10);
    f[0] = 11;   // one sample 1 higher: 10.01 -> 10
    TEST_ASSERT_EQ(s.analyze(f.data()).brightness, 10, "10.01 rounds to 10");
    std::vector<uint8_t> g = frame(10);
    for (int i = 0; i < 60; ++i) g[(i / 10) * 10 * W + (i % 10) * 10] = 11;   // 60 of 100 samples +1: 10.6
    TEST_ASSERT_EQ(s.analyze(g.data()).brightness, 11, "10.6 rounds to 11");
}

TEST(the_first_frame_has_no_motion_reading_because_there_is_nothing_to_compare_to) {
    SceneSampler s(W, H);
    SceneReading r = s.analyze(frame(200).data());
    TEST_ASSERT(!r.hasPrevious, "no previous frame yet");
    TEST_ASSERT_EQ((int)r.motion, 0, "motion is 0 then, not 'a jump from black'");
    TEST_ASSERT(s.analyze(frame(200).data()).hasPrevious, "from the second frame on there is one");
}

TEST(motion_is_the_sum_of_absolute_differences_to_the_previous_frame_samples) {
    SceneSampler s(W, H);
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frame(100).data()).motion, 0, "identical frames: no motion");
    // Every sample 5 brighter: 100 samples * 5.
    TEST_ASSERT_EQ((int)s.analyze(frame(105).data()).motion, 500, "+5 on 100 samples");
    // And back down: differences are absolute, so this counts the same.
    TEST_ASSERT_EQ((int)s.analyze(frame(100).data()).motion, 500, "-5 on 100 samples");
    // One sample changing by 200, the rest not.
    std::vector<uint8_t> f = frame(100);
    f[0] = 0;   // pixel (0,0) is a sample: |0 - 100| = 100
    TEST_ASSERT_EQ((int)s.analyze(f.data()).motion, 100, "a single sample changes by 100");
}

TEST(motion_ignores_changes_between_the_sample_pixels) {
    SceneSampler s(W, H);
    s.analyze(frame(50).data());
    std::vector<uint8_t> f = frame(50);
    f[1] = 255; f[W + 5] = 0; f[95 * W + 95] = 255;   // none of these is on the grid
    TEST_ASSERT_EQ((int)s.analyze(f.data()).motion, 0, "off-grid pixels do not count");
}

TEST(motion_compares_with_the_frame_just_before_not_with_the_first_one) {
    SceneSampler s(W, H);
    s.analyze(frame(0).data());
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frame(100).data()).motion, 0, "the lamp stayed on: no motion any more");
}

TEST(a_degenerate_sampler_does_not_crash) {
    SceneSampler none(0, 0);
    TEST_ASSERT_EQ((int)none.sampleCount(), 0, "no samples");
    TEST_ASSERT_EQ(none.analyze(nullptr).brightness, 0, "null frame, no samples: zeros");
    SceneSampler s(W, H);
    SceneReading r = s.analyze(nullptr);
    TEST_ASSERT(r.brightness == 0 && r.motion == 0, "a null frame reads as nothing");
    SceneSampler stepZero(20, 20, 0);   // a step below 1 is taken as 1: every pixel
    TEST_ASSERT_EQ((int)stepZero.sampleCount(), 400, "step 0 -> step 1");
}

// ── the gate ────────────────────────────────────────────────────────────

static SceneReading reading(int brightness, uint32_t motion, bool hasPrevious = true) {
    SceneReading r; r.brightness = brightness; r.motion = motion; r.hasPrevious = hasPrevious; return r;
}

static SceneConfig cfg(int dark, uint32_t motion, uint32_t holdMs) {
    SceneConfig c; c.darkBelow = dark; c.motionAtLeast = motion; c.holdMs = holdMs; return c;
}

TEST(with_both_checks_off_the_gate_is_always_active_and_never_reports_a_change) {
    SceneGate g(cfg(0, 0, 0));
    for (uint32_t t = 0; t < 5; ++t) {
        SceneVerdict v = g.update(t * 100, reading(0, 0), false);
        TEST_ASSERT(v.run && v.state == SceneState::Active, "runs even on a black, still picture");
        TEST_ASSERT(!v.changed && !v.clearPerson, "and says nothing about it");
    }
}

TEST(dark_pictures_pause_detection) {
    SceneGate g(cfg(40, 0, 0));
    SceneVerdict v = g.update(0, reading(39, 9999), false);
    TEST_ASSERT(v.state == SceneState::Dark && !v.run, "brightness 39 < 40 is dark, even with plenty of motion");
    TEST_ASSERT(v.changed, "going dark is reported");
    TEST_ASSERT(!g.update(100, reading(39, 9999), false).changed, "but only once");
}

TEST(the_darkness_threshold_itself_counts_as_light) {
    SceneGate g(cfg(40, 0, 0));
    TEST_ASSERT(g.update(0, reading(40, 0), false).run, "brightness 40 is not below 40");
}

TEST(darkness_ends_only_a_little_above_the_threshold_so_dusk_does_not_flicker) {
    SceneGate g(cfg(40, 0, 0));
    g.update(0, reading(30, 0), false);                                   // dark
    TEST_ASSERT(g.update(10, reading(40, 0), false).state == SceneState::Dark, "40: still dark (needs 45)");
    TEST_ASSERT(g.update(20, reading(44, 0), false).state == SceneState::Dark, "44: still dark");
    TEST_ASSERT(g.update(30, reading(45, 0), false).state == SceneState::Active, "45 = threshold + hysteresis: light again");
    TEST_ASSERT(g.update(40, reading(41, 0), false).state == SceneState::Active, "41 is light once light (not below 40)");
    TEST_ASSERT(g.update(50, reading(39, 0), false).state == SceneState::Dark, "39: dark again");
}

TEST(a_person_flagged_in_the_dark_is_cleared_but_not_when_it_is_light) {
    SceneGate g(cfg(40, 0, 0));
    TEST_ASSERT(g.update(0, reading(10, 0), true).clearPerson, "dark + person flagged: drop it");
    TEST_ASSERT(!g.update(10, reading(10, 0), false).clearPerson, "dark, nothing flagged: nothing to clear");
    TEST_ASSERT(!g.update(20, reading(200, 0), true).clearPerson, "light + person: keep");
}

TEST(without_motion_the_gate_is_idle_and_with_motion_it_is_active) {
    SceneGate g(cfg(0, 300, 0));
    SceneVerdict v = g.update(0, reading(120, 0), false);
    TEST_ASSERT(v.state == SceneState::Idle && !v.run, "still picture: idle");
    TEST_ASSERT(v.changed, "leaving the initial 'active' is reported");
    v = g.update(100, reading(120, 299), false);
    TEST_ASSERT(v.state == SceneState::Idle, "299 < 300");
    v = g.update(200, reading(120, 300), false);
    TEST_ASSERT(v.state == SceneState::Active && v.run && v.changed, "300 >= 300 is motion");
    v = g.update(300, reading(120, 0), false);
    TEST_ASSERT(v.state == SceneState::Idle && v.changed, "and with hold 0 it is idle again as soon as it stops");
}

TEST(the_first_frame_never_counts_as_motion) {
    SceneGate g(cfg(0, 300, 0));
    TEST_ASSERT(g.update(0, reading(120, 99999, false), false).state == SceneState::Idle,
                "no previous frame: its 'motion' value is meaningless");
}

TEST(detection_stays_on_for_the_hold_time_after_the_last_motion) {
    SceneGate g(cfg(0, 300, 10000));                                      // hold 10 s
    g.update(1000, reading(120, 500), false);                             // motion at t = 1 s
    TEST_ASSERT(g.update(5000, reading(120, 0), false).run, "4 s later: still on");
    TEST_ASSERT(g.update(11000, reading(120, 0), false).run, "exactly 10 s after: still on");
    TEST_ASSERT(!g.update(11001, reading(120, 0), false).run, "10.001 s after: off");
    g.update(20000, reading(120, 400), false);                            // moves again
    TEST_ASSERT(g.update(25000, reading(120, 0), false).run, "the hold starts over from the newest motion");
}

TEST(motion_that_does_not_reach_the_threshold_does_not_extend_the_hold) {
    SceneGate g(cfg(0, 300, 5000));
    g.update(0, reading(120, 400), false);
    g.update(4000, reading(120, 299), false);
    TEST_ASSERT(!g.update(5001, reading(120, 299), false).run, "only real motion restarts the hold");
}

TEST(a_flagged_person_keeps_detection_running_without_motion) {
    SceneGate g(cfg(0, 300, 0));
    SceneVerdict v = g.update(0, reading(120, 0), true);
    TEST_ASSERT(v.run && v.state == SceneState::Active, "someone standing still is not lost");
    TEST_ASSERT(!g.update(100, reading(120, 0), false).run, "once nothing is flagged it goes idle");
}

TEST(a_person_flagged_does_not_keep_detection_running_in_the_dark) {
    SceneGate g(cfg(40, 300, 0));
    SceneVerdict v = g.update(0, reading(5, 0), true);
    TEST_ASSERT(!v.run && v.state == SceneState::Dark, "darkness wins over a flagged person");
}

TEST(the_hold_survives_the_millis_wrap_around) {
    SceneGate g(cfg(0, 300, 10000));
    uint32_t nearEnd = 0xFFFFFFFFu - 2000u;
    g.update(nearEnd, reading(120, 500), false);
    TEST_ASSERT(g.update(nearEnd + 5000u, reading(120, 0), false).run, "5 s later, across the wrap: still on");
    TEST_ASSERT(!g.update(nearEnd + 20000u, reading(120, 0), false).run, "20 s later: off");
}

TEST(configure_starts_afresh) {
    SceneGate g(cfg(40, 300, 10000));
    g.update(0, reading(5, 0), false);
    g.update(10, reading(100, 900), false);
    g.configure(cfg(40, 300, 10000));
    TEST_ASSERT(g.update(20, reading(100, 0), false).state == SceneState::Idle, "remembers no old motion");
    TEST_ASSERT_EQ(g.config().darkBelow, 40, "config is readable back");
}

TEST(dark_and_motion_together_light_and_moving_runs_the_model) {
    SceneGate g(cfg(40, 300, 2000));
    TEST_ASSERT(g.update(0, reading(120, 0, false), false).state == SceneState::Idle, "light, nothing moved yet");
    TEST_ASSERT(g.update(100, reading(120, 800), false).run, "light and moving: run");
    TEST_ASSERT(!g.update(200, reading(20, 800), false).run, "moving but dark: do not run");
}

// ── the log lines ───────────────────────────────────────────────────────

TEST(each_state_has_a_readable_serial_line) {
    SceneConfig c = cfg(40, 300, 0);
    std::string dark = describeScene(SceneState::Dark, reading(12, 0), c);
    std::string idle = describeScene(SceneState::Idle, reading(120, 7), c);
    std::string active = describeScene(SceneState::Active, reading(120, 812), c);
    TEST_ASSERT(has(dark, "DARK") && has(dark, "brightness 12 < 40"), dark.c_str());
    TEST_ASSERT(has(idle, "still") && has(idle, "motion 7 < 300"), idle.c_str());
    TEST_ASSERT(has(active, "active") && has(active, "motion 812") && has(active, "brightness 120"), active.c_str());
}

int main() {
    RUN_TEST(a_96x96_frame_is_sampled_at_every_10th_pixel_in_both_directions_100_samples);
    RUN_TEST(brightness_is_the_average_gray_of_the_sample_pixels_only);
    RUN_TEST(brightness_is_rounded_to_the_nearest_whole_value);
    RUN_TEST(the_first_frame_has_no_motion_reading_because_there_is_nothing_to_compare_to);
    RUN_TEST(motion_is_the_sum_of_absolute_differences_to_the_previous_frame_samples);
    RUN_TEST(motion_ignores_changes_between_the_sample_pixels);
    RUN_TEST(motion_compares_with_the_frame_just_before_not_with_the_first_one);
    RUN_TEST(a_degenerate_sampler_does_not_crash);

    RUN_TEST(with_both_checks_off_the_gate_is_always_active_and_never_reports_a_change);
    RUN_TEST(dark_pictures_pause_detection);
    RUN_TEST(the_darkness_threshold_itself_counts_as_light);
    RUN_TEST(darkness_ends_only_a_little_above_the_threshold_so_dusk_does_not_flicker);
    RUN_TEST(a_person_flagged_in_the_dark_is_cleared_but_not_when_it_is_light);
    RUN_TEST(without_motion_the_gate_is_idle_and_with_motion_it_is_active);
    RUN_TEST(the_first_frame_never_counts_as_motion);
    RUN_TEST(detection_stays_on_for_the_hold_time_after_the_last_motion);
    RUN_TEST(motion_that_does_not_reach_the_threshold_does_not_extend_the_hold);
    RUN_TEST(a_flagged_person_keeps_detection_running_without_motion);
    RUN_TEST(a_person_flagged_does_not_keep_detection_running_in_the_dark);
    RUN_TEST(the_hold_survives_the_millis_wrap_around);
    RUN_TEST(configure_starts_afresh);
    RUN_TEST(dark_and_motion_together_light_and_moving_runs_the_model);

    RUN_TEST(each_state_has_a_readable_serial_line);

    return test::summarize();
}
