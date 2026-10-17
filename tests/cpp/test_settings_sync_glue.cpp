#include "fake_core.h"
// Tests for settings_sync.h — the Arduino half of changing a board's stored settings from the
// dashboard — compiled for real against the fakes of the core (ota_fakes/). What this proves:
// the header compiles as the sketch will use it, asks for the right URL with the camera key,
// applies a queued change to the (fake) flash, reports it with the right body, and asks for a
// restart only after a real change. What every decision is (all-or-nothing, locked settings,
// never leaving the board incomplete) is tested in test_settings_change.cpp. It can NOT prove
// the real radio and flash work: that needs a board.

#include "framework.h"

#include "settings_schema.h"
#include "settings_sync.h"
#include "settings_fakes.h"

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

static void fill(MemoryStore& st) {
  esp32cam_settings::CheckedLine c = esp32cam_settings::checkLine(esp32cam_settings::RECORDER_SCHEMA, TYPICAL);
  for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
}
static void resetWorld() { fake::g() = fake::State(); fake::g().wifiUp = true; }
static void route(const std::string& part, int code, const std::string& body = "") {
  fake::Route r; r.part = part; r.code = code; r.body = body;
  fake::g().routes.push_back(r);
}
// Ticks once per fake second until `untilMs`; true if any tick asked for a restart.
static bool runUntil(SettingsSync& s, uint32_t untilMs) {
  bool restart = false;
  while (fake::g().now < untilMs) {
    fake::g().now += 1000;
    if (s.tick("relay.lan", 8080, "KEY123", "cam2")) restart = true;
  }
  return restart;
}
static size_t count(const std::string& method, const std::string& part) {
  size_t n = 0;
  for (size_t i = 0; i < fake::g().requests.size(); i++)
    if (fake::g().methods[i] == method && fake::g().requests[i].find(part) != std::string::npos) n++;
  return n;
}
static SettingsSync make(MemoryStore& st) { return SettingsSync(esp32cam_settings::RECORDER_SCHEMA, st, "recorder", esp32cam_settings::recorderLockedKeys()); }

TEST(nothing_is_asked_while_wifi_is_down) {
  resetWorld(); fake::g().wifiUp = false;
  MemoryStore st; fill(st); SettingsSync s = make(st);
  runUntil(s, 200000);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "no request without Wi-Fi");
}

TEST(the_first_ask_comes_after_the_start_delay_not_before) {
  resetWorld(); route("/change", 404); route("/report", 200);
  MemoryStore st; fill(st); SettingsSync s = make(st);
  runUntil(s, 20000);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "nothing in the first 20 s: the camera gets the radio first");
  runUntil(s, 22000);
  TEST_ASSERT(count("GET", "/change") >= 1, "then it asks");
}

TEST(it_reports_the_board_then_asks_with_the_right_url_and_camera_key) {
  resetWorld(); route("/change", 404); route("/report", 200);
  MemoryStore st; fill(st); SettingsSync s = make(st);
  runUntil(s, 25000);
  TEST_ASSERT_EQ(count("POST", "/report"), (size_t)1, "one boot report");
  size_t i = 0; while (fake::g().methods[i] != "GET") i++;
  TEST_ASSERT_EQ(fake::g().requests[i], std::string("http://relay.lan:8080/device-settings/recorder/cam2/change"), "ask URL");
  TEST_ASSERT_EQ(fake::g().headers[i]["X-Api-Key"], std::string("KEY123"), "camera key");
  size_t j = 0; while (fake::g().methods[j] != "POST") j++;
  TEST_ASSERT_EQ(fake::g().requests[j], std::string("http://relay.lan:8080/device-settings/recorder/cam2/report"), "report URL");
  TEST_ASSERT_EQ(fake::g().headers[j]["X-Api-Key"], std::string("KEY123"), "camera key on the report too");
  const std::string& body = fake::g().bodies[j];
  TEST_ASSERT(body.compare(0, 7, "0\nboot\n") == 0, "boot report body starts with number 0 and 'boot'");
  TEST_ASSERT(body.find("PUSH_GAP_MUL=1.5") != std::string::npos, "carries the settings");
  TEST_ASSERT(body.find("s3cret") == std::string::npos && body.find("password1") == std::string::npos, "no secret leaves the board");
}

TEST(a_queued_change_is_stored_reported_and_asks_for_a_restart) {
  resetWorld(); route("/change", 200, "555\nLOG_HEARTBEAT=900\n"); route("/report", 200);
  MemoryStore st; fill(st); SettingsSync s = make(st);
  bool restart = runUntil(s, 25000);
  TEST_ASSERT(restart, "restart requested");
  TEST_ASSERT_EQ(st.m["LOG_HEARTBEAT"], std::string("900"), "stored in flash");
  TEST_ASSERT_EQ(s.changedNames(), std::string("LOG_HEARTBEAT"), "names for the log");
  std::string last;
  for (size_t i = 0; i < fake::g().requests.size(); i++) if (fake::g().methods[i] == "POST") last = fake::g().bodies[i];
  TEST_ASSERT(last.compare(0, 12, "555\napplied\n") == 0, "reported as applied for that change number");
  TEST_ASSERT(last.find("LOG_HEARTBEAT=900") != std::string::npos, "with the new values");
}

TEST(a_refused_change_is_reported_and_does_not_restart) {
  resetWorld(); route("/change", 200, "556\nAPI_KEY=another-key\n"); route("/report", 200);
  MemoryStore st; fill(st); SettingsSync s = make(st);
  bool restart = runUntil(s, 25000);
  TEST_ASSERT(!restart, "no restart");
  TEST_ASSERT_EQ(st.m["API_KEY"], std::string("s3cret"), "the key is untouched");
  std::string last;
  for (size_t i = 0; i < fake::g().requests.size(); i++) if (fake::g().methods[i] == "POST") last = fake::g().bodies[i];
  TEST_ASSERT(last.compare(0, 13, "556\nrejected\n") == 0, "reported as rejected");
}

TEST(an_answer_that_does_not_parse_is_ignored) {
  resetWorld(); route("/change", 200, "garbage without a number"); route("/report", 200);
  MemoryStore st; fill(st); SettingsSync s = make(st);
  TEST_ASSERT(!runUntil(s, 25000), "no restart");
  TEST_ASSERT_EQ(count("POST", "/report"), (size_t)1, "only the boot report: nothing was applied");
}

TEST(an_unreachable_relay_changes_nothing) {
  resetWorld();   // no routes: every request is "connection refused"
  MemoryStore st; fill(st); SettingsSync s = make(st);
  std::map<std::string, std::string> before = st.m;
  TEST_ASSERT(!runUntil(s, 100000), "no restart");
  TEST_ASSERT(st.m == before, "flash untouched");
}

int main() {
  RUN_TEST(nothing_is_asked_while_wifi_is_down);
  RUN_TEST(the_first_ask_comes_after_the_start_delay_not_before);
  RUN_TEST(it_reports_the_board_then_asks_with_the_right_url_and_camera_key);
  RUN_TEST(a_queued_change_is_stored_reported_and_asks_for_a_restart);
  RUN_TEST(a_refused_change_is_reported_and_does_not_restart);
  RUN_TEST(an_answer_that_does_not_parse_is_ignored);
  RUN_TEST(an_unreachable_relay_changes_nothing);
  return test::summarize();
}
