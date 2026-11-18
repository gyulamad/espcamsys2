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
// Since F-29 the port and the search timings are SETTINGS, not build-time knobs (RF_ENABLED,
// RF_PORT, RF_FIRST_S, RF_OK_S, RF_RETRY_MIN_S, RF_RETRY_MAX_S). The values reach this class through
// the constructor; the defaults are the old hard-coded ones, so a sketch that passes nothing behaves
// exactly as before. RF_ENABLED is the sketch's decision, made once per tick from its settings — a
// search switched off mid-boot must not resurrect here.

#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_system.h>   // esp_random() — the documented hardware RNG (review ARD-015)

#include <string>

#include "relay_find_logic.h"
#include "settings_logic.h"

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
// `port`: the UDP port the probes go to — the relay's discoveryPort (RF_PORT; the default is the
// old hard-coded 8082, which the relay's own default still matches).
class WifiFindEnv : public esp32cam_relayfind::IFindEnv {
 public:
  explicit WifiFindEnv(int port = 8082) : port_(port), open_(false) {}

  uint32_t nowMs() override { return millis(); }
  void pauseMs(uint32_t ms) override { delay(ms); }

  // The discovery nonce must be unpredictable: an attacker who can guess it
  // before the legitimate relay answers can race a fake reply (review ARD-013).
  // Arduino's `random()` is a PRNG in the API contract — it currently routes
  // through `esp_random()` on Arduino-ESP32, but that is an implementation
  // detail a future core version or third-party library could change. Call
  // the documented hardware RNG directly so the security property is explicit
  // (review ARD-015).
  std::string newNonce() override {
    static const char digits[] = "0123456789abcdef";
    std::string s;
    for (int i = 0; i < 16; ++i) s += digits[esp_random() & 0x0f];
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
    if (!udp_.beginPacket(addr, (uint16_t)port_)) return false;
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

  int port() const { return port_; }   // for the log line that names the UDP port

 private:
  bool ensureOpen() {
    if (!open_) open_ = udp_.begin(0) == 1;   // port 0: any free port; the relay answers to wherever the probe came from
    return open_;
  }
  WiFiUDP udp_;
  int port_;
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
  // `port` and the four search timings come from the sketch's settings (RF_PORT, RF_FIRST_S,
  // RF_OK_S, RF_RETRY_MIN_S, RF_RETRY_MAX_S); the defaults are the old hard-coded values. The
  // timings are milliseconds here, as RelayFinder takes them.
  explicit RelayFind(esp32cam_settings::ISettingsStore& store, int port = 8082,
                     uint32_t firstMs = 10UL * 1000UL, uint32_t okMs = 60UL * 1000UL,
                     uint32_t retryMinMs = 15UL * 1000UL, uint32_t retryMaxMs = 300UL * 1000UL)
      : env_(port),
        address_(store),
        finder_(env_, address_, firstMs, okMs, retryMinMs, retryMaxMs) {}

  // true: the relay answered from another address and SERVER_HOST now holds it — restart the board so
  // every task starts with it. Does nothing unless a check is due; takes a few seconds when a search
  // is needed, so call it from a background task only.
  bool tick(const std::string& host, const std::string& apiKey, bool relayDown) {
    using esp32cam_relayfind::RelayFinder;
    RelayFinder::Result r = finder_.tick(relayDown && WiFi.status() == WL_CONNECTED, host, apiKey);
    if (r == RelayFinder::Idle) return false;
    env_.close();
    if (r == RelayFinder::NotFound && (finder_.failures() == 1 || finder_.failures() % 12 == 0)) {   // not every time: the log keeps the first and then one in twelve
      RELAY_FIND_WARN("relay not found (try %u): not at %s or anywhere nearby - is it off, or is UDP %d blocked on it?",
                      (unsigned)finder_.failures(), host.c_str(), env_.port());
    } else if (r == RelayFinder::Moved) {
      RELAY_FIND_INFO("the relay is at %s now (SERVER_HOST was %s) - stored, restarting to use it",
                      finder_.found().c_str(), host.c_str());
    }
    return r == RelayFinder::Moved;
  }

 private:
  WifiFindEnv env_;
  StoredServerHost address_;
  esp32cam_relayfind::RelayFinder finder_;
};
