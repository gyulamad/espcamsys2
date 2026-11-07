// ota.h — the Arduino half of the over-the-air firmware update: asks the relay which
// firmware is current, downloads it, flashes it and restarts. Every DECISION (is the
// answer valid, is an update needed, when to ask, what to report) is in ota_logic.h and
// unit-tested; this file only joins them to HTTPClient and Update. The desktop tests
// compile it against fakes of those (tests/cpp/test_ota_glue.cpp), but the real flash
// and radio can only be checked on a board.
//
// Copied into every sketch folder that uses it (see ota_logic.h); the copies must be identical.
//
// The sketch includes this AFTER defining FW_GIT (the git version the build script
// wrote into fw_version.h, or "dev" for a hand-built sketch), and calls
//     OtaUpdater ota("recorder");            // or "detector"
//     ota.tick(host, httpPort, apiKey, id);   // every second or so, from a task
// HTTP must never run in loop() (it would stall the camera): call tick() from a
// background task that already does networking.
//
// Knobs (define before including to change):
//   OTA_ENABLED         1; set 0 to build a sketch that never updates itself
//   OTA_CHECK_SECONDS   60   between checks (plus up to 15 s random jitter)
//   OTA_RETRY_SECONDS   300  wait after a failed update
//
// The camera is NOT paused and not deinitialised during the update: the flash writes briefly
// stall the other core, which the stream survives. (Revisit if hardware tests show trouble.)

#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <string>

#include "ota_logic.h"

#ifndef OTA_ENABLED
#define OTA_ENABLED 1
#endif
#ifndef OTA_CHECK_SECONDS
#define OTA_CHECK_SECONDS 60
#endif
#ifndef OTA_RETRY_SECONDS
#define OTA_RETRY_SECONDS 300
#endif

// (review ARD-008) maximum bytes the OTA logic will buffer for the version
// reply before parsing it. The valid shape is "<version>\n<md5>\n" (~80 bytes
// typical, ~120 worst case) — anything bigger is either a relay bug or a
// malicious response, and unbounded getString() would let a hostile relay
// exhaust the camera's ~300 KB heap.
#ifndef OTA_VERSION_REPLY_MAX_BYTES
#define OTA_VERSION_REPLY_MAX_BYTES 256
#endif
// (review ARD-016) sanity bounds on the firmware size. The Update library
// already refuses anything bigger than the OTA partition, but a 1-byte body
// would otherwise proceed to writeStream and fail confusingly; bounding the
// size at the application level also produces a clearer error token.
#ifndef OTA_FIRMWARE_MIN_BYTES
#define OTA_FIRMWARE_MIN_BYTES 100 * 1024
#endif
#ifndef OTA_FIRMWARE_MAX_BYTES
#define OTA_FIRMWARE_MAX_BYTES 2 * 1024 * 1024
#endif

// Where this reports to. The recorder maps these to its remote log (so the relay's log file
// shows them); the default is the serial port.
#ifndef OTA_INFO
#define OTA_INFO(...) Serial.printf("[ota] " __VA_ARGS__), Serial.println()
#endif
#ifndef OTA_WARN
#define OTA_WARN(...) Serial.printf("[ota] WARN " __VA_ARGS__), Serial.println()
#endif

// Reads at most maxBytes bytes from http into out. Returns true on success
// (the body was fully read AND within the bound); false if the body grew past
// the bound (a hostile or buggy relay response) or the read failed.
//
// (review ARD-008) HTTPClient::getString() calls WiFiClient::readString(),
// which appends to a String until either the connection closes or setTimeout()
// elapses — it is NOT bounded by Content-Length and does NOT cap the
// allocation. A relay (or MITM) returning Content-Length: 50000000 and a few
// MB of payload would OOM the camera. Reading through the stream pointer with
// an explicit cap is the fix.
static bool readBounded(HTTPClient& http, std::string& out, size_t maxBytes) {
  WiFiClient* stream = http.getStreamPtr();
  if (!stream) return false;
  out.clear();
  out.reserve(64);
  uint8_t buf[256];
  while (http.connected() && out.size() < maxBytes) {
    int n = stream->read(buf, sizeof(buf));
    if (n <= 0) {
      if (!http.connected()) break;
      continue;
    }
    out.append(reinterpret_cast<const char*>(buf), static_cast<size_t>(n));
  }
  return out.size() < maxBytes;   // false = was truncated = refuse
}

class OtaUpdater {
 public:
  explicit OtaUpdater(const char* type) : type_(type), policy_(makeTiming()) {}

  // One pass: does nothing unless a check is due. Takes seconds when it does (and a minute or
  // so when it flashes), so call it from a background task only.
  void tick(const std::string& host, int port, const std::string& apiKey, const std::string& id) {
#if OTA_ENABLED
    uint32_t now = millis();
    uint32_t jitter = (uint32_t)random(0, 15001);
    if (!policy_.due(now, WiFi.status() == WL_CONNECTED, jitter)) return;

    std::string reported = policy_.pendingError();
    std::string url = esp32cam_ota::buildVersionUrl(host, port, type_, id, FW_GIT, reported);

    HTTPClient http;
    http.begin(String(url.c_str()));
    http.setTimeout(5000);
    http.addHeader("X-Api-Key", apiKey.c_str());
    int code = http.GET();
    std::string body;
    if (code == 200) {
      // (review ARD-008) bounded read: a hostile relay (or a MITM, since the
      // OTA URL is plain HTTP — see ARD-001) returning a huge body would
      // otherwise exhaust the camera's heap. parseVersionReply only looks at
      // the first ~120 bytes anyway.
      if (!readBounded(http, body, OTA_VERSION_REPLY_MAX_BYTES)) {
        OTA_WARN("the relay's firmware answer was too large (>%d bytes) - ignoring it", (int)OTA_VERSION_REPLY_MAX_BYTES);
        http.end();
        policy_.onResult(millis(), true, "", jitter);
        return;
      }
    }
    http.end();

    if (code != 200 && code != 404) {
      // Relay unreachable (or an answer we can't use): nothing to flash, and an error
      // we wanted to report has not been delivered yet, so it stays pending.
      policy_.onResult(millis(), true, "", jitter);
      return;
    }
    policy_.clearError();   // the relay has seen it
    if (code == 404) {      // nothing published for this type yet
      policy_.onResult(millis(), true, "", jitter);
      return;
    }

    esp32cam_ota::VersionReply reply;
    if (!esp32cam_ota::parseVersionReply(body, reply)) {
      OTA_WARN("the relay's firmware answer was not understood - ignoring it");
      policy_.onResult(millis(), true, "", jitter);
      return;
    }
    if (!esp32cam_ota::updateNeeded(FW_GIT, reply)) {
      policy_.onResult(millis(), true, "", jitter);
      return;
    }

    OTA_INFO("firmware %s is published, this board runs %s - downloading", reply.version.c_str(), FW_GIT);
    std::string err = download(host, port, apiKey, id, reply);
    // Only reached when something went wrong: a good update restarts the board.
    OTA_WARN("firmware update to %s failed (%s) - will try again in %d s", reply.version.c_str(), err.c_str(), OTA_RETRY_SECONDS);
    policy_.onResult(millis(), false, err, jitter);
#else
    (void)host; (void)port; (void)apiKey; (void)id;
#endif
  }

 private:
  static esp32cam_ota::OtaTiming makeTiming() {
    esp32cam_ota::OtaTiming t = esp32cam_ota::defaultTiming();
    t.checkMs = (uint32_t)OTA_CHECK_SECONDS * 1000UL;
    t.retryMs = (uint32_t)OTA_RETRY_SECONDS * 1000UL;
    return t;
  }

  // Downloads and flashes `reply`. Returns an error token on failure; on success the board restarts
  // and this does not return.
  std::string download(const std::string& host, int port, const std::string& apiKey,
                       const std::string& id, const esp32cam_ota::VersionReply& reply) {
    std::string url = esp32cam_ota::buildFirmwareUrl(host, port, type_, id);
    HTTPClient http;
    http.begin(String(url.c_str()));
    http.setTimeout(15000);   // per read, not for the whole download
    http.addHeader("X-Api-Key", apiKey.c_str());
    int code = http.GET();
    if (code != 200) {
      http.end();
      return esp32cam_ota::httpErrToken(code);
    }
    int len = http.getSize();
    if (len <= 0) {           // chunked or empty: the update needs the size up front
      http.end();
      return "no_length";
    }
    // (review ARD-016) application-level size bounds. Update.begin() will
    // refuse anything bigger than the OTA partition, but a 1-byte body would
    // otherwise proceed to writeStream and fail with a confusing
    // "short_write". Bounds also produce clearer error tokens.
    if (len < (int)OTA_FIRMWARE_MIN_BYTES || len > (int)OTA_FIRMWARE_MAX_BYTES) {
      http.end();
      return "bad_size";
    }
    if (!Update.begin((size_t)len)) {
      std::string err = Update.getError() == UPDATE_ERROR_NO_PARTITION
                            ? std::string("no_ota_partition")
                            : esp32cam_ota::errToken(std::string("begin_") + Update.errorString());
      http.end();
      return err;
    }
    Update.setMD5(reply.md5.c_str());
    size_t written = Update.writeStream(*http.getStreamPtr());
    http.end();
    if (written != (size_t)len) {
      Update.abort();
      return "short_write";
    }
    if (!Update.end(true)) {
      std::string err = Update.getError() == UPDATE_ERROR_MD5
                            ? std::string("md5_failed")
                            : esp32cam_ota::errToken(std::string("end_") + Update.errorString());
      Update.abort();
      return err;
    }
    if (!Update.isFinished()) return "not_finished";

    OTA_INFO("firmware %s written (%d bytes) - restarting", reply.version.c_str(), len);
    delay(1000);
    ESP.restart();
    return "";   // not reached
  }

  const char* type_;
  esp32cam_ota::OtaPolicy policy_;
};
