// OTA.h — reusable WiFi + OTA (over-the-air firmware update) framework
// for ESP32 Arduino sketches.
//
// What this gives you, from the sketch's point of view:
//
//   #include "OTA.h"
//
//   void setup() {
//     OTA.setup();   // brings up WiFi (strongest of several known
//                     // networks, auto-failover) and starts listening
//                     // for OTA uploads
//     ... your original setup() ...
//   }
//
//   void loop() {
//     OTA.loop();     // keeps WiFi alive + services pending OTA uploads
//     ... your original loop() ...
//   }
//
// All the WiFi networks, hostname, OTA password, port and the various
// timing constants ("magic numbers") live in OTA.config.h, in this same
// sketch folder — nothing tunable is hardcoded in here.
//
// Design notes:
//   - Multi-SSID + "connect to the strongest" is handled by the ESP32
//     core's own WiFiMulti: every network listed in OTA.config.h is
//     registered with it, and WiFiMulti::run() scans and joins whichever
//     configured AP currently has the best RSSI, failing over to another
//     one automatically if the link drops.
//   - Actual firmware upload is handled by the ESP32 core's own
//     ArduinoOTA library (the same "Tools > Port > network port" flow
//     the Arduino IDE already supports) — this file just wires it up
//     with sensible defaults and logging.
//   - Both of those are bundled with the ESP32 Arduino core, so nothing
//     extra needs to be installed via the Library Manager.
//   - Header-only, by design, to keep this a two-file drop-in
//     (OTA.h + OTA.config.h). Because it defines the global `OTA`
//     instance, only #include "OTA.h" from ONE file in the sketch (the
//     .ino) — a normal single-sketch project already does this
//     naturally, since the .ino is the only place that needs it.
//
// Placement note (important on camera boards!): bring WiFi up AFTER any
// camera / large-buffer initialization, not before. The WiFi driver
// claims a sizeable chunk of internal DRAM for its own buffers as soon
// as it starts, and things like camera frame buffers or a TFLite tensor
// arena want that same RAM. Call OTA.setup() after your camera/model init
// succeeds, not as the very first line of setup() — see the two sketches
// this was applied to for a worked example.

#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <ArduinoOTA.h>
#include <string.h> // strlen()

#include "OTA.config.h"

class OTAClass {
public:
  // Registers every network from OTA.config.h, blocks (with a timeout)
  // until one of them connects, then starts the OTA listener. Safe to
  // call even if WiFi never connects — see OTA_REBOOT_ON_WIFI_TIMEOUT.
  void setup();

  // Call every loop() iteration. Cheap when already connected: re-checks
  // the link at most every OTA_WIFI_RECHECK_INTERVAL_MS, and services
  // any in-progress OTA upload the rest of the time.
  void loop();

  // ── Status helpers — thin wrappers so sketches don't need to reach
  // into WiFi.* directly if they'd rather go through OTA.
  bool isConnected() const { return WiFi.status() == WL_CONNECTED; }
  String ssid() const { return WiFi.SSID(); }
  int32_t rssi() const { return WiFi.RSSI(); }
  IPAddress ip() const { return WiFi.localIP(); }

  // ── Optional hooks — set one if a sketch needs to react to an OTA
  // event itself (e.g. pause camera capture during a flash write).
  // Purely additive: the built-in Serial logging in startOta() always
  // runs regardless of whether these are set.
  void onStart(void (*cb)()) { _userOnStart = cb; }
  void onEnd(void (*cb)()) { _userOnEnd = cb; }
  void onProgress(void (*cb)(unsigned int, unsigned int)) { _userOnProgress = cb; }
  void onError(void (*cb)(ota_error_t)) { _userOnError = cb; }

private:
  WiFiMulti _wifiMulti;
  bool _otaStarted = false;
  unsigned long _lastWifiCheckMs = 0;

  void (*_userOnStart)() = nullptr;
  void (*_userOnEnd)() = nullptr;
  void (*_userOnProgress)(unsigned int, unsigned int) = nullptr;
  void (*_userOnError)(ota_error_t) = nullptr;

  void connectWifi();
  void startOta();
};

inline void OTAClass::connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // lower latency; OTA and streaming both want this off

  for (int i = 0; i < OTA_WIFI_NETWORK_COUNT; i++) {
    _wifiMulti.addAP(OTA_WIFI_NETWORKS[i].ssid, OTA_WIFI_NETWORKS[i].password);
  }

  Serial.print("[OTA] Connecting to WiFi");
  unsigned long start = millis();
  while (_wifiMulti.run() != WL_CONNECTED) {
    if (millis() - start > OTA_WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println();
      Serial.println("[OTA] WiFi connect timed out.");
#if OTA_REBOOT_ON_WIFI_TIMEOUT
      Serial.println("[OTA] Rebooting to retry...");
      delay(200);
      ESP.restart();
#else
      Serial.println("[OTA] Continuing without WiFi — will keep retrying from loop().");
      return;
#endif
    }
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  Serial.printf("[OTA] Connected to %s, IP: %s, RSSI: %d dBm\n",
                 WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
}

inline void OTAClass::startOta() {
  if (_otaStarted || WiFi.status() != WL_CONNECTED) return;

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPort(OTA_PORT);
  if (strlen(OTA_PASSWORD) > 0) {
    ArduinoOTA.setPassword(OTA_PASSWORD);
  } else {
    Serial.println("[OTA] WARNING: OTA_PASSWORD is empty — OTA uploads are unauthenticated.");
  }

  ArduinoOTA.onStart([this]() {
    String type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
    Serial.println("[OTA] Start updating " + type);
    if (_userOnStart) _userOnStart();
  });
  ArduinoOTA.onEnd([this]() {
    Serial.println("\n[OTA] Update complete, rebooting...");
    if (_userOnEnd) _userOnEnd();
  });
  ArduinoOTA.onProgress([this](unsigned int progress, unsigned int total) {
    Serial.printf("[OTA] Progress: %u%%\r", (progress * 100) / total);
    if (_userOnProgress) _userOnProgress(progress, total);
  });
  ArduinoOTA.onError([this](ota_error_t error) {
    Serial.printf("[OTA] Error[%u]: ", error);
    switch (error) {
      case OTA_AUTH_ERROR:    Serial.println("Auth Failed"); break;
      case OTA_BEGIN_ERROR:   Serial.println("Begin Failed"); break;
      case OTA_CONNECT_ERROR: Serial.println("Connect Failed"); break;
      case OTA_RECEIVE_ERROR: Serial.println("Receive Failed"); break;
      case OTA_END_ERROR:     Serial.println("End Failed"); break;
      default:                Serial.println("Unknown Error"); break;
    }
    if (_userOnError) _userOnError(error);
  });

  ArduinoOTA.begin();
  _otaStarted = true;
  Serial.printf("[OTA] Ready. Hostname: %s, port: %d\n", OTA_HOSTNAME, OTA_PORT);
}

inline void OTAClass::setup() {
  connectWifi();
  startOta();
}

inline void OTAClass::loop() {
  unsigned long now = millis();
  if (now - _lastWifiCheckMs >= OTA_WIFI_RECHECK_INTERVAL_MS) {
    _lastWifiCheckMs = now;
    if (_wifiMulti.run() == WL_CONNECTED) {
      startOta(); // no-op once already started; (re)starts it after a reconnect
    }
  }
  if (_otaStarted && WiFi.status() == WL_CONNECTED) {
    ArduinoOTA.handle();
  }
}

// The global instance sketches call OTA.setup()/OTA.loop() on — same
// pattern the core's own `ArduinoOTA` global uses.
OTAClass OTA;
