// test_person_log_glue.cpp — runs the person detector sketch's ACTUAL remote-logging glue (the block
// between the "Remote logging glue" markers in ESP32_CAM_TFLite_Person.ino) on a desktop, against fake
// Arduino / FreeRTOS / HTTP objects and a fake clock.
//
// remote_log.h holds the decision-making and has its own thorough tests (test_remote_log.cpp); this
// covers what the detector's sketch wraps around it: that the log is serial-only until the settings say
// the live view (and so Wi-Fi) is on, the fixed configuration it then uses (the detector has no LOG_*
// settings), who the entries are filed under, the HTTP request, the mutex discipline and the background
// task. The recorder's sketch has a block of the same shape and test_sketch_log_glue.cpp tests that one.
//
// The glue is not copied here: run_tests.sh extracts it from the .ino into build/person_log_glue.inc
// just before compiling, so this always tests the code that will really be flashed — and fails to
// compile, loudly, if the markers or the functions it needs ever disappear.
//
// Build & run (also done by run_tests.sh):
//   sed -n '/Remote logging glue ──/,/end of remote logging glue/p' ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/person_log_glue.inc
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_log_glue test_person_log_glue.cpp

#include "framework.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

// ── fake Arduino / ESP32 / FreeRTOS environment ─────────────────────────

#define FW_BUILD "test-build 1"

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
#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
using esp32cam_settings::PersonSettings;
static PersonSettings g_cfg;
static void useTypicalSettings() {
    g_cfg = PersonSettings();
    g_cfg.streamEnabled = true;
    g_cfg.serverHost = "192.168.4.9";
    g_cfg.httpPort = 8080;
    g_cfg.detectorId = "detector-1";
    g_cfg.apiKey = "s3cret";
}
static struct TypicalSettingsAtStartup { TypicalSettingsAtStartup() { useTypicalSettings(); } } g_typicalSettings;

#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/remote_log.h"

// What the sketch declares just above the block (the block itself is what gets extracted).
using esp32cam_logic::LogLevel;
using esp32cam_logic::LogUplink;
using esp32cam_logic::RemoteLog;
using esp32cam_logic::RemoteLogConfig;
using esp32cam_logic::LOG_MSG_MAX;
using esp32cam_logic::LOG_SITE_MAX;
using esp32cam_logic::formatCallSite;

// ── the code under test, extracted verbatim from the sketch ─────────────
#include "build/person_log_glue.inc"

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

// Runs the delivery the way the task does, stepping the fake clock in 250 ms ticks until `untilMs`;
// returns how many HTTP requests were made.
static size_t pumpUntil(uint32_t untilMs) {
    size_t before = g_posts.size();
    while (g_now < untilMs) { g_now += 250; remoteLogPump(); }
    return g_posts.size() - before;
}

// ── tests ───────────────────────────────────────────────────────────────
// (The glue's RemoteLog instance is a global, so tests that need a clean one use messages that cannot
// collide with earlier ones, and drain it first.)

TEST(before_the_settings_are_read_the_log_is_serial_only) {
    resetWorld(); g_now = 500;
    RLOG_ERROR("logged before remoteLogConfigure");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "nothing is queued for the relay yet");
    TEST_ASSERT(serialHas("logged before remoteLogConfigure"), "but it is on the serial port");
}

TEST(with_the_live_view_off_nothing_is_ever_queued_or_started) {
    // STREAM_ENABLED=0: no Wi-Fi at all, so no remote logging and no tasks — exactly as before.
    resetWorld();
    g_cfg.streamEnabled = false;
    remoteLogConfigure();
    remoteLogStart();
    TEST_ASSERT_EQ((int)g_tasks.size(), 0, "no delivery task");
    g_now += 100000;
    RLOG_ERROR("serial only now");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "nothing queued for the relay");
    TEST_ASSERT(serialHas("serial only now"), "still on the serial port");
    useTypicalSettings();
}

TEST(configuring_with_the_live_view_on_queues_entries_made_before_the_task_exists) {
    // setup() logs the boot lines BEFORE the camera and the model are initialised (the task is only
    // created afterwards, in startNetwork()): they must wait in memory for it.
    resetWorld(); g_now = 1000;
    remoteLogConfigure();
    RLOG_INFO("boot line logged before the delivery task exists");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 1, "queued for the relay");
    TEST_ASSERT_EQ((int)g_tasks.size(), 0, "and no task is running yet");
}

TEST(starting_creates_the_mutex_and_a_background_task_pinned_to_core_0) {
    resetWorld();
    remoteLogStart();
    TEST_ASSERT_EQ(g_mutexesCreated, 2, "a mutex was created (the earlier test that stayed serial-only created one too)");
    TEST_ASSERT_EQ((int)g_tasks.size(), 1, "one task");
    TEST_ASSERT(g_tasks.size() == 1 && std::string(g_tasks[0].name) == "remoteLog", "named");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].core == 0, "on core 0, where the Wi-Fi stack runs, away from loop()");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].stack >= 8192, "enough stack for an HTTP client");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].fn == remoteLogTask, "runs the delivery loop");
}

TEST(an_error_is_filed_under_the_detector_id_with_the_right_url_headers_and_body) {
    resetWorld(); g_now = 100000;
    pumpUntil(g_now + 30000); g_posts.clear();                  // drain what earlier tests left
    RLOG_ERROR("Camera capture failed (code %d)", 42);
    uint32_t t = g_now;
    g_now = t + 200;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "one request, at once (it is an error)");
    if (g_posts.empty()) return;
    const Post& p = g_posts[0];
    TEST_ASSERT(p.url == "http://192.168.4.9:8080/log", p.url.c_str());
    TEST_ASSERT(headerValue(p, "Content-Type") == "application/json", "JSON content type");
    TEST_ASSERT(headerValue(p, "X-Api-Key") == "s3cret", "the camera key, in the header");
    TEST_ASSERT(has(p.body, "\"camera\":\"detector-1\""), "filed under the DETECTOR_ID, which is how it appears in the relay's log");
    TEST_ASSERT(has(p.body, "\"fw\":\"test-build 1\""), "with the firmware build");
    TEST_ASSERT(has(p.body, "\"level\":\"ERROR\""), "level");
    TEST_ASSERT(has(p.body, "\"message\":\"Camera capture failed (code 42)\""), "message formatted printf-style");
    TEST_ASSERT(has(p.body, "\"rssi\":-64") && has(p.body, "\"heap\":150000"), "signal and heap at that moment");
    TEST_ASSERT(has(p.body, "\"ageMs\":200"), "it says how long ago it happened");
}

TEST(the_trace_names_this_file_and_function_not_the_full_path) {
    resetWorld(); g_now = 500000;
    RLOG_ERROR("where am I");
    g_now += 100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "delivered");
    if (g_posts.empty()) return;
    const std::string& b = g_posts[0].body;
    TEST_ASSERT(has(b, "at test_person_log_glue.cpp:"), "file name without directories");
    TEST_ASSERT(!has(b, "../../") && !has(b, "/home/"), "no directory path");
}

TEST(the_slow_http_request_never_runs_while_the_mutex_is_held) {
    // THE invariant: if the request were made under the lock, every RLOG_*() in loop() would block until it
    // finished — a slow relay would stall detection.
    resetWorld(); g_now = 600000; g_maxLockDepth = 0;
    RLOG_WARN("something to deliver");
    g_now += 100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "delivered");
    if (g_posts.empty()) return;
    TEST_ASSERT_EQ(g_posts[0].lockDepthDuringCall, 0, "the mutex was NOT held during the HTTP call");
    TEST_ASSERT_EQ(g_lockDepth, 0, "every lock was released");
    TEST_ASSERT(g_maxLockDepth <= 1, "locks are never nested");
}

TEST(the_fixed_configuration_info_goes_to_the_relay_after_ten_seconds_debug_never) {
    resetWorld(); g_now = 700000;
    RLOG_INFO("routine event A");
    g_now += 3000;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "3 s old: still waiting so routine lines go out together");
    g_now += 7100;
    remoteLogPump();
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "10 s old: sent");
    g_posts.clear();
    RLOG_DEBUG("only for serial %d", 7);
    pumpUntil(g_now + 60000);
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "a DEBUG line is never sent");
    TEST_ASSERT(serialHas("only for serial 7"), "but it is on the serial port");
}

TEST(the_config_is_fixed_in_the_sketch_there_are_no_log_settings) {
    RemoteLogConfig on = remoteLogConfigFor(true);
    RemoteLogConfig off = remoteLogConfigFor(false);
    TEST_ASSERT(on.remoteEnabled && !off.remoteEnabled, "remote delivery follows the live view");
    TEST_ASSERT(on.remoteMinLevel == LogLevel::Info, "INFO and above");
    TEST_ASSERT(on.echoAlways, "the serial port always gets everything");
    TEST_ASSERT_EQ((int)on.flushIntervalMs, 10000, "routine lines wait 10 s");
    TEST_ASSERT_EQ((int)on.retryPeriodMs, 30000, "a failed delivery is retried after 30 s");
    TEST_ASSERT_EQ((int)on.maxRetries, 3, "three times");
    TEST_ASSERT_EQ((int)on.repeatWindowMs, 30000, "identical messages inside 30 s are counted, not repeated");
}

TEST(relay_down_the_real_glue_retries_every_30_seconds_then_gives_up_and_says_so_on_serial_only) {
    resetWorld(); g_now = 1000000;
    pumpUntil(g_now + 60000);                                   // drain whatever earlier tests left
    g_posts.clear(); g_serial.clear();

    g_relayCode = -1;                                           // relay unreachable
    RLOG_ERROR("relay-down scenario");
    uint32_t t0 = g_now;
    pumpUntil(t0 + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "attempt 1 right away (it is an error)");
    TEST_ASSERT(serialHas("could not deliver log entries (connection refused)"), "the failure is reported on serial");
    TEST_ASSERT(serialHas("retrying in 30 s"), "with the schedule");
    pumpUntil(t0 + 29000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "nothing for the first 30 s");
    pumpUntil(t0 + 31000);
    TEST_ASSERT_EQ((int)g_posts.size(), 2, "retry 1 at 30 s");
    TEST_ASSERT(g_posts.size() > 1 && has(g_posts[1].body, "\"attempt\":1"), "the request says which attempt it is");
    pumpUntil(t0 + 61000);
    pumpUntil(t0 + 91000);
    TEST_ASSERT_EQ((int)g_posts.size(), 4, "retries 2 and 3 at 60 and 90 s: four attempts in all");
    TEST_ASSERT(serialHas("giving up on remote logging after 4 failed deliveries"), "then it says it gave up");
    pumpUntil(t0 + 3600000);
    TEST_ASSERT_EQ((int)g_posts.size(), 4, "and never tries again by itself, however long it waits");
    TEST_ASSERT_EQ(g_lockDepth, 0, "locks balanced throughout");
    TEST_ASSERT_EQ((int)remoteLogInstance.pending(), 0, "the failure notes are serial-only: they never became log entries");
}

TEST(when_the_uplink_to_the_relay_comes_up_remote_logging_resumes_and_says_so) {
    // (relies on the previous test having left the glue in the given-up state)
    TEST_ASSERT(remoteLogInstance.uplinkState() == LogUplink::GaveUp, "precondition: gave up");
    g_relayCode = 200; g_posts.clear(); g_serial.clear();
    remoteLogRelayReachable();
    TEST_ASSERT(remoteLogInstance.uplinkState() == LogUplink::Healthy, "healthy again");
    TEST_ASSERT(serialHas("remote logging resumed"), "announced");
    pumpUntil(g_now + 30000);
    TEST_ASSERT(!g_posts.empty() && has(g_posts[0].body, "remote logging resumed"), "and the announcement itself is delivered to the relay");
    TEST_ASSERT(!g_posts.empty() && !has(g_posts[0].body, "\"dropped\":0"), "along with how many entries were lost while it was given up");
    g_serial.clear();
    remoteLogRelayReachable();
    TEST_ASSERT(!serialHas("resumed"), "an uplink that comes up while logging is healthy says nothing");
}

TEST(wifi_down_nothing_is_attempted_and_the_entry_keeps_its_true_age) {
    resetWorld(); g_now = 5000000;
    pumpUntil(g_now + 30000); g_posts.clear();                 // drain
    g_wifiStatus = 0;                                          // Wi-Fi lost
    RLOG_WARN("Wi-Fi connection lost - reconnecting");
    uint32_t t0 = g_now;
    pumpUntil(t0 + 90000);
    TEST_ASSERT_EQ((int)g_posts.size(), 0, "no attempt without Wi-Fi");
    g_wifiStatus = WL_CONNECTED;
    pumpUntil(g_now + 1000);
    TEST_ASSERT_EQ((int)g_posts.size(), 1, "sent as soon as Wi-Fi is back");
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

TEST(the_background_task_sleeps_250ms_then_runs_the_delivery_and_repeats) {
    resetWorld();
    g_now += 100000;
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
    TEST_ASSERT(g_posts.size() > postsBefore, "the delivery ran inside the loop and sent the entry");
    if (g_posts.size() > postsBefore) TEST_ASSERT(has(g_posts.back().body, "background task probe"), "it is the probe entry");
}

int main() {
    RUN_TEST(before_the_settings_are_read_the_log_is_serial_only);
    RUN_TEST(with_the_live_view_off_nothing_is_ever_queued_or_started);
    RUN_TEST(configuring_with_the_live_view_on_queues_entries_made_before_the_task_exists);
    RUN_TEST(starting_creates_the_mutex_and_a_background_task_pinned_to_core_0);
    RUN_TEST(an_error_is_filed_under_the_detector_id_with_the_right_url_headers_and_body);
    RUN_TEST(the_trace_names_this_file_and_function_not_the_full_path);
    RUN_TEST(the_slow_http_request_never_runs_while_the_mutex_is_held);
    RUN_TEST(the_fixed_configuration_info_goes_to_the_relay_after_ten_seconds_debug_never);
    RUN_TEST(the_config_is_fixed_in_the_sketch_there_are_no_log_settings);
    RUN_TEST(relay_down_the_real_glue_retries_every_30_seconds_then_gives_up_and_says_so_on_serial_only);
    RUN_TEST(when_the_uplink_to_the_relay_comes_up_remote_logging_resumes_and_says_so);
    RUN_TEST(wifi_down_nothing_is_attempted_and_the_entry_keeps_its_true_age);
    RUN_TEST(a_very_long_message_is_cut_cleanly);
    RUN_TEST(the_background_task_sleeps_250ms_then_runs_the_delivery_and_repeats);
    return test::summarize();
}
