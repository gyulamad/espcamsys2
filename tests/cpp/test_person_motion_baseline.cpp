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

static void feed(MotionBaseline& b, uint32_t motion, int frames) {
    for (int i = 0; i < frames; ++i) b.observe(motion);
}

// ── off ─────────────────────────────────────────────────────────────────

TEST(a_baseline_that_was_never_configured_is_off_and_leaves_the_threshold_alone) {
    MotionBaseline b;
    TEST_ASSERT(!b.enabled(), "off");
    b.observe(5000);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "it learns nothing");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the floor comes back untouched");
    TEST_ASSERT_EQ((int)b.threshold(0), 0, "also a floor of 0");
}

TEST(length_zero_switches_it_off_whatever_the_percentage) {
    MotionBaseline b;
    b.configure(0, 30);
    TEST_ASSERT(!b.enabled(), "length 0 = off");
    feed(b, 800, 100);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "nothing learnt");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the threshold stays the fixed one");
    b.configure(0, 1000);
    feed(b, 800, 100);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "also with a huge percentage");
}

TEST(any_length_above_zero_switches_it_on) {
    MotionBaseline b;
    b.configure(1, 30);
    TEST_ASSERT(b.enabled(), "length 1 is the smallest that counts");
    b.configure(100000, 30);
    TEST_ASSERT(b.enabled(), "and the largest the setting allows");
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
    b.observe(400);
    TEST_ASSERT(near(b.average(), 400.0, 1e-9), "seeded with the reading itself");
    TEST_ASSERT_EQ((int)b.threshold(0), 520, "400 + 30%");
}

TEST(each_reading_moves_the_average_by_2_over_length_plus_1_of_the_difference) {
    MotionBaseline b;
    b.configure(3, 0);   // alpha = 2 / (3 + 1) = 0.5
    b.observe(100);
    b.observe(200);
    TEST_ASSERT(near(b.average(), 150.0, 1e-9), "100 + 0.5 * (200 - 100)");
    b.observe(0);
    TEST_ASSERT(near(b.average(), 75.0, 1e-9), "150 + 0.5 * (0 - 150)");

    MotionBaseline c;
    c.configure(9, 0);   // alpha = 0.2
    c.observe(100);
    c.observe(600);
    TEST_ASSERT(near(c.average(), 200.0, 1e-9), "100 + 0.2 * 500");
}

TEST(length_one_follows_the_last_reading_exactly) {
    MotionBaseline b;
    b.configure(1, 0);   // alpha = 2 / 2 = 1
    b.observe(100);
    b.observe(700);
    TEST_ASSERT(near(b.average(), 700.0, 1e-9), "no smoothing at all");
}

// ── the threshold ───────────────────────────────────────────────────────

TEST(the_threshold_is_the_average_plus_the_percentage) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(1000);
    TEST_ASSERT_EQ((int)b.threshold(0), 1300, "+30%");
    b.configure(3000, 100);
    b.observe(1000);
    TEST_ASSERT_EQ((int)b.threshold(0), 2000, "+100% doubles it");
    b.configure(3000, 0);
    b.observe(1000);
    TEST_ASSERT_EQ((int)b.threshold(0), 1000, "+0% is the average itself");
}

TEST(the_threshold_is_rounded_to_the_nearest_whole_number) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(101);   // 131.3
    TEST_ASSERT_EQ((int)b.threshold(0), 131, "131.3 -> 131");
    b.configure(3000, 30);
    b.observe(105);   // 136.5
    TEST_ASSERT_EQ((int)b.threshold(0), 137, "136.5 -> 137");
    b.configure(3, 0);
    b.observe(3);
    b.observe(4);     // average 3.5
    TEST_ASSERT_EQ((int)b.threshold(0), 4, "3.5 -> 4");
}

TEST(the_fixed_threshold_is_the_floor_the_average_can_only_raise_it) {
    MotionBaseline b;
    b.configure(3000, 30);
    b.observe(50);   // 65 is far below the floor
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "a calm scene behaves as without the EMA");
    b.configure(3000, 30);
    b.observe(1000); // 1300 is above it
    TEST_ASSERT_EQ((int)b.threshold(300), 1300, "a noisy one raises it");
    b.configure(3000, 30);
    b.observe(230);  // 299
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "just below the floor: the floor");
    b.configure(3000, 30);
    b.observe(231);  // 300.3 -> 300
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "equal to the floor");
    b.configure(3000, 30);
    b.observe(232);  // 301.6 -> 302
    TEST_ASSERT_EQ((int)b.threshold(300), 302, "just above it");
}

TEST(a_storm_raises_the_threshold_and_it_comes_back_down_when_the_storm_is_over) {
    MotionBaseline b;
    b.configure(9, 30);   // alpha 0.2: settles within a couple of dozen frames
    feed(b, 100, 50);
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "calm: 130 is below the floor");
    feed(b, 500, 100);
    TEST_ASSERT(near(b.average(), 500.0, 0.01), "the storm's noise level has been learnt");
    TEST_ASSERT_EQ((int)b.threshold(300), 650, "500 + 30%: the noise no longer reaches the threshold");
    feed(b, 10, 100);
    TEST_ASSERT(near(b.average(), 10.0, 0.01), "and forgotten again");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "back to the floor");
}

TEST(a_short_burst_such_as_a_person_walking_through_barely_moves_a_long_average) {
    MotionBaseline b;
    b.configure(3000, 30);   // a few minutes of frames
    feed(b, 100, 1);
    feed(b, 2000, 50);       // a person crossing the picture for 50 frames
    TEST_ASSERT(b.average() < 170.0, "the average rose by well under a tenth of the burst's height");
    TEST_ASSERT(b.threshold(100) < 230, "so the threshold is still low");
    TEST_ASSERT(2000 >= b.threshold(100), "and the person's own motion is far above it");
}

// ── configure ───────────────────────────────────────────────────────────

TEST(configure_starts_over_and_forgets_what_the_old_settings_learnt) {
    MotionBaseline b;
    b.configure(100, 30);
    feed(b, 900, 10);
    TEST_ASSERT(b.average() > 0.0, "learnt something");
    b.configure(100, 30);
    TEST_ASSERT(near(b.average(), 0.0, 0.0), "average cleared");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "and the first reading seeds it again, not 'moves' it");
    b.observe(40);
    TEST_ASSERT(near(b.average(), 40.0, 1e-9), "seeded afresh");
}

TEST(configure_can_switch_it_off_again) {
    MotionBaseline b;
    b.configure(100, 30);
    feed(b, 900, 10);
    b.configure(0, 30);
    TEST_ASSERT(!b.enabled(), "off");
    TEST_ASSERT_EQ((int)b.threshold(300), 300, "the fixed threshold again");
}

// ── limits ──────────────────────────────────────────────────────────────

TEST(extreme_readings_never_wrap_the_threshold_around) {
    MotionBaseline b;
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(UINT32_MAX);
    TEST_ASSERT(b.threshold(300) == UINT32_MAX, "saturates at the largest value instead of wrapping to a small one");
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(390451572);   // x 11 = 4294967292, rounds to just below the limit
    TEST_ASSERT(b.threshold(0) >= 4294967000u, "just below the limit it is exact");
}

TEST(the_largest_possible_real_motion_reading_is_far_from_any_limit) {
    // 255 per sample pixel, 100 sample pixels (scene_logic.h): the biggest a frame can show.
    MotionBaseline b;
    b.configure(3000, MAX_MOTION_EMA_PERCENT);
    b.observe(255u * 100u);
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
    RUN_TEST(each_reading_moves_the_average_by_2_over_length_plus_1_of_the_difference);
    RUN_TEST(length_one_follows_the_last_reading_exactly);
    RUN_TEST(the_threshold_is_the_average_plus_the_percentage);
    RUN_TEST(the_threshold_is_rounded_to_the_nearest_whole_number);
    RUN_TEST(the_fixed_threshold_is_the_floor_the_average_can_only_raise_it);
    RUN_TEST(a_storm_raises_the_threshold_and_it_comes_back_down_when_the_storm_is_over);
    RUN_TEST(a_short_burst_such_as_a_person_walking_through_barely_moves_a_long_average);
    RUN_TEST(configure_starts_over_and_forgets_what_the_old_settings_learnt);
    RUN_TEST(configure_can_switch_it_off_again);
    RUN_TEST(extreme_readings_never_wrap_the_threshold_around);
    RUN_TEST(the_largest_possible_real_motion_reading_is_far_from_any_limit);
    RUN_TEST(the_setting_limits_are_what_the_schema_and_the_documentation_say);
    return test::summarize();
}
