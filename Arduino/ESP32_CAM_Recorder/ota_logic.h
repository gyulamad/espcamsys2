// ota_logic.h — the decisions of the over-the-air firmware update, as plain C++11
// (no Arduino includes), so they are unit-tested on a desktop: see
// tests/cpp/test_ota_logic.cpp. The Wi-Fi/HTTP/flash half is ota.h.
//
// How an update goes (server-driven, the board polls — boards sit behind NAT):
//   1. every ~60 s the board asks the relay  GET /ota/<type>/version?id=&fw=&err=
//      and gets "<version>\n<md5>\n" (404: nothing published for this type).
//   2. if that version differs from the one it runs (FW_GIT) it downloads
//      /ota/<type>/firmware.bin, checks the md5, flashes, reboots.
//   "Different", not "newer": deploying an older commit downgrades the fleet.
//   3. when something fails it remembers a short token (md5_failed, http_404, ...),
//      reports it with the NEXT poll (err=) so the relay's log shows why, and waits
//      5 minutes before trying again.
//
// This file is deliberately copied into every sketch folder that uses it (an Arduino
// sketch can only include files from its own folder); run_tests.sh checks the copies
// are identical. Edit one, copy it over the others.

#pragma once

#include <stdint.h>
#include <string>

namespace esp32cam_ota {

// ── what the relay answers ───────────────────────────────────────────────

struct VersionReply {
  std::string version;
  std::string md5;   // 32 lower-case hex characters
};

static inline bool isVersionChar(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
}

// "<version>\n<md5>\n" -> reply. Anything else is refused: a half-understood answer must
// never start a flash. A version is 1-64 characters of A-Z a-z 0-9 . _ - (the relay's rule).
static inline bool parseVersionReply(const std::string& text, VersionReply& out) {
  size_t nl = text.find('\n');
  if (nl == std::string::npos) return false;
  std::string version = text.substr(0, nl);
  std::string rest = text.substr(nl + 1);
  size_t nl2 = rest.find('\n');
  std::string md5 = nl2 == std::string::npos ? rest : rest.substr(0, nl2);
  if (nl2 != std::string::npos && nl2 + 1 != rest.size()) return false;   // nothing but the final newline may follow
  if (version.empty() || version.size() > 64) return false;
  for (size_t i = 0; i < version.size(); i++) if (!isVersionChar(version[i])) return false;
  if (md5.size() != 32) return false;
  for (size_t i = 0; i < md5.size(); i++) {
    char c = md5[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  out.version = version;
  out.md5 = md5;
  return true;
}

// Should the board flash? Only when the published version is not the one it runs.
static inline bool updateNeeded(const std::string& running, const VersionReply& reply) {
  return reply.version != running;
}

// ── URLs ─────────────────────────────────────────────────────────────────
// The id and the running version are already safe (ids are checked by the settings, FW_GIT
// by the deploy script); the error token is cleaned below. None needs URL-encoding.

static inline std::string buildVersionUrl(const std::string& host, int port, const char* type,
                                          const std::string& id, const std::string& running,
                                          const std::string& err) {
  std::string url = "http://" + host + ":" + std::to_string(port) + "/ota/" + type +
                    "/version?id=" + id + "&fw=" + running;
  if (!err.empty()) url += "&err=" + err;
  return url;
}

static inline std::string buildFirmwareUrl(const std::string& host, int port, const char* type,
                                           const std::string& id) {
  return "http://" + host + ":" + std::to_string(port) + "/ota/" + type + "/firmware.bin?id=" + id;
}

// ── error tokens ─────────────────────────────────────────────────────────

// A short word for the relay's log: letters, digits and . _ - only, at most 40 characters.
// Anything else (spaces in an error text, say) becomes '_' so it is safe in a URL.
static inline std::string errToken(const std::string& raw) {
  std::string t;
  for (size_t i = 0; i < raw.size() && t.size() < 40; i++) {
    char c = raw[i];
    t += (isVersionChar(c) ? c : '_');
  }
  return t;
}

static inline std::string httpErrToken(int code) {
  // Negative codes are the HTTP client's own (connection refused, timeout, ...).
  if (code < 0) return "http_err" + std::to_string(-code);
  return "http_" + std::to_string(code);
}

// ── when to ask ──────────────────────────────────────────────────────────

struct OtaTiming {
  uint32_t firstCheckMs;    // after Wi-Fi came up (let the board settle first)
  uint32_t checkMs;         // between checks
  uint32_t jitterMs;        // up to this much is added to every wait (boards must not all ask at once)
  uint32_t retryMs;         // wait after a failed update
};

static inline OtaTiming defaultTiming() {
  OtaTiming t;
  t.firstCheckMs = 20UL * 1000UL;
  t.checkMs = 60UL * 1000UL;
  t.jitterMs = 15UL * 1000UL;
  t.retryMs = 300UL * 1000UL;
  return t;
}

// When the next check is due, and the error to report with it. Time is millis(); all
// comparisons are done as differences so the 49-day wrap-around is harmless.
class OtaPolicy {
 public:
  explicit OtaPolicy(const OtaTiming& t = defaultTiming())
      : t_(t), wifiWasUp_(false), dueAt_(0), pendingErr_() {}

  // Called often (every second or so). true: do a check now.
  // `jitterMs` is a fresh random number in [0, timing.jitterMs] from the caller (kept out of
  // here so the policy stays deterministic).
  bool due(uint32_t nowMs, bool wifiUp, uint32_t jitterMs) {
    if (!wifiUp) { wifiWasUp_ = false; return false; }
    if (!wifiWasUp_) {            // Wi-Fi just came up: first check shortly, not at once
      wifiWasUp_ = true;
      dueAt_ = nowMs + t_.firstCheckMs + clampJitter(jitterMs);
      return false;
    }
    return (int32_t)(nowMs - dueAt_) >= 0;
  }

  // The outcome of the check that was due. ok: the relay answered (whatever it said) and, if an
  // update was needed, it was not attempted or did not fail. A failure's token goes out with the
  // next poll.
  void onResult(uint32_t nowMs, bool ok, const std::string& errTokenText, uint32_t jitterMs) {
    if (ok) {
      dueAt_ = nowMs + t_.checkMs + clampJitter(jitterMs);
    } else {
      pendingErr_ = errTokenText;
      dueAt_ = nowMs + t_.retryMs + clampJitter(jitterMs);
    }
  }

  // The token to send as err= with the next poll. It stays until the relay has really
  // received it (clearError() after a poll that got an answer): if that poll itself fails,
  // the next one carries it again.
  const std::string& pendingError() const { return pendingErr_; }
  void clearError() { pendingErr_.clear(); }

 private:
  uint32_t clampJitter(uint32_t j) const { return j > t_.jitterMs ? t_.jitterMs : j; }

  OtaTiming t_;
  bool wifiWasUp_;
  uint32_t dueAt_;
  std::string pendingErr_;
};

}  // namespace esp32cam_ota
