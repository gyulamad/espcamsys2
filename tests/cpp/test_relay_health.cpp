// test_relay_health.cpp — unit tests for relay_health.h: the relay is "down"
// (relay-find should run) only when it has not been CONFIRMED — a bare TCP
// connect is not a confirmation, and the class has no method that would let one
// in. No ESP32, no Arduino core.

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/relay_health.h"

TEST(relay_is_down_until_first_confirmation) {
    RelayHealth h;
    TEST_ASSERT(h.isDown(0, 30000), "never confirmed: down immediately");
    TEST_ASSERT(h.isDown(100000, 30000), "still down after 100 s with no confirmation");
}

TEST(confirm_means_not_down_within_threshold) {
    RelayHealth h;
    h.confirm(1000);
    TEST_ASSERT(!h.isDown(1000, 500), "just confirmed: not down");
    TEST_ASSERT(!h.isDown(1499, 500), "within the threshold: not down");
    TEST_ASSERT(h.isDown(1501, 500), "past the threshold: down again");
}

TEST(confirm_measured_from_the_last_call) {
    RelayHealth h;
    h.confirm(1000);
    h.confirm(2000);
    h.confirm(3000);
    TEST_ASSERT_EQ(h.lastConfirmedMs(), 3000u, "the last confirm wins");
    TEST_ASSERT(!h.isDown(3499, 500), "the threshold is measured from the last confirm");
    TEST_ASSERT(h.isDown(3501, 500), "and eventually expires");
}

TEST(wrong_host_404_loop_leaves_the_relay_down) {
    RelayHealth h;
    TEST_ASSERT(h.isDown(31000, 30000), "30 s of 404-loops: relay is down, relay-find runs");
    TEST_ASSERT(h.isDown(91000, 90000), "90 s (detector threshold): same, just a longer threshold");
}

TEST(millis_wrap_around_is_harmless) {
    RelayHealth h;
    h.confirm(0xFFFFFFF0);
    TEST_ASSERT(!h.isDown(0xFFFFFFF0 + 0x10, 500), "32 ms after confirm near the wrap: not down");
    TEST_ASSERT(!h.isDown(0x10, 500), "across the wrap: 32 ms elapsed, within threshold");
    TEST_ASSERT(h.isDown(0x210, 500), "past the threshold across the wrap: down");
}

int main() {
    RUN_TEST(relay_is_down_until_first_confirmation);
    RUN_TEST(confirm_means_not_down_within_threshold);
    RUN_TEST(confirm_measured_from_the_last_call);
    RUN_TEST(wrong_host_404_loop_leaves_the_relay_down);
    RUN_TEST(millis_wrap_around_is_harmless);
    return test::summarize();
}
