// test_remote_log.cpp — unit tests for Arduino/.../remote_log.h, the camera's
// remote logging core (queue, repeat suppression, trace, retry/give-up state
// machine, JSON). Everything here is driven by a fake clock and a fake relay,
// so the 5-minute retry timings can be checked in microseconds.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_remote_log test_remote_log.cpp

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/remote_log.h"

#include <string>
#include <vector>

using namespace esp32cam_logic;

// ── helpers ─────────────────────────────────────────────────────────────

struct Serial {
    std::vector<std::string> lines;
    static void echo(void* user, LogLevel, const char* line) { static_cast<Serial*>(user)->lines.push_back(line); }
    bool anyContains(const char* s) const { for (size_t i = 0; i < lines.size(); i++) if (lines[i].find(s) != std::string::npos) return true; return false; }
};

static RemoteLogConfig cfg() {
    RemoteLogConfig c;
    c.remoteEnabled = true;
    c.remoteMinLevel = LogLevel::Info;
    c.echoAlways = true;
    c.flushIntervalMs = 10000;
    c.retryPeriodMs = 300000;   // 5 minutes
    c.maxRetries = 3;
    c.repeatWindowMs = 30000;
    return c;
}

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }
static size_t count(const std::string& s, const char* part) {
    size_t n = 0, pos = 0;
    while ((pos = s.find(part, pos)) != std::string::npos) { n++; pos += strlen(part); }
    return n;
}

// Asks for a batch; returns the JSON ("" if none is due).
static std::string batch(RemoteLog& rl, uint32_t now, bool wifi, uint32_t& lastSeq) {
    std::string body;
    return rl.prepareBatch(now, wifi, "cam2", "fw-1", body, lastSeq) ? body : std::string();
}

// ── text helpers ────────────────────────────────────────────────────────

TEST(truncation_leaves_short_text_alone) {
    char buf[16];
    TEST_ASSERT_EQ((int)copyTruncatedUtf8(buf, sizeof(buf), "hello"), 5, "length");
    TEST_ASSERT(strcmp(buf, "hello") == 0, "unchanged");
}

TEST(truncation_marks_the_cut_and_fits_the_buffer) {
    char buf[10];
    size_t n = copyTruncatedUtf8(buf, sizeof(buf), "abcdefghijklmnopqrstuvwxyz");
    TEST_ASSERT(strcmp(buf, "abcdef...") == 0, "ends with ...");
    TEST_ASSERT_EQ((int)n, 9, "length is dstSize-1");
}

TEST(truncation_never_cuts_a_utf8_character_in_half) {
    // "—" is 3 bytes (E2 80 94). Place it so a naive cut lands inside it.
    const char* src = "abcdef\xE2\x80\x94xyz";   // abcdef—xyz
    for (size_t cap = 6; cap < 14; cap++) {
        char buf[32];
        copyTruncatedUtf8(buf, cap, src);
        // valid UTF-8: every lead byte 0xE2 must be followed by 0x80 0x94
        for (const char* p = buf; *p; ++p) {
            if ((unsigned char)*p == 0xE2) {
                TEST_ASSERT((unsigned char)p[1] == 0x80 && (unsigned char)p[2] == 0x94, "complete character only");
            }
        }
    }
}

TEST(truncation_into_a_tiny_buffer_is_safe) {
    char buf[4];
    copyTruncatedUtf8(buf, sizeof(buf), "abcdefgh");
    TEST_ASSERT(strlen(buf) < 4, "stays inside the buffer");
    char one[1];
    TEST_ASSERT_EQ((int)copyTruncatedUtf8(one, 1, "abc"), 0, "capacity 1 holds nothing");
    TEST_ASSERT_EQ((int)copyTruncatedUtf8(one, 0, "abc"), 0, "capacity 0 is a no-op");
}

TEST(basename_strips_directories_of_both_kinds) {
    TEST_ASSERT(strcmp(pathBasename("/tmp/arduino/sketch/ESP32_CAM_Recorder.ino"), "ESP32_CAM_Recorder.ino") == 0, "unix");
    TEST_ASSERT(strcmp(pathBasename("C:\\Users\\me\\sketch\\a.ino"), "a.ino") == 0, "windows");
    TEST_ASSERT(strcmp(pathBasename("plain.ino"), "plain.ino") == 0, "no directory");
}

TEST(call_site_format) {
    char site[LOG_SITE_MAX];
    formatCallSite(site, sizeof(site), "/a/b/ESP32_CAM_Recorder.ino", 405, "loop");
    TEST_ASSERT(strcmp(site, "ESP32_CAM_Recorder.ino:405 loop()") == 0, "file:line func()");
}

TEST(appendWhole_refuses_a_piece_that_does_not_fit) {
    char buf[12] = "";
    size_t len = 0;
    TEST_ASSERT(appendWhole(buf, sizeof(buf), len, "abcde"), "fits");
    TEST_ASSERT(!appendWhole(buf, sizeof(buf), len, "123456789"), "does not fit -> rejected whole");
    TEST_ASSERT_EQ((int)len, 5, "length unchanged by the rejected piece");
    TEST_ASSERT(strcmp(buf, "abcde") == 0, "content unchanged");
}

TEST(reset_reasons_are_named_and_the_bad_ones_flagged) {
    TEST_ASSERT(strstr(resetReasonName(9), "BROWNOUT") != nullptr, "brownout named");
    TEST_ASSERT(strstr(resetReasonName(4), "PANIC") != nullptr, "panic named");
    TEST_ASSERT(strstr(resetReasonName(6), "watchdog") != nullptr, "task watchdog named");
    TEST_ASSERT(strcmp(resetReasonName(1), "power-on") == 0, "power-on");
    TEST_ASSERT(strcmp(resetReasonName(77), "unknown") == 0, "unknown number");
    for (int r : {4, 5, 6, 7, 9}) TEST_ASSERT(isAbnormalReset(r), "crash / watchdog / brownout are abnormal");
    for (int r : {0, 1, 2, 3, 8, 10}) TEST_ASSERT(!isAbnormalReset(r), "power-on, reset pin, software restart, deep sleep are not");
}

TEST(level_from_int_clamps) {
    TEST_ASSERT(logLevelFromInt(-5) == LogLevel::Debug, "below range");
    TEST_ASSERT(logLevelFromInt(0) == LogLevel::Debug, "0");
    TEST_ASSERT(logLevelFromInt(1) == LogLevel::Info, "1");
    TEST_ASSERT(logLevelFromInt(2) == LogLevel::Warn, "2");
    TEST_ASSERT(logLevelFromInt(3) == LogLevel::Error, "3");
    TEST_ASSERT(logLevelFromInt(99) == LogLevel::Error, "above range");
}

// ── breadcrumbs ─────────────────────────────────────────────────────────

TEST(breadcrumbs_list_recent_events_oldest_first_with_their_age) {
    BreadcrumbRing r;
    r.add(1000, LogLevel::Info, "first");
    r.add(4500, LogLevel::Warn, "second");
    char buf[LOG_TRACE_MAX] = "at x";
    size_t len = strlen(buf);
    r.appendTo(buf, sizeof(buf), len, 13000);
    TEST_ASSERT(strcmp(buf, "at x\nrecent events (oldest first):\n  -12.0s INFO first\n  -8.5s WARN second") == 0, buf);
}

TEST(breadcrumbs_keep_only_the_most_recent_few) {
    BreadcrumbRing r;
    char msg[16];
    for (size_t i = 0; i < LOG_BREADCRUMBS + 4; i++) { snprintf(msg, sizeof(msg), "event%zu", i); r.add((uint32_t)i * 1000, LogLevel::Info, msg); }
    TEST_ASSERT_EQ((int)r.size(), (int)LOG_BREADCRUMBS, "bounded");
    char buf[LOG_TRACE_MAX] = "";
    size_t len = 0;
    r.appendTo(buf, sizeof(buf), len, 20000);
    TEST_ASSERT(!has(buf, "event0") && !has(buf, "event3\n") , "the oldest are gone");
    TEST_ASSERT(has(buf, "event4") && has(buf, "event9"), "the newest are kept");
    TEST_ASSERT(std::string(buf).find("event4") < std::string(buf).find("event9"), "oldest first");
}

TEST(breadcrumbs_never_emit_a_cut_off_line) {
    BreadcrumbRing r;
    for (size_t i = 0; i < LOG_BREADCRUMBS; i++) r.add((uint32_t)i * 1000, LogLevel::Info, "a fairly long event description to use up the space");
    char buf[100] = "at here";
    size_t len = strlen(buf);
    r.appendTo(buf, sizeof(buf), len, 10000);
    TEST_ASSERT(strlen(buf) < sizeof(buf), "inside the buffer");
    // every line that made it in is complete
    std::string s(buf);
    size_t pos = 0;
    while ((pos = s.find("\n  -", pos)) != std::string::npos) {
        size_t end = s.find('\n', pos + 1);
        std::string line = s.substr(pos + 1, end == std::string::npos ? std::string::npos : end - pos - 1);
        TEST_ASSERT(has(line.c_str(), "description to use up the space"), "complete line");
        pos += 1;
    }
}

TEST(a_breadcrumb_is_always_a_single_line) {
    BreadcrumbRing r;
    r.add(1000, LogLevel::Warn, "first line\nsecond line that must not leak\r\nthird");
    r.add(2000, LogLevel::Info, "tab\tseparated\x01value");
    char buf[LOG_TRACE_MAX] = "";
    size_t len = 0;
    r.appendTo(buf, sizeof(buf), len, 3000);
    std::string s(buf);
    TEST_ASSERT(has(buf, "-2.0s WARN first line\n"), buf);
    TEST_ASSERT(!has(buf, "second line") && !has(buf, "third"), "only the first line is kept");
    TEST_ASSERT(has(buf, "-1.0s INFO tab separated value"), "other control characters become spaces");
    int lines = 0;
    for (size_t i = 0; i < s.size(); i++) if (s[i] == '\n') lines++;
    TEST_ASSERT_EQ(lines, 3, "the header plus exactly one line per breadcrumb");
}

TEST(breadcrumb_age_survives_the_clock_wrapping) {
    BreadcrumbRing r;
    r.add(0xFFFFFF00u, LogLevel::Info, "before wrap");
    char buf[LOG_TRACE_MAX] = "";
    size_t len = 0;
    r.appendTo(buf, sizeof(buf), len, 0x00000100u);  // 512 ms later
    TEST_ASSERT(has(buf, "-0.5s INFO before wrap"), buf);
}

// ── queue ───────────────────────────────────────────────────────────────

static LogEntry mk(uint32_t seq, LogLevel lvl, uint32_t up = 0) {
    LogEntry e;
    memset(&e, 0, sizeof(e));
    e.seq = seq; e.level = lvl; e.uptimeMs = up;
    snprintf(e.message, sizeof(e.message), "m%u", (unsigned)seq);
    return e;
}

TEST(queue_keeps_order_and_reports_nothing_dropped_until_full) {
    LogQueue q;
    for (uint32_t i = 1; i <= LOG_QUEUE_CAPACITY; i++) TEST_ASSERT_EQ((int)q.push(mk(i, LogLevel::Info)), 0, "room");
    TEST_ASSERT_EQ((int)q.size(), (int)LOG_QUEUE_CAPACITY, "full");
    TEST_ASSERT_EQ((int)q.at(0).seq, 1, "oldest first");
}

TEST(queue_when_full_drops_the_oldest_NON_error) {
    LogQueue q;
    q.push(mk(1, LogLevel::Error));
    for (uint32_t i = 2; i <= LOG_QUEUE_CAPACITY; i++) q.push(mk(i, LogLevel::Info));
    TEST_ASSERT_EQ((int)q.push(mk(100, LogLevel::Info)), 1, "one dropped");
    TEST_ASSERT_EQ((int)q.at(0).seq, 1, "the old ERROR survived");
    TEST_ASSERT_EQ((int)q.at(1).seq, 3, "the oldest INFO (seq 2) went instead");
    TEST_ASSERT_EQ((int)q.at(q.size() - 1).seq, 100, "the new one is last");
}

TEST(queue_full_of_errors_drops_the_oldest_error) {
    LogQueue q;
    for (uint32_t i = 1; i <= LOG_QUEUE_CAPACITY; i++) q.push(mk(i, LogLevel::Error));
    q.push(mk(50, LogLevel::Error));
    TEST_ASSERT_EQ((int)q.size(), (int)LOG_QUEUE_CAPACITY, "still bounded");
    TEST_ASSERT_EQ((int)q.at(0).seq, 2, "oldest error dropped");
    TEST_ASSERT_EQ((int)q.at(q.size() - 1).seq, 50, "new error kept");
}

TEST(queue_removeThroughSeq_removes_the_delivered_prefix_only) {
    LogQueue q;
    for (uint32_t i = 1; i <= 6; i++) q.push(mk(i, LogLevel::Info));
    q.removeThroughSeq(4);
    TEST_ASSERT_EQ((int)q.size(), 2, "two left");
    TEST_ASSERT_EQ((int)q.at(0).seq, 5, "5 is next");
    q.removeThroughSeq(3);
    TEST_ASSERT_EQ((int)q.size(), 2, "an already-removed seq changes nothing");
}

TEST(queue_removeThroughSeq_copes_with_entries_evicted_meanwhile) {
    LogQueue q;
    for (uint32_t i = 1; i <= LOG_QUEUE_CAPACITY; i++) q.push(mk(i, LogLevel::Info));
    for (uint32_t i = 0; i < 5; i++) q.push(mk(100 + i, LogLevel::Info)); // evicts seq 1..5 while a batch ending at 8 is "in flight"
    q.removeThroughSeq(8);
    TEST_ASSERT_EQ((int)q.at(0).seq, 9, "everything up to 8 is gone, nothing newer touched");
}

TEST(queue_clear_and_hasAtLeast) {
    LogQueue q;
    q.push(mk(1, LogLevel::Debug)); q.push(mk(2, LogLevel::Info));
    TEST_ASSERT(!q.hasAtLeast(LogLevel::Warn), "no warning yet");
    q.push(mk(3, LogLevel::Warn));
    TEST_ASSERT(q.hasAtLeast(LogLevel::Warn), "warning present");
    TEST_ASSERT_EQ((int)q.clear(), 3, "clear reports how many");
    TEST_ASSERT(q.empty(), "empty");
}

// ── uplink state machine ────────────────────────────────────────────────

TEST(uplink_healthy_sends_urgent_stale_or_nearly_full_but_not_routine_fresh_entries) {
    LogUplink u(10000, 300000, 3);
    TEST_ASSERT(!u.due(0, 1, false, 500, false, true), "one fresh routine entry waits");
    TEST_ASSERT(u.due(0, 1, true, 500, false, true), "urgent goes out at once");
    TEST_ASSERT(u.due(0, 1, false, 10000, false, true), "after the flush interval it goes");
    TEST_ASSERT(!u.due(0, 1, false, 9999, false, true), "just before it, it doesn't");
    TEST_ASSERT(u.due(0, 8, false, 100, true, true), "a nearly full queue goes");
    TEST_ASSERT(!u.due(0, 0, true, 99999, true, true), "nothing pending: nothing to send");
}

TEST(uplink_never_tries_while_wifi_is_down_and_that_is_not_a_failure) {
    LogUplink u(10000, 300000, 3);
    TEST_ASSERT(!u.due(0, 5, true, 99999, true, false), "no WiFi, no attempt");
    TEST_ASSERT_EQ((int)u.failedAttempts(), 0, "no failure recorded");
}

TEST(uplink_retry_waits_the_full_period_and_urgent_entries_do_not_shorten_it) {
    LogUplink u(10000, 300000, 3);
    TEST_ASSERT(!u.onFailure(1000), "first failure: not the last");
    TEST_ASSERT(u.state() == LogUplink::Backoff, "backing off");
    TEST_ASSERT(!u.due(1001, 5, true, 99999, true, true), "urgent + full does not skip the wait");
    TEST_ASSERT(!u.due(1000 + 299999, 5, true, 99999, true, true), "one ms early");
    TEST_ASSERT(u.due(1000 + 300000, 5, false, 0, false, true), "due exactly when the period has passed — even for routine entries");
}

TEST(uplink_gives_up_after_the_first_attempt_plus_N_retries) {
    LogUplink u(10000, 300000, 3);                  // 3 retries allowed
    TEST_ASSERT(!u.onFailure(0),        "attempt 1 (the original) failed");
    TEST_ASSERT(!u.onFailure(300000),   "retry 1 failed");
    TEST_ASSERT(!u.onFailure(600000),   "retry 2 failed");
    TEST_ASSERT(u.state() == LogUplink::Backoff, "still retrying after 3 failures");
    TEST_ASSERT(u.onFailure(900000),    "retry 3 failed -> give up");
    TEST_ASSERT(u.state() == LogUplink::GaveUp, "serial only");
    TEST_ASSERT(!u.accepting(), "no longer accepting entries");
    TEST_ASSERT(!u.due(99999999, 5, true, 99999, true, true), "never sends again");
}

TEST(uplink_zero_retries_gives_up_on_the_first_failure) {
    LogUplink u(10000, 300000, 0);
    TEST_ASSERT(u.onFailure(0), "no retries allowed");
    TEST_ASSERT(u.state() == LogUplink::GaveUp, "gave up");
}

TEST(uplink_success_resets_the_failure_count) {
    LogUplink u(10000, 300000, 3);
    u.onFailure(0); u.onFailure(300000);
    u.onSuccess();
    TEST_ASSERT(u.state() == LogUplink::Healthy, "healthy again");
    TEST_ASSERT_EQ((int)u.failedAttempts(), 0, "count reset");
    TEST_ASSERT(!u.onFailure(1), "so it gets its full set of retries again");
}

TEST(uplink_rearm_only_revives_a_board_that_gave_up) {
    LogUplink u(10000, 300000, 1);
    u.onFailure(0);
    TEST_ASSERT(!u.rearm(), "a board that is merely backing off keeps its schedule (no retry storm on a flapping link)");
    TEST_ASSERT(u.state() == LogUplink::Backoff, "still backing off");
    u.onFailure(300000);
    TEST_ASSERT(u.state() == LogUplink::GaveUp, "gave up");
    TEST_ASSERT(u.rearm(), "rearm revives it");
    TEST_ASSERT(u.state() == LogUplink::Healthy && u.accepting(), "healthy and accepting");
}

TEST(uplink_retry_timing_survives_the_clock_wrapping) {
    LogUplink u(10000, 300000, 3);
    uint32_t t = 0xFFFFFFFFu - 1000;                // 1 s before millis() wraps
    u.onFailure(t);                                  // next attempt is 299 s after the wrap
    TEST_ASSERT(!u.due(t + 1000, 1, true, 0, false, true), "not due right after the wrap");
    TEST_ASSERT(u.due(t + 300000, 1, false, 0, false, true), "due once the period has passed, across the wrap");
}

// ── JSON ────────────────────────────────────────────────────────────────

TEST(json_string_escaping) {
    std::string s;
    appendJsonString(s, "a\"b\\c\nd\re\tf\x01g");
    TEST_ASSERT(s == "\"a\\\"b\\\\c\\nd\\re\\tf\\u0001g\"", s.c_str());
}

TEST(json_string_leaves_utf8_alone) {
    std::string s;
    appendJsonString(s, "dropping \xE2\x80\x94 now");
    TEST_ASSERT(s == "\"dropping \xE2\x80\x94 now\"", "bytes >= 0x80 pass through");
}

TEST(json_batch_exact_shape) {
    LogEntry e = mk(7, LogLevel::Error, 9000);
    e.freeHeap = 84312; e.rssi = -71;
    strcpy(e.message, "Frame capture failed");
    strcpy(e.trace, "at a.ino:405 loop()");
    std::string out;
    appendBatchJson(out, &e, 1, 14000, "cam2", "Oct  3 2026", 2, 5);
    TEST_ASSERT(out == "{\"camera\":\"cam2\",\"fw\":\"Oct  3 2026\",\"attempt\":2,\"dropped\":5,\"entries\":["
                       "{\"seq\":7,\"level\":\"ERROR\",\"ageMs\":5000,\"uptimeMs\":9000,\"heap\":84312,\"rssi\":-71,"
                       "\"message\":\"Frame capture failed\",\"trace\":\"at a.ino:405 loop()\"}]}", out.c_str());
}

TEST(json_batch_with_several_entries_is_comma_separated) {
    LogEntry es[3] = { mk(1, LogLevel::Info), mk(2, LogLevel::Warn), mk(3, LogLevel::Debug) };
    std::string out;
    appendBatchJson(out, es, 3, 100, "c", "f", 0, 0);
    TEST_ASSERT_EQ((int)count(out, "{\"seq\":"), 3, "three entries");
    TEST_ASSERT(has(out, "},{\"seq\":2") && has(out, "},{\"seq\":3"), "separated by commas");
    TEST_ASSERT(out.back() == '}' && has(out, "]}"), "closed properly");
}

TEST(json_age_is_right_when_millis_wrapped_between_the_event_and_the_send) {
    LogEntry e = mk(1, LogLevel::Info, 0xFFFFFF00u);
    std::string out;
    appendBatchJson(out, &e, 1, 0x100u, "c", "f", 0, 0);   // sent 512 ms after the event, across the wrap
    TEST_ASSERT(has(out, "\"ageMs\":512,"), out.c_str());
}

// ── RemoteLog: whole-pipeline scenarios ─────────────────────────────────

TEST(routine_entries_wait_for_the_flush_interval_then_go_out_together) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Info, 1000, "a.ino:1 f()", "first", 100000, -60);
    rl.log(LogLevel::Info, 2000, "a.ino:2 f()", "second", 100000, -60);
    uint32_t seq = 0;
    TEST_ASSERT(batch(rl, 5000, true, seq).empty(), "too soon: the oldest has waited only 4 s");
    std::string b = batch(rl, 11000, true, seq);
    TEST_ASSERT(!b.empty(), "the oldest has now waited 10 s");
    TEST_ASSERT(has(b, "\"message\":\"first\"") && has(b, "\"message\":\"second\""), "both in one request");
    TEST_ASSERT_EQ((int)seq, 2, "lastSeq is the last included");
    rl.onSendResult(11000, true, seq);
    TEST_ASSERT_EQ((int)rl.pending(), 0, "delivered entries are gone from memory");
}

TEST(an_error_is_sent_immediately_and_carries_its_trace) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Info, 1000, "a.ino:10 setup()", "WiFi connected", 100000, -60);
    rl.log(LogLevel::Info, 2000, "a.ino:20 loop()", "push connection established", 99000, -61);
    rl.log(LogLevel::Debug, 2500, "a.ino:25 loop()", "noisy debug heartbeat", 99000, -61);
    rl.log(LogLevel::Error, 4000, "ESP32_CAM_Recorder.ino:405 loop()", "Frame capture failed", 90000, -75);
    uint32_t seq = 0;
    std::string b = batch(rl, 4000, true, seq);
    TEST_ASSERT(!b.empty(), "urgent: no waiting for the flush interval");
    TEST_ASSERT(has(b, "at ESP32_CAM_Recorder.ino:405 loop()"), "call site in the trace");
    TEST_ASSERT(has(b, "recent events (oldest first):"), "events leading up to it");
    TEST_ASSERT(has(b, "-3.0s INFO WiFi connected") && has(b, "-2.0s INFO push connection established"), "with their ages");
    TEST_ASSERT(!has(b, "noisy debug heartbeat\\n") || !has(b, "-1.5s DEBUG"), "routine DEBUG chatter is not in the trace");
    TEST_ASSERT(has(b, "\"heap\":90000,\"rssi\":-75"), "heap and signal at that moment");
}

TEST(an_info_entry_carries_only_its_call_site) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Info, 1000, "a.ino:1 f()", "earlier", 1, 1);
    rl.log(LogLevel::Info, 2000, "a.ino:2 g()", "now", 1, 1);
    uint32_t seq = 0;
    std::string b = batch(rl, 20000, true, seq);
    TEST_ASSERT(has(b, "\"trace\":\"at a.ino:2 g()\""), "just the call site");
}

TEST(entries_below_the_remote_level_stay_on_serial) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Debug, 1000, "a.ino:1 f()", "only for the serial port", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 0, "not queued");
    TEST_ASSERT(ser.anyContains("only for the serial port"), "but printed");
}

TEST(setting_the_remote_level_to_debug_sends_debug_too) {
    RemoteLogConfig c = cfg(); c.remoteMinLevel = LogLevel::Debug;
    Serial ser; RemoteLog rl(c, Serial::echo, &ser);
    rl.log(LogLevel::Debug, 1000, "a.ino:1 f()", "debug detail", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 1, "queued");
}

TEST(serial_echo_can_be_limited_to_what_is_not_sent_remotely) {
    RemoteLogConfig c = cfg(); c.echoAlways = false;
    Serial ser; RemoteLog rl(c, Serial::echo, &ser);
    rl.log(LogLevel::Info, 1000, "a.ino:1 f()", "goes to the relay", 1, 1);
    rl.log(LogLevel::Debug, 1000, "a.ino:2 f()", "stays on serial", 1, 1);
    TEST_ASSERT(!ser.anyContains("goes to the relay"), "not echoed while the relay carries it");
    TEST_ASSERT(ser.anyContains("stays on serial"), "echoed because nothing else carries it");
}

TEST(serial_echo_line_has_uptime_level_message_and_call_site) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Warn, 12345, "a.ino:7 f()", "something odd", 1, 1);
    TEST_ASSERT(ser.lines.size() == 1 && ser.lines[0] == "[12.3s WARN] something odd  (a.ino:7 f())", ser.lines.empty() ? "" : ser.lines[0].c_str());
}

TEST(remote_logging_can_be_switched_off_entirely) {
    RemoteLogConfig c = cfg(); c.remoteEnabled = false; c.echoAlways = false;
    Serial ser; RemoteLog rl(c, Serial::echo, &ser);
    rl.log(LogLevel::Error, 1000, "a.ino:1 f()", "serial only", 1, 1);
    uint32_t seq = 0;
    TEST_ASSERT_EQ((int)rl.pending(), 0, "nothing queued");
    TEST_ASSERT(batch(rl, 99999, true, seq).empty(), "nothing to send");
    TEST_ASSERT(ser.anyContains("serial only"), "printed (serial is then the only place)");
}

TEST(identical_messages_are_collapsed_and_summarised) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    for (int i = 0; i < 100; i++) rl.log(LogLevel::Warn, 1000 + i * 500, "a.ino:9 loop()", "Push connect failed, will retry", 1, 1);  // 50 s of failures, every 0.5 s
    TEST_ASSERT(rl.pending() <= 3, "100 repeats did not become 100 entries");
    uint32_t seq = 0;
    std::string b = batch(rl, 60000, true, seq);
    TEST_ASSERT(has(b, "Push connect failed, will retry"), "the message is there");
    TEST_ASSERT(has(b, "repeated "), "with a repeat count");
    TEST_ASSERT(ser.lines.size() <= 4, "the serial port is not flooded either");
}

TEST(a_different_message_flushes_the_repeat_note_first_and_in_order) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    for (int i = 0; i < 5; i++) rl.log(LogLevel::Warn, 1000 + i * 100, "a.ino:9 loop()", "same thing", 1, 1);
    rl.log(LogLevel::Info, 2000, "a.ino:10 loop()", "something else", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 3, "original, 4 repeats summarised, then the new one");
    uint32_t seq = 0;
    std::string b = batch(rl, 2000, true, seq);
    size_t a = b.find("same thing"), s = b.find("(last message repeated 4 more times)"), n = b.find("something else");
    TEST_ASSERT(a != std::string::npos && s != std::string::npos && n != std::string::npos, "all three present");
    TEST_ASSERT(a < s && s < n, "in the order they happened");
}

TEST(the_repeat_note_appears_by_itself_once_the_repetition_stops) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    for (int i = 0; i < 4; i++) rl.log(LogLevel::Warn, 1000 + i * 100, "a.ino:9 loop()", "flapping", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 1, "only the first so far");
    rl.tick(10000, 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 1, "the window has not passed yet");
    rl.tick(1000 + 300 + 30000, 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 2, "the summary was written without any further message");
}

TEST(the_same_message_after_the_window_is_a_new_entry) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Warn, 0, "s", "again and again", 1, 1);
    rl.log(LogLevel::Warn, 29999, "s", "again and again", 1, 1);   // inside the window: suppressed
    rl.log(LogLevel::Warn, 30000, "s", "again and again", 1, 1);   // window over: a fresh entry (after the summary)
    TEST_ASSERT_EQ((int)rl.pending(), 3, "original + summary of 1 repeat + the fresh one");
}

TEST(same_text_at_a_different_level_is_not_a_repeat) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Info, 0, "s", "x", 1, 1);
    rl.log(LogLevel::Error, 10, "s", "x", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 2, "two entries");
}

TEST(relay_down_the_retry_timeline_matches_the_spec) {
    // 5-minute retry period, 3 retries: attempts at t=0, 5, 10 and 15 minutes, then serial only.
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "a.ino:1 f()", "something broke", 1, 1);
    uint32_t seq = 0;
    uint32_t t = 0;
    const uint32_t MIN = 60000;
    TEST_ASSERT(!batch(rl, t, true, seq).empty(), "attempt 1 (urgent: immediately)");
    rl.onSendResult(t, false, seq);                                   // relay unreachable
    TEST_ASSERT_EQ((int)rl.pending(), 1, "kept in memory");
    TEST_ASSERT(batch(rl, 4 * MIN + 59000, true, seq).empty(), "not before 5 minutes");
    t = 5 * MIN;
    std::string retry1 = batch(rl, t, true, seq);
    TEST_ASSERT(!retry1.empty(), "retry 1 at 5 minutes");
    TEST_ASSERT(has(retry1, "\"attempt\":1"), "the request says which attempt it is");
    TEST_ASSERT(has(retry1, "\"ageMs\":300000"), "and how long ago the event happened, so the relay files it under the right time");
    rl.onSendResult(t, false, seq);
    t = 10 * MIN;
    TEST_ASSERT(!batch(rl, t, true, seq).empty(), "retry 2 at 10 minutes");
    rl.onSendResult(t, false, seq);
    t = 15 * MIN;
    TEST_ASSERT(!batch(rl, t, true, seq).empty(), "retry 3 at 15 minutes");
    rl.onSendResult(t, false, seq);
    TEST_ASSERT(rl.uplinkState() == LogUplink::GaveUp, "after retry 3 failed: gave up");
    TEST_ASSERT_EQ((int)rl.pending(), 0, "the unsendable entry is dropped");
    TEST_ASSERT_EQ((int)rl.dropped(), 1, "and counted");
    TEST_ASSERT(batch(rl, 99 * MIN, true, seq).empty(), "never tries again by itself");
}

TEST(after_giving_up_new_messages_go_to_serial_only_and_are_counted_as_lost) {
    RemoteLogConfig c = cfg(); c.maxRetries = 0; c.echoAlways = false;
    Serial ser; RemoteLog rl(c, Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "first", 1, 1);
    uint32_t seq = 0;
    batch(rl, 0, true, seq);
    rl.onSendResult(0, false, seq);                                   // gave up at once
    rl.log(LogLevel::Error, 5000, "s", "while serial-only", 1, 1);
    TEST_ASSERT_EQ((int)rl.pending(), 0, "not queued (no unbounded growth)");
    TEST_ASSERT(ser.anyContains("while serial-only"), "echoed even though echoAlways is off — it is the only place");
    TEST_ASSERT_EQ((int)rl.dropped(), 2, "both the dropped entry and the serial-only one count as not delivered");
}

TEST(rearming_after_the_relay_returns_resumes_delivery_and_reports_what_was_lost) {
    RemoteLogConfig c = cfg(); c.maxRetries = 0;
    Serial ser; RemoteLog rl(c, Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "lost one", 1, 1);
    uint32_t seq = 0;
    batch(rl, 0, true, seq);
    rl.onSendResult(0, false, seq);                                   // gave up, 1 lost
    rl.log(LogLevel::Error, 1000, "s", "lost two", 1, 1);              // serial only, 2 lost
    TEST_ASSERT(rl.onRelayReachable(), "the relay is back");
    rl.log(LogLevel::Error, 2000, "s", "delivered", 1, 1);
    std::string b = batch(rl, 2000, true, seq);
    TEST_ASSERT(has(b, "\"message\":\"delivered\""), "new entries flow again");
    TEST_ASSERT(has(b, "\"dropped\":2"), "and the relay is told how many were lost");
    rl.onSendResult(2000, true, seq);
    rl.log(LogLevel::Error, 3000, "s", "next", 1, 1);
    TEST_ASSERT(has(batch(rl, 3000, true, seq), "\"dropped\":0"), "reported once, not forever");
}

TEST(a_successful_retry_after_a_failure_delivers_and_resets) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "x", 1, 1);
    uint32_t seq = 0;
    batch(rl, 0, true, seq);
    rl.onSendResult(0, false, seq);
    batch(rl, 300000, true, seq);
    rl.onSendResult(300000, true, seq);
    TEST_ASSERT(rl.uplinkState() == LogUplink::Healthy, "healthy");
    TEST_ASSERT_EQ((int)rl.pending(), 0, "delivered");
    TEST_ASSERT_EQ((int)rl.failedAttempts(), 0, "failures forgotten");
}

TEST(entries_logged_while_a_delivery_is_in_flight_are_not_lost_when_it_succeeds) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "in the batch", 1, 1);
    uint32_t seq = 0;
    std::string b = batch(rl, 0, true, seq);                           // the HTTP request starts...
    rl.log(LogLevel::Error, 100, "s", "logged during the request", 1, 1); // ...and meanwhile the main loop logs
    rl.onSendResult(200, true, seq);
    TEST_ASSERT_EQ((int)rl.pending(), 1, "only the delivered one was removed");
    TEST_ASSERT(has(std::string(rl.queue().at(0).message), "logged during the request"), "the new one is still queued");
}

TEST(a_long_outage_cannot_exhaust_memory_and_errors_survive_it) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "the important error", 1, 1);
    char msg[32];
    for (int i = 0; i < 100; i++) { snprintf(msg, sizeof(msg), "routine %d", i); rl.log(LogLevel::Info, 1000 + (uint32_t)i, "s", msg, 1, 1); }
    TEST_ASSERT_EQ((int)rl.pending(), (int)LOG_QUEUE_CAPACITY, "bounded");
    TEST_ASSERT(has(std::string(rl.queue().at(0).message), "the important error"), "the ERROR was kept");
    TEST_ASSERT_EQ((int)rl.dropped(), 100 + 1 - (int)LOG_QUEUE_CAPACITY, "everything that didn't fit is counted");
}

TEST(a_big_backlog_is_sent_in_batches_of_at_most_eight) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    char msg[16];
    for (int i = 0; i < 20 && i < (int)LOG_QUEUE_CAPACITY; i++) { snprintf(msg, sizeof(msg), "e%d", i); rl.log(LogLevel::Warn, (uint32_t)i, "s", msg, 1, 1); }
    uint32_t seq = 0;
    std::string b1 = batch(rl, 100, true, seq);
    TEST_ASSERT_EQ((int)count(b1, "{\"seq\":"), (int)LOG_BATCH_MAX, "first batch is the maximum");
    rl.onSendResult(100, true, seq);
    TEST_ASSERT_EQ((int)rl.pending(), (int)(LOG_QUEUE_CAPACITY - LOG_BATCH_MAX), "the rest is still waiting");
    std::string b2 = batch(rl, 200, true, seq);
    TEST_ASSERT(has(b2, "\"message\":\"e8\""), "the next batch continues where the first stopped");
    TEST_ASSERT(!has(b2, "\"message\":\"e7\""), "without repeating");
}

TEST(wifi_down_means_no_attempt_and_no_penalty_and_delivery_resumes_with_wifi) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    rl.log(LogLevel::Error, 0, "s", "while offline", 1, 1);
    uint32_t seq = 0;
    TEST_ASSERT(batch(rl, 60000, false, seq).empty(), "no attempt without WiFi");
    TEST_ASSERT_EQ((int)rl.failedAttempts(), 0, "not counted as a failure");
    TEST_ASSERT(has(batch(rl, 61000, true, seq), "\"message\":\"while offline\""), "sent as soon as WiFi is back");
}

TEST(a_very_long_message_is_cut_cleanly_in_the_entry) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    std::string longMsg;
    for (int i = 0; i < 100; i++) longMsg += "dash \xE2\x80\x94 ";
    rl.log(LogLevel::Error, 0, "s", longMsg.c_str(), 1, 1);
    const LogEntry& e = rl.queue().at(0);
    TEST_ASSERT(strlen(e.message) < LOG_MSG_MAX, "fits");
    TEST_ASSERT(strlen(e.message) > 100, "but keeps most of it");
    size_t n = strlen(e.message);
    TEST_ASSERT(strcmp(e.message + n - 3, "...") == 0, "marked as cut");
    for (const char* p = e.message; *p; ++p) {
        if ((unsigned char)*p == 0xE2) TEST_ASSERT((unsigned char)p[1] == 0x80 && (unsigned char)p[2] == 0x94, "no half characters");
    }
}

TEST(everything_works_across_the_millis_wrap_around) {
    Serial ser; RemoteLog rl(cfg(), Serial::echo, &ser);
    uint32_t t = 0xFFFFFFFFu - 2000;                                   // 2 s before the clock wraps
    rl.log(LogLevel::Info, t, "s", "before the wrap", 1, 1);
    uint32_t seq = 0;
    TEST_ASSERT(batch(rl, t + 5000, true, seq).empty(), "5 s old: still waiting, across the wrap");
    std::string b = batch(rl, t + 10000, true, seq);
    TEST_ASSERT(!b.empty(), "10 s old: goes out, across the wrap");
    TEST_ASSERT(has(b, "\"ageMs\":10000,"), "age is right");
}

int main() {
    RUN_TEST(truncation_leaves_short_text_alone);
    RUN_TEST(truncation_marks_the_cut_and_fits_the_buffer);
    RUN_TEST(truncation_never_cuts_a_utf8_character_in_half);
    RUN_TEST(truncation_into_a_tiny_buffer_is_safe);
    RUN_TEST(basename_strips_directories_of_both_kinds);
    RUN_TEST(call_site_format);
    RUN_TEST(appendWhole_refuses_a_piece_that_does_not_fit);
    RUN_TEST(reset_reasons_are_named_and_the_bad_ones_flagged);
    RUN_TEST(level_from_int_clamps);
    RUN_TEST(breadcrumbs_list_recent_events_oldest_first_with_their_age);
    RUN_TEST(breadcrumbs_keep_only_the_most_recent_few);
    RUN_TEST(breadcrumbs_never_emit_a_cut_off_line);
    RUN_TEST(a_breadcrumb_is_always_a_single_line);
    RUN_TEST(breadcrumb_age_survives_the_clock_wrapping);
    RUN_TEST(queue_keeps_order_and_reports_nothing_dropped_until_full);
    RUN_TEST(queue_when_full_drops_the_oldest_NON_error);
    RUN_TEST(queue_full_of_errors_drops_the_oldest_error);
    RUN_TEST(queue_removeThroughSeq_removes_the_delivered_prefix_only);
    RUN_TEST(queue_removeThroughSeq_copes_with_entries_evicted_meanwhile);
    RUN_TEST(queue_clear_and_hasAtLeast);
    RUN_TEST(uplink_healthy_sends_urgent_stale_or_nearly_full_but_not_routine_fresh_entries);
    RUN_TEST(uplink_never_tries_while_wifi_is_down_and_that_is_not_a_failure);
    RUN_TEST(uplink_retry_waits_the_full_period_and_urgent_entries_do_not_shorten_it);
    RUN_TEST(uplink_gives_up_after_the_first_attempt_plus_N_retries);
    RUN_TEST(uplink_zero_retries_gives_up_on_the_first_failure);
    RUN_TEST(uplink_success_resets_the_failure_count);
    RUN_TEST(uplink_rearm_only_revives_a_board_that_gave_up);
    RUN_TEST(uplink_retry_timing_survives_the_clock_wrapping);
    RUN_TEST(json_string_escaping);
    RUN_TEST(json_string_leaves_utf8_alone);
    RUN_TEST(json_batch_exact_shape);
    RUN_TEST(json_batch_with_several_entries_is_comma_separated);
    RUN_TEST(json_age_is_right_when_millis_wrapped_between_the_event_and_the_send);
    RUN_TEST(routine_entries_wait_for_the_flush_interval_then_go_out_together);
    RUN_TEST(an_error_is_sent_immediately_and_carries_its_trace);
    RUN_TEST(an_info_entry_carries_only_its_call_site);
    RUN_TEST(entries_below_the_remote_level_stay_on_serial);
    RUN_TEST(setting_the_remote_level_to_debug_sends_debug_too);
    RUN_TEST(serial_echo_can_be_limited_to_what_is_not_sent_remotely);
    RUN_TEST(serial_echo_line_has_uptime_level_message_and_call_site);
    RUN_TEST(remote_logging_can_be_switched_off_entirely);
    RUN_TEST(identical_messages_are_collapsed_and_summarised);
    RUN_TEST(a_different_message_flushes_the_repeat_note_first_and_in_order);
    RUN_TEST(the_repeat_note_appears_by_itself_once_the_repetition_stops);
    RUN_TEST(the_same_message_after_the_window_is_a_new_entry);
    RUN_TEST(same_text_at_a_different_level_is_not_a_repeat);
    RUN_TEST(relay_down_the_retry_timeline_matches_the_spec);
    RUN_TEST(after_giving_up_new_messages_go_to_serial_only_and_are_counted_as_lost);
    RUN_TEST(rearming_after_the_relay_returns_resumes_delivery_and_reports_what_was_lost);
    RUN_TEST(a_successful_retry_after_a_failure_delivers_and_resets);
    RUN_TEST(entries_logged_while_a_delivery_is_in_flight_are_not_lost_when_it_succeeds);
    RUN_TEST(a_long_outage_cannot_exhaust_memory_and_errors_survive_it);
    RUN_TEST(a_big_backlog_is_sent_in_batches_of_at_most_eight);
    RUN_TEST(wifi_down_means_no_attempt_and_no_penalty_and_delivery_resumes_with_wifi);
    RUN_TEST(a_very_long_message_is_cut_cleanly_in_the_entry);
    RUN_TEST(everything_works_across_the_millis_wrap_around);
    return test::summarize();
}
