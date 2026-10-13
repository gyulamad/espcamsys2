// test_sketch_log_glue.cpp — runs the sketch's ACTUAL remote-logging glue
// (the block between the "Remote logging glue" markers in
// ESP32_CAM_Recorder.ino) on a desktop, against fake Arduino / FreeRTOS /
// HTTP objects and a fake clock.
//
// remote_log.h holds the decision-making and has its own thorough tests; this
// covers what the sketch wraps around it: formatting a message, capturing the
// call site, the mutex discipline, the background uplink task, the HTTP
// request (URL, headers, body) and the serial-only failure notes.
//
// The glue is not copied here: run_tests.sh extracts it from the .ino into
// build/log_glue.inc just before compiling, so this always tests the code that
// will really be flashed — and fails to compile, loudly, if the markers or the
// functions it needs ever disappear.
//
// Build & run (also done by run_tests.sh):
//   sed -n '/Remote logging glue ──/,/end of remote logging glue/p' ../../Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino > build/log_glue.inc
//   g++ -std=c++17 -Wall -Wextra -o build/test_sketch_log_glue test_sketch_log_glue.cpp

#include "framework.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

// ── fake Arduino / ESP32 / FreeRTOS environment ─────────────────────────

static uint32_t g_now = 0;
static uint32_t millis() { return g_now; }

struct String {
    std::string s;
    String() {}
    String(const char* c) : s(c) {}
    const char* c_str() const { return s.c_str(); }
    String operator+(int v) const { return String((s + std::to_string(v)).c_str()); }
};

#define WL_CONNECTED 3
static int g_wifiStatus = WL_CONNECTED;
static int g_rssi = -64;
struct FakeWiFi {
    int status() { return g_wifiStatus; }
    int RSSI() { return g_rssi; }
} WiFi;

static uint32_t g_freeHeap = 150000;
struct FakeEsp { uint32_t getFreeHeap() { return g_freeHeap; } } ESP;

static std::vector<std::string> g_serial;
struct FakeSerial {
    void println(const char* s) { g_serial.push_back(s); }
    void printf(const char* fmt, ...) __attribute__((format(printf, 2, 3))) {
        char buf[512];
        va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
        g_serial.push_back(buf);
    }
} Serial;

// -- the mutex: counts nesting so the tests can assert the discipline --
typedef void* SemaphoreHandle_t;
#define portMAX_DELAY 0xFFFFFFFFu
static int g_lockDepth = 0;
static int g_maxLockDepth = 0;
static int g_mutexesCreated = 0;
static SemaphoreHandle_t xSemaphoreCreateMutex() { g_mutexesCreated++; return (SemaphoreHandle_t)0x1; }
static int xSemaphoreTake(SemaphoreHandle_t, uint32_t) { g_lockDepth++; if (g_lockDepth > g_maxLockDepth) g_maxLockDepth = g_lockDepth; return 1; }
static int xSemaphoreGive(SemaphoreHandle_t) { g_lockDepth--; return 1; }

// -- the task API: recorded, not run --
struct TaskCall { const char* name; uint32_t stack; unsigned prio; int core; void (*fn)(void*); };
static std::vector<TaskCall> g_tasks;
static int xTaskCreatePinnedToCore(void (*fn)(void*), const char* name, uint32_t stack, void*, unsigned prio, void*, int core) {
    g_tasks.push_back({name, stack, prio, core, fn});
    return 1;
}
// vTaskDelay records the delays; a test can make the Nth call throw StopTask
// so that an endless task body (for (;;) { ... }) can be run for a few turns.
struct StopTask {};
static std::vector<uint32_t> g_taskDelays;
static int g_stopAfterDelays = -1;
static void vTaskDelay(uint32_t ms) {
    g_taskDelays.push_back(ms);
    if (g_stopAfterDelays >= 0 && (int)g_taskDelays.size() > g_stopAfterDelays) throw StopTask();
}
#define pdMS_TO_TICKS(ms) (ms)

// -- the HTTP client, talking to a controllable fake relay --
struct Post { std::string url; std::vector<std::pair<std::string, std::string>> headers; std::string body; int lockDepthDuringCall; };
static std::vector<Post> g_posts;
static int g_relayCode = 200;       // what the fake relay answers; <= 0 = could not connect
struct HTTPClient {
    std::string url; int timeout = 0; std::vector<std::pair<std::string, std::string>> headers;
    void begin(String u) { url = u.s; }
    void setTimeout(int t) { timeout = t; }
    void addHeader(const char* k, const char* v) { headers.push_back({k, v}); }
    int POST(uint8_t* data, size_t len) {
        g_posts.push_back({url, headers, std::string((const char*)data, len), g_lockDepth});
        return g_relayCode;
    }
    String errorToString(int) { return String("connection refused"); }
    void end() {}
};

// -- the sketch's settings: what setup() has read from flash (settings_schema.h) --
#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
using esp32cam_settings::RecorderSettings;
static RecorderSettings g_cfg;
static void useTypicalSettings() {
    g_cfg = RecorderSettings();
    g_cfg.serverHost = "192.168.4.9";
    g_cfg.httpPort = 8080;
    g_cfg.cameraId = "cam2";
    g_cfg.apiKey = "s3cret";
    g_cfg.logEnabled = true;
    g_cfg.logMinLevel = 1;          // INFO
    g_cfg.logEcho = true;
    g_cfg.logRetryMax = 3;
    g_cfg.logRetrySec = 300;        // 5 minutes
    g_cfg.logFlushSec = 10;
    g_cfg.logRepeatSec = 30;
}
static struct TypicalSettingsAtStartup { TypicalSettingsAtStartup() { useTypicalSettings(); } } g_typicalSettings;

#include "../../Arduino/ESP32_CAM_Recorder/logic.h"
#include "../../Arduino/ESP32_CAM_Recorder/remote_log.h"
using namespace esp32cam_logic;

// ── the code under test, extracted verbatim from the sketch ─────────────
#include "build/log_glue.inc"

// ── helpers ─────────────────────────────────────────────────────────────

static void resetWorld() {
    g_posts.clear(); g_serial.clear(); g_tasks.clear();
    g_relayCode = 200; g_wifiStatus = WL_CONNECTED; g_rssi = -64; g_freeHeap = 150000;
}
static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }
static bool serialHas(const char* part) { for (const auto& l : g_serial) if (has(l, part)) return true; return false; }
static std::string headerValue(const Post& p, const char* name) {
    for (const auto& h : p.headers) if (h.first == name) return h.second;
    return "<missing>";
}

// Runs the uplink the way the task does, stepping the fake clock in 250 ms
// ticks until `untilMs`; returns how many HTTP requests were made.
static size_t pumpUntil(uint32_t untilMs) {
    size_t before = g_posts.size();
    while (g_now < untilMs) { g_now += 250; remoteLogPump(); }
    return g_posts.size() - before;
}

// ── tests ───────────────────────────────────────────────────────────────
// (The glue's RemoteLog instance is a global, so tests that need a clean one
// use messages that cannot collide with earlier ones, and drain it first.)

TEST(before_start_up_the_log_is_serial_only_because_the_settings_are_not_read_yet) {
    resetWorld(); g_now = 500;
    RLOG_ERROR("logged before remoteLogStart");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "nothing is queued for the relay yet");
    TEST_ASSERT(serialHas("logged before remoteLogStart"), "but it is on the serial port");
}

TEST(starting_creates_the_mutex_and_a_background_task_pinned_to_core_0) {
    resetWorld();
    remoteLogStart();
    TEST_ASSERT_EQ(g_mutexesCreated, 1, "one mutex");
    TEST_ASSERT_EQ((int)g_tasks.size(), 1, "one task");
    TEST_ASSERT(std::string(g_tasks[0].name) == "remoteLog", "named");
    TEST_ASSERT_EQ(g_tasks[0].core, 0, "on core 0, where the WiFi stack runs, away from loop()");
    TEST_ASSERT(g_tasks[0].stack >= 8192, "enough stack for an HTTP client");
    TEST_ASSERT(g_tasks[0].fn == remoteLogTask, "runs the uplink loop");
}

TEST(an_error_is_delivered_with_the_right_url_headers_and_body) {
    resetWorld(); g_now = 1000;
    RLOG_ERROR("Frame capture failed (code %d)", 42);
    g_now = 1200;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "one request");
    if (g_posts.empty()) return;
    const Post& p = g_posts[0];
    TEST_ASSERT(p.url == "http://192.168.4.9:8080/log", p.url.c_str());
    TEST_ASSERT(headerValue(p, "Content-Type") == "application/json", "JSON content type");
    TEST_ASSERT(headerValue(p, "X-Api-Key") == "s3cret", "the camera key, in the header");
    TEST_ASSERT(has(p.body, "\"camera\":\"cam2\""), "who is sending");
    TEST_ASSERT(has(p.body, "\"level\":\"ERROR\""), "level");
    TEST_ASSERT(has(p.body, "\"message\":\"Frame capture failed (code 42)\""), "message formatted printf-style");
    TEST_ASSERT(has(p.body, "\"rssi\":-64") && has(p.body, "\"heap\":150000"), "signal and heap at that moment");
    TEST_ASSERT(has(p.body, "\"ageMs\":200"), "it says how long ago it happened");
}

TEST(the_trace_names_this_file_and_function_not_the_full_path) {
    resetWorld(); g_now = 5000;
    RLOG_ERROR("where am I");
    g_now = 5100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "delivered");
    if (g_posts.empty()) return;
    const std::string& b = g_posts[0].body;
    TEST_ASSERT(has(b, "at test_sketch_log_glue.cpp:"), "file name without directories");
    TEST_ASSERT(!has(b, "../../") && !has(b, "/home/"), "no directory path");
    TEST_ASSERT(has(b, "()"), "and a function name");
}

TEST(the_slow_http_request_never_runs_while_the_mutex_is_held) {
    // THE invariant: if the request were made under the lock, every RLOG_* call in
    // loop() would block until it finished — logging would stall the video stream.
    resetWorld(); g_now = 10000; g_maxLockDepth = 0;
    RLOG_WARN("something to deliver");
    g_now = 10100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "delivered");
    if (g_posts.empty()) return;
    TEST_ASSERT_EQ(g_posts[0].lockDepthDuringCall, 0, "the mutex was NOT held during the HTTP call");
    TEST_ASSERT_EQ(g_lockDepth, 0, "every lock was released");
    TEST_ASSERT(g_maxLockDepth <= 1, "locks are never nested");
}

TEST(a_routine_info_waits_for_the_flush_interval) {
    resetWorld(); g_now = 20000;
    RLOG_INFO("routine event A");
    g_now = 23000;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "3 s old: still waiting");
    g_now = 30100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "10 s old: sent");
}

TEST(debug_stays_on_serial_by_default_but_is_printed) {
    resetWorld(); g_now = 40000;
    RLOG_DEBUG("only for serial %d", 7);
    g_now = 60000;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "never sent at the default level");
    TEST_ASSERT(serialHas("only for serial 7"), "but on the serial port");
}

TEST(serial_output_has_uptime_level_message_and_call_site) {
    resetWorld(); g_now = 12345;
    RLOG_WARN("odd thing");
    TEST_ASSERT(g_serial.size() >= 1, "printed");
    const std::string& l = g_serial.back();
    TEST_ASSERT(l.rfind("[12.3s WARN] odd thing  (test_sketch_log_glue.cpp:", 0) == 0, l.c_str());
    g_now = 100000; remoteLogPump(); g_now += 1000; remoteLogPump(); // drain
}

TEST(relay_down_the_real_glue_retries_on_the_five_minute_schedule_then_gives_up) {
    resetWorld(); g_now = 1000000;
    // drain whatever earlier tests left, with a healthy relay
    pumpUntil(g_now + 60000);
    g_posts.clear(); g_serial.clear();

    g_relayCode = -1;                                           // relay unreachable
    RLOG_ERROR("relay-down scenario");
    uint32_t t0 = g_now;
    pumpUntil(t0 + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "attempt 1 right away (it is an error)");
    TEST_ASSERT(serialHas("could not deliver log entries (connection refused)"), "the failure is reported on serial");
    pumpUntil(t0 + 4 * 60000 + 59000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "nothing for the first 5 minutes");
    pumpUntil(t0 + 5 * 60000 + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 2, "retry 1 at 5 minutes");
    TEST_ASSERT(g_posts.size() > 1 && has(g_posts[1].body, "\"attempt\":1"), "the request says which attempt it is");
    TEST_ASSERT(g_posts.size() > 1 && has(g_posts[1].body, "\"ageMs\":3"), "and how old the entry is (about 5 minutes)");
    pumpUntil(t0 + 10 * 60000 + 1000);
    pumpUntil(t0 + 15 * 60000 + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 4, "retries 2 and 3 at 10 and 15 minutes: four attempts in all");
    TEST_ASSERT(serialHas("giving up on remote logging after 4 failed deliveries"), "then it says it gave up");
    pumpUntil(t0 + 120 * 60000);
    TEST_ASSERT_EQ((int)g_posts.size(), 4, "and never tries again by itself, however long it waits");
    TEST_ASSERT_EQ(g_lockDepth, 0, "locks balanced throughout");
}

TEST(the_delivery_failure_notes_are_serial_only_and_never_become_log_entries) {
    // (relies on the previous test having left the glue in the given-up state)
    TEST_ASSERT(remoteLogInstance.uplinkState() == LogUplink::GaveUp, "precondition: gave up");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "nothing queued, so the note did not feed itself");
}

TEST(when_the_relay_is_reachable_again_remote_logging_resumes_and_says_so) {
    g_relayCode = 200; g_posts.clear(); g_serial.clear();
    remoteLogRelayReachable();
    TEST_ASSERT(remoteLogInstance.uplinkState() == LogUplink::Healthy, "healthy again");
    TEST_ASSERT(serialHas("remote logging resumed"), "announced");
    pumpUntil(g_now + 30000);
    TEST_ASSERT(g_posts.size() >= 1, "and the announcement itself is delivered");
    TEST_ASSERT(!g_posts.empty() && has(g_posts[0].body, "remote logging resumed"), "to the relay");
    TEST_ASSERT(!g_posts.empty() && has(g_posts[0].body, "\"dropped\":"), "along with how many entries were lost");
    TEST_ASSERT(!g_posts.empty() && !has(g_posts[0].body, "\"dropped\":0"), "a non-zero number: the entry that was given up on");
}

TEST(wifi_down_nothing_is_attempted_and_the_entry_keeps_its_true_age) {
    resetWorld(); g_now = 5000000;
    pumpUntil(g_now + 30000); g_posts.clear();                 // drain
    g_wifiStatus = 0;                                          // WiFi lost
    RLOG_WARN("WiFi connection lost — reconnecting");
    uint32_t t0 = g_now;
    pumpUntil(t0 + 90000);
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "no attempt without WiFi");
    g_wifiStatus = WL_CONNECTED;
    pumpUntil(g_now + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "sent as soon as WiFi is back");
    TEST_ASSERT(!g_posts.empty() && has(g_posts[0].body, "\"ageMs\":9"), "filed as having happened about 90 s ago, not when it arrived");
}

TEST(a_very_long_message_is_cut_cleanly) {
    resetWorld(); g_now = 7000000;
    pumpUntil(g_now + 30000); g_posts.clear();
    std::string big(500, 'x');
    RLOG_ERROR("%s", big.c_str());
    g_now += 100; remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "delivered");
    TEST_ASSERT(!g_posts.empty() && has(g_posts[0].body, "xxx...\""), "ends with ... instead of overflowing");
    TEST_ASSERT(!g_posts.empty() && g_posts[0].body.size() < 2000, "the request stays small");
}

TEST(the_background_task_sleeps_250ms_then_runs_the_uplink_and_repeats) {
    resetWorld();
    g_now += 100000;                       // well past everything earlier tests did
    RLOG_ERROR("background task probe");   // urgent: due on the very next pump
    g_taskDelays.clear();
    g_stopAfterDelays = 2;                 // sleep, pump, sleep, pump, sleep -> stop
    size_t postsBefore = g_posts.size();
    bool stopped = false;
    try { remoteLogTask(nullptr); } catch (const StopTask&) { stopped = true; }
    g_stopAfterDelays = -1;
    TEST_ASSERT(stopped, "the task loop is endless: it only ended because the test stopped it");
    TEST_ASSERT_EQ((int)g_taskDelays.size(), 3, "three sleeps: it sleeps first, then pumps, every turn");
    for (uint32_t d : g_taskDelays) TEST_ASSERT_EQ((int)d, 250, "each sleep is 250 ms");
    TEST_ASSERT(g_posts.size() > postsBefore, "the uplink ran inside the loop and sent the entry");
    if (g_posts.size() > postsBefore) TEST_ASSERT(has(g_posts.back().body, "background task probe"), "it is the probe entry");
}

TEST(the_log_settings_decide_the_level_and_timing_the_log_is_started_with) {
    // remoteLogStart() applies the settings that were read from flash.
    resetWorld();
    g_cfg.logMinLevel = 2;          // WARN and above go to the relay
    g_cfg.logFlushSec = 3;
    g_cfg.logRetryMax = 1;
    g_cfg.logRetrySec = 60;
    g_cfg.logRepeatSec = 0;
    remoteLogStart();
    g_now += 100000;
    pumpUntil(g_now + 30000); g_posts.clear();                 // drain
    RLOG_INFO("an info below the level");
    RLOG_WARN("a warning at the level");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 1, "INFO stays on serial; only the WARN is queued");
    pumpUntil(g_now + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "the WARN is delivered right away");
    g_relayCode = -1;
    RLOG_ERROR("relay is down");
    pumpUntil(g_now + 1000);
    pumpUntil(g_now + 61000);
    TEST_ASSERT_EQ(remoteLogInstance.uplinkState() == LogUplink::GaveUp ? 1 : 0, 1,
                   "1 retry after 60 s, then given up (LOG_RETRY_MAX=1, LOG_RETRY_SEC=60)");
    useTypicalSettings();
}

TEST(with_remote_logging_off_in_the_settings_no_uplink_task_is_started) {
    resetWorld();
    g_cfg.logEnabled = false;
    remoteLogStart();
    TEST_ASSERT_EQ((int)g_tasks.size(), 0, "no background task when LOG_ENABLED=0");
    g_now += 1000000;
    RLOG_ERROR("serial only now");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "nothing is queued for the relay");
    TEST_ASSERT(serialHas("serial only now"), "it is still printed on serial");
    useTypicalSettings();
}

int main() {
    RUN_TEST(before_start_up_the_log_is_serial_only_because_the_settings_are_not_read_yet);
    RUN_TEST(starting_creates_the_mutex_and_a_background_task_pinned_to_core_0);
    RUN_TEST(an_error_is_delivered_with_the_right_url_headers_and_body);
    RUN_TEST(the_trace_names_this_file_and_function_not_the_full_path);
    RUN_TEST(the_slow_http_request_never_runs_while_the_mutex_is_held);
    RUN_TEST(a_routine_info_waits_for_the_flush_interval);
    RUN_TEST(debug_stays_on_serial_by_default_but_is_printed);
    RUN_TEST(serial_output_has_uptime_level_message_and_call_site);
    RUN_TEST(relay_down_the_real_glue_retries_on_the_five_minute_schedule_then_gives_up);
    RUN_TEST(the_delivery_failure_notes_are_serial_only_and_never_become_log_entries);
    RUN_TEST(when_the_relay_is_reachable_again_remote_logging_resumes_and_says_so);
    RUN_TEST(wifi_down_nothing_is_attempted_and_the_entry_keeps_its_true_age);
    RUN_TEST(a_very_long_message_is_cut_cleanly);
    RUN_TEST(the_background_task_sleeps_250ms_then_runs_the_uplink_and_repeats);
    RUN_TEST(the_log_settings_decide_the_level_and_timing_the_log_is_started_with);
    RUN_TEST(with_remote_logging_off_in_the_settings_no_uplink_task_is_started);
    return test::summarize();
}
