// test_setup_mode_session.cpp — unit tests for setup_session.h (F-21): the setup-mode session
// state machine, driven with a fake network, a fake form outcome, a fake flash store and a clock
// the test advances by hand. No ESP32, no Arduino core.

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/setup_session.h"

#include <stdint.h>
#include <string>
#include <vector>

using namespace esp32cam_setup;

namespace {

struct FakeNet : ISetupNet {
    int starts = 0, polls = 0, stops = 0;
    int failStarts = 0;  // the next N starts fail
    std::string lastSsid, lastPass;
    bool startAccessPoint(const std::string &ssid, const std::string &pass) override {
        starts++;
        lastSsid = ssid;
        lastPass = pass;
        if (failStarts > 0) { failStarts--; return false; }
        return true;
    }
    void poll() override { polls++; }
    void stop() override { stops++; }
    int calls() const { return starts + polls + stops; }
};

struct FakeOutcome : ISetupOutcome {
    bool wasSaved = false, wasExited = false;
    bool saved() const override { return wasSaved; }
    bool exited() const override { return wasExited; }
};

struct FakeStore : ISetupStore {
    int clears = 0, failClears = 0;  // the next N clears fail
    bool clearSetupMode() override {
        clears++;
        if (failClears > 0) { failClears--; return false; }
        return true;
    }
};

struct FakeLog : ISetupLog {
    std::vector<std::string> lines;
    void line(const std::string &text) override { lines.push_back(text); }
    bool contains(const std::string &needle) const {
        for (const std::string &l : lines)
            if (l.find(needle) != std::string::npos) return true;
        return false;
    }
};

const char *const PASSWORD = "S3cret-Pass!";
const char *const SSID = "espcamsys2-recorder-d4e5f6";
const uint32_t GRACE = 1500, RETRY = 5000;

SetupSessionConfig config(uint32_t graceMs = GRACE) {
    SetupSessionConfig c;
    c.ssid = SSID;
    c.password = PASSWORD;
    c.graceMs = graceMs;
    c.retryMs = RETRY;
    return c;
}

struct Rig {
    FakeNet net;
    FakeOutcome out;
    FakeStore store;
    FakeLog log;
    SetupMode mode;
    explicit Rig(bool active = true, uint32_t graceMs = GRACE)
        : mode(active, config(graceMs), net, out, store, &log) {}
};

}  // namespace

TEST(not_in_setup_proceeds_and_never_touches_the_net) {
    Rig r(false);
    bool allProceed = true;
    for (uint32_t t = 0; t < 100000; t += 777)
        if (r.mode.step(t) != SetupStep::Proceed) allProceed = false;
    r.mode.stop();
    TEST_ASSERT(allProceed, "every step answers Proceed");
    TEST_ASSERT_EQ(r.net.calls(), 0, "the network is never touched, not even stop()");
    TEST_ASSERT_EQ(r.store.clears, 0, "the flash is never touched");
    TEST_ASSERT(r.log.lines.empty(), "nothing is logged");
}

TEST(setup_opens_the_access_point_and_then_serves) {
    Rig r;
    TEST_ASSERT(r.mode.step(0) == SetupStep::Running, "the first step starts the access point");
    TEST_ASSERT_EQ(r.net.starts, 1, "one start");
    TEST_ASSERT_EQ(r.net.lastSsid, std::string(SSID), "with the SSID given");
    TEST_ASSERT_EQ(r.net.lastPass, std::string(PASSWORD), "and the password given");
    TEST_ASSERT_EQ(r.net.polls, 0, "the start step itself does not poll");
    TEST_ASSERT(r.mode.step(10) == SetupStep::Running, "then it keeps running");
    TEST_ASSERT_EQ(r.net.polls, 1, "and serves on every step");
    TEST_ASSERT_EQ(r.net.starts, 1, "without starting again");
    TEST_ASSERT_EQ(r.net.stops, 0, "and without stopping");
    TEST_ASSERT_EQ(r.store.clears, 0, "nothing is cleared while the user has not decided");
}

TEST(waits_forever_days_and_across_the_millis_wrap) {
    Rig r;
    r.mode.step(0);
    bool running = true;
    uint32_t t = 0;
    for (int hour = 0; hour < 240; hour++) {  // ten days, an hour at a time
        t += 3600u * 1000u;
        if (r.mode.step(t) != SetupStep::Running) running = false;
    }
    t = 0xFFFFFF00u;  // and right over the 32-bit millis() wrap
    for (int i = 0; i < 100; i++) {
        t += 50u;
        if (r.mode.step(t) != SetupStep::Running) running = false;
    }
    TEST_ASSERT(running, "still Running after days of waiting and across the millis() wrap");
    TEST_ASSERT_EQ(r.net.starts, 1, "the access point was started once");
    TEST_ASSERT_EQ(r.net.stops, 0, "and never torn down");
    TEST_ASSERT_EQ(r.store.clears, 0, "and SETUP_MODE untouched");
}

TEST(saved_clears_the_switch_serves_through_the_grace_then_restarts) {
    Rig r;
    r.mode.step(1000);
    r.mode.step(1100);
    r.out.wasSaved = true;
    int pollsBefore = r.net.polls;
    TEST_ASSERT(r.mode.step(2000) == SetupStep::Running, "saved: not restarted yet");
    TEST_ASSERT_EQ(r.store.clears, 1, "SETUP_MODE=0 is stored");
    TEST_ASSERT_EQ(r.net.polls, pollsBefore + 1, "the pages are still served (the browser gets its reply)");
    TEST_ASSERT(r.mode.step(3499) == SetupStep::Running, "1499 ms after the clear: still in the grace period");
    TEST_ASSERT_EQ(r.net.stops, 0, "the access point is still up");
    TEST_ASSERT(r.mode.step(3500) == SetupStep::Restart, "exactly the grace period after the clear: Restart");
    TEST_ASSERT_EQ(r.net.stops, 1, "the network is torn down once");
    TEST_ASSERT(r.mode.step(99999) == SetupStep::Restart, "Restart is sticky");
    r.mode.stop();
    TEST_ASSERT_EQ(r.net.stops, 1, "and later calls change nothing");
    TEST_ASSERT_EQ(r.store.clears, 1, "SETUP_MODE is cleared once, not again");
}

TEST(exit_behaves_like_saved) {
    Rig r;
    r.mode.step(1000);
    r.out.wasExited = true;
    TEST_ASSERT(r.mode.step(2000) == SetupStep::Running, "exited: not restarted yet");
    TEST_ASSERT_EQ(r.store.clears, 1, "SETUP_MODE=0 is stored");
    TEST_ASSERT(r.mode.step(3500) == SetupStep::Restart, "Restart after the grace period");
    TEST_ASSERT_EQ(r.net.stops, 1, "network torn down");
    TEST_ASSERT(r.log.contains("without saving"), "and the log says it was left without saving");
}

TEST(grace_is_counted_across_the_millis_wrap_and_may_be_zero) {
    Rig r;
    r.mode.step(0xFFFFFFF0u);
    r.out.wasSaved = true;
    TEST_ASSERT(r.mode.step(0xFFFFFFF8u) == SetupStep::Running, "just saved, near the wrap");
    TEST_ASSERT(r.mode.step(1490u) == SetupStep::Running, "1498 ms later, across the wrap: still grace");
    TEST_ASSERT(r.mode.step(1492u) == SetupStep::Restart, "1500 ms later: Restart");

    Rig z(true, 0);
    z.mode.step(0);
    z.out.wasExited = true;
    TEST_ASSERT(z.mode.step(5) == SetupStep::Restart, "a zero grace period restarts at once");
}

TEST(a_decision_made_before_the_access_point_is_up_is_not_lost) {
    Rig r;
    r.net.failStarts = 1;
    r.out.wasSaved = true;  // sticky
    TEST_ASSERT(r.mode.step(0) == SetupStep::Running, "the first start fails");
    TEST_ASSERT_EQ(r.store.clears, 0, "nothing is cleared while the access point is not up");
    TEST_ASSERT(r.mode.step(5000) == SetupStep::Running, "the retry succeeds");
    TEST_ASSERT(r.mode.step(5001) == SetupStep::Running, "now serving: it sees the decision");
    TEST_ASSERT_EQ(r.store.clears, 1, "and acts on it");
}

TEST(a_flash_write_that_fails_does_not_restart_and_is_retried) {
    Rig r;
    r.store.failClears = 2;
    r.mode.step(0);
    r.out.wasSaved = true;
    TEST_ASSERT(r.mode.step(100) == SetupStep::Running, "the first clear fails: no restart");
    TEST_ASSERT_EQ(r.store.clears, 1, "one attempt");
    TEST_ASSERT(r.mode.step(4000) == SetupStep::Running, "too early to retry");
    TEST_ASSERT_EQ(r.store.clears, 1, "no new attempt before the retry pause");
    TEST_ASSERT(r.mode.step(5100) == SetupStep::Running, "the second attempt fails too");
    TEST_ASSERT_EQ(r.store.clears, 2, "two attempts");
    TEST_ASSERT(r.mode.step(10100) == SetupStep::Running, "the third succeeds; the grace starts now");
    TEST_ASSERT_EQ(r.store.clears, 3, "three attempts");
    TEST_ASSERT(r.mode.step(11599) == SetupStep::Running, "still in the grace period");
    TEST_ASSERT(r.mode.step(11600) == SetupStep::Restart, "Restart only after the grace");
    TEST_ASSERT_EQ(r.net.stops, 1, "network torn down once");
    TEST_ASSERT(r.log.contains("could not store"), "the failure was logged");
}

TEST(an_access_point_that_fails_is_cleaned_up_and_retried_and_never_proceeds) {
    Rig r;
    r.net.failStarts = 3;
    TEST_ASSERT(r.mode.step(0) == SetupStep::Running, "the first start fails: Running, not Proceed");
    TEST_ASSERT_EQ(r.net.starts, 1, "one attempt");
    TEST_ASSERT_EQ(r.net.stops, 1, "the half-started access point is cleaned up");
    TEST_ASSERT(r.mode.step(4999) == SetupStep::Running, "too early to retry");
    TEST_ASSERT_EQ(r.net.starts, 1, "no attempt before the retry pause");
    TEST_ASSERT(r.mode.step(5000) == SetupStep::Running, "the second attempt fails");
    TEST_ASSERT_EQ(r.net.starts, 2, "two attempts");
    TEST_ASSERT(r.mode.step(10000) == SetupStep::Running, "the third attempt fails");
    TEST_ASSERT_EQ(r.net.starts, 3, "three attempts");
    TEST_ASSERT(r.mode.step(15000) == SetupStep::Running, "the fourth succeeds");
    TEST_ASSERT_EQ(r.net.starts, 4, "four attempts");
    TEST_ASSERT_EQ(r.net.polls, 0, "nothing served before it is up");
    r.mode.step(15001);
    TEST_ASSERT_EQ(r.net.polls, 1, "served once it is up");
    TEST_ASSERT(r.log.contains("failed to start"), "the failure was logged");
}

TEST(an_access_point_that_never_starts_never_proceeds) {
    Rig r;
    r.net.failStarts = 1000000;
    bool neverProceed = true;
    for (uint32_t i = 0; i < 2000; i++)
        if (r.mode.step(i * 1000u) == SetupStep::Proceed) neverProceed = false;
    TEST_ASSERT(neverProceed, "2000 failed steps and not one Proceed");
    TEST_ASSERT_EQ(r.store.clears, 0, "and SETUP_MODE untouched");
}

TEST(stop_leaves_the_wifi_clean_once_and_is_idempotent) {
    Rig r;
    r.mode.stop();
    TEST_ASSERT_EQ(r.net.calls(), 0, "stop() before anything was started leaves the network alone");
    r.mode.step(0);
    r.mode.stop();
    TEST_ASSERT_EQ(r.net.stops, 1, "stop() after the start tears the network down");
    r.mode.stop();
    TEST_ASSERT_EQ(r.net.stops, 1, "and a second stop() does nothing");
}

TEST(the_password_is_never_logged) {
    Rig r;
    r.net.failStarts = 1;
    r.store.failClears = 1;
    r.mode.step(0);
    r.mode.step(5000);
    r.out.wasSaved = true;
    for (uint32_t t = 5001; t < 20000; t += 500) r.mode.step(t);
    TEST_ASSERT(!r.log.lines.empty(), "the session logged something");
    TEST_ASSERT(!r.log.contains(PASSWORD), "but never the password");
    TEST_ASSERT(r.log.contains(SSID), "the SSID is logged, so the user knows which network to join");
}

TEST(the_log_is_optional) {
    FakeNet net;
    FakeOutcome out;
    FakeStore store;
    SetupMode mode(true, config(), net, out, store);  // no log sink
    net.failStarts = 1;
    mode.step(0);
    mode.step(5000);
    out.wasSaved = true;
    mode.step(5001);
    TEST_ASSERT(mode.step(7000) == SetupStep::Restart, "a session without a log still runs to the end");
}

int main() {
    RUN_TEST(not_in_setup_proceeds_and_never_touches_the_net);
    RUN_TEST(setup_opens_the_access_point_and_then_serves);
    RUN_TEST(waits_forever_days_and_across_the_millis_wrap);
    RUN_TEST(saved_clears_the_switch_serves_through_the_grace_then_restarts);
    RUN_TEST(exit_behaves_like_saved);
    RUN_TEST(grace_is_counted_across_the_millis_wrap_and_may_be_zero);
    RUN_TEST(a_decision_made_before_the_access_point_is_up_is_not_lost);
    RUN_TEST(a_flash_write_that_fails_does_not_restart_and_is_retried);
    RUN_TEST(an_access_point_that_fails_is_cleaned_up_and_retried_and_never_proceeds);
    RUN_TEST(an_access_point_that_never_starts_never_proceeds);
    RUN_TEST(stop_leaves_the_wifi_clean_once_and_is_idempotent);
    RUN_TEST(the_password_is_never_logged);
    RUN_TEST(the_log_is_optional);
    return test::summarize();
}
