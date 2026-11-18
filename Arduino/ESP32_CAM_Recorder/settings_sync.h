// settings_sync.h — the Arduino half of "change this board's stored settings from the
// dashboard": every half minute or so it asks the relay whether a change is queued for this
// board, applies it, tells the relay what happened, and says when the board must restart.
// Every DECISION (what is allowed, all-or-nothing, never leaving the board incomplete, when to
// ask, what to report) is in settings_logic.h (ChangePoller & co.) and unit-tested; this file
// only joins it to HTTPClient. The desktop tests compile it against fakes of the core
// (tests/cpp/test_settings_sync_glue.cpp); the real radio and flash can only be checked on a board.
//
// Like ota.h, call it from a background task that already does networking, never from loop()
// (HTTP in loop() would stall the stream):
//     SettingsSync sync(RECORDER_SCHEMA, store, "recorder", recorderLockedKeys());
//     if (sync.tick(host, httpPort, apiKey, id)) { /* settings were stored */ restart(); }
//
// Since F-29 the schedule is a SETTING, not a build-time knob (SYNC_ENABLED, SYNC_FIRST_S,
// SYNC_CHECK_S). The values reach this class through the constructor; the defaults are the old
// hard-coded ones, so a sketch that passes nothing behaves exactly as before. SYNC_ENABLED is the
// sketch's decision, made once per tick from its settings — a sync switched off mid-boot must not
// resurrect here.

#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include <string>
#include <vector>

#include "settings_logic.h"

// The relay as the poller sees it:
//   GET  /device-settings/<type>/<id>/change   -> 200 "<number>\n<KEY=value;...>", or 404 (nothing queued)
//   POST /device-settings/<type>/<id>/report   body "<number>\n<result>\n<message>\n<KEY=value;...>"
// Both with X-Api-Key (the camera key), like every other request a camera makes.
class RelayChangeLink : public esp32cam_settings::IChangeLink {
 public:
  explicit RelayChangeLink(const char* type) : type_(type), port_(0) {}

  void target(const std::string& host, int port, const std::string& apiKey, const std::string& id) {
    host_ = host; port_ = port; apiKey_ = apiKey; id_ = id;
  }

  bool online() override { return WiFi.status() == WL_CONNECTED; }

  esp32cam_settings::FetchResult fetchChange(std::string& rev, std::string& line) override {
    HTTPClient http;
    http.begin(String(url("change").c_str()));
    http.setTimeout(5000);
    http.addHeader("X-Api-Key", apiKey_.c_str());
    int code = http.GET();
    std::string body;
    if (code == 200) body = http.getString().c_str();
    http.end();
    if (code == 404) return esp32cam_settings::FetchResult::NothingStaged;
    if (code != 200) return esp32cam_settings::FetchResult::Failed;
    if (!esp32cam_settings::parseChangeReply(body, rev, line)) return esp32cam_settings::FetchResult::Failed;
    return esp32cam_settings::FetchResult::Got;
  }

  bool report(const std::string& rev, const std::string& result, const std::string& message,
              const std::string& settingsLine) override {
    std::string body = rev + "\n" + result + "\n" + esp32cam_settings::oneLine(message) + "\n" + settingsLine;
    HTTPClient http;
    http.begin(String(url("report").c_str()));
    http.setTimeout(5000);
    http.addHeader("X-Api-Key", apiKey_.c_str());
    http.addHeader("Content-Type", "text/plain");
    int code = http.POST(String(body.c_str()));
    http.end();
    return code == 200;
  }

 private:
  std::string url(const char* what) const {
    return "http://" + host_ + ":" + std::to_string(port_) + "/device-settings/" + type_ + "/" + id_ + "/" + what;
  }
  std::string type_, host_, apiKey_, id_;
  int port_;
};

class SettingsSync {
 public:
  // `firstS` / `checkS`: the ask schedule in seconds, from the sketch's settings (SYNC_FIRST_S,
  // SYNC_CHECK_S); the defaults are the old hard-coded values. ChangePoller takes milliseconds.
  SettingsSync(const esp32cam_settings::Schema& schema, esp32cam_settings::ISettingsStore& store, const char* type,
               const std::vector<std::string>& lockedKeys, uint32_t firstS = 20, uint32_t checkS = 30)
      : link_(type),
        poller_(schema, store, link_, lockedKeys, firstS * 1000UL, checkS * 1000UL) {}

  // true: settings were stored — restart the board so they take effect. Does nothing unless an
  // ask is due; takes a few seconds when it is, so call it from a background task only. Whether
  // the board asks at all is the sketch's decision (SYNC_ENABLED), made before the call.
  bool tick(const std::string& host, int port, const std::string& apiKey, const std::string& id) {
    link_.target(host, port, apiKey, id);
    return poller_.tick(millis()) == esp32cam_settings::ChangePoller::Restart;
  }

  // true: the restart tick() asked for was requested by the dashboard (a command), not caused by new
  // settings — so the log says so instead of listing no settings.
  bool rebootRequested() const { return poller_.rebootRequested(); }

  // Names only, for the log (values can be passwords).
  std::string changedNames() const {
    std::string out;
    const std::vector<std::string>& c = poller_.lastChanged();
    for (size_t i = 0; i < c.size(); ++i) out += (i ? ", " : "") + c[i];
    return out;
  }

 private:
  RelayChangeLink link_;
  esp32cam_settings::ChangePoller poller_;
};
