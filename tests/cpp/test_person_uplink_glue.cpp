// test_person_uplink_glue.cpp — runs the person detector sketch's ACTUAL uplink glue (the block between
// the "Uplink glue" markers in ESP32_CAM_TFLite_Person.ino: WifiUplinkEnv, logWifi, logHeartbeat) and the
// code that wires it to the board's settings (networkTask, startNetwork, the boot report and the start-up
// failure handling) on a desktop, against fake Arduino / WiFi / lwIP / FreeRTOS / camera-component objects.
//
// report_logic.h decides everything (UplinkSession is unit-tested in test_person_report_logic.cpp and
// run against the real relay in tests/e2e/test_detector_firmware_e2e.js); WifiUplinkEnv is the thin layer
// that turns those decisions into WiFiClient calls. It is the part that can only run on the board, so
// this test is where its details are pinned down:
//   * DNS failure and connect failure are told apart (they have different cures);
//   * a connection the relay has CLOSED is noticed — WiFiClient::connected() counts an orderly close as
//     still connected, so the glue peeks the socket (this is how a relay that refuses and hangs up, or is
//     restarted, is seen at once);
//   * writes survive partial acceptance, and a relay that accepts nothing is given up on after the stall
//     timeout instead of blocking forever;
//   * the snapshot is taken under the mutex, the frame is copied only when it is new, the mutex is always
//     released;
//   * the JPEG encoder's buffer is always freed, success or not;
//   * a '%' in a message never reaches printf as a format;
//   * the Wi-Fi event and heartbeat lines;
//   * networkTask() turns the SETTINGS into the session's configuration (host, port, id, key, picture
//     rate, write timeout, retry cap, heartbeat period) — a unit slip there would silently break the
//     stream — and runs Wi-Fi, firmware-update check, uplink and heartbeat in the right order;
//   * startNetwork() fails loudly and cleanly (out of memory, task not created), never half-started;
//   * the boot report says why the board restarted; a camera or model that cannot start is logged,
//     given time to reach the relay, and followed by a restart instead of silence.
//
// The glue is not copied here: run_tests.sh extracts it from the .ino into build/uplink_glue.inc just
// before compiling, so this always tests the code that will really be flashed — and fails to compile,
// loudly, if the markers or the functions it needs ever disappear.
//
// Build & run (also done by run_tests.sh):
//   sed -n '/Uplink glue ──/,/end of uplink glue/p' ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/uplink_glue.inc
//   sed -n -e '/The task ──/,/end of network task and start/p' -e '/Boot report ──/,/end of boot report/p' ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/network_glue.inc
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_uplink_glue test_person_uplink_glue.cpp

#include "framework.h"

#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

// ── fake Arduino / ESP32 environment ────────────────────────────────────

#define FW_BUILD "a1b2c3d Oct 17 2026 12:00:00"

static uint32_t g_now = 0;
static uint32_t millis() { return g_now; }
static std::vector<uint32_t> g_delays;
static void delay(uint32_t ms) { g_delays.push_back(ms); g_now += ms; }   // time passes while the glue waits

struct String {
    std::string s;
    String() {}
    String(const char* c) : s(c) {}
    const char* c_str() const { return s.c_str(); }
};

struct IPAddress {
    std::string s = "0.0.0.0";
    IPAddress() {}
    IPAddress(const char* c) : s(c) {}
    String toString() const { return String(s.c_str()); }
};

#define WL_CONNECTED 3
static int g_wifiStatus = WL_CONNECTED;
static int g_rssi = -61;
static std::string g_ssid = "extender-1";
static std::string g_localIp = "192.168.4.37";
static bool g_dnsWorks = true;
static std::vector<std::string> g_dnsAsked;
static bool g_wifiDriverOk = true;             // false: the driver cannot start (no internal RAM)
static int g_wifiMode = 0;                     // WIFI_OFF until mode(WIFI_STA) succeeds
static std::vector<std::string> g_wifiCalls;      // "mode:1", "sleep:0", ...
struct FakeWiFi {
    int status() { return g_wifiStatus; }
    int RSSI() { return g_rssi; }
    String SSID() { return String(g_ssid.c_str()); }
    IPAddress localIP() { return IPAddress(g_localIp.c_str()); }
    bool mode(int m) { g_wifiCalls.push_back("mode:" + std::to_string(m)); if (g_wifiDriverOk) g_wifiMode = m; return g_wifiDriverOk; }
    int getMode() { return g_wifiMode; }
    void setSleep(bool on) { g_wifiCalls.push_back(std::string("sleep:") + (on ? "1" : "0")); }
    int hostByName(const char* host, IPAddress& out) { g_dnsAsked.push_back(host); if (!g_dnsWorks) return 0; out = IPAddress("192.168.4.9"); return 1; }
} WiFi;

struct Restarted {};
static uint32_t g_freeHeap = 88000, g_minHeap = 61000;
struct FakeEsp {
    uint32_t getFreeHeap() { return g_freeHeap; }
    uint32_t getMinFreeHeap() { return g_minHeap; }
    const char* getSdkVersion() { return "v5.3.2"; }
    void restart() { throw Restarted(); }
} ESP;

static unsigned g_stackLeft = 5000;
static unsigned uxTaskGetStackHighWaterMark(void*) { return g_stackLeft; }

// -- FreeRTOS mutex: counts balance --
typedef void* SemaphoreHandle_t;
static int g_lockDepth = 0;
static bool g_mutexGranted = true;
static int xSemaphoreTake(SemaphoreHandle_t, uint32_t) { if (!g_mutexGranted) return 0; g_lockDepth++; return 1; }
static int xSemaphoreGive(SemaphoreHandle_t) { g_lockDepth--; return 1; }
#define pdMS_TO_TICKS(ms) (ms)
#define pdTRUE 1
#define pdPASS 1

// -- more FreeRTOS: mutex creation that can fail, tasks that are recorded not run, delays that move the
//    clock (and can end an endless task loop by throwing) --
static bool g_mutexCreateFails = false;
static int g_mutexesCreated = 0, g_mutexesDeleted = 0;
static SemaphoreHandle_t xSemaphoreCreateMutex() { if (g_mutexCreateFails) return nullptr; g_mutexesCreated++; return (SemaphoreHandle_t)0x2; }
static void vSemaphoreDelete(SemaphoreHandle_t) { g_mutexesDeleted++; }
struct TaskCall { const char* name; uint32_t stack; unsigned prio; int core; void (*fn)(void*); };
static std::vector<TaskCall> g_tasks;
static bool g_taskCreateFails = false;
static int xTaskCreatePinnedToCore(void (*fn)(void*), const char* name, uint32_t stack, void*, unsigned prio, void*, int core) {
    if (g_taskCreateFails) return 0;
    g_tasks.push_back({name, stack, prio, core, fn});
    return pdPASS;
}
struct StopTask {};
static std::vector<uint32_t> g_taskDelays;
static int g_stopAfterDelays = -1;
static void (*g_onTaskDelay)() = nullptr;       // what "happens in the world" while the task sleeps
static void vTaskDelay(uint32_t ms) {
    g_taskDelays.push_back(ms);
    g_now += ms;
    if (g_onTaskDelay) g_onTaskDelay();
    if (g_stopAfterDelays >= 0 && (int)g_taskDelays.size() >= g_stopAfterDelays) throw StopTask();
}

// -- malloc that can fail (startNetwork() allocates the picture snapshot with it) --
static bool g_mallocFails = false;
static void* fakeMalloc(size_t n) { return g_mallocFails ? nullptr : ::malloc(n); }

// -- Wi-Fi station setup and the multi-network connector --
#define WIFI_STA 1
static std::vector<int> g_wifiRunScript;           // wifiMulti.run() results, one per call; the last repeats
static size_t g_wifiRunCalls = 0;
struct FakeWiFiMulti {
    std::vector<std::pair<std::string, std::string> > aps;
    void addAP(const char* ssid, const char* pass) { aps.push_back(std::make_pair(std::string(ssid), std::string(pass))); }
    int run() {
        size_t i = g_wifiRunCalls++;
        int r = g_wifiRunScript.empty() ? WL_CONNECTED : g_wifiRunScript[i < g_wifiRunScript.size() ? i : g_wifiRunScript.size() - 1];
        g_wifiStatus = r;
        return r;
    }
};
static FakeWiFiMulti wifiMulti;

// -- the firmware update check (ota.h in the sketch) --
struct OtaCall { std::string host; int port; std::string key; std::string id; };
static std::vector<OtaCall> g_otaCalls;
struct FakeOta { void tick(const std::string& host, int port, const std::string& key, const std::string& id) { g_otaCalls.push_back({host, port, key, id}); } };
static FakeOta otaUpdater;

// -- the settings changed from the dashboard (settings_sync.h in the sketch) --
static int g_settingsSyncTicks = 0;
static void settingsSyncTick() { g_settingsSyncTicks++; }

// -- the internal-RAM line the sketch logs (defined outside the extracted blocks) --
static std::vector<std::string> g_heapStages;
static void logInternalHeap(const char* stage) { g_heapStages.push_back(stage); }

// -- the remote log's delivery task is started from startNetwork() --
static int g_remoteLogStarts = 0;
static void remoteLogStart() { g_remoteLogStarts++; }

// -- what the boot report asks the chip --
static int g_resetReason = 1;
static int esp_reset_reason() { return g_resetReason; }
static bool g_psram = true;
static bool psramFound() { return g_psram; }
#define ESP_ARDUINO_VERSION_MAJOR 3
#define ESP_ARDUINO_VERSION_MINOR 1
#define ESP_ARDUINO_VERSION_PATCH 0

// -- lwIP: the glue peeks the raw socket to see an orderly close --
#define MSG_PEEK 2
#define MSG_DONTWAIT 8
static int g_recvResult = -1;     // what recv() returns
static int g_recvErrno = EWOULDBLOCK;
static int g_recvFlags = 0, g_recvFd = -99;
static int recv(int fd, void*, size_t, int flags) {
    g_recvFd = fd; g_recvFlags = flags;
    if (g_recvResult < 0) errno = g_recvErrno;
    return g_recvResult;
}

// -- the TCP client the glue wraps --
struct WiFiClient {
    // what the tests script
    static bool connectWorks;
    static bool connectedFlag;
    static int fdValue;
    static size_t acceptPerWrite;          // 0 = accepts nothing
    static std::vector<uint8_t> toRead;
    // what the tests inspect
    static std::vector<uint8_t> written;
    static int stops, connects, noDelayCalls, writeCalls;
    static std::string connectIp; static int connectPort; static int connectTimeout; static bool noDelay;
    static int dropAfterWrites;            // the connection dies after this many write() calls (-1 = never)

    void stop() { stops++; connectedFlag = false; }
    int connect(IPAddress ip, uint16_t port, int32_t timeout) {
        connects++; connectIp = ip.s; connectPort = port; connectTimeout = timeout;
        connectedFlag = connectWorks;
        return connectWorks ? 1 : 0;
    }
    void setNoDelay(bool on) { noDelayCalls++; noDelay = on; }
    uint8_t connected() { return connectedFlag; }
    int fd() const { return fdValue; }
    size_t write(const uint8_t* data, size_t len) {
        writeCalls++;
        if (dropAfterWrites >= 0 && writeCalls > dropAfterWrites) { connectedFlag = false; return 0; }
        size_t n = acceptPerWrite < len ? acceptPerWrite : len;
        written.insert(written.end(), data, data + n);
        return n;
    }
    int available() { return (int)toRead.size(); }
    int read(uint8_t* buf, size_t n) {
        size_t k = n < toRead.size() ? n : toRead.size();
        memcpy(buf, toRead.data(), k);
        toRead.erase(toRead.begin(), toRead.begin() + k);
        return (int)k;
    }
    static void reset() {
        connectWorks = true; connectedFlag = false; fdValue = 7; acceptPerWrite = 1000000; toRead.clear();
        written.clear(); stops = connects = noDelayCalls = writeCalls = 0; connectIp.clear(); connectPort = 0; connectTimeout = 0; noDelay = false;
        dropAfterWrites = -1;
    }
};
bool WiFiClient::connectWorks = true;
bool WiFiClient::connectedFlag = false;
int WiFiClient::fdValue = 7;
size_t WiFiClient::acceptPerWrite = 1000000;
std::vector<uint8_t> WiFiClient::toRead;
std::vector<uint8_t> WiFiClient::written;
int WiFiClient::stops = 0, WiFiClient::connects = 0, WiFiClient::noDelayCalls = 0, WiFiClient::writeCalls = 0;
std::string WiFiClient::connectIp; int WiFiClient::connectPort = 0; int WiFiClient::connectTimeout = 0; bool WiFiClient::noDelay = false;
int WiFiClient::dropAfterWrites = -1;

// -- the camera component's JPEG encoder: scripted, and it allocates like the real one --
enum pixformat_t { PIXFORMAT_GRAYSCALE = 3 };
static const int IMAGE_WIDTH = 96, IMAGE_HEIGHT = 96, IMAGE_SIZE = 96 * 96;
static bool g_jpegOk = true;
static size_t g_jpegLen = 600;
static bool g_jpegAllocOnFailure = false;       // a real encoder may fail after it has allocated
static int g_jpegCalls = 0;
static size_t g_jpegSrcLen = 0; static int g_jpegW = 0, g_jpegH = 0; static int g_jpegFmt = 0; static int g_jpegQuality = 0;
static int g_jpegAllocs = 0, g_jpegFrees = 0;
static void* g_jpegBuf = nullptr;
static bool fmt2jpg(uint8_t* src, size_t srcLen, uint16_t w, uint16_t h, pixformat_t fmt, uint8_t quality, uint8_t** out, size_t* outLen) {
    g_jpegCalls++; g_jpegSrcLen = srcLen; g_jpegW = w; g_jpegH = h; g_jpegFmt = (int)fmt; g_jpegQuality = quality;
    (void)src;
    if (!g_jpegOk && !g_jpegAllocOnFailure) { *out = nullptr; *outLen = 0; return false; }
    uint8_t* b = (uint8_t*)malloc(g_jpegLen ? g_jpegLen : 1);
    g_jpegAllocs++; g_jpegBuf = b;
    for (size_t i = 0; i < g_jpegLen; i++) b[i] = (uint8_t)(i & 0xff);
    if (g_jpegLen >= 2) { b[0] = 0xff; b[1] = 0xd8; }
    *out = b; *outLen = g_jpegLen;
    return g_jpegOk;
}
// the glue calls free() on the encoder's buffer: count it
static void countedFree(void* p) { if (p) g_jpegFrees++; ::free(p); }
#define free countedFree

// -- the log: echoes like the real one, remembers the level --
struct LogLine { char level; std::string text; uint32_t at; };
static std::vector<LogLine> g_rlog;
static void fakeLog(char level, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void fakeLog(char level, const char* fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    g_rlog.push_back({level, buf, g_now});
}
#define RLOG_DEBUG(...) fakeLog('D', __VA_ARGS__)
#define RLOG_INFO(...)  fakeLog('I', __VA_ARGS__)
#define RLOG_WARN(...)  fakeLog('W', __VA_ARGS__)
#define RLOG_ERROR(...) fakeLog('E', __VA_ARGS__)
static int g_reachableCalls = 0;
static void remoteLogRelayReachable() { g_reachableCalls++; }

// -- the sketch's settings and the snapshot the detection loop shares with the uplink --
#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
using esp32cam_settings::PersonSettings;
static PersonSettings g_cfg;
#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/remote_log.h"
using esp32cam_logic::isAbnormalReset;       // (the sketch declares these above its logging glue)
using esp32cam_logic::resetReasonName;
static person_report::Snapshot reportSnap;
static uint8_t* reportFrame = nullptr;
static SemaphoreHandle_t reportMutex = nullptr;

// ── the code under test, extracted verbatim from the sketch ─────────────
#include "build/uplink_glue.inc"
#define malloc fakeMalloc
#include "build/network_glue.inc"
#undef malloc
#undef free

// ── helpers ─────────────────────────────────────────────────────────────

static std::vector<uint8_t> g_frameStore;
static void resetWorld() {
    WiFiClient::reset();
    g_now = 1000; g_delays.clear(); g_wifiStatus = WL_CONNECTED; g_rssi = -61; g_ssid = "extender-1"; g_localIp = "192.168.4.37";
    g_dnsWorks = true; g_dnsAsked.clear(); g_freeHeap = 88000; g_minHeap = 61000; g_stackLeft = 5000;
    g_lockDepth = 0; g_mutexGranted = true;
    g_recvResult = -1; g_recvErrno = EWOULDBLOCK; g_recvFlags = 0; g_recvFd = -99;
    g_jpegOk = true; g_jpegLen = 600; g_jpegAllocOnFailure = false; g_jpegCalls = 0; g_jpegAllocs = g_jpegFrees = 0; g_jpegQuality = 0;
    g_rlog.clear(); g_reachableCalls = 0;
    g_mutexCreateFails = false; g_mutexesCreated = g_mutexesDeleted = 0; g_tasks.clear(); g_taskCreateFails = false;
    g_taskDelays.clear(); g_stopAfterDelays = -1; g_onTaskDelay = nullptr; g_mallocFails = false;
    g_wifiCalls.clear(); g_wifiDriverOk = true; g_wifiMode = 0; g_settingsSyncTicks = 0; g_heapStages.clear(); g_wifiRunScript.clear(); g_wifiRunCalls = 0; wifiMulti.aps.clear(); g_otaCalls.clear();
    g_remoteLogStarts = 0; g_resetReason = 1; g_psram = true;
    reportFrame = nullptr; reportMutex = nullptr;
    g_cfg = PersonSettings();
    g_cfg.streamJpegQuality = 80;
    g_frameStore.assign(IMAGE_SIZE, 0x11);
    reportFrame = g_frameStore.data();
    reportMutex = (SemaphoreHandle_t)0x1;
    reportSnap = person_report::Snapshot();
    reportSnap.valid = true; reportSnap.seq = 5; reportSnap.brightness = 99;
}
static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }
static bool logged(char level, const char* part) {
    for (size_t i = 0; i < g_rlog.size(); i++) if (g_rlog[i].level == level && has(g_rlog[i].text, part)) return true;
    return false;
}

// ── open(): DNS and TCP told apart ───────────────────────────────────────

TEST(open_resolves_the_host_connects_to_the_resolved_address_and_turns_nagle_off) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why;
    TEST_ASSERT(env.open("relay.lan", 8080, 4000, why), "opens");
    TEST_ASSERT(g_dnsAsked.size() == 1 && g_dnsAsked[0] == "relay.lan", "the host name was resolved");
    TEST_ASSERT(WiFiClient::connectIp == "192.168.4.9" && WiFiClient::connectPort == 8080 && WiFiClient::connectTimeout == 4000, "connected to the resolved address, port and timeout");
    TEST_ASSERT(WiFiClient::noDelayCalls == 1 && WiFiClient::noDelay, "small messages several times a second: Nagle off");
    TEST_ASSERT(WiFiClient::stops >= 1, "any old socket is dropped first");
}

TEST(a_dns_failure_is_told_apart_from_a_connect_failure) {
    resetWorld();
    g_dnsWorks = false;
    WifiUplinkEnv env;
    std::string why;
    TEST_ASSERT(!env.open("relay.local", 8080, 4000, why), "fails");
    TEST_ASSERT(has(why, "cannot resolve 'relay.local'") && has(why, "SERVER_HOST"), "says it is DNS and what to do");
    TEST_ASSERT_EQ(WiFiClient::connects, 0, "no connect was attempted");
}

TEST(a_connect_failure_names_the_likely_causes_and_the_wifi_signal) {
    resetWorld();
    WiFiClient::connectWorks = false;
    g_rssi = -83;
    WifiUplinkEnv env;
    std::string why;
    TEST_ASSERT(!env.open("192.168.4.9", 8080, 4000, why), "fails");
    TEST_ASSERT(has(why, "TCP connect failed") && has(why, "relay down") && has(why, "SERVER_HOST/HTTP_PORT") && has(why, "firewall"), "the causes");
    TEST_ASSERT(has(why, "-83 dBm"), "and the signal, because a weak link is a common cause");
    TEST_ASSERT(why.size() < 100, "short enough to leave room for the rest of the log line");
}

// ── isOpen(): an orderly close is noticed ────────────────────────────────

TEST(is_open_is_false_when_the_client_says_it_is_not_connected) {
    resetWorld();
    WifiUplinkEnv env;
    WiFiClient::connectedFlag = false;
    TEST_ASSERT(!env.isOpen(), "not connected");
}

TEST(is_open_peeks_the_raw_socket_without_consuming_anything) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why;
    env.open("h", 1, 1000, why);
    g_recvResult = -1; g_recvErrno = EWOULDBLOCK;
    TEST_ASSERT(env.isOpen(), "connected, nothing to read yet: open");
    TEST_ASSERT_EQ(g_recvFd, 7, "the client's socket was looked at");
    TEST_ASSERT((g_recvFlags & MSG_PEEK) && (g_recvFlags & MSG_DONTWAIT), "a peek that never blocks, so nothing is consumed");
}

TEST(an_orderly_close_by_the_relay_is_noticed_although_connected_says_otherwise) {
    // THE reason for the peek: WiFiClient::connected() counts a peer's FIN (recv returns 0) as still
    // connected. Without this the board would think a relay that just refused it, or was restarted, was
    // still there, and find out only when a write failed two messages later.
    resetWorld();
    WifiUplinkEnv env;
    std::string why;
    env.open("h", 1, 1000, why);
    TEST_ASSERT(WiFiClient::connectedFlag, "the client still claims to be connected");
    g_recvResult = 0;
    TEST_ASSERT(!env.isOpen(), "but recv()==0 is the relay's close: not open");
}

TEST(waiting_data_means_open_and_the_other_errors_mean_broken) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why;
    env.open("h", 1, 1000, why);
    g_recvResult = 1;
    TEST_ASSERT(env.isOpen(), "data waiting to be read: still open (as connected() counts it)");
    g_recvResult = -1; g_recvErrno = EAGAIN;
    TEST_ASSERT(env.isOpen(), "EAGAIN is 'nothing yet', the same as EWOULDBLOCK");
    g_recvErrno = ECONNRESET;
    TEST_ASSERT(!env.isOpen(), "a reset is broken");
    g_recvErrno = ENOTCONN;
    TEST_ASSERT(!env.isOpen(), "not connected is broken");
}

TEST(a_client_without_a_socket_is_not_open) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why;
    env.open("h", 1, 1000, why);
    WiFiClient::fdValue = -1;
    TEST_ASSERT(!env.isOpen(), "no descriptor");
}

// ── send() ───────────────────────────────────────────────────────────────

TEST(send_writes_everything_when_the_relay_accepts_it) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why; env.open("h", 1, 1000, why);
    std::vector<uint8_t> data(3000, 0x5a);
    TEST_ASSERT_EQ(env.send(data.data(), data.size(), 3000), (size_t)3000, "all written");
    TEST_ASSERT_EQ(WiFiClient::written.size(), (size_t)3000, "all of it reached the socket");
}

TEST(send_keeps_going_when_the_relay_takes_it_in_pieces) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why; env.open("h", 1, 1000, why);
    WiFiClient::acceptPerWrite = 700;
    std::vector<uint8_t> data(3000);
    for (size_t i = 0; i < data.size(); i++) data[i] = (uint8_t)i;
    TEST_ASSERT_EQ(env.send(data.data(), data.size(), 3000), (size_t)3000, "all written");
    TEST_ASSERT(WiFiClient::written == data, "in order, none repeated or lost");
    TEST_ASSERT_EQ(WiFiClient::writeCalls, 5, "five writes of up to 700");
}

TEST(send_gives_up_on_a_relay_that_accepts_nothing_after_the_stall_timeout) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why; env.open("h", 1, 1000, why);
    WiFiClient::acceptPerWrite = 0;
    uint32_t t0 = g_now;
    std::vector<uint8_t> data(100, 1);
    TEST_ASSERT_EQ(env.send(data.data(), data.size(), 3000), (size_t)0, "nothing was written");
    TEST_ASSERT(g_now - t0 >= 3000 && g_now - t0 < 3100, "it gave up after about the stall timeout, not never and not at once");
    TEST_ASSERT(!g_delays.empty() && g_delays[0] == 2, "and waited in short sleeps, so other tasks run");
}

TEST(send_reports_how_far_it_got_when_the_stall_comes_midway) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why; env.open("h", 1, 1000, why);
    WiFiClient::acceptPerWrite = 600;
    WiFiClient::dropAfterWrites = 2;      // two writes work, then the connection dies
    std::vector<uint8_t> data(3000, 7);
    size_t n = env.send(data.data(), data.size(), 3000);
    TEST_ASSERT_EQ(n, (size_t)1200, "the bytes that were accepted are reported, so the session sees a partial write");
}

TEST(send_does_not_write_to_a_connection_that_is_gone) {
    resetWorld();
    WifiUplinkEnv env;
    WiFiClient::connectedFlag = false;
    std::vector<uint8_t> data(10, 1);
    TEST_ASSERT_EQ(env.send(data.data(), data.size(), 3000), (size_t)0, "nothing written");
    TEST_ASSERT_EQ(WiFiClient::writeCalls, 0, "not even attempted");
}

// ── receive() and close() ────────────────────────────────────────────────

TEST(receive_never_waits_and_reads_what_is_there_up_to_the_buffer_size) {
    resetWorld();
    WifiUplinkEnv env;
    uint8_t buf[8];
    TEST_ASSERT_EQ(env.receive(buf, sizeof(buf)), (size_t)0, "nothing available: 0, at once");
    WiFiClient::toRead.assign(20, 0x41);
    TEST_ASSERT_EQ(env.receive(buf, sizeof(buf)), (size_t)8, "more than fits: the buffer's worth");
    TEST_ASSERT_EQ(env.receive(buf, sizeof(buf)), (size_t)8, "the next lot");
    TEST_ASSERT_EQ(env.receive(buf, sizeof(buf)), (size_t)4, "the rest");
    TEST_ASSERT_EQ(env.receive(buf, sizeof(buf)), (size_t)0, "then nothing");
}

TEST(close_stops_the_client) {
    resetWorld();
    WifiUplinkEnv env;
    std::string why; env.open("h", 1, 1000, why);
    int before = WiFiClient::stops;
    env.close();
    TEST_ASSERT_EQ(WiFiClient::stops, before + 1, "stopped");
    TEST_ASSERT(!WiFiClient::connectedFlag, "no longer connected");
}

// ── the detection loop's snapshot ────────────────────────────────────────

TEST(the_snapshot_copies_the_frame_only_when_it_is_new) {
    resetWorld();
    WifiUplinkEnv env;
    std::vector<uint8_t> mine(IMAGE_SIZE, 0);
    person_report::Snapshot s;
    TEST_ASSERT(env.takeSnapshot(s, mine.data(), 4), "a snapshot");
    TEST_ASSERT(s.valid && s.seq == 5 && s.brightness == 99, "with the readings");
    TEST_ASSERT_EQ((int)mine[0], 0x11, "a frame newer than the one the caller has is copied");
    std::fill(mine.begin(), mine.end(), 0);
    TEST_ASSERT(env.takeSnapshot(s, mine.data(), 5), "again");
    TEST_ASSERT_EQ((int)mine[0], 0, "the frame the caller already has is NOT copied again");
    TEST_ASSERT_EQ(g_lockDepth, 0, "the mutex was released both times");
}

TEST(the_snapshot_is_refused_when_there_is_nothing_to_give_or_no_lock) {
    resetWorld();
    WifiUplinkEnv env;
    std::vector<uint8_t> mine(IMAGE_SIZE, 0);
    person_report::Snapshot s;

    reportSnap.valid = false;
    TEST_ASSERT(!env.takeSnapshot(s, mine.data(), 0), "no frame has been seen yet");
    TEST_ASSERT_EQ(g_lockDepth, 0, "and the mutex is still released");

    reportSnap.valid = true;
    g_mutexGranted = false;
    TEST_ASSERT(!env.takeSnapshot(s, mine.data(), 0), "the detection loop holds the lock: try again next pass, never wait long");
    TEST_ASSERT_EQ(g_lockDepth, 0, "nothing was left locked");
    g_mutexGranted = true;

    reportMutex = nullptr;
    TEST_ASSERT(!env.takeSnapshot(s, mine.data(), 0), "before startNetwork() created the mutex");
    reportMutex = (SemaphoreHandle_t)0x1; reportFrame = nullptr;
    TEST_ASSERT(!env.takeSnapshot(s, mine.data(), 0), "or the frame buffer");
}

// ── the JPEG encoder ─────────────────────────────────────────────────────

TEST(encoding_passes_the_frame_geometry_and_the_configured_quality_and_frees_the_buffer) {
    resetWorld();
    WifiUplinkEnv env;
    std::vector<uint8_t> gray(IMAGE_SIZE, 0x33);
    std::string jpeg;
    TEST_ASSERT(env.encodeJpeg(gray.data(), jpeg), "encoded");
    TEST_ASSERT_EQ(jpeg.size(), (size_t)600, "the bytes were copied out");
    TEST_ASSERT_EQ((int)(uint8_t)jpeg[0], 0xff, "a JPEG");
    TEST_ASSERT(g_jpegSrcLen == 9216 && g_jpegW == 96 && g_jpegH == 96 && g_jpegFmt == PIXFORMAT_GRAYSCALE, "96x96 grayscale");
    TEST_ASSERT_EQ(g_jpegQuality, 80, "STREAM_JPEG_Q");
    TEST_ASSERT_EQ(g_jpegAllocs, g_jpegFrees, "the encoder's buffer was freed (it is a fresh allocation on every call)");
}

TEST(a_failed_encode_reports_failure_and_still_frees_whatever_was_allocated) {
    resetWorld();
    WifiUplinkEnv env;
    std::vector<uint8_t> gray(IMAGE_SIZE, 0x33);
    std::string jpeg;
    g_jpegOk = false;
    TEST_ASSERT(!env.encodeJpeg(gray.data(), jpeg), "reports failure");
    TEST_ASSERT(jpeg.empty(), "nothing copied");

    g_jpegAllocOnFailure = true;
    TEST_ASSERT(!env.encodeJpeg(gray.data(), jpeg), "reports failure again");
    TEST_ASSERT_EQ(g_jpegAllocs, g_jpegFrees, "a buffer the encoder allocated before failing is not leaked");

    g_jpegOk = true; g_jpegAllocOnFailure = false; g_jpegLen = 0;
    TEST_ASSERT(!env.encodeJpeg(gray.data(), jpeg), "success with zero bytes is no picture");
    TEST_ASSERT_EQ(g_jpegAllocs, g_jpegFrees, "and nothing leaks");
}

// ── telemetry, the log, the reachable hook ───────────────────────────────

TEST(telemetry_reports_the_boards_address_signal_and_free_heap) {
    resetWorld();
    WifiUplinkEnv env;
    person_report::Telemetry t = env.telemetry();
    TEST_ASSERT(t.ip == "192.168.4.37" && t.rssi == -61 && t.heap == 88000, "ip, rssi, heap");
}

TEST(log_lines_keep_their_level_and_a_percent_sign_is_never_a_format) {
    resetWorld();
    WifiUplinkEnv env;
    env.log(person_report::Level::Debug, "d");
    env.log(person_report::Level::Info, "i");
    env.log(person_report::Level::Warn, "w");
    env.log(person_report::Level::Error, "e");
    TEST_ASSERT(g_rlog.size() == 4 && g_rlog[0].level == 'D' && g_rlog[1].level == 'I' && g_rlog[2].level == 'W' && g_rlog[3].level == 'E', "each level maps to its own");
    g_rlog.clear();
    env.log(person_report::Level::Warn, "100% of %s and %d are not formats");
    TEST_ASSERT(logged('W', "100% of %s and %d are not formats"), "a message with % signs arrives intact");
}

TEST(the_relay_becoming_reachable_is_passed_on_to_the_log) {
    resetWorld();
    WifiUplinkEnv env;
    env.relayReachable();
    TEST_ASSERT_EQ(g_reachableCalls, 1, "remote logging is told to resume");
    TEST_ASSERT_EQ((int)env.nowMs(), (int)g_now, "and the clock is millis()");
}

// ── the Wi-Fi event lines and the heartbeat ──────────────────────────────

TEST(wifi_events_become_one_log_line_each) {
    using person_report::WifiEvent;
    resetWorld();
    WifiEvent e;
    e.kind = WifiEvent::Connected;
    logWifi(e);
    TEST_ASSERT(logged('I', "Wi-Fi connected to 'extender-1', IP 192.168.4.37, -61 dBm"), "connected: network, address, signal");
    e.kind = WifiEvent::Reconnected; e.downForMs = 125000;
    logWifi(e);
    TEST_ASSERT(logged('I', "Wi-Fi back on 'extender-1'") && logged('I', "it was down for 2m 05s"), "reconnected: and for how long it was gone");
    e.kind = WifiEvent::Lost;
    logWifi(e);
    TEST_ASSERT(logged('W', "Wi-Fi connection lost - reconnecting"), "lost: a warning");
    g_wifiStatus = 1;
    e.kind = WifiEvent::StillDown; e.downForMs = 30000;
    g_rlog.clear();
    logWifi(e);
    TEST_ASSERT(logged('W', "Wi-Fi still not connected: NO_SSID_AVAIL (none of the WIFI networks is in range)"), "still down: what the status means");
    TEST_ASSERT(!logged('W', "30"), "the text has no changing number, so the log can collapse the repeats");
    g_rlog.clear();
    e.kind = WifiEvent::None;
    logWifi(e);
    TEST_ASSERT(g_rlog.empty(), "no event, no line");
}

// A session over a fake environment, only for describe() in the heartbeat.
struct NullEnv : public person_report::IUplinkEnv {
    uint32_t nowMs() override { return g_now; }
    bool open(const std::string&, int, uint32_t, std::string& why) override { why = "refused"; return false; }
    bool isOpen() override { return false; }
    size_t send(const uint8_t*, size_t, uint32_t) override { return 0; }
    size_t receive(uint8_t*, size_t) override { return 0; }
    void close() override {}
    bool takeSnapshot(person_report::Snapshot&, uint8_t*, uint32_t) override { return false; }
    bool encodeJpeg(const uint8_t*, std::string&) override { return false; }
    person_report::Telemetry telemetry() override { return person_report::Telemetry(); }
    void log(person_report::Level, const std::string&) override {}
    void relayReachable() override {}
};

TEST(the_heartbeat_is_two_short_lines_one_for_the_board_one_for_the_link) {
    resetWorld();
    g_now = 3 * 3600000u + 12 * 60000u;
    NullEnv nenv;
    person_report::UplinkConfig ucfg;
    ucfg.host = "192.168.4.9"; ucfg.port = 8080; ucfg.detectorId = "detector-1";
    person_report::UplinkSession session(ucfg, nenv);
    session.step(true);     // one failed attempt, so describe() has a failure to quote
    logHeartbeat(session);
    TEST_ASSERT(logged('I', "heartbeat: Wi-Fi 'extender-1', IP 192.168.4.37, -61 dBm, up 3h 12m, free heap 88000 (lowest 61000)"), "the board: network, address, signal, uptime, memory");
    TEST_ASSERT(logged('I', "heartbeat: relay link down after 1 attempt: could not reach the relay at 192.168.4.9:8080: refused"), "the link: its state and the last failure");
    for (size_t i = 0; i < g_rlog.size(); i++) TEST_ASSERT(g_rlog[i].text.size() < 150, "each line fits the log's 160 bytes");
    TEST_ASSERT(!logged('W', "stack"), "no stack warning while there is plenty");
}

TEST(a_nearly_exhausted_network_task_stack_is_warned_about) {
    resetWorld();
    g_stackLeft = 700;
    NullEnv nenv;
    person_report::UplinkConfig ucfg;
    ucfg.host = "h"; ucfg.port = 1; ucfg.detectorId = "d";
    person_report::UplinkSession session(ucfg, nenv);
    logHeartbeat(session);
    TEST_ASSERT(logged('W', "the network task has only 700 bytes of stack left at its worst"), "a warning with the number");
    TEST_ASSERT(logged('W', "raise its size"), "and what to do about it");
}


// ── startNetwork() ───────────────────────────────────────────────────────

static void typicalLiveViewSettings() {
    g_cfg.streamEnabled = true;
    g_cfg.serverHost = "192.168.4.9"; g_cfg.httpPort = 8080; g_cfg.apiKey = "s3cret"; g_cfg.detectorId = "det-1";
    esp32cam_settings::WifiNet a; a.ssid = "extender-1"; a.pass = "pw1";
    esp32cam_settings::WifiNet b; b.ssid = "extender-2"; b.pass = "pw2";
    g_cfg.wifi.push_back(a); g_cfg.wifi.push_back(b);
    g_cfg.streamMaxFps = 10; g_cfg.streamJpegQuality = 80; g_cfg.streamWriteTimeoutSec = 3;
    g_cfg.announceHeartbeatSec = 600; g_cfg.announceRetrySec = 30;
}

TEST(starting_the_live_view_allocates_the_snapshot_starts_the_log_task_and_the_network_task) {
    resetWorld(); typicalLiveViewSettings();
    reportFrame = nullptr; reportMutex = nullptr;
    TEST_ASSERT(startNetwork(), "starts");
    TEST_ASSERT(reportFrame != nullptr && reportMutex != nullptr, "the snapshot buffer and its mutex exist, so the detection loop's hooks start working");
    TEST_ASSERT_EQ(g_remoteLogStarts, 1, "the log's delivery task was started");
    TEST_ASSERT(g_tasks.size() == 1 && std::string(g_tasks[0].name) == "network", "one task, named");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].core == 0, "on core 0, where the Wi-Fi stack lives, away from detection");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].stack >= 16384, "16 KB: JPEG encoding, the update's HTTP and flash calls and the uplink share this stack");
    TEST_ASSERT(g_tasks.size() == 1 && g_tasks[0].fn == networkTask, "running the network loop");
    TEST_ASSERT(logged('I', "live view starting: Wi-Fi, then the relay at 192.168.4.9:8080 as 'det-1'"), "and the log says where it will connect");
    ::free(reportFrame);
}

TEST(out_of_memory_for_the_snapshot_fails_loudly_and_leaves_nothing_half_started) {
    resetWorld(); typicalLiveViewSettings();
    reportFrame = nullptr; reportMutex = nullptr;
    g_mallocFails = true;
    TEST_ASSERT(!startNetwork(), "reports failure");
    TEST_ASSERT(logged('E', "live view OFF: out of memory for the picture snapshot (free heap 88000 bytes)"), "an ERROR says why and how much memory there was");
    TEST_ASSERT(reportFrame == nullptr && reportMutex == nullptr, "the hooks stay disabled (they need both)");
    TEST_ASSERT_EQ(g_mutexesDeleted, g_mutexesCreated, "the mutex that was created is deleted again: nothing leaks");
    TEST_ASSERT(g_tasks.empty() && g_remoteLogStarts == 0, "no task was started");
}

TEST(a_mutex_that_cannot_be_created_is_the_same_failure) {
    resetWorld(); typicalLiveViewSettings();
    reportFrame = nullptr; reportMutex = nullptr;
    g_mutexCreateFails = true;
    TEST_ASSERT(!startNetwork(), "reports failure");
    TEST_ASSERT(logged('E', "live view OFF: out of memory for the picture snapshot"), "an ERROR says why");
    TEST_ASSERT(reportFrame == nullptr && reportMutex == nullptr && g_tasks.empty(), "nothing is left half started");
}

TEST(a_network_task_that_cannot_be_created_is_reported) {
    resetWorld(); typicalLiveViewSettings();
    reportFrame = nullptr; reportMutex = nullptr;
    g_taskCreateFails = true;
    TEST_ASSERT(!startNetwork(), "reports failure");
    TEST_ASSERT(logged('E', "live view OFF: could not start the network task (free heap 88000 bytes)"), "an ERROR says why");
    TEST_ASSERT(!logged('I', "live view starting"), "and does not claim to be starting");
    ::free(reportFrame);
}

// ── networkTask(): Wi-Fi, firmware update, uplink, heartbeat ─────────────

// Runs the endless task loop for `passes` turns (each ends in vTaskDelay, which the fake turns into a
// StopTask exception after the last one).
static void runNetworkTask(int passes) {
    g_stopAfterDelays = passes;
    try { networkTask(nullptr); } catch (const StopTask&) {}
    g_stopAfterDelays = -1;
}

TEST(the_network_task_puts_wi_fi_in_station_mode_without_sleep_and_adds_every_network) {
    resetWorld(); typicalLiveViewSettings();
    runNetworkTask(1);
    TEST_ASSERT(g_wifiCalls.size() == 2 && g_wifiCalls[0] == "mode:1" && g_wifiCalls[1] == "sleep:0", "station mode, modem-sleep off (it adds latency to every request)");
    TEST_ASSERT(wifiMulti.aps.size() == 2 && wifiMulti.aps[0].first == "extender-1" && wifiMulti.aps[0].second == "pw1" &&
                wifiMulti.aps[1].first == "extender-2" && wifiMulti.aps[1].second == "pw2", "both WIFI networks, with their passwords, in order");
}

TEST(once_wi_fi_is_up_the_task_asks_for_dashboard_settings_changes_every_pass) {
    resetWorld(); typicalLiveViewSettings();
    runNetworkTask(3);
    TEST_ASSERT_EQ(g_settingsSyncTicks, 3, "settingsSyncTick() runs on every pass while the network is up (it does nothing until an ask is due)");
}

TEST(without_a_network_the_task_does_not_ask_for_settings_changes) {
    resetWorld(); typicalLiveViewSettings();
    g_wifiRunScript.push_back(6);                       // WL_DISCONNECTED
    runNetworkTask(5);
    TEST_ASSERT_EQ(g_settingsSyncTicks, 0, "no relay to ask");
}

TEST(a_wi_fi_driver_that_cannot_start_is_retried_quietly_every_five_seconds) {
    resetWorld(); typicalLiveViewSettings();
    g_wifiDriverOk = false;                             // the driver never comes up: no internal RAM
    runNetworkTask(3);
    bool all5000 = g_taskDelays.size() == 3;
    for (size_t i = 0; i < g_taskDelays.size(); i++) if (g_taskDelays[i] != 5000) all5000 = false;
    TEST_ASSERT(all5000, "a 5 s pause per pass instead of hammering the driver every 500 ms");
    TEST_ASSERT_EQ(g_wifiRunCalls, (size_t)0, "WiFiMulti is not asked to connect through a driver that is not there");
    TEST_ASSERT(logged('W', "Wi-Fi driver cannot start"), "one clear warning says why");
    TEST_ASSERT(!g_heapStages.empty() && g_heapStages[0] == "a failed Wi-Fi init", "and the internal-RAM numbers are logged with it");
    TEST_ASSERT(g_otaCalls.empty() && g_settingsSyncTicks == 0, "nothing else runs without a network");
}

TEST(while_wi_fi_is_down_the_task_waits_half_a_second_and_does_nothing_else) {
    resetWorld(); typicalLiveViewSettings();
    g_wifiRunScript.push_back(6);                       // WL_DISCONNECTED
    runNetworkTask(25);                                 // 12.5 s
    bool all500 = true;
    for (size_t i = 0; i < g_taskDelays.size(); i++) if (g_taskDelays[i] != 500) all500 = false;
    TEST_ASSERT(all500 && g_taskDelays.size() == 25, "a 500 ms pause per pass: no busy-waiting, while the radio looks for a network");
    TEST_ASSERT(g_otaCalls.empty(), "no firmware update check without a network");
    TEST_ASSERT_EQ(WiFiClient::connects, 0, "no attempt to reach the relay");
    TEST_ASSERT(!logged('I', "Wi-Fi connected"), "nothing claims it is connected");
    TEST_ASSERT(logged('W', "Wi-Fi still not connected: DISCONNECTED"), "but after 10 s the log says it is STILL not connected, and what the status means");
}

TEST(once_wi_fi_is_up_the_task_checks_for_updates_and_opens_the_uplink_with_the_settings) {
    resetWorld(); typicalLiveViewSettings();
    g_wifiRunScript.push_back(3);
    runNetworkTask(3);
    TEST_ASSERT(g_taskDelays.size() == 3 && g_taskDelays[0] == 10, "a 10 ms pause per pass once connected, so the uplink is serviced promptly");
    TEST_ASSERT(g_otaCalls.size() == 3, "the firmware update check runs every pass (it only acts when one is due)");
    TEST_ASSERT(!g_otaCalls.empty() && g_otaCalls[0].host == "192.168.4.9" && g_otaCalls[0].port == 8080 && g_otaCalls[0].key == "s3cret" && g_otaCalls[0].id == "det-1", "with the relay's address, the key and the detector's id");
    TEST_ASSERT(logged('I', "Wi-Fi connected to 'extender-1', IP 192.168.4.37, -61 dBm"), "the log says it connected, once");
    std::string req(WiFiClient::written.begin(), WiFiClient::written.end());
    TEST_ASSERT(req.rfind("GET /detector/det-1/uplink HTTP/1.1\r\nHost: 192.168.4.9:8080\r\n", 0) == 0, "the uplink request names the detector id and the relay's host and port, straight from the settings");
    TEST_ASSERT(has(req, "X-Api-Key: s3cret\r\n"), "and carries API_KEY");
    TEST_ASSERT_EQ(WiFiClient::connects, 1, "connected once");
}

TEST(a_wi_fi_drop_closes_the_relay_connection_and_the_log_says_so) {
    resetWorld(); typicalLiveViewSettings();
    int seq[] = {3, 3, 6, 6, 3};
    for (int i = 0; i < 5; i++) g_wifiRunScript.push_back(seq[i]);
    runNetworkTask(5);
    TEST_ASSERT(logged('W', "Wi-Fi connection lost - reconnecting"), "the loss is logged once");
    TEST_ASSERT(logged('W', "Wi-Fi is down: the relay connection is closed"), "and the half-open relay connection is closed with it");
    TEST_ASSERT(logged('I', "Wi-Fi back on 'extender-1'"), "the return is logged");
    TEST_ASSERT_EQ(WiFiClient::connects, 2, "and a fresh connection is made at once when it is back");
    TEST_ASSERT(g_taskDelays.size() == 5 && g_taskDelays[2] == 500 && g_taskDelays[3] == 500 && g_taskDelays[4] == 10, "slow polling while down, quick again when up");
}

// How many pictures went out in two seconds with the detection loop producing a frame every pass.
static void detectionLoopProducesAFrame() { reportSnap.valid = true; reportSnap.seq++; }
static int picturesSent() {
    // Walk the messages after the uplink request's head: [4-byte length][1][2-byte status length][status][JPEG?]
    std::string w(WiFiClient::written.begin(), WiFiClient::written.end());
    size_t pos = w.find("\r\n\r\n");
    int withPicture = 0;
    if (pos == std::string::npos) return 0;
    pos += 4;
    while (pos + 7 <= w.size()) {
        size_t len = ((size_t)(uint8_t)w[pos] << 24) | ((size_t)(uint8_t)w[pos + 1] << 16) | ((size_t)(uint8_t)w[pos + 2] << 8) | (size_t)(uint8_t)w[pos + 3];
        if (pos + 4 + len > w.size()) break;
        size_t sl = ((size_t)(uint8_t)w[pos + 5] << 8) | (size_t)(uint8_t)w[pos + 6];
        if (len > 3 + sl) withPicture++;
        pos += 4 + len;
    }
    return withPicture;
}
static int picturesInTwoSeconds(int fps) {
    resetWorld(); typicalLiveViewSettings();
    g_cfg.streamMaxFps = fps;
    const char* ok = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: espcam-detector/1\r\n\r\n";
    WiFiClient::toRead.assign(ok, ok + strlen(ok));
    g_onTaskDelay = detectionLoopProducesAFrame;
    runNetworkTask(200);                                // 200 passes of 10 ms
    return picturesSent();
}

TEST(stream_max_fps_sets_how_many_pictures_go_out_per_second) {
    int at4 = picturesInTwoSeconds(4);
    TEST_ASSERT(at4 >= 7 && at4 <= 9, ("4 pictures/s for 2 s is about 8, got " + std::to_string(at4)).c_str());
    int at20 = picturesInTwoSeconds(20);
    TEST_ASSERT(at20 >= 36 && at20 <= 42, ("20 pictures/s for 2 s is about 40, got " + std::to_string(at20)).c_str());
    int at1 = picturesInTwoSeconds(1);
    TEST_ASSERT(at1 >= 2 && at1 <= 3, ("1 picture/s for 2 s is about 2, got " + std::to_string(at1)).c_str());
}

TEST(ann_retry_caps_how_long_the_task_waits_between_attempts_to_reach_the_relay) {
    resetWorld(); typicalLiveViewSettings();
    g_cfg.announceRetrySec = 10;
    WiFiClient::connectWorks = false;
    runNetworkTask(3500);                               // 35 s: 2 + 4 + 8 s, then the cap
    TEST_ASSERT(logged('W', "retrying in 2 s") && logged('W', "retrying in 4 s") && logged('W', "retrying in 8 s"), "the first retries come soon and double");
    TEST_ASSERT(logged('W', "retrying in 10 s"), "then the wait stops at ANN_RETRY");
    TEST_ASSERT(!logged('W', "retrying in 16 s") && !logged('W', "retrying in 30 s"), "and never goes beyond it");
    TEST_ASSERT(logged('W', "could not reach the relay at 192.168.4.9:8080: TCP connect failed"), "each failure says what the board found out");
}

TEST(ann_heartbeat_sets_how_often_the_status_lines_come) {
    resetWorld(); typicalLiveViewSettings();
    g_cfg.announceHeartbeatSec = 2;
    runNetworkTask(500);                                // 5 s
    int boardLines = 0, linkLines = 0;
    for (size_t i = 0; i < g_rlog.size(); i++) {
        if (has(g_rlog[i].text, "heartbeat: Wi-Fi 'extender-1'")) boardLines++;
        if (has(g_rlog[i].text, "heartbeat: relay link")) linkLines++;
    }
    TEST_ASSERT_EQ(boardLines, 2, "a board line at 2 s and at 4 s");
    TEST_ASSERT_EQ(linkLines, 2, "each followed by the link's state");
}

static uint32_t g_stallStart = 0;
static void relayStopsAcceptingAfterFivePasses() {
    detectionLoopProducesAFrame();
    if (g_taskDelays.size() == 5) { WiFiClient::acceptPerWrite = 0; g_stallStart = g_now; }   // the relay stops accepting data
}

TEST(streaming_wr_tmo_s_decides_how_long_a_stalled_relay_is_waited_for) {
    resetWorld(); typicalLiveViewSettings();
    g_cfg.streamWriteTimeoutSec = 2;
    const char* ok = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: espcam-detector/1\r\n\r\n";
    WiFiClient::toRead.assign(ok, ok + strlen(ok));
    g_onTaskDelay = relayStopsAcceptingAfterFivePasses;
    runNetworkTask(80);
    uint32_t lostAt = 0;
    for (size_t i = 0; i < g_rlog.size(); i++) if (has(g_rlog[i].text, "the relay stopped accepting data")) { lostAt = g_rlog[i].at; break; }
    TEST_ASSERT(lostAt != 0, "the stall is detected and logged as a lost connection");
    TEST_ASSERT(lostAt - g_stallStart >= 2000 && lostAt - g_stallStart < 2300, ("after about the 2 s configured, not 3 and not never; took " + std::to_string(lostAt - g_stallStart) + " ms").c_str());
}

// ── the boot report ──────────────────────────────────────────────────────

TEST(a_normal_boot_reports_firmware_memory_settings_and_where_the_live_view_goes) {
    resetWorld(); typicalLiveViewSettings();
    g_resetReason = 1;
    g_cfg.personGpio = 12; g_cfg.detectThreshold = 0.6f; g_cfg.clearThreshold = 0.5f; g_cfg.darkThreshold = 40; g_cfg.motionThreshold = 300; g_cfg.motionHoldSec = 10;
    logBootInfo();
    TEST_ASSERT(logged('I', "booted (power-on)"), "why it booted, as an INFO when it was a normal power-on");
    TEST_ASSERT(logged('I', "firmware built a1b2c3d Oct 17 2026 12:00:00, detector id det-1, free heap 88000 bytes, PSRAM yes"), "which firmware: did the update reach this board?");
    TEST_ASSERT(logged('I', "Arduino-ESP32 core 3.1.0, ESP-IDF v5.3.2"), "and the platform");
    TEST_ASSERT(logged('I', "settings: alarm GPIO 12, detect at 60%, clear below 50%, dark below 40, motion at 300, hold 10 s"), "the detection settings, so a log alone explains the behaviour");
    TEST_ASSERT(logged('I', "live view: relay 192.168.4.9:8080, at most 10 pictures/s, JPEG quality 80"), "and where the live view goes");
    TEST_ASSERT(!logged('I', "API_KEY") && !logged('I', "s3cret") && !logged('I', "pw1"), "no secret is ever logged");
    for (size_t i = 0; i < g_rlog.size(); i++) TEST_ASSERT(g_rlog[i].text.size() < 150, "each line fits the log's 160 bytes");
}

TEST(an_abnormal_restart_is_an_error_naming_the_reason) {
    resetWorld(); typicalLiveViewSettings();
    g_resetReason = 9;       // brownout
    logBootInfo();
    TEST_ASSERT(logged('E', "booted after an abnormal restart: BROWNOUT (supply voltage dipped"), "an ERROR, so it stands out in the relay's log");
    g_rlog.clear();
    g_resetReason = 4;       // panic
    logBootInfo();
    TEST_ASSERT(logged('E', "booted after an abnormal restart: PANIC (crash / exception)"), "a crash is called a crash");
    g_rlog.clear();
    g_resetReason = 3;       // software restart: deliberate (an update, or the start-up failure restart)
    logBootInfo();
    TEST_ASSERT(logged('I', "booted (software restart)"), "a deliberate restart is not an alarm");
}

TEST(missing_psram_is_stated_and_a_board_without_the_live_view_says_so) {
    resetWorld(); typicalLiveViewSettings();
    g_psram = false;
    logBootInfo();
    TEST_ASSERT(logged('I', "PSRAM NO"), "the camera cannot work without PSRAM: say so up front");
    g_rlog.clear();
    g_cfg.streamEnabled = false;
    logBootInfo();
    TEST_ASSERT(logged('I', "detector id (live view off)"), "no id to report when the live view is off");
    TEST_ASSERT(logged('I', "live view is off (STREAM_ENABLED=0): no Wi-Fi, nothing is sent to the relay"), "and it says that nothing will be sent");
}

// ── start-up failure ─────────────────────────────────────────────────────

TEST(a_camera_that_will_not_start_is_logged_given_time_to_reach_the_relay_then_restarted) {
    resetWorld(); typicalLiveViewSettings();
    reportFrame = nullptr; reportMutex = nullptr;
    uint32_t t0 = g_now;
    bool restarted = false;
    try { startupFailed("Camera initialization FAILED"); } catch (const Restarted&) { restarted = true; }
    TEST_ASSERT(restarted, "the board restarts instead of sitting in an empty loop, looking fine on a serial cable");
    TEST_ASSERT(logged('E', "Camera initialization FAILED - the detector cannot work, restarting in 30 s"), "an ERROR says what failed and what happens next");
    TEST_ASSERT(g_now - t0 >= 30000 && g_now - t0 < 30300, "after 30 s: time for Wi-Fi to come up and the line to reach the relay");
    TEST_ASSERT(g_tasks.size() == 1 && std::string(g_tasks[0].name) == "network", "the network is started for that, with the live view on");
    ::free(reportFrame);
}

TEST(without_the_live_view_a_start_up_failure_starts_no_network_but_still_restarts) {
    resetWorld(); typicalLiveViewSettings();
    g_cfg.streamEnabled = false;
    bool restarted = false;
    try { startupFailed("TFLite initialization FAILED"); } catch (const Restarted&) { restarted = true; }
    TEST_ASSERT(restarted, "restarts");
    TEST_ASSERT(g_tasks.empty() && g_remoteLogStarts == 0, "no Wi-Fi task: STREAM_ENABLED=0 means no Wi-Fi at all");
    TEST_ASSERT(logged('E', "TFLite initialization FAILED - the detector cannot work, restarting in 30 s"), "still logged (to the serial port)");
}

int main() {
    RUN_TEST(open_resolves_the_host_connects_to_the_resolved_address_and_turns_nagle_off);
    RUN_TEST(a_dns_failure_is_told_apart_from_a_connect_failure);
    RUN_TEST(a_connect_failure_names_the_likely_causes_and_the_wifi_signal);
    RUN_TEST(is_open_is_false_when_the_client_says_it_is_not_connected);
    RUN_TEST(is_open_peeks_the_raw_socket_without_consuming_anything);
    RUN_TEST(an_orderly_close_by_the_relay_is_noticed_although_connected_says_otherwise);
    RUN_TEST(waiting_data_means_open_and_the_other_errors_mean_broken);
    RUN_TEST(a_client_without_a_socket_is_not_open);
    RUN_TEST(send_writes_everything_when_the_relay_accepts_it);
    RUN_TEST(send_keeps_going_when_the_relay_takes_it_in_pieces);
    RUN_TEST(send_gives_up_on_a_relay_that_accepts_nothing_after_the_stall_timeout);
    RUN_TEST(send_reports_how_far_it_got_when_the_stall_comes_midway);
    RUN_TEST(send_does_not_write_to_a_connection_that_is_gone);
    RUN_TEST(receive_never_waits_and_reads_what_is_there_up_to_the_buffer_size);
    RUN_TEST(close_stops_the_client);
    RUN_TEST(the_snapshot_copies_the_frame_only_when_it_is_new);
    RUN_TEST(the_snapshot_is_refused_when_there_is_nothing_to_give_or_no_lock);
    RUN_TEST(encoding_passes_the_frame_geometry_and_the_configured_quality_and_frees_the_buffer);
    RUN_TEST(a_failed_encode_reports_failure_and_still_frees_whatever_was_allocated);
    RUN_TEST(telemetry_reports_the_boards_address_signal_and_free_heap);
    RUN_TEST(log_lines_keep_their_level_and_a_percent_sign_is_never_a_format);
    RUN_TEST(the_relay_becoming_reachable_is_passed_on_to_the_log);
    RUN_TEST(wifi_events_become_one_log_line_each);
    RUN_TEST(the_heartbeat_is_two_short_lines_one_for_the_board_one_for_the_link);
    RUN_TEST(a_nearly_exhausted_network_task_stack_is_warned_about);
    RUN_TEST(starting_the_live_view_allocates_the_snapshot_starts_the_log_task_and_the_network_task);
    RUN_TEST(out_of_memory_for_the_snapshot_fails_loudly_and_leaves_nothing_half_started);
    RUN_TEST(a_mutex_that_cannot_be_created_is_the_same_failure);
    RUN_TEST(a_network_task_that_cannot_be_created_is_reported);
    RUN_TEST(the_network_task_puts_wi_fi_in_station_mode_without_sleep_and_adds_every_network);
    RUN_TEST(while_wi_fi_is_down_the_task_waits_half_a_second_and_does_nothing_else);
    RUN_TEST(once_wi_fi_is_up_the_task_checks_for_updates_and_opens_the_uplink_with_the_settings);
    RUN_TEST(a_wi_fi_drop_closes_the_relay_connection_and_the_log_says_so);
    RUN_TEST(stream_max_fps_sets_how_many_pictures_go_out_per_second);
    RUN_TEST(ann_retry_caps_how_long_the_task_waits_between_attempts_to_reach_the_relay);
    RUN_TEST(ann_heartbeat_sets_how_often_the_status_lines_come);
    RUN_TEST(streaming_wr_tmo_s_decides_how_long_a_stalled_relay_is_waited_for);
    RUN_TEST(a_normal_boot_reports_firmware_memory_settings_and_where_the_live_view_goes);
    RUN_TEST(an_abnormal_restart_is_an_error_naming_the_reason);
    RUN_TEST(missing_psram_is_stated_and_a_board_without_the_live_view_says_so);
    RUN_TEST(a_camera_that_will_not_start_is_logged_given_time_to_reach_the_relay_then_restarted);
    RUN_TEST(without_the_live_view_a_start_up_failure_starts_no_network_but_still_restarts);
    return test::summarize();
}
