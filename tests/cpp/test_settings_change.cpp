// test_settings_change.cpp — unit tests for changing the STORED settings of a board from the
// relay (applyChangeLine, renderReport, parseChangeReply and ChangePoller in settings_logic.h),
// using the Recorder's key table. No ESP32, no Wi-Fi: the relay is a scripted fake and the
// clock is a number.
//
// A change line is a way to reconfigure a board from afar, so what matters most is what it
// is NOT allowed to do: touch the settings that connect the board to the relay, half-apply,
// or leave the board needing a setting it does not have.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_change test_settings_change.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "settings_fakes.h"

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

static void fill(MemoryStore& st) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, TYPICAL);
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
}
static std::vector<std::string> locked() { return recorderLockedKeys(); }
static ChangeResult changeLine(MemoryStore& st, const std::string& line) { return applyChangeLine(RECORDER_SCHEMA, st, line, locked()); }
static bool mentions(const ChangeResult& r, const std::string& part) {
    for (size_t i = 0; i < r.errors.size(); ++i) if (r.errors[i].find(part) != std::string::npos) return true;
    return false;
}

// ── applyChangeLine ─────────────────────────────────────────────────────

TEST(a_valid_change_is_stored_and_named) {
    MemoryStore st; fill(st);
    ChangeResult r = changeLine(st, "PUSH_GAP_MUL=2;LOG_HEARTBEAT=900");
    TEST_ASSERT(r.ok(), "accepted");
    TEST_ASSERT_EQ(r.changed.size(), (size_t)2, "both changed");
    TEST_ASSERT_EQ(st.m["PUSH_GAP_MUL"], std::string("2"), "stored");
    TEST_ASSERT_EQ(st.m["LOG_HEARTBEAT"], std::string("900"), "stored");
    TEST_ASSERT_EQ(st.m["CAMERA_ID"], std::string("cam2"), "the rest is untouched");
}

TEST(a_change_is_all_or_nothing) {
    MemoryStore st; fill(st);
    ChangeResult r = changeLine(st, "PUSH_GAP_MUL=2;LOG_HEARTBEAT=0");   // 0 is below the minimum of 1
    TEST_ASSERT(!r.ok(), "refused");
    TEST_ASSERT(mentions(r, "LOG_HEARTBEAT"), "says which one");
    TEST_ASSERT_EQ(st.m["PUSH_GAP_MUL"], std::string("1.5"), "the good value was NOT stored either");
}

TEST(the_settings_that_reach_the_relay_can_not_be_changed) {
    const char* keys[] = { "WIFI=other-net:password99", "SERVER_HOST=10.0.0.9", "PUSH_PORT=9000", "HTTP_PORT=9001", "CAMERA_ID=cam9", "API_KEY=another" };
    for (size_t i = 0; i < 6; ++i) {
        MemoryStore st; fill(st);
        std::map<std::string, std::string> before = st.m;
        ChangeResult r = changeLine(st, std::string("LOG_HEARTBEAT=900;") + keys[i]);
        TEST_ASSERT(!r.ok(), std::string("refused: ") + keys[i]);
        TEST_ASSERT(mentions(r, "serial port"), "says why");
        TEST_ASSERT(st.m == before, "nothing at all was stored");
    }
}

TEST(a_locked_setting_given_with_its_current_value_is_just_ignored) {
    MemoryStore st; fill(st);
    ChangeResult r = changeLine(st, "CAMERA_ID=cam2;LOG_HEARTBEAT=900");
    TEST_ASSERT(r.ok(), "the unchanged locked setting is no problem");
    TEST_ASSERT_EQ(r.changed.size(), (size_t)1, "only the real change counts");
}

TEST(repeating_a_change_changes_nothing) {
    MemoryStore st; fill(st);
    TEST_ASSERT(changeLine(st, "LOG_HEARTBEAT=900").ok(), "first");
    ChangeResult again = changeLine(st, "LOG_HEARTBEAT=900");
    TEST_ASSERT(again.ok() && again.changed.empty(), "second time: fine, nothing to store (so no restart)");
}

TEST(garbage_and_unknown_settings_are_refused) {
    MemoryStore st; fill(st);
    TEST_ASSERT(!changeLine(st, "NOPE=1").ok(), "unknown setting");
    TEST_ASSERT(!changeLine(st, "LOG_HEARTBEAT").ok(), "not KEY=value");
    TEST_ASSERT(!changeLine(st, "LOG_HEARTBEAT=abc").ok(), "not a number");
    TEST_ASSERT(!changeLine(st, "LOG_ECHO=maybe").ok(), "not a bool");
    TEST_ASSERT(!changeLine(st, "ALARM_ACTIVE=SIDEWAYS").ok(), "not a level");
    TEST_ASSERT(!changeLine(st, "").ok(), "empty");
    TEST_ASSERT(!changeLine(st, "LOG_HEARTBEAT=5;LOG_HEARTBEAT=6").ok(), "twice in one line");
}

TEST(switching_a_feature_on_needs_the_settings_it_requires) {
    MemoryStore st; fill(st);
    TEST_ASSERT(changeLine(st, "ALARM_GPIO_PIN=-1").ok(), "alarm off is fine");
    st.m.erase("ALARM_ACTIVE"); st.m.erase("ALARM_ALL_CAMS");   // what a board that never had an alarm holds
    std::map<std::string, std::string> before = st.m;
    ChangeResult r = changeLine(st, "ALARM_GPIO_PIN=14");
    TEST_ASSERT(!r.ok(), "refused: it would leave the board incomplete");
    TEST_ASSERT(mentions(r, "ALARM_ACTIVE") && mentions(r, "ALARM_ALL_CAMS"), "names what is needed");
    TEST_ASSERT(st.m == before, "nothing stored");
    TEST_ASSERT(changeLine(st, "ALARM_GPIO_PIN=14;ALARM_ACTIVE=HIGH;ALARM_ALL_CAMS=1").ok(), "all together is fine");
    TEST_ASSERT_EQ(st.m["ALARM_ACTIVE"], std::string("HIGH"), "stored");
}

TEST(switching_a_feature_off_does_not_require_its_settings) {
    MemoryStore st; fill(st);
    TEST_ASSERT(changeLine(st, "LOG_ENABLED=0").ok(), "remote log off; its other settings stay stored but unused");
    TEST_ASSERT_EQ(st.m["LOG_ENABLED"], std::string("0"), "stored");
}

TEST(a_failing_flash_write_puts_the_earlier_ones_back) {
    struct FlakyStore : MemoryStore {
        int writes = 0, failAt = 2;
        bool set(const std::string& k, const std::string& v) override {
            if (++writes == failAt) return false;
            return MemoryStore::set(k, v);
        }
    } st;
    CheckedLine c = checkLine(RECORDER_SCHEMA, TYPICAL);
    st.failAt = 0;
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
    st.writes = 0; st.failAt = 2;
    std::map<std::string, std::string> before = st.m;
    ChangeResult r = applyChangeLine(RECORDER_SCHEMA, st, "PUSH_GAP_MUL=3;LOG_HEARTBEAT=900", locked());
    TEST_ASSERT(!r.ok() && mentions(r, "flash"), "reported");
    TEST_ASSERT(r.changed.empty(), "nothing counts as changed");
    st.failAt = 0;
    TEST_ASSERT(st.m == before, "the first write was undone");
}

TEST(only_existing_keys_are_read_from_flash) {
    MemoryStore st; fill(st);
    changeLine(st, "LOG_HEARTBEAT=900");
    TEST_ASSERT_EQ(st.badGets, 0, "the real flash logs an error for a key that does not exist");
}

// ── renderReport ────────────────────────────────────────────────────────

TEST(the_report_lists_stored_settings_with_secrets_masked) {
    MemoryStore st; fill(st);
    std::string rep = renderReport(RECORDER_SCHEMA, st);
    TEST_ASSERT(rep.find("PUSH_GAP_MUL=1.5") != std::string::npos, "plain values are there");
    TEST_ASSERT(rep.find("API_KEY=********") != std::string::npos, "the key is masked");
    TEST_ASSERT(rep.find("s3cret") == std::string::npos, "the key itself never leaves");
    TEST_ASSERT(rep.find("password1") == std::string::npos, "nor a Wi-Fi password");
    TEST_ASSERT(rep.find("extender-1") != std::string::npos, "the network name does (the page shows it)");
}

TEST(the_report_skips_settings_that_are_not_stored) {
    MemoryStore st;
    st.set("PUSH_GAP_MUL", "1.5");
    TEST_ASSERT_EQ(renderReport(RECORDER_SCHEMA, st), std::string("PUSH_GAP_MUL=1.5"), "only what is there");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of a missing key");
}

// ── parseChangeReply ────────────────────────────────────────────────────

TEST(the_reply_is_a_number_then_the_line) {
    std::string rev, line;
    TEST_ASSERT(parseChangeReply("1760600000123\nLOG_HEARTBEAT=900\n", rev, line), "parsed");
    TEST_ASSERT_EQ(rev, std::string("1760600000123"), "number");
    TEST_ASSERT_EQ(line, std::string("LOG_HEARTBEAT=900"), "line without the trailing newline");
}

TEST(a_reply_that_does_not_look_right_is_refused) {
    std::string rev, line;
    const char* bad[] = { "", "no newline", "\nLOG=1", "abc\nLOG=1", "12x\nLOG=1", "123\n", "123\n\n", "12345678901234567890\nX=1" };
    for (size_t i = 0; i < 8; ++i) TEST_ASSERT(!parseChangeReply(bad[i], rev, line), std::string("refused: ") + bad[i]);
}

// ── ChangePoller ────────────────────────────────────────────────────────

struct FakeLink : IChangeLink {
    bool up = true;
    FetchResult next = FetchResult::NothingStaged;
    std::string rev = "42", line;
    bool reportOk = true;
    int fetches = 0;
    struct Rep { std::string rev, result, message, settings; };
    std::vector<Rep> reports;
    bool online() override { return up; }
    FetchResult fetchChange(std::string& r, std::string& l) override { fetches++; r = rev; l = line; return next; }
    bool report(const std::string& r, const std::string& res, const std::string& msg, const std::string& s) override {
        Rep x; x.rev = r; x.result = res; x.message = msg; x.settings = s; reports.push_back(x);
        return reportOk;
    }
};

TEST(the_poller_waits_for_the_first_delay_then_asks_at_its_gap) {
    MemoryStore st; fill(st); FakeLink link;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 20000, 30000);
    p.tick(1000);
    p.tick(15000);
    TEST_ASSERT_EQ(link.fetches, 0, "nothing in the first 20 s");
    p.tick(21000);
    TEST_ASSERT_EQ(link.fetches, 1, "first ask");
    p.tick(40000);
    TEST_ASSERT_EQ(link.fetches, 1, "not again before the gap");
    p.tick(51000);
    TEST_ASSERT_EQ(link.fetches, 2, "again after the gap");
}

TEST(the_poller_reports_the_board_once_when_it_first_gets_through) {
    MemoryStore st; fill(st); FakeLink link;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    p.tick(10); p.tick(2000); p.tick(4000);
    TEST_ASSERT_EQ(link.reports.size(), (size_t)1, "one boot report, not one per ask");
    TEST_ASSERT_EQ(link.reports[0].result, std::string("boot"), "marked as the boot report");
    TEST_ASSERT_EQ(link.reports[0].rev, std::string("0"), "no change number");
    TEST_ASSERT(link.reports[0].settings.find("PUSH_GAP_MUL=1.5") != std::string::npos, "carries the settings");
}

TEST(a_failed_boot_report_is_retried) {
    MemoryStore st; fill(st); FakeLink link; link.reportOk = false;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    p.tick(10); p.tick(2000);
    TEST_ASSERT_EQ(link.reports.size(), (size_t)2, "tried again on the next ask");
    link.reportOk = true;
    p.tick(4000); p.tick(6000);
    TEST_ASSERT_EQ(link.reports.size(), (size_t)3, "and then no more");
}

TEST(offline_nothing_is_asked) {
    MemoryStore st; fill(st); FakeLink link; link.up = false;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    p.tick(10); p.tick(5000);
    TEST_ASSERT_EQ(link.fetches + (int)link.reports.size(), 0, "no request while Wi-Fi is down");
}

TEST(a_queued_change_is_applied_reported_and_the_board_restarts) {
    MemoryStore st; fill(st); FakeLink link;
    link.next = FetchResult::Got; link.line = "LOG_HEARTBEAT=900;PUSH_GAP_MUL=2";
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    ChangePoller::Status s = p.tick(10);
    TEST_ASSERT(s == ChangePoller::Restart, "restart so the new values start clean");
    TEST_ASSERT_EQ(st.m["LOG_HEARTBEAT"], std::string("900"), "stored");
    const FakeLink::Rep& last = link.reports.back();
    TEST_ASSERT_EQ(last.result, std::string("applied"), "reported as applied");
    TEST_ASSERT_EQ(last.rev, std::string("42"), "for the right change");
    TEST_ASSERT(last.message.find("LOG_HEARTBEAT") != std::string::npos, "names what changed");
    TEST_ASSERT(last.message.find("900") == std::string::npos, "never the values");
    TEST_ASSERT(last.settings.find("LOG_HEARTBEAT=900") != std::string::npos, "the report already shows the new values");
}

TEST(a_refused_change_is_reported_with_the_reason_and_nothing_restarts) {
    MemoryStore st; fill(st); FakeLink link;
    link.next = FetchResult::Got; link.line = "API_KEY=newkey";
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    TEST_ASSERT(p.tick(10) == ChangePoller::Idle, "no restart");
    TEST_ASSERT_EQ(link.reports.back().result, std::string("rejected"), "reported as rejected");
    TEST_ASSERT(link.reports.back().message.find("serial port") != std::string::npos, "with the reason");
    TEST_ASSERT_EQ(st.m["API_KEY"], std::string("s3cret"), "untouched");
}

TEST(a_change_that_changes_nothing_is_reported_as_applied_without_a_restart) {
    MemoryStore st; fill(st); FakeLink link;
    link.next = FetchResult::Got; link.line = "LOG_HEARTBEAT=600";
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    TEST_ASSERT(p.tick(10) == ChangePoller::Idle, "no restart for nothing");
    TEST_ASSERT_EQ(link.reports.back().result, std::string("applied"), "so the relay stops offering it");
}

TEST(the_board_restarts_even_if_the_report_could_not_be_delivered) {
    MemoryStore st; fill(st); FakeLink link; link.reportOk = false;
    link.next = FetchResult::Got; link.line = "LOG_HEARTBEAT=900";
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    TEST_ASSERT(p.tick(10) == ChangePoller::Restart, "the change is in flash, so it must take effect");
}

TEST(an_unreachable_relay_or_nothing_queued_does_nothing) {
    MemoryStore st; fill(st); FakeLink link;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 0, 1000);
    link.next = FetchResult::Failed;
    TEST_ASSERT(p.tick(10) == ChangePoller::Idle, "relay down");
    link.next = FetchResult::NothingStaged;
    TEST_ASSERT(p.tick(2000) == ChangePoller::Idle, "nothing queued");
}

TEST(the_poller_survives_the_millis_counter_wrapping_around) {
    MemoryStore st; fill(st); FakeLink link;
    ChangePoller p(RECORDER_SCHEMA, st, link, locked(), 10000, 5000);
    p.tick(4294960000u);                 // armed shortly before the wrap: first ask due 10 s later, i.e. after it
    p.tick(4294966000u);
    TEST_ASSERT_EQ(link.fetches, 0, "not yet due, before the wrap");
    p.tick(1000u);                       // after the wrap, still before 4294960000 + 10000 - 2^32 = 2704
    TEST_ASSERT_EQ(link.fetches, 0, "still not due just after the wrap");
    p.tick(3000u);
    TEST_ASSERT_EQ(link.fetches, 1, "due across the wrap");
}

int main() {
    RUN_TEST(a_valid_change_is_stored_and_named);
    RUN_TEST(a_change_is_all_or_nothing);
    RUN_TEST(the_settings_that_reach_the_relay_can_not_be_changed);
    RUN_TEST(a_locked_setting_given_with_its_current_value_is_just_ignored);
    RUN_TEST(repeating_a_change_changes_nothing);
    RUN_TEST(garbage_and_unknown_settings_are_refused);
    RUN_TEST(switching_a_feature_on_needs_the_settings_it_requires);
    RUN_TEST(switching_a_feature_off_does_not_require_its_settings);
    RUN_TEST(a_failing_flash_write_puts_the_earlier_ones_back);
    RUN_TEST(only_existing_keys_are_read_from_flash);
    RUN_TEST(the_report_lists_stored_settings_with_secrets_masked);
    RUN_TEST(the_report_skips_settings_that_are_not_stored);
    RUN_TEST(the_reply_is_a_number_then_the_line);
    RUN_TEST(a_reply_that_does_not_look_right_is_refused);
    RUN_TEST(the_poller_waits_for_the_first_delay_then_asks_at_its_gap);
    RUN_TEST(the_poller_reports_the_board_once_when_it_first_gets_through);
    RUN_TEST(a_failed_boot_report_is_retried);
    RUN_TEST(offline_nothing_is_asked);
    RUN_TEST(a_queued_change_is_applied_reported_and_the_board_restarts);
    RUN_TEST(a_refused_change_is_reported_with_the_reason_and_nothing_restarts);
    RUN_TEST(a_change_that_changes_nothing_is_reported_as_applied_without_a_restart);
    RUN_TEST(the_board_restarts_even_if_the_report_could_not_be_delivered);
    RUN_TEST(an_unreachable_relay_or_nothing_queued_does_nothing);
    RUN_TEST(the_poller_survives_the_millis_counter_wrapping_around);
    return test::summarize();
}
