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

// ── the motion area ─────────────────────────────────────────────────────
//
// The part of the picture that is watched for motion (MOTION_X0/Y0/X1/Y1): x0/y0 are the first column/row
// inside it, x1/y1 the first one outside. Only the sample pixels inside it add to the motion reading.

// The frame `base`, with the sample pixel at (x, y) set to `value`.
static std::vector<uint8_t> frameWith(uint8_t base, int x, int y, uint8_t value) {
    std::vector<uint8_t> f = frame(base);
    f[y * W + x] = value;
    return f;
}

TEST(the_motion_area_is_the_whole_picture_until_one_is_set) {
    SceneSampler s(W, H);
    TEST_ASSERT(s.motionArea() == MotionArea(0, 0, 96, 96), "default 0,0 - 96,96");
    TEST_ASSERT(MotionArea() == MotionArea(0, 0, FRAME_SIZE, FRAME_SIZE), "the type's own default is the same");
    TEST_ASSERT(MotionArea(1, 2, 30, 40) != MotionArea(1, 2, 30, 41), "areas compare by all four numbers");
    SceneSampler odd(25, 11);
    TEST_ASSERT(odd.motionArea() == MotionArea(0, 0, 25, 11), "on another size, the whole of THAT picture");
    s.analyze(frame(0).data());
    TEST_ASSERT_EQ((int)s.analyze(frame(1).data()).motion, 100, "so every sample counts: 100 samples * 1");
}

TEST(a_motion_area_must_lie_inside_the_picture_and_be_at_least_one_sample_step_wide_and_high) {
    std::string err;
    TEST_ASSERT(motionAreaUsable(MotionArea(0, 0, 96, 96), W, H, err), "the whole picture");
    TEST_ASSERT(motionAreaUsable(MotionArea(86, 86, 96, 96), W, H, err), "10x10 in the corner: the smallest allowed");
    TEST_ASSERT(motionAreaUsable(MotionArea(5, 5, 15, 15), W, H, err), "10x10 between the grid lines still holds a sample (10,10)");

    TEST_ASSERT(!motionAreaUsable(MotionArea(-1, 0, 96, 96), W, H, err) && has(err, "inside the 96x96 picture"), "left of the picture");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, -1, 96, 96), W, H, err), "above the picture");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, 0, 97, 96), W, H, err), "right of the picture");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, 0, 96, 97), W, H, err), "below the picture");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, 0, 9, 96), W, H, err) && has(err, "at least 10 pixels"), "too narrow");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, 0, 96, 9), W, H, err), "too low");
    TEST_ASSERT(!motionAreaUsable(MotionArea(50, 0, 40, 96), W, H, err), "right edge left of the left edge");
    TEST_ASSERT(!motionAreaUsable(MotionArea(40, 40, 40, 96), W, H, err), "nothing in it at all");
    TEST_ASSERT(!motionAreaUsable(MotionArea(0, 0, 96, 96), 50, 50, err), "judged against the picture it is given");
}

TEST(every_usable_motion_area_contains_at_least_one_sample_pixel) {
    // The reason for the minimum size: an area with no sample in it would read 0 motion forever.
    for (int x0 = 0; x0 + SAMPLE_STEP <= W; ++x0) {
        bool found = false;
        for (int x = x0; x < x0 + SAMPLE_STEP; ++x) if (x % SAMPLE_STEP == 0) found = true;
        TEST_ASSERT(found, "a 10 wide span always holds a multiple of 10");
        if (!found) return;
    }
}

TEST(only_sample_pixels_inside_the_motion_area_add_to_the_motion_reading) {
    SceneSampler s(W, H);
    TEST_ASSERT(s.setMotionArea(MotionArea(20, 30, 60, 70)), "the area is accepted");   // samples x = 20,30,40,50  y = 30,40,50,60
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frame(105).data()).motion, 4 * 4 * 5, "16 samples inside * 5");
    TEST_ASSERT_EQ((int)s.analyze(frameWith(105, 30, 40, 205).data()).motion, 100, "a change inside counts");
    TEST_ASSERT_EQ((int)s.analyze(frameWith(105, 80, 40, 5).data()).motion, 100, "the sample inside returning to 105 counts (100), the outside one dropping to 5 does not");
}

TEST(motion_outside_the_motion_area_is_ignored) {
    SceneSampler s(W, H);
    s.setMotionArea(MotionArea(0, 0, 50, 50));      // top left quarter
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 90, 90, 0).data()).motion, 0, "the far corner moves: not watched");
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 50, 50, 0).data()).motion, 0, "just outside (50,50): not watched");
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 90, 0, 0).data()).motion, 0, "right of the area, same rows");
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 0, 90, 0).data()).motion, 0, "below the area, same columns");
}

TEST(the_left_and_top_edges_are_inside_the_area_and_the_right_and_bottom_edges_are_outside) {
    SceneSampler s(W, H);
    s.setMotionArea(MotionArea(20, 20, 60, 60));    // samples 20,30,40,50 in both directions
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 20, 20, 0).data()).motion, 100, "(20,20) is the first sample inside");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 50, 50, 0).data()).motion, 100, "(50,50) is the last sample inside");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 60, 60, 0).data()).motion, 0, "(60,60): x1 and y1 are exclusive");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 10, 10, 0).data()).motion, 0, "(10,10): outside");
}

TEST(an_area_that_ends_just_after_a_sample_includes_it_and_one_that_starts_just_after_excludes_it) {
    SceneSampler s(W, H);
    s.setMotionArea(MotionArea(1, 1, 31, 31));      // samples 10,20,30 (0 is left of x0=1)
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 0, 0, 0).data()).motion, 0, "(0,0) is outside, x0=1");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 30, 30, 0).data()).motion, 100, "(30,30) is inside, x1=31");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frame(110).data()).motion, 3 * 3 * 10, "3x3 samples inside");
}

TEST(brightness_is_always_taken_over_the_whole_picture_not_only_the_motion_area) {
    SceneSampler s(W, H);
    s.setMotionArea(MotionArea(0, 0, 20, 20));      // only 4 samples
    std::vector<uint8_t> f = frame(0);
    for (int y = 0; y < H; y += 10) for (int x = 0; x < W; x += 10) if (x >= 20 || y >= 20) f[y * W + x] = 200;   // everything but the area is bright
    TEST_ASSERT_EQ(s.analyze(f.data()).brightness, (96 * 200 + 50) / 100, "96 of the 100 samples at 200, 4 at 0");
}

TEST(a_refused_motion_area_leaves_the_previous_one_in_place) {
    SceneSampler s(W, H);
    TEST_ASSERT(s.setMotionArea(MotionArea(0, 0, 50, 50)), "a good one");
    TEST_ASSERT(!s.setMotionArea(MotionArea(0, 0, 5, 50)), "too narrow: refused");
    TEST_ASSERT(!s.setMotionArea(MotionArea(0, 0, 200, 200)), "outside the picture: refused");
    TEST_ASSERT(s.motionArea() == MotionArea(0, 0, 50, 50), "the good one is still the area");
    s.analyze(frame(100).data());
    TEST_ASSERT_EQ((int)s.analyze(frameWith(100, 90, 90, 0).data()).motion, 0, "and it still ignores the far corner");
}

TEST(changing_the_motion_area_keeps_comparing_with_the_frame_just_before) {
    // The sampler remembers every sample, not only the ones inside the area, so a new area never compares
    // against stale or zero data (which would read as a burst of motion).
    SceneSampler s(W, H);
    s.setMotionArea(MotionArea(0, 0, 50, 50));
    s.analyze(frame(100).data());
    s.analyze(frame(200).data());                   // everything changed, but only the top left was watched
    s.setMotionArea(MotionArea(0, 0, 96, 96));
    TEST_ASSERT_EQ((int)s.analyze(frame(200).data()).motion, 0, "the frame did not change: no motion, wherever the area is");
}

TEST(a_person_sized_movement_in_the_area_switches_the_gate_on_but_a_waving_tree_outside_does_not) {
    SceneSampler s(W, H);
    SceneConfig c;
    c.motionAtLeast = 300;
    SceneGate g(c);
    s.setMotionArea(MotionArea(0, 0, 60, 96));      // the left part; the tree stands on the right

    std::vector<uint8_t> still = frame(100);
    uint32_t t = 0;
    g.update(t, s.analyze(still.data()), false);

    // The tree: every sample in the right part flips by 80 -> 4 columns * 10 rows * 80 = 3200, far above 300.
    std::vector<uint8_t> tree = still;
    for (int y = 0; y < H; ++y) for (int x = 60; x < W; ++x) tree[y * W + x] = 20;
    t += 100;
    SceneReading tr = s.analyze(tree.data());
    SceneVerdict v = g.update(t, tr, false);
    TEST_ASSERT_EQ((int)tr.motion, 0, "the swaying tree adds nothing to the reading");
    TEST_ASSERT(v.state == SceneState::Idle && !v.run, "so the scene stays still and the model is not run");

    // A person walks in the watched part: 4 samples change by 100 = 400 >= 300.
    std::vector<uint8_t> person = tree;
    for (int y = 30; y < 50; ++y) for (int x = 10; x < 30; ++x) person[y * W + x] = 0;
    t += 100;
    SceneReading pr = s.analyze(person.data());
    v = g.update(t, pr, false);
    TEST_ASSERT_EQ((int)pr.motion, 400, "2x2 samples * 100");
    TEST_ASSERT(v.state == SceneState::Active && v.run, "and the gate switches detection on");
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

// ── the motion auto-calibration in the gate ─────────────────────────────

// A gate whose motion threshold follows a moving average of `emaFrames` frames (+ `percent`%); MOTION_THRESH is its floor.
static SceneConfig cfgEma(int dark, uint32_t motionFloor, uint32_t holdMs, uint32_t emaFrames, uint32_t percent) {
    SceneConfig c = cfg(dark, motionFloor, holdMs);
    c.motionEmaFrames = emaFrames;
    c.motionEmaPercent = percent;
    return c;
}

// Feeds `frames` readings of `motion`, 100 ms apart from `*t` on; returns the last verdict.
static SceneVerdict feedGate(SceneGate& g, uint32_t* t, uint32_t motion, int frames) {
    SceneVerdict v;
    for (int i = 0; i < frames; ++i) { *t += 100; v = g.update(*t, reading(120, motion), false); }
    return v;
}

TEST(a_config_without_the_ema_keeps_the_fixed_threshold_exactly_as_before) {
    SceneConfig c = cfg(0, 300, 0);
    TEST_ASSERT_EQ((int)c.motionEmaFrames, 0, "the length defaults to 0 = off");
    SceneGate g(c);
    g.configure(c);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "the threshold is MOTION_THRESH");
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    // A scene that keeps "moving" at 500: with the fixed threshold the model runs on every single frame, for ever.
    for (int i = 0; i < 300; ++i) {
        t += 100;
        SceneVerdict v = g.update(t, reading(120, 500), false);
        TEST_ASSERT(v.state == SceneState::Active && v.run, "still active");
        TEST_ASSERT_EQ((int)v.motionLimit, 300, "judged against the fixed threshold");
    }
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "and it never moved");
}

TEST(with_the_ema_on_a_scene_that_keeps_moving_stops_counting_as_motion_and_a_person_still_does) {
    SceneGate g(cfgEma(0, 300, 0, 9, 30));
    g.configure(cfgEma(0, 300, 0, 9, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);

    SceneVerdict v = feedGate(g, &t, 500, 1);
    TEST_ASSERT(v.state == SceneState::Active && v.motionLimit == 300, "at first the storm counts as motion: 500 >= 300");

    v = feedGate(g, &t, 500, 200);
    TEST_ASSERT_EQ((int)v.motionLimit, 650, "the threshold has followed the noise: 500 + 30%");
    TEST_ASSERT(v.state == SceneState::Idle && !v.run, "the storm no longer keeps the model busy");

    v = feedGate(g, &t, 2000, 1);
    TEST_ASSERT(v.state == SceneState::Active && v.run, "a person walking through (2000) is far above it");
    TEST_ASSERT_EQ((int)v.motionLimit, 650, "judged against the level the storm had made, not one the person's own motion raised");
}

TEST(the_threshold_never_drops_below_motion_thresh_so_a_calm_scene_is_unchanged) {
    SceneGate g(cfgEma(0, 300, 0, 9, 30));
    g.configure(cfgEma(0, 300, 0, 9, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    SceneVerdict v = feedGate(g, &t, 20, 200);   // sensor noise only: 20 + 30% = 26
    TEST_ASSERT_EQ((int)v.motionLimit, 300, "MOTION_THRESH is the floor");
    TEST_ASSERT(v.state == SceneState::Idle, "idle, as without the EMA");
    v = feedGate(g, &t, 300, 1);
    TEST_ASSERT(v.state == SceneState::Active, "and 300 still switches it on");
}

TEST(the_threshold_comes_back_down_after_the_storm) {
    SceneGate g(cfgEma(0, 300, 0, 9, 30));
    g.configure(cfgEma(0, 300, 0, 9, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    feedGate(g, &t, 500, 200);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 650, "raised");
    feedGate(g, &t, 10, 200);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "and down on the floor again");
}

TEST(a_frame_is_judged_before_it_is_learnt_so_a_spike_cannot_raise_its_own_bar) {
    SceneGate g(cfgEma(0, 100, 0, 3, 30));   // alpha 0.5
    g.configure(cfgEma(0, 100, 0, 3, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    feedGate(g, &t, 100, 1);   // seeds the average with 100
    SceneVerdict v = feedGate(g, &t, 1000, 1);
    TEST_ASSERT_EQ((int)v.motionLimit, 130, "the spike met the threshold of the average before it (100 + 30%)");
    TEST_ASSERT(v.state == SceneState::Active, "so it counts as motion");
    TEST_ASSERT_EQ((int)g.motionThreshold(), 715, "and only then raised the average to 550 -> 715 for the next frame");
}

TEST(the_first_frame_has_no_reading_so_the_average_does_not_learn_from_it) {
    SceneGate g(cfgEma(0, 300, 0, 9, 30));
    g.configure(cfgEma(0, 300, 0, 9, 30));
    SceneVerdict v = g.update(0, reading(120, 5000, false), false);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "nothing learnt from a frame that was compared with nothing");
    TEST_ASSERT(v.state == SceneState::Idle && !v.run, "and it is no motion either");
    g.update(100, reading(120, 400), false);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 520, "the first real reading (400) seeds it");
}

TEST(with_the_motion_check_off_the_ema_changes_nothing) {
    SceneGate g(cfgEma(0, 0, 0, 9, 30));
    g.configure(cfgEma(0, 0, 0, 9, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    SceneVerdict v = feedGate(g, &t, 800, 50);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 0, "MOTION_THRESH=0 stays 'off' however long the EMA is");
    TEST_ASSERT_EQ((int)v.motionLimit, 0, "reported as off");
    TEST_ASSERT(v.state == SceneState::Active && v.run, "every frame counts as moving, as before");
}

TEST(the_hold_time_and_the_person_rule_work_as_before_with_the_ema_on) {
    SceneGate g(cfgEma(0, 300, 1000, 9, 30));
    g.configure(cfgEma(0, 300, 1000, 9, 30));
    g.update(0, reading(120, 0, false), false);
    TEST_ASSERT(g.update(100, reading(120, 400), false).run, "motion");
    TEST_ASSERT(g.update(1000, reading(120, 0), false).run, "still held 900 ms later");
    TEST_ASSERT(!g.update(1200, reading(120, 0), false).run, "no longer after the hold");
    TEST_ASSERT(g.update(1300, reading(120, 0), true).run, "but a flagged person keeps it running");
}

TEST(darkness_works_as_before_with_the_ema_on) {
    SceneGate g(cfgEma(40, 300, 0, 9, 30));
    g.configure(cfgEma(40, 300, 0, 9, 30));
    g.update(0, reading(120, 0, false), false);
    SceneVerdict v = g.update(100, reading(10, 800), true);
    TEST_ASSERT(v.state == SceneState::Dark && v.clearPerson && !v.run, "dark pictures pause detection and clear a person");
}

TEST(configure_forgets_what_the_average_learnt) {
    SceneGate g(cfgEma(0, 300, 0, 9, 30));
    g.configure(cfgEma(0, 300, 0, 9, 30));
    uint32_t t = 0;
    g.update(t, reading(120, 0, false), false);
    feedGate(g, &t, 500, 200);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 650, "learnt");
    g.configure(cfgEma(0, 300, 0, 9, 30));
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "a new configuration starts from the floor");
    g.configure(cfgEma(0, 300, 0, 0, 30));
    feedGate(g, &t, 500, 200);
    TEST_ASSERT_EQ((int)g.motionThreshold(), 300, "and with the length 0 it does not learn at all");
}

TEST(the_idle_serial_line_shows_the_threshold_the_frame_was_judged_against) {
    SceneConfig c = cfgEma(40, 300, 0, 9, 30);
    std::string idle = describeScene(SceneState::Idle, reading(120, 500), c, 650);
    TEST_ASSERT(has(idle, "still") && has(idle, "motion 500 < 650"), idle.c_str());
    std::string fixed = describeScene(SceneState::Idle, reading(120, 7), c);
    TEST_ASSERT(has(fixed, "motion 7 < 300"), "the short form shows MOTION_THRESH");
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

    RUN_TEST(the_motion_area_is_the_whole_picture_until_one_is_set);
    RUN_TEST(a_motion_area_must_lie_inside_the_picture_and_be_at_least_one_sample_step_wide_and_high);
    RUN_TEST(every_usable_motion_area_contains_at_least_one_sample_pixel);
    RUN_TEST(only_sample_pixels_inside_the_motion_area_add_to_the_motion_reading);
    RUN_TEST(motion_outside_the_motion_area_is_ignored);
    RUN_TEST(the_left_and_top_edges_are_inside_the_area_and_the_right_and_bottom_edges_are_outside);
    RUN_TEST(an_area_that_ends_just_after_a_sample_includes_it_and_one_that_starts_just_after_excludes_it);
    RUN_TEST(brightness_is_always_taken_over_the_whole_picture_not_only_the_motion_area);
    RUN_TEST(a_refused_motion_area_leaves_the_previous_one_in_place);
    RUN_TEST(changing_the_motion_area_keeps_comparing_with_the_frame_just_before);
    RUN_TEST(a_person_sized_movement_in_the_area_switches_the_gate_on_but_a_waving_tree_outside_does_not);

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

    RUN_TEST(a_config_without_the_ema_keeps_the_fixed_threshold_exactly_as_before);
    RUN_TEST(with_the_ema_on_a_scene_that_keeps_moving_stops_counting_as_motion_and_a_person_still_does);
    RUN_TEST(the_threshold_never_drops_below_motion_thresh_so_a_calm_scene_is_unchanged);
    RUN_TEST(the_threshold_comes_back_down_after_the_storm);
    RUN_TEST(a_frame_is_judged_before_it_is_learnt_so_a_spike_cannot_raise_its_own_bar);
    RUN_TEST(the_first_frame_has_no_reading_so_the_average_does_not_learn_from_it);
    RUN_TEST(with_the_motion_check_off_the_ema_changes_nothing);
    RUN_TEST(the_hold_time_and_the_person_rule_work_as_before_with_the_ema_on);
    RUN_TEST(darkness_works_as_before_with_the_ema_on);
    RUN_TEST(configure_forgets_what_the_average_learnt);
    RUN_TEST(the_idle_serial_line_shows_the_threshold_the_frame_was_judged_against);

    RUN_TEST(each_state_has_a_readable_serial_line);

    return test::summarize();
}
