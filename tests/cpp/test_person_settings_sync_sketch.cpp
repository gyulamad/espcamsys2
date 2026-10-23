#include "fake_core.h"
// The person detector's "Settings changed from the dashboard" block (the CALIBRATE page), extracted VERBATIM from
// ESP32_CAM_TFLite_Person.ino by run_tests.sh and compiled against fakes of what it touches (the flash,
// the log, restartBoard, the core). settings_sync.h and the poller are tested on their own
// (test_settings_sync_glue.cpp, test_settings_change.cpp); this proves the sketch's own few lines
// join them up correctly — names qualified, the store and schema passed, the right settings used for
// the relay, and the board restarted (once) only after a real change. If the markers move or a name
// changes, the extract is empty/wrong and this fails to compile — loudly.
//
// Build & run (run_tests.sh extracts the block first):
//   sed -n '/Settings changed from the dashboard ──/,/end of settings changed from the dashboard/p'
//       ../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino > build/person_sync_glue.inc

#include "framework.h"

#include <cstdarg>
#include <cstdio>

#include "settings_schema.h"
#include "settings_fakes.h"

using esp32cam_settings::PersonSettings;

// ── what the sketch provides to the block ──
PersonSettings g_cfg;
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
#include "../build/person_sync_glue.inc"

static const char* TYPICAL =
    "PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;"
    "MOTION_HOLD_S=10;STREAM_ENABLED=1;WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;"
    "API_KEY=s3cret;DETECTOR_ID=detector-1;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;"
    "ANN_HEARTBEAT=600;ANN_RETRY=30";

static void setUp() {
  // A reboot resets the sketch's statics and the clock together; the fake clock restarts at 0 here, so
  // the poller (created on first use) must be created afresh too.
  delete g_sync; g_sync = nullptr; delete g_syncStore; g_syncStore = nullptr;
  fake::g() = fake::State(); fake::g().wifiUp = true;
  g_flash = MemoryStore();
  esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(esp32cam_settings::PERSON_SCHEMA, TYPICAL);
  for (size_t i = 0; i < c.pairs.size(); ++i) g_flash.set(c.pairs[i].key, c.pairs[i].value);
  g_cfg = PersonSettings();
  g_cfg.serverHost = "relay.lan"; g_cfg.httpPort = 8080; g_cfg.detectorId = "detector-1"; g_cfg.apiKey = "KEY123";
  g_restarts = 0; g_log.clear();
}
static void route(const std::string& part, int code, const std::string& body = "") {
  fake::Route r; r.part = part; r.code = code; r.body = body; fake::g().routes.push_back(r);
}
static void runSeconds(int n) { for (int i = 0; i < n; i++) { fake::g().now += 1000; settingsSyncTick(); } }

TEST(the_detector_asks_the_relay_as_a_detector_with_its_own_id_host_port_and_key) {
  setUp(); route("/change", 404); route("/report", 200);
  runSeconds(60);
  bool asked = false;
  for (size_t i = 0; i < fake::g().requests.size(); i++) {
    if (fake::g().methods[i] == "GET" && fake::g().requests[i] == "http://relay.lan:8080/device-settings/detector/detector-1/change") {
      asked = true;
      TEST_ASSERT_EQ(fake::g().headers[i]["X-Api-Key"], std::string("KEY123"), "camera key");
    }
  }
  TEST_ASSERT(asked, "asked the relay for a change as a detector, for its own id");
  TEST_ASSERT_EQ(g_restarts, 0, "nothing queued: no restart");
}

TEST(a_calibration_change_is_stored_logged_by_name_and_restarts_the_detector_once) {
  setUp(); route("/change", 200, "777\nDARK_THRESH=55;MOTION_THRESH=450;DETECT_THRESH=0.7\n"); route("/report", 200);
  runSeconds(60);
  TEST_ASSERT_EQ(g_flash.m["DARK_THRESH"], std::string("55"), "stored in the (fake) flash");
  TEST_ASSERT_EQ(g_flash.m["MOTION_THRESH"], std::string("450"), "all of it");
  TEST_ASSERT_EQ(g_flash.m["DETECT_THRESH"], std::string("0.7"), "including a threshold with a fraction");
  TEST_ASSERT(g_restarts >= 1, "the detector restarts so the new values take effect");
  TEST_ASSERT(g_log.find("DARK_THRESH, MOTION_THRESH, DETECT_THRESH") != std::string::npos, "the log names what changed");
  TEST_ASSERT(g_log.find("450") == std::string::npos, "...and never a value");
}

TEST(the_connection_settings_and_the_alarm_pin_are_refused_by_the_sketch_wiring) {
  const char* lines[] = { "778\nSERVER_HOST=10.9.9.9\n", "779\nDETECTOR_ID=other\n", "780\nPERSON_GPIO=4\n", "781\nSTREAM_ENABLED=0\n" };
  for (size_t i = 0; i < 4; i++) {
    setUp(); route("/change", 200, lines[i]); route("/report", 200);
    runSeconds(60);
    TEST_ASSERT_EQ(g_flash.m["SERVER_HOST"], std::string("192.168.4.9"), "the server is unchanged");
    TEST_ASSERT_EQ(g_flash.m["DETECTOR_ID"], std::string("detector-1"), "the id is unchanged");
    TEST_ASSERT_EQ(g_flash.m["PERSON_GPIO"], std::string("13"), "the alarm pin is unchanged");
    TEST_ASSERT_EQ(g_flash.m["STREAM_ENABLED"], std::string("1"), "the live view stays on");
    TEST_ASSERT_EQ(g_restarts, 0, "no restart");
  }
}

TEST(a_clear_threshold_above_the_detect_threshold_is_refused) {
  setUp(); route("/change", 200, "782\nCLEAR_THRESH=0.9\n"); route("/report", 200);
  runSeconds(60);
  TEST_ASSERT_EQ(g_flash.m["CLEAR_THRESH"], std::string("0.5"), "unchanged: the hysteresis would be inverted");
  TEST_ASSERT_EQ(g_restarts, 0, "no restart");
}

TEST(both_thresholds_changed_together_are_accepted) {
  setUp(); route("/change", 200, "783\nDETECT_THRESH=0.9;CLEAR_THRESH=0.8\n"); route("/report", 200);
  runSeconds(60);
  TEST_ASSERT_EQ(g_flash.m["DETECT_THRESH"], std::string("0.9"), "stored");
  TEST_ASSERT_EQ(g_flash.m["CLEAR_THRESH"], std::string("0.8"), "stored");
  TEST_ASSERT(g_restarts >= 1, "restarts");
}

TEST(a_wifi_that_is_down_asks_nothing) {
  setUp(); fake::g().wifiUp = false; route("/change", 200, "784\nDARK_THRESH=55\n");
  runSeconds(120);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "no request");
  TEST_ASSERT_EQ(g_restarts, 0, "no restart");
}

int main() {
  RUN_TEST(the_detector_asks_the_relay_as_a_detector_with_its_own_id_host_port_and_key);
  RUN_TEST(a_calibration_change_is_stored_logged_by_name_and_restarts_the_detector_once);
  RUN_TEST(the_connection_settings_and_the_alarm_pin_are_refused_by_the_sketch_wiring);
  RUN_TEST(a_clear_threshold_above_the_detect_threshold_is_refused);
  RUN_TEST(both_thresholds_changed_together_are_accepted);
  RUN_TEST(a_wifi_that_is_down_asks_nothing);
  return test::summarize();
}
