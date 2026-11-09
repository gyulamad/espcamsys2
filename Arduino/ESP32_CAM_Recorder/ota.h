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

// How long a response may stay silent before it is given up on. The reader yields while it waits (see
// readBody), so this is not about the task watchdog; it is that a relay that goes quiet must not hold the
// network task for ever. The version reply is a few dozen bytes, the image is megabytes over Wi-Fi.
#ifndef OTA_VERSION_REPLY_IDLE_MS
#define OTA_VERSION_REPLY_IDLE_MS 5000
#endif
#ifndef OTA_DOWNLOAD_IDLE_MS
#define OTA_DOWNLOAD_IDLE_MS 15000
#endif

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
      // (review ARD-008) bounded read: a hostile relay (or a MITM, since the OTA URL is plain HTTP — see
      // ARD-001) returning a huge body would otherwise exhaust the camera's heap. parseVersionReply only
      // looks at the first ~120 bytes anyway.
      BodyRead read = readBody(http, OTA_VERSION_REPLY_MAX_BYTES, OTA_VERSION_REPLY_IDLE_MS,
                               [&body](uint8_t* data, size_t n) {
                                 body.append(reinterpret_cast<const char*>(data), n);
                                 return n;
                               });
      if (read.step != esp32cam_ota::ReadStep::Done) {
        if (read.step == esp32cam_ota::ReadStep::TooLarge) {
          OTA_WARN("the relay's firmware answer was too large (>%d bytes) - ignoring it", (int)OTA_VERSION_REPLY_MAX_BYTES);
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
    // The image goes to flash through the same reader as the version reply (see readBody): it yields on every
    // pass, so the Wi-Fi stack and the idle task run during the whole download — Update.writeStream() reads
    // in a tight loop that never yields, and the task watchdog reboots the board mid-download — and it gives
    // up when the relay goes quiet instead of waiting for ever.
    size_t written = readBody(http, (size_t)OTA_FIRMWARE_MAX_BYTES + 1, OTA_DOWNLOAD_IDLE_MS,
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
};
