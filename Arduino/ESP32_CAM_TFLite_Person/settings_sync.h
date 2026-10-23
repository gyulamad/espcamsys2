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
// Knobs (define before including to change):
//   SETTINGS_SYNC_ENABLED         1; set 0 to build a sketch the dashboard can not reconfigure
//   SETTINGS_SYNC_FIRST_SECONDS   20   after boot, before the first ask (the camera and the
//                                      stream get the radio first)
//   SETTINGS_SYNC_CHECK_SECONDS   30   between asks

#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include <string>
#include <vector>

#include "settings_logic.h"

#ifndef SETTINGS_SYNC_ENABLED
#define SETTINGS_SYNC_ENABLED 1
#endif
#ifndef SETTINGS_SYNC_FIRST_SECONDS
#define SETTINGS_SYNC_FIRST_SECONDS 20
#endif
#ifndef SETTINGS_SYNC_CHECK_SECONDS
#define SETTINGS_SYNC_CHECK_SECONDS 30
#endif

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
  SettingsSync(const esp32cam_settings::Schema& schema, esp32cam_settings::ISettingsStore& store, const char* type,
               const std::vector<std::string>& lockedKeys)
      : link_(type),
        poller_(schema, store, link_, lockedKeys, (uint32_t)SETTINGS_SYNC_FIRST_SECONDS * 1000UL,
                (uint32_t)SETTINGS_SYNC_CHECK_SECONDS * 1000UL) {}

  // true: settings were stored — restart the board so they take effect. Does nothing unless an
  // ask is due; takes a few seconds when it is, so call it from a background task only.
  bool tick(const std::string& host, int port, const std::string& apiKey, const std::string& id) {
#if SETTINGS_SYNC_ENABLED
    link_.target(host, port, apiKey, id);
    return poller_.tick(millis()) == esp32cam_settings::ChangePoller::Restart;
#else
    (void)host; (void)port; (void)apiKey; (void)id;
    return false;
#endif
  }

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
