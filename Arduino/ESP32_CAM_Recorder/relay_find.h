// relay_find.h — the Arduino half of "find the relay again when its address changed": every minute
// or so it checks that the relay answers at the address stored in SERVER_HOST and, when it does not,
// looks for it (a broadcast, then a sweep of the subnet) and stores the address it answered from.
// Every DECISION (what to look for, in which order, what to believe, when to look again, what to
// change) is in relay_find_logic.h and unit-tested; this file only joins it to WiFiUDP and the flash
// store. The desktop tests compile it against fakes of the core (tests/cpp/test_relay_find_glue.cpp);
// the real radio can only be checked on a board.
//
// Copied into every sketch folder that uses it (see relay_find_logic.h); the copies must be identical.
//
// Like ota.h, call it from a background task that already does networking, never from loop() (a sweep
// takes a few seconds):
//     RelayFind find(store);                          // store: the flash settings
//     if (find.tick(host, apiKey, relayDown)) { /* SERVER_HOST was changed */ restart(); }
// `relayDown`: the board's own connection to the relay has been down for a while (the sketch decides
// how long). While the relay works at the stored address none of this runs, so a healthy system never
// sends a discovery packet.
//
// Knobs (define before including to change):
//   RELAY_FIND_ENABLED              1; set 0 to build a sketch that keeps whatever SERVER_HOST it has
//   RELAY_FIND_PORT                 8082; UDP port the relay answers on (discoveryPort in the relay's config.js)
//   RELAY_FIND_FIRST_SECONDS        10   after boot (Wi-Fi up), before the first check
//   RELAY_FIND_OK_SECONDS           60   between checks while the relay answers
//   RELAY_FIND_RETRY_MIN_SECONDS    15   first wait after a failed search ...
//   RELAY_FIND_RETRY_MAX_SECONDS    300  ... doubling up to this

#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>

#include <string>

#include "relay_find_logic.h"
#include "settings_logic.h"

#ifndef RELAY_FIND_ENABLED
#define RELAY_FIND_ENABLED 1
#endif
#ifndef RELAY_FIND_PORT
#define RELAY_FIND_PORT 8082
#endif
#ifndef RELAY_FIND_FIRST_SECONDS
#define RELAY_FIND_FIRST_SECONDS 10
#endif
#ifndef RELAY_FIND_OK_SECONDS
#define RELAY_FIND_OK_SECONDS 60
#endif
#ifndef RELAY_FIND_RETRY_MIN_SECONDS
#define RELAY_FIND_RETRY_MIN_SECONDS 15
#endif
#ifndef RELAY_FIND_RETRY_MAX_SECONDS
#define RELAY_FIND_RETRY_MAX_SECONDS 300
#endif

// Where this reports to. The sketches map these to their remote log (so the relay's log file shows
// them); the default is the serial port.
#ifndef RELAY_FIND_INFO
#define RELAY_FIND_INFO(...) Serial.printf("[relay-find] " __VA_ARGS__), Serial.println()
#endif
#ifndef RELAY_FIND_WARN
#define RELAY_FIND_WARN(...) Serial.printf("[relay-find] WARN " __VA_ARGS__), Serial.println()
#endif

// The network as the locator sees it: ONE UDP socket, opened by the first probe of a search and
// closed by RelayFind::tick() when the search is over (sockets are few on an ESP32).
class WifiFindEnv : public esp32cam_relayfind::IFindEnv {
 public:
  WifiFindEnv() : open_(false) {}

  uint32_t nowMs() override { return millis(); }
  void pauseMs(uint32_t ms) override { delay(ms); }

  // Arduino's random() is the chip's hardware random number generator.
  std::string newNonce() override {
    static const char digits[] = "0123456789abcdef";
    std::string s;
    for (int i = 0; i < 16; ++i) s += digits[random(0, 16)];
    return s;
  }

  bool resolve(const std::string& host, std::string& ip) override {
    uint8_t literal[4];
    if (esp32cam_relayfind::parseIpv4(host, literal)) {
      ip = host;
      return true;
    }
    IPAddress addr;
    if (!WiFi.hostByName(host.c_str(), addr)) return false;
    ip = addr.toString().c_str();
    return true;
  }

  std::string ownIp() override { return WiFi.localIP().toString().c_str(); }

  bool send(const std::string& ip, const std::string& payload) override {
    IPAddress addr;
    if (!addr.fromString(ip.c_str()) || !ensureOpen()) return false;
    if (!udp_.beginPacket(addr, (uint16_t)RELAY_FIND_PORT)) return false;
    udp_.write(reinterpret_cast<const uint8_t*>(payload.data()), payload.size());
    return udp_.endPacket() == 1;
  }

  bool receive(uint32_t waitMs, std::string& fromIp, std::string& payload) override {
    if (!open_) return false;   // nothing was ever sent, so nothing can come back
    uint32_t start = millis();
    for (;;) {
      if (udp_.parsePacket() > 0) {
        uint8_t buf[160];   // an answer is 89 bytes; anything longer fails the check anyway
        int len = udp_.read(buf, sizeof(buf));
        if (len > 0) {
          fromIp = udp_.remoteIP().toString().c_str();
          payload.assign(reinterpret_cast<const char*>(buf), (size_t)len);
          return true;
        }
      }
      if ((uint32_t)(millis() - start) >= waitMs) return false;
      delay(2);
    }
  }

  void close() {
    if (!open_) return;
    udp_.stop();
    open_ = false;
  }

 private:
  bool ensureOpen() {
    if (!open_) open_ = udp_.begin(0) == 1;   // port 0: any free port; the relay answers to wherever the probe came from
    return open_;
  }
  WiFiUDP udp_;
  bool open_;
};

// SERVER_HOST in the board's flash settings.
class StoredServerHost : public esp32cam_relayfind::IAddressStore {
 public:
  explicit StoredServerHost(esp32cam_settings::ISettingsStore& store) : store_(store) {}
  bool saveHost(const std::string& host) override { return store_.set("SERVER_HOST", host); }

 private:
  esp32cam_settings::ISettingsStore& store_;
};

class RelayFind {
 public:
  explicit RelayFind(esp32cam_settings::ISettingsStore& store)
      : address_(store),
        finder_(env_, address_, (uint32_t)RELAY_FIND_FIRST_SECONDS * 1000UL, (uint32_t)RELAY_FIND_OK_SECONDS * 1000UL,
                (uint32_t)RELAY_FIND_RETRY_MIN_SECONDS * 1000UL, (uint32_t)RELAY_FIND_RETRY_MAX_SECONDS * 1000UL) {}

  // true: the relay answered from another address and SERVER_HOST now holds it — restart the board so
  // every task starts with it. Does nothing unless a check is due; takes a few seconds when a search
  // is needed, so call it from a background task only.
  bool tick(const std::string& host, const std::string& apiKey, bool relayDown) {
#if RELAY_FIND_ENABLED
    using esp32cam_relayfind::RelayFinder;
    RelayFinder::Result r = finder_.tick(relayDown && WiFi.status() == WL_CONNECTED, host, apiKey);
    if (r == RelayFinder::Idle) return false;
    env_.close();
    if (r == RelayFinder::NotFound && (finder_.failures() == 1 || finder_.failures() % 12 == 0)) {   // not every time: the log keeps the first and then one in twelve
      RELAY_FIND_WARN("relay not found (try %u): not at %s or anywhere nearby - is it off, or is UDP %d blocked on it?",
                      (unsigned)finder_.failures(), host.c_str(), (int)RELAY_FIND_PORT);
    } else if (r == RelayFinder::Moved) {
      RELAY_FIND_INFO("the relay is at %s now (SERVER_HOST was %s) - stored, restarting to use it",
                      finder_.found().c_str(), host.c_str());
    }
    return r == RelayFinder::Moved;
#else
    (void)host; (void)apiKey; (void)relayDown;
    return false;
#endif
  }

 private:
  WifiFindEnv env_;
  StoredServerHost address_;
  esp32cam_relayfind::RelayFinder finder_;
};
