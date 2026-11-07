// test_person_motion_baseline.cpp — unit tests for the motion auto-calibration's moving average
// (ESP32_CAM_TFLite_Person/motion_baseline.h). No ESP32, no Arduino core.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_motion_baseline test_person_motion_baseline.cpp
//
// The gate's use of it (the threshold the motion check really applies) is tested in
// test_person_scene_logic.cpp.

#include "framework.h"

#include <math.h>
#include <stdint.h>

#include "../../Arduino/ESP32_CAM_TFLite_Person/motion_baseline.h"

using namespace person_scene;

static bool near(double a, double b, double tolerance) { return fabs(a - b) <= tolerance; }

// `floor` is MOTION_THRESH. Most tests use a floor of 1: a floor that hardly gets in the way.
static void feed(MotionBaseline& b, uint32_t motion, int frames, uint32_t floor = 1) {
    for (int i = 0; i < frames; ++i) b.observe(motion, floor);
}

// ── off ─────────────────────────────────────────────────────────────────

TEST(a_baseline_that_was_never_configured_is_off_and_leaves_the_threshold_alone) {
    MotionBaseline b;
    TEST_ASSERT(!b.enabled(), "off");
    b.observe(5000, 300);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "it learns nothing");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the floor comes back untouched");
    TEST_ASSERT_EQ((int)b.threshold(0), 0, "also a floor of 0");
}

TEST(length_zero_switches_it_off_whatever_the_percentage) {
    MotionBaseline b;
    b.configure(0, 30);
    TEST_ASSERT(!b.enabled(), "length 0 = off");
    feed(b, 800, 100, 300);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "nothing learnt");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the threshold stays the fixed one");
    b.configure(0, 1000);
    feed(b, 800, 100, 300);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "also with a huge percentage");
}

TEST(any_length_above_zero_switches_it_on) {
    MotionBaseline b;
    b.configure(1, 30);
    TEST_ASSERT(b.enabled(), "on");
}

// ── learning ────────────────────────────────────────────────────────────

TEST(before_the_first_reading_the_threshold_is_the_floor) {
    MotionBaseline b;
    b.configure(100, 30);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "nothing learnt yet: not 0 * 1.3, the floor");
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "average 0");
}

TEST(the_first_reading_seeds_the_average_there_is_no_warm_up_from_zero) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(40, 300);
    TEST_ASSERT(near(b.average(), 40.0, 1e-9), "a calm first reading: seeded with the reading itself");
    b.configure(3000, 30);
    b.observe(150, 1000);
    TEST_ASSERT(near(b.average(), 150.0, 1e-9), "and again");
}

TEST(a_first_reading_above_what_the_floor_allows_is_seeded_at_that_not_at_the_spike) {
    // A camera that has just started shows big differences while its exposure settles. That reading
    // must not start the threshold above MOTION_THRESH (it did: minutes of a blind detector).
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(4000, 300);
    TEST_ASSERT(near(b.average(), 300.0 / 1.3, 1e-9), "floor / (1 + 30%)");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the threshold is the floor, as without the EMA");
}

TEST(each_reading_moves_the_average_by_2_over_length_plus_1_of_the_difference) {
    MotionBaseline b;
    b.configure(3, 0);   // alpha = 2 / (3 + 1) = 0.5
    b.observe(100, 1000);   // seeded: 100 (the floor allows 1000)
    b.observe(200, 1000);
    TEST_ASSERT(near(b.average(), 150.0, 1e-9), "100 + 0.5 * (200 - 100)");
    b.observe(0, 1000);
    TEST_ASSERT(near(b.average(), 75.0, 1e-9), "150 + 0.5 * (0 - 150)");

    MotionBaseline c;
    c.configure(9, 0);   // alpha = 0.2
    c.observe(100, 1000);
    c.observe(300, 1000);
    TEST_ASSERT(near(c.average(), 140.0, 1e-9), "100 + 0.2 * 200");
}

TEST(length_one_follows_the_last_reading_exactly) {
    MotionBaseline b;
    b.configure(1, 0);   // alpha = 2 / 2 = 1
    b.observe(100, 1000);
    b.observe(700, 1000);
    TEST_ASSERT(near(b.average(), 700.0, 1e-9), "no smoothing at all (700 is within twice the threshold of 1000)");
}

TEST(a_reading_counts_for_at_most_twice_the_threshold_in_force) {
    MotionBaseline b;
    b.configure(1, 0);   // alpha 1: the average is the (clipped) last reading
    b.observe(100, 300);                    // seeded 100; the threshold is the floor 300
    b.observe(5000, 300);
    TEST_ASSERT(near(b.average(), 600.0, 1e-9), "5000 counts as 2 * 300");
    b.observe(5000, 300);
    TEST_ASSERT(near(b.average(), 1200.0, 1e-9), "now the threshold is 600 (average + 0%), so 2 * 600");
    TEST_ASSERT_EQ((int)CLIP_FACTOR, 2, "the factor");
}

// ── the threshold ───────────────────────────────────────────────────────

TEST(the_threshold_is_the_average_plus_the_percentage) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(1000, 2000);
    TEST_ASSERT_EQ((int)b.threshold(0), 1300, "+30%");
    b.configure(3000, 100);
    b.observe(1000, 2000);
    TEST_ASSERT_EQ((int)b.threshold(0), 2000, "+100% doubles it");
    b.configure(3000, 0);
    b.observe(1000, 2000);
    TEST_ASSERT_EQ((int)b.threshold(0), 1000, "+0% is the average itself");
}

TEST(the_threshold_is_rounded_to_the_nearest_whole_number) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(101, 1000);   // 131.3
    TEST_ASSERT_EQ((int)b.threshold(0), 131, "131.3 -> 131");
    b.configure(3000, 30);
    b.observe(105, 1000);   // 136.5
    TEST_ASSERT_EQ((int)b.threshold(0), 137, "136.5 -> 137");
    b.configure(3, 0);
    b.observe(3, 1000);
    b.observe(4, 1000);     // average 3.5
    TEST_ASSERT_EQ((int)b.threshold(0), 4, "3.5 -> 4");
}

TEST(the_fixed_threshold_is_the_floor_the_average_can_only_raise_it) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(50, 300);   // 65 is far below the floor
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "a calm scene behaves as without the EMA");
    b.configure(3000, 30);
    b.observe(230, 300);  // 299
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "just below the floor: the floor");
    b.configure(3000, 30);
    b.observe(231, 300);  // 300.3 -> 300
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "equal to the floor");
    // The first reading can not seed above floor / 1.3 = 230.77, so a higher threshold needs time:
    b.configure(3000, 30);
    b.observe(1000, 300);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "a first reading of 1000 does not raise it");
    feed(b, 1000, 3000, 300);
    TEST_ASSERT(b.threshold(300) > 300, "readings that stay high do");
}

TEST(a_storm_raises_the_threshold_and_it_comes_back_down_when_the_storm_is_over) {
    MotionBaseline b;
    b.configure(9, 30);   // alpha 0.2: settles within a couple of dozen frames
    feed(b, 100, 50, 300);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "calm: 130 is below the floor");
    feed(b, 500, 100, 300);
    TEST_ASSERT(near(b.average(), 500.0, 0.01), "the storm's noise level has been learnt");
    TEST_ASSERT_EQ((int)b.threshold(300), 650, "500 + 30%: the noise no longer reaches the threshold");
    feed(b, 10, 100, 300);
    TEST_ASSERT(near(b.average(), 10.0, 0.01), "and forgotten again");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "back to the floor");
}

TEST(a_short_burst_such_as_a_person_walking_through_barely_moves_a_long_average) {
    MotionBaseline b;
    b.configure(3000, 30);   // a few minutes of frames
    feed(b, 100, 1, 300);
    feed(b, 2000, 50, 300);  // a person crossing the picture for 50 frames
    TEST_ASSERT(b.average() < 130.0, "the average rose by a few percent, not by the burst's height");
    TEST_ASSERT(b.threshold(300) == 300, "so the threshold is still the floor");
    TEST_ASSERT(2000 >= b.threshold(300), "and the person's own motion is far above it");
}

TEST(a_long_busy_spell_does_not_blind_the_detector_to_the_next_person) {
    // 90 s of a person working in the picture (10 frames a second), then someone walks by (motion 800).
    // Learnt without the clip, the threshold had climbed to 912 and the walk was not noticed at all.
    MotionBaseline b;
    b.configure(3000, 30);
    feed(b, 40, 6000, 300);
    feed(b, 1500, 900, 300);
    TEST_ASSERT(b.threshold(300) < 500, "the threshold is still low");
    TEST_ASSERT(800 >= b.threshold(300), "the walk is noticed");
}

TEST(noise_that_stays_above_the_threshold_still_raises_it_a_storm_is_learnt) {
    MotionBaseline b;
    b.configure(600, 30);
    feed(b, 40, 2000, 300);
    feed(b, 500, 6000, 300);
    TEST_ASSERT(b.threshold(300) > 600, "the bar went up above the noise (650 when settled)");
}

// ── configure ───────────────────────────────────────────────────────────

TEST(configure_starts_over_and_forgets_what_the_old_settings_learnt) {
    MotionBaseline b;
    b.configure(100, 30);
    feed(b, 900, 10, 300);
    TEST_ASSERT(b.average() > 0.0, "learnt something");
    b.configure(100, 30);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "average cleared");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "and the first reading seeds it again, not 'moves' it");
    b.observe(40, 300);
    TEST_ASSERT(near(b.average(), 40.0, 1e-9), "seeded afresh");
}

TEST(configure_can_switch_it_off_again) {
    MotionBaseline b;
    b.configure(100, 30);
    feed(b, 900, 10, 300);
    b.configure(0, 30);
    TEST_ASSERT(!b.enabled(), "off");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the fixed threshold again");
}

// ── limits ──────────────────────────────────────────────────────────────

TEST(extreme_readings_never_wrap_the_threshold_around) {
    MotionBaseline b;
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(UINT32_MAX, UINT32_MAX);
    TEST_ASSERT(b.threshold(300) == UINT32_MAX, "saturates at the largest value instead of wrapping to a small one");
    TEST_ASSERT(b.threshold(UINT32_MAX) == UINT32_MAX, "also as the floor");
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(390451572, UINT32_MAX);   // x 11 = 4294967292, rounds to just below the limit
    TEST_ASSERT(b.threshold(0) >= 4294967000u, "just below the limit it is exact");
}

TEST(the_largest_possible_real_motion_reading_is_far_from_any_limit) {
    // 255 per sample pixel, 100 sample pixels (scene_logic.h): the biggest a frame can show.
    MotionBaseline b;
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(255u * 100u, 255u * 100u * 11u);   // a floor that lets the reading seed in full
    TEST_ASSERT_EQ((int)b.threshold(0), 280500, "25500 + 1000%");
}

TEST(the_setting_limits_are_what_the_schema_and_the_documentation_say) {
    TEST_ASSERT_EQ((int)MAX_MOTION_EMA_LEN, 100000, "frames");
    TEST_ASSERT_EQ((int)MAX_MOTION_EMA_PERCENT, 1000, "percent");
    TEST_ASSERT_EQ((int)DEFAULT_MOTION_EMA_PERCENT, 30, "the usual percentage");
}

int main() {
    RUN_TEST(a_baseline_that_was_never_configured_is_off_and_leaves_the_threshold_alone);
    RUN_TEST(length_zero_switches_it_off_whatever_the_percentage);
    RUN_TEST(any_length_above_zero_switches_it_on);
    RUN_TEST(before_the_first_reading_the_threshold_is_the_floor);
    RUN_TEST(the_first_reading_seeds_the_average_there_is_no_warm_up_from_zero);
    RUN_TEST(a_first_reading_above_what_the_floor_allows_is_seeded_at_that_not_at_the_spike);
    RUN_TEST(each_reading_moves_the_average_by_2_over_length_plus_1_of_the_difference);
    RUN_TEST(length_one_follows_the_last_reading_exactly);
    RUN_TEST(a_reading_counts_for_at_most_twice_the_threshold_in_force);
    RUN_TEST(the_threshold_is_the_average_plus_the_percentage);
    RUN_TEST(the_threshold_is_rounded_to_the_nearest_whole_number);
    RUN_TEST(the_fixed_threshold_is_the_floor_the_average_can_only_raise_it);
    RUN_TEST(a_storm_raises_the_threshold_and_it_comes_back_down_when_the_storm_is_over);
    RUN_TEST(a_short_burst_such_as_a_person_walking_through_barely_moves_a_long_average);
    RUN_TEST(a_long_busy_spell_does_not_blind_the_detector_to_the_next_person);
    RUN_TEST(noise_that_stays_above_the_threshold_still_raises_it_a_storm_is_learnt);
    RUN_TEST(configure_starts_over_and_forgets_what_the_old_settings_learnt);
    RUN_TEST(configure_can_switch_it_off_again);
    RUN_TEST(extreme_readings_never_wrap_the_threshold_around);
    RUN_TEST(the_largest_possible_real_motion_reading_is_far_from_any_limit);
    RUN_TEST(the_setting_limits_are_what_the_schema_and_the_documentation_say);
    return test::summarize();
}
