#include "fake_core.h"
// The sketch's "Settings changed from the dashboard" block, extracted VERBATIM from
// ESP32_CAM_Recorder.ino by run_tests.sh and compiled against fakes of what it touches (the flash,
// the log, restartBoard, the core). settings_sync.h and the poller are tested on their own
// (test_settings_sync_glue.cpp, test_settings_change.cpp); this proves the sketch's own few lines
// join them up correctly — names qualified, the store and schema passed, the right settings used for
// the relay, and the board restarted (once) only after a real change. If the markers move or a name
// changes, the extract is empty/wrong and this fails to compile — loudly.
//
// Build & run (run_tests.sh extracts the block first):
//   sed -n '/Settings changed from the dashboard ──/,/end of settings changed from the dashboard/p'
//       ../../Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino > build/sync_glue.inc

#include "framework.h"

#include <cstdarg>
#include <cstdio>

#include "settings_schema.h"
#include "settings_fakes.h"

using esp32cam_settings::RecorderSettings;

// ── what the sketch provides to the block ──
RecorderSettings g_cfg;
static MemoryStore g_flash;                                     // "the flash": shared by every PreferencesStore, like the real NVS
class PreferencesStore : public esp32cam_settings::ISettingsStore {
 public:
  bool has(const std::string& k) override { return g_flash.has(k); }
  std::string get(const std::string& k) override { return g_flash.get(k); }
  bool set(const std::string& k, const std::string& v) override { return g_flash.set(k, v); }
  void clearAll() override { g_flash.clearAll(); }
};
static int g_restarts = 0;
void restartBoard() { g_restarts++; }
static std::string g_log;
static void logCapture(const char* fmt, ...) {
  char buf[512]; va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
  g_log += buf; g_log += "\n";
}
#define RLOG_INFO(...) logCapture(__VA_ARGS__)
void settingsSyncTick();   // forward-declared in the sketch before otaTask(), defined by the block

// ── the code under test, extracted verbatim from the sketch ──
#include "../build/sync_glue.inc"

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

static void setUp() {
  // A reboot resets the sketch's statics and the clock together; the fake clock restarts at 0 here, so
  // the poller (created on first use) must be created afresh too.
  delete g_sync; g_sync = nullptr; delete g_syncStore; g_syncStore = nullptr;
  fake::g() = fake::State(); fake::g().wifiUp = true;
  g_flash = MemoryStore();
  esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(esp32cam_settings::RECORDER_SCHEMA, TYPICAL);
  for (size_t i = 0; i < c.pairs.size(); ++i) g_flash.set(c.pairs[i].key, c.pairs[i].value);
  g_cfg = RecorderSettings();
  g_cfg.serverHost = "relay.lan"; g_cfg.httpPort = 8080; g_cfg.cameraId = "cam2"; g_cfg.apiKey = "KEY123";
  g_restarts = 0; g_log.clear();
}
static void route(const std::string& part, int code, const std::string& body = "") {
  fake::Route r; r.part = part; r.code = code; r.body = body; fake::g().routes.push_back(r);
}
static void runSeconds(int n) { for (int i = 0; i < n; i++) { fake::g().now += 1000; settingsSyncTick(); } }

TEST(the_board_asks_the_relay_with_its_own_id_host_port_and_key) {
  setUp(); route("/change", 404); route("/report", 200);
  runSeconds(60);
  bool asked = false;
  for (size_t i = 0; i < fake::g().requests.size(); i++) {
    if (fake::g().methods[i] == "GET" && fake::g().requests[i] == "http://relay.lan:8080/device-settings/recorder/cam2/change") {
      asked = true;
      TEST_ASSERT_EQ(fake::g().headers[i]["X-Api-Key"], std::string("KEY123"), "camera key");
    }
  }
  TEST_ASSERT(asked, "asked the relay for a change as a recorder, for its own id");
  TEST_ASSERT_EQ(g_restarts, 0, "nothing queued: no restart");
}

TEST(a_queued_change_is_stored_logged_by_name_and_restarts_the_board_once) {
  setUp(); route("/change", 200, "777\nLOG_HEARTBEAT=900;PUSH_GAP_MUL=2\n"); route("/report", 200);
  runSeconds(60);
  TEST_ASSERT_EQ(g_flash.m["LOG_HEARTBEAT"], std::string("900"), "stored in the (fake) flash");
  TEST_ASSERT_EQ(g_flash.m["PUSH_GAP_MUL"], std::string("2"), "all of it");
  TEST_ASSERT(g_restarts >= 1, "the board restarts so the new values take effect");
  TEST_ASSERT(g_log.find("LOG_HEARTBEAT, PUSH_GAP_MUL") != std::string::npos, "the log names what changed");
  TEST_ASSERT(g_log.find("900") == std::string::npos, "…and never a value");
}

TEST(a_connection_setting_is_refused_by_the_sketch_wiring_too) {
  setUp(); route("/change", 200, "778\nSERVER_HOST=10.9.9.9\n"); route("/report", 200);
  runSeconds(60);
  TEST_ASSERT_EQ(g_flash.m["SERVER_HOST"], std::string("192.168.4.9"), "the server is unchanged: the sketch passes the locked list");
  TEST_ASSERT_EQ(g_restarts, 0, "no restart");
}

TEST(a_wifi_that_is_down_asks_nothing) {
  setUp(); fake::g().wifiUp = false; route("/change", 200, "779\nLOG_HEARTBEAT=900\n");
  runSeconds(120);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "no request");
  TEST_ASSERT_EQ(g_restarts, 0, "no restart");
}

int main() {
  RUN_TEST(the_board_asks_the_relay_with_its_own_id_host_port_and_key);
  RUN_TEST(a_queued_change_is_stored_logged_by_name_and_restarts_the_board_once);
  RUN_TEST(a_connection_setting_is_refused_by_the_sketch_wiring_too);
  RUN_TEST(a_wifi_that_is_down_asks_nothing);
  return test::summarize();
}
