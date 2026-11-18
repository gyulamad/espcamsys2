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
// Since F-29 the timing and the response bounds are SETTINGS, not build-time knobs
// (OTA_CHECK_S, OTA_RETRY_S, OTA_VER_MAX_B, OTA_FW_MIN_B, OTA_FW_MAX_B, OTA_VER_IDLE_MS,
// OTA_DL_IDLE_MS — and OTA_ENABLED, which the sketch honours by not calling tick() at
// all). The values reach this class through the constructor; the defaults are the old
// hard-coded ones, so a sketch that passes nothing behaves exactly as before:
//     OtaUpdater ota("recorder", timing, limits);
// (Whether the board updates at all is the sketch's decision, made once per tick from
// its settings — an update disabled mid-boot must not resurrect here.)
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

// Where this reports to. The recorder maps these to its remote log (so the relay's log file
// shows them); the default is the serial port.
#ifndef OTA_INFO
#define OTA_INFO(...) Serial.printf("[ota] " __VA_ARGS__), Serial.println()
#endif
#ifndef OTA_WARN
#define OTA_WARN(...) Serial.printf("[ota] WARN " __VA_ARGS__), Serial.println()
#endif

// The outcome of readBody(): why it stopped, and how many bytes the sink took.
struct BodyRead {
  esp32cam_ota::ReadStep step;
  size_t bytes;
};

// Reads the rest of a response body from `http` into `sink` (a callable taking (uint8_t*, size_t) and
// returning how many of those bytes it took; the buffer is the reader's own, and Update.write() wants it non-const), until esp32cam_ota::nextReadStep() says it is over: all the
// announced bytes read, the connection closed, more than maxBytes, or nothing arriving for idleLimitMs.
//
// Two rules this loop exists to keep (a loop that broke either rebooted the board every ~50 s):
//  * it ALWAYS yields with delay(1) — Arduino's yield() / delay(0) never let the idle task run, and the task
//    watchdog reboots a board whose idle task is starved for 5 s. A connection that stays open after the last
//    byte (HTTP keep-alive) is the normal case, not a reason to poll faster.
//  * it ALWAYS ends: "connected() and nothing to read" is not "keep going", it is a timeout in the making.
//
// (review ARD-008) The body is read through the stream with an explicit cap instead of
// HTTPClient::getString(), which is not bounded by Content-Length and would let a hostile or buggy relay
// exhaust the camera's heap.
template <typename Sink>
static BodyRead readBody(HTTPClient& http, size_t maxBytes, uint32_t idleLimitMs, Sink sink) {
  using esp32cam_ota::ReadStep;
  WiFiClient* stream = http.getStreamPtr();
  if (!stream) return BodyRead{ReadStep::Incomplete, 0};

  const int expected = http.getSize();   // the Content-Length, -1 when the relay did not announce one
  uint8_t buf[1024];
  size_t have = 0;
  uint32_t lastByteAt = millis();

  for (;;) {
    ReadStep step = esp32cam_ota::nextReadStep(have, expected, maxBytes, http.connected(),
                                               (uint32_t)(millis() - lastByteAt), idleLimitMs);
    if (step != ReadStep::Continue) return BodyRead{step, have};

    int avail = stream->available();
    if (avail > 0) {
      size_t room = maxBytes - have;                       // nextReadStep() ended the loop if there were none
      size_t want = (size_t)avail < sizeof(buf) ? (size_t)avail : sizeof(buf);
      int n = stream->read(buf, want < room ? want : room);
      if (n > 0) {
        have += sink(buf, (size_t)n);
        lastByteAt = millis();
      }
    }
    delay(1);
  }
}

class OtaUpdater {
 public:
  // `timing`: when checks happen (esp32cam_ota::defaultTiming() = the old hard-coded schedule).
  // `limits`: how big / how slow a response may be (esp32cam_ota::defaultOtaLimits() = the old bounds,
  // see ota_logic.h for why each exists).
  explicit OtaUpdater(const char* type,
                      const esp32cam_ota::OtaTiming& timing = esp32cam_ota::defaultTiming(),
                      const esp32cam_ota::OtaLimits& limits = esp32cam_ota::defaultOtaLimits())
      : type_(type), policy_(timing), limits_(limits), retryS_(timing.retryMs / 1000UL) {}

  // One pass: does nothing unless a check is due. Takes seconds when it does (and a minute or
  // so when it flashes), so call it from a background task only.
  void tick(const std::string& host, int port, const std::string& apiKey, const std::string& id) {
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
      // (review ARD-008) bounded read: a hostile relay (or a MITM, since the OTA URL is plain HTTP — see
      // ARD-001) returning a huge body would otherwise exhaust the camera's heap. parseVersionReply only
      // looks at the first ~120 bytes anyway.
      BodyRead read = readBody(http, limits_.versionReplyMaxBytes, limits_.versionReplyIdleMs,
                               [&body](uint8_t* data, size_t n) {
                                 body.append(reinterpret_cast<const char*>(data), n);
                                 return n;
                               });
      if (read.step != esp32cam_ota::ReadStep::Done) {
        if (read.step == esp32cam_ota::ReadStep::TooLarge) {
          OTA_WARN("the relay's firmware answer was too large (>%d bytes) - ignoring it", (int)limits_.versionReplyMaxBytes);
        } else {
          OTA_WARN("the relay's firmware answer did not arrive completely - ignoring it");
        }
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
    OTA_WARN("firmware update to %s failed (%s) - will try again in %d s", reply.version.c_str(), err.c_str(), (int)retryS_);
    policy_.onResult(millis(), false, err, jitter);
  }

 private:

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
    if (len < (int)limits_.firmwareMinBytes || len > (int)limits_.firmwareMaxBytes) {
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
    // The image goes to flash through the same reader as the version reply (see readBody): it yields on every
    // pass, so the Wi-Fi stack and the idle task run during the whole download — Update.writeStream() reads
    // in a tight loop that never yields, and the task watchdog reboots the board mid-download — and it gives
    // up when the relay goes quiet instead of waiting for ever.
    size_t written = readBody(http, (size_t)limits_.firmwareMaxBytes + 1, limits_.downloadIdleMs,
                              [](uint8_t* data, size_t n) { return Update.write(data, n); }).bytes;
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
  esp32cam_ota::OtaLimits limits_;
  uint32_t retryS_;   // for the "will try again in N s" line (timing.retryMs, kept for the message)
};
