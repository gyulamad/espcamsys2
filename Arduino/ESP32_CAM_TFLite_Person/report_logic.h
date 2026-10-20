// report_logic.h — what the person detector tells the relay about itself, and how it keeps the
// connection to the relay up, as plain, hardware-free C++ (no Arduino, no WiFi, no FreeRTOS) so it
// can be unit tested on a desktop with g++ — see tests/cpp/test_person_report_logic.cpp.
//
// WHY: to AIM a detector and choose its thresholds per camera you want to see, on the dashboard
// under that camera's picture, what the detector sees (its 96x96 grayscale frame) and the numbers
// behind its alarm line: brightness, motion, person score, their thresholds, and the level of the
// alarm GPIO. A detector is often behind a NAT router, so nothing can connect to IT: it connects OUT
// to the relay and keeps ONE connection open, pushing its pictures and readings up it. (It used to
// POST a report with a base64 picture about four times a second — a new TCP connection each time —
// and, separately, serve its picture to one LAN viewer; this replaces both.)
//
// The connection is an HTTP Upgrade on the relay's normal HTTP port, which is why the board needs no
// extra setting, and every refusal is an ordinary HTTP answer it can print and send to the log:
//
//   detector -> relay   GET /detector/<DETECTOR_ID>/uplink HTTP/1.1
//                       Connection: Upgrade / Upgrade: espcam-detector/1 / X-Api-Key: <API_KEY>
//   relay -> detector   HTTP/1.1 101 Switching Protocols        accepted: raw byte stream from here on
//                       HTTP/1.1 401 ... {"error":"..."}        refused, then closed: the JSON says why
//   then, detector -> relay only, repeated:  [4-byte big-endian length][message]
//     message = [1][2-byte big-endian N][N bytes of JSON status][JPEG bytes — none for a heartbeat]
//
// The receiving side, which checks every field, is nodejs/camera-relay/lib/detectorlink.js and
// lib/detectorstate.js; tests/e2e/test_detector_firmware_e2e.js runs THIS code against the real
// relay so the two cannot drift apart.
//
// This file decides WHAT is sent and WHEN, and runs the connection's state machine (UplinkSession);
// ESP32_CAM_TFLite_Person.ino supplies the socket, the JPEG encoder, the snapshot of the detection
// loop and the clock through IUplinkEnv.
//
// Must stay valid C++11 (the ESP32 toolchain's dialect) — run_tests.sh checks.

#ifndef PERSON_REPORT_LOGIC_H
#define PERSON_REPORT_LOGIC_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

#include "scene_logic.h"

namespace person_report {

// Appends `s` as a quoted JSON string (bytes >= 0x80 pass through so UTF-8 stays UTF-8).
inline void appendJsonString(std::string& out, const std::string& s) {
    out += '"';
    for (size_t i = 0; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) { char u[8]; snprintf(u, sizeof(u), "\\u%04x", c); out += u; }
                else out += (char)c;
        }
    }
    out += '"';
}

// The relay's log endpoint (POST /log), where everything the detector says about itself goes.
inline std::string buildLogUrl(const std::string& host, int httpPort) {
    return "http://" + host + ":" + std::to_string(httpPort) + "/log";
}

// ── What the detector sees ───────────────────────────────────────────────

// How the gate is shown. "off" = both checks are switched off (DARK_THRESH=0 and MOTION_THRESH=0):
// the model runs on every frame.
enum class Gate { Dark, Still, Active, Off };

inline const char* gateName(Gate g) {
    switch (g) {
        case Gate::Dark:   return "dark";
        case Gate::Still:  return "still";
        case Gate::Active: return "active";
        case Gate::Off:
        default:           return "off";
    }
}

inline Gate gateFor(person_scene::SceneState state, int darkBelow, uint32_t motionAtLeast) {
    if (darkBelow <= 0 && motionAtLeast == 0) return Gate::Off;
    switch (state) {
        case person_scene::SceneState::Dark: return Gate::Dark;
        case person_scene::SceneState::Idle: return Gate::Still;
        case person_scene::SceneState::Active:
        default:                             return Gate::Active;
    }
}

// What the detection loop last saw. Written by it (core 1), read by the uplink task (core 0).
struct Snapshot {
    bool valid = false;        // at least one frame has been looked at
    uint32_t seq = 0;          // changes with every frame
    int brightness = 0;
    uint32_t motion = 0;
    Gate gate = Gate::Off;
    bool hasScore = false;     // the model has produced a score at least once
    float score = 0.0f;        // the LAST person score, 0..1
    uint32_t scoreAtMs = 0;    // when it was produced
    bool detected = false;     // the detector currently flags a person = the alarm GPIO is driven HIGH
};

// The detector's settings that the readings carry (the thresholds the numbers are compared with).
struct Config {
    std::string detectorId;
    std::string fw;
    int gpioPin = 13;
    int darkBelow = 0;
    uint32_t motionAtLeast = 0;
    uint32_t holdSec = 0;
    float detectAt = 0.6f;
    float clearAt = 0.5f;
};

// A score older than this is not shown: the model is paused (dark / nothing moving), so the old
// number would mislead someone aiming the detector. The model runs every loop when it runs at all.
constexpr uint32_t SCORE_FRESH_MS = 1500;

// How the uplink is doing, reported with every message so the relay (and the dashboard) can show
// trouble the board itself has noticed.
struct LinkStats {
    uint32_t frames = 0;       // pictures sent since boot
    uint32_t jpegFails = 0;    // frames that could not be encoded as JPEG since boot
    uint32_t reconnects = 0;   // times the connection to the relay was lost since boot
    uint32_t heap = 0;         // free heap, bytes
};

// The JSON status of one message. One object, no line breaks. Numbers are printed
// locale-independently (only snprintf of integers and a fixed "%d.%03d" for the scores).
inline std::string buildStatusJson(const Config& cfg, const Snapshot& s, uint32_t nowMs, const std::string& ip,
                                   int rssi, uint32_t uptimeMs, const LinkStats& link) {
    auto fixed3 = [](float v) {
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        int milli = (int)(v * 1000.0f + 0.5f);
        char b[16];
        snprintf(b, sizeof(b), "%d.%03d", milli / 1000, milli % 1000);
        return std::string(b);
    };

    std::string out = "{\"ip\":";
    appendJsonString(out, ip);
    out += ",\"fw\":";
    appendJsonString(out, cfg.fw);

    char buf[160];
    snprintf(buf, sizeof(buf), ",\"uptimeMs\":%u,\"rssi\":%d", (unsigned)uptimeMs, rssi);
    out += buf;

    snprintf(buf, sizeof(buf), ",\"gpio\":{\"pin\":%d,\"high\":%s}", cfg.gpioPin, s.detected ? "true" : "false");
    out += buf;

    snprintf(buf, sizeof(buf),
             ",\"scene\":{\"state\":\"%s\",\"brightness\":%d,\"motion\":%u,\"darkBelow\":%d,\"motionAtLeast\":%u,\"holdS\":%u}",
             gateName(s.gate), s.brightness, (unsigned)s.motion, cfg.darkBelow, (unsigned)cfg.motionAtLeast, (unsigned)cfg.holdSec);
    out += buf;

    bool fresh = s.hasScore && (uint32_t)(nowMs - s.scoreAtMs) <= SCORE_FRESH_MS;
    out += ",\"person\":{\"score\":";
    out += fresh ? fixed3(s.score) : std::string("null");
    out += ",\"detectAt\":" + fixed3(cfg.detectAt) + ",\"clearAt\":" + fixed3(cfg.clearAt);
    out += s.detected ? ",\"detected\":true}" : ",\"detected\":false}";

    snprintf(buf, sizeof(buf), ",\"link\":{\"frames\":%u,\"jpegFails\":%u,\"reconnects\":%u,\"heap\":%u}",
             (unsigned)link.frames, (unsigned)link.jpegFails, (unsigned)link.reconnects, (unsigned)link.heap);
    out += buf;
    out += "}";
    return out;
}

// ── The wire format ──────────────────────────────────────────────────────

constexpr size_t MAX_STATUS_BYTES = 2048;       // the relay refuses more (detectorlink.js MAX_STATUS_BYTES)
constexpr size_t MAX_JPEG_BYTES = 16 * 1024;    // ... and a bigger picture (MAX_JPEG_BYTES)
constexpr uint8_t MSG_FRAME = 1;

// One message as it travels on the wire: [4-byte length][1][2-byte status length][status][JPEG].
// `jpeg` may be null / empty (a heartbeat, or a frame that could not be encoded). Returns an EMPTY
// string if the status or the picture is over the limits the relay would refuse — never a message
// the relay cannot use.
inline std::string buildFrameMessage(const std::string& status, const uint8_t* jpeg, size_t jpegLen) {
    if (status.empty() || status.size() > MAX_STATUS_BYTES || jpegLen > MAX_JPEG_BYTES) return std::string();
    if (jpeg == nullptr) jpegLen = 0;
    size_t bodyLen = 1 + 2 + status.size() + jpegLen;
    std::string out;
    out.reserve(4 + bodyLen);
    out += (char)((bodyLen >> 24) & 0xff);
    out += (char)((bodyLen >> 16) & 0xff);
    out += (char)((bodyLen >> 8) & 0xff);
    out += (char)(bodyLen & 0xff);
    out += (char)MSG_FRAME;
    out += (char)((status.size() >> 8) & 0xff);
    out += (char)(status.size() & 0xff);
    out += status;
    if (jpegLen > 0) out.append((const char*)jpeg, jpegLen);
    return out;
}

// The request that asks the relay to switch the connection over to the uplink.
inline std::string buildUplinkRequest(const std::string& host, int port, const std::string& detectorId, const std::string& apiKey) {
    std::string r = "GET /detector/" + detectorId + "/uplink HTTP/1.1\r\n";
    r += "Host: " + host + ":" + std::to_string(port) + "\r\n";
    r += "Connection: Upgrade\r\n";
    r += "Upgrade: espcam-detector/1\r\n";
    r += "X-Api-Key: " + apiKey + "\r\n\r\n";
    return r;
}

// The first bytes of `s` that are printable, for quoting something unexpected in a log line.
inline std::string printablePrefix(const std::string& s, size_t max) {
    std::string out;
    for (size_t i = 0; i < s.size() && out.size() < max; i++) {
        unsigned char c = (unsigned char)s[i];
        out += (c >= 0x20 && c < 0x7f) ? (char)c : '.';
    }
    return out;
}

// The "error" text of a small JSON body like {"error":"wrong key: ..."}, or "" if there is none. Not a
// JSON parser: it finds the member and reads its string, unescaping \" \\ \n and \t.
inline std::string extractJsonError(const std::string& body) {
    size_t k = body.find("\"error\"");
    if (k == std::string::npos) return std::string();
    size_t i = body.find(':', k + 7);
    if (i == std::string::npos) return std::string();
    i = body.find('"', i + 1);
    if (i == std::string::npos) return std::string();
    std::string out;
    for (i++; i < body.size(); i++) {
        char c = body[i];
        if (c == '"') return out;
        if (c == '\\' && i + 1 < body.size()) {
            char n = body[++i];
            out += (n == 'n' || n == 't') ? ' ' : n;
        } else {
            out += c;
        }
    }
    return std::string();   // the closing quote never came: not usable
}

// What the relay answered to the uplink request.
struct UplinkHead {
    enum Kind {
        Incomplete,        // more bytes are needed
        Accepted,          // 101: the connection is now the uplink
        Refused,           // an HTTP error: `status` and `detail` (the relay's own reason) say which
        Malformed,         // not an HTTP answer at all
        ClosedSilently     // the relay closed the connection without answering
    };
    Kind kind = Incomplete;
    int status = 0;
    std::string detail;
};

// Judges the bytes received so far. `closed`: the relay closed its end (nothing more will come).
inline UplinkHead parseUplinkHead(const std::string& received, bool closed) {
    UplinkHead h;
    if (received.empty()) {
        h.kind = closed ? UplinkHead::ClosedSilently : UplinkHead::Incomplete;
        return h;
    }
    size_t end = received.find("\r\n\r\n");
    if (end == std::string::npos) {
        if (received.size() > 2048) {
            h.kind = UplinkHead::Malformed;
            h.detail = "answer head over 2048 bytes";
        } else if (closed) {
            h.kind = UplinkHead::Malformed;
            h.detail = "answer cut off: '" + printablePrefix(received, 24) + "'";
        } else {
            h.kind = UplinkHead::Incomplete;
        }
        return h;
    }

    // Status line: "HTTP/1.x NNN reason"
    size_t lineEnd = received.find("\r\n");
    std::string line = received.substr(0, lineEnd);
    int status = 0;
    if (line.compare(0, 7, "HTTP/1.") == 0 && line.size() >= 12 && line[8] == ' ' &&
        line[9] >= '0' && line[9] <= '9' && line[10] >= '0' && line[10] <= '9' && line[11] >= '0' && line[11] <= '9') {
        status = (line[9] - '0') * 100 + (line[10] - '0') * 10 + (line[11] - '0');
    }
    if (status < 100) {
        h.kind = UplinkHead::Malformed;
        h.detail = "not HTTP: '" + printablePrefix(received, 24) + "'";
        return h;
    }
    h.status = status;
    if (status == 101) {
        h.kind = UplinkHead::Accepted;
        return h;
    }

    // A refusal: its JSON body says why. Wait for the whole body if the length is announced and sane.
    std::string body = received.substr(end + 4);
    size_t cl = std::string::npos;
    size_t p = received.find("Content-Length:");
    if (p == std::string::npos) p = received.find("content-length:");
    if (p != std::string::npos && p < end) {
        unsigned long v = 0;
        for (size_t i = p + 15; i < end && received[i] != '\r'; i++) {
            if (received[i] >= '0' && received[i] <= '9') v = v * 10 + (unsigned long)(received[i] - '0');
            if (v > 4096) break;
        }
        if (v <= 4096) cl = (size_t)v;
    }
    if (!closed && cl != std::string::npos && body.size() < cl) {
        h.kind = UplinkHead::Incomplete;
        return h;
    }
    h.kind = UplinkHead::Refused;
    h.detail = extractJsonError(body);
    if (h.detail.empty() && line.size() > 13) h.detail = line.substr(13);   // the reason phrase
    return h;
}

// Why the relay refused, as the log line says it — with what to do about it.
inline std::string explainRefusal(int status, const std::string& detail, const std::string& host, int port) {
    std::string at = host + ":" + std::to_string(port);
    std::string d = detail.empty() ? std::string("no reason given") : detail;
    switch (status) {
        case 401:
            // The relay's own reason usually says what to fix already; add the hint only if it does not.
            return "the relay at " + at + " refused the uplink (HTTP 401): " + d +
                   (d.find("camKey") == std::string::npos ? " — API_KEY on the board must equal camKey in the relay's config.js" : "");
        case 404:
            return "the relay at " + at + " answered HTTP 404 (" + d +
                   ") — probably a relay older than this firmware: update and restart nodejs/camera-relay";
        case 426:
            return "the relay at " + at + " wants another uplink protocol (HTTP 426: " + d +
                   ") — relay and firmware are not the same version";
        case 503:
            return "the relay at " + at + " cannot take this detector (HTTP 503): " + d;
        default:
            return "the relay at " + at + " refused the uplink (HTTP " + std::to_string(status) + "): " + d;
    }
}

// ── Reading the Wi-Fi status ─────────────────────────────────────────────

// WiFi.status() by number (wl_status_t — stable across Arduino-ESP32 versions), with what it usually means.
inline const char* wifiStatusName(int status) {
    switch (status) {
        case 0:   return "IDLE (not trying to connect)";
        case 1:   return "NO_SSID_AVAIL (none of the WIFI networks is in range)";
        case 2:   return "SCAN_COMPLETED";
        case 3:   return "CONNECTED";
        case 4:   return "CONNECT_FAILED (wrong Wi-Fi password?)";
        case 5:   return "CONNECTION_LOST";
        case 6:   return "DISCONNECTED";
        case 255: return "NO_SHIELD (Wi-Fi not started)";
        default:  return "unknown status";
    }
}

// What an esp_camera_init() error usually means, as a log-line suffix (starting with " - ") or "" when there
// is nothing useful to add. The codes are esp_err_t (0x1xx: ESP-IDF) and the esp32-camera component's own
// (0x2xxxx). The ribbon cable and the supply are by far the commonest causes of "does not start".
inline const char* cameraErrorHint(int err) {
    switch (err) {
        case 0x105:     // ESP_ERR_NOT_FOUND
        case 0x20001:   // ESP_ERR_CAMERA_NOT_DETECTED
            return " - camera not detected: is its ribbon cable seated, and the 5 V supply steady?";
        case 0x101:     // ESP_ERR_NO_MEM
            return " - out of memory: is PSRAM enabled in the board options?";
        case 0x102:     // ESP_ERR_INVALID_STATE
            return " - the camera driver was already started";
        case 0x20002:   // ESP_ERR_CAMERA_FAILED_TO_SET_FRAME_SIZE
        case 0x20003:   // ESP_ERR_CAMERA_FAILED_TO_SET_OUT_FORMAT
        case 0x20004:   // ESP_ERR_CAMERA_NOT_SUPPORTED
            return " - this camera sensor does not support the requested picture size or format";
        default:
            return "";
    }
}

// "42s", "3m 05s", "2h 10m", "3d 4h" — for log lines.
inline std::string formatDuration(uint32_t ms) {
    uint32_t s = ms / 1000;
    char b[40];
    if (s < 60) snprintf(b, sizeof(b), "%us", (unsigned)s);
    else if (s < 3600) snprintf(b, sizeof(b), "%um %02us", (unsigned)(s / 60), (unsigned)(s % 60));
    else if (s < 86400) snprintf(b, sizeof(b), "%uh %02um", (unsigned)(s / 3600), (unsigned)((s % 3600) / 60));
    else snprintf(b, sizeof(b), "%ud %uh", (unsigned)(s / 86400), (unsigned)((s % 86400) / 3600));
    return std::string(b);
}

// "1 picture", "2 pictures" — so a log line never says "1 pictures".
inline std::string plural(uint32_t n, const char* noun) {
    return std::to_string((unsigned)n) + " " + noun + (n == 1 ? "" : "s");
}

// Wi-Fi going away and coming back, turned into things worth saying: the first connection after boot,
// losing it (once), the time it has been down while it still is (every stillDownEveryMs), and getting
// it back (with how long it was gone). Keeps the log to one line per event instead of one per pass.
struct WifiEvent {
    enum Kind { None, Connected, Reconnected, Lost, StillDown };
    Kind kind = None;
    uint32_t downForMs = 0;    // Reconnected / StillDown: how long Wi-Fi was / has been down
};

class WifiWatch {
public:
    explicit WifiWatch(uint32_t stillDownEveryMs = 10000)
        : stillDownEveryMs_(stillDownEveryMs), haveState_(false), up_(false), everUp_(false), downSince_(0), noteAt_(0) {}

    WifiEvent update(uint32_t now, bool up) {
        WifiEvent e;
        if (!haveState_) {
            haveState_ = true;
            downSince_ = now;      // boot: Wi-Fi has not connected yet
            noteAt_ = now;
        }
        if (up) {
            if (!everUp_) {
                e.kind = WifiEvent::Connected;
            } else if (!up_) {
                e.kind = WifiEvent::Reconnected;
                e.downForMs = (uint32_t)(now - downSince_);
            }
            up_ = true;
            everUp_ = true;
            return e;
        }
        if (up_) {                 // it was up a moment ago
            up_ = false;
            downSince_ = now;
            noteAt_ = now;
            e.kind = WifiEvent::Lost;
            return e;
        }
        if ((uint32_t)(now - noteAt_) >= stillDownEveryMs_) {
            noteAt_ = now;
            e.kind = WifiEvent::StillDown;
            e.downForMs = (uint32_t)(now - downSince_);
        }
        return e;
    }

private:
    uint32_t stillDownEveryMs_;
    bool haveState_, up_, everUp_;
    uint32_t downSince_, noteAt_;
};

// "Every N ms": true once per period (the first call only starts the clock).
class Every {
public:
    explicit Every(uint32_t periodMs) : period_(periodMs), started_(false), last_(0) {}
    bool due(uint32_t now) {
        if (!started_) { started_ = true; last_ = now; return false; }
        if ((uint32_t)(now - last_) >= period_) { last_ = now; return true; }
        return false;
    }

private:
    uint32_t period_;
    bool started_;
    uint32_t last_;
};

// ── When to send ─────────────────────────────────────────────────────────

// A picture is due when the detection loop looked at another frame, at most every minGapMs (the
// STREAM_MAX_FPS setting: the network and the dashboard need a few pictures a second, not one per
// detection cycle). With no new frame, a heartbeat — the readings alone, no picture — goes out every
// heartbeatMs, so the relay keeps the detector online while it is paused (the camera stalled, say) and
// the connection never goes quiet long enough for anyone to think it is dead.
class SendPolicy {
public:
    enum Decision { Nothing, Frame, Heartbeat };

    SendPolicy(uint32_t minGapMs, uint32_t heartbeatMs)
        : minGapMs_(minGapMs), heartbeatMs_(heartbeatMs), haveSent_(false), sentAt_(0), sentSeq_(0) {}

    // Cheap check before the snapshot is even looked at (taking it costs a lock and maybe a copy).
    bool mayLook(uint32_t now) const { return !haveSent_ || (uint32_t)(now - sentAt_) >= minGapMs_; }

    Decision decide(uint32_t now, bool snapshotValid, uint32_t seq) const {
        if (!snapshotValid) return Nothing;
        if (!haveSent_) return Frame;
        uint32_t since = (uint32_t)(now - sentAt_);
        if (since < minGapMs_) return Nothing;
        if (seq != sentSeq_) return Frame;
        return since >= heartbeatMs_ ? Heartbeat : Nothing;
    }

    void onFrameSent(uint32_t now, uint32_t seq) { haveSent_ = true; sentAt_ = now; sentSeq_ = seq; }
    void onHeartbeatSent(uint32_t now) { haveSent_ = true; sentAt_ = now; }
    uint32_t sentSeq() const { return sentSeq_; }

    // A new connection: the first message goes out at once, whatever was sent before.
    void reset() { haveSent_ = false; sentSeq_ = 0; }

private:
    uint32_t minGapMs_, heartbeatMs_;
    bool haveSent_;
    uint32_t sentAt_;
    uint32_t sentSeq_;
};

// How long to wait before the next attempt to reach the relay after `failuresInARow` failures: the
// first retry comes soon (a relay restart should cost seconds, not half a minute), then the wait
// doubles up to maxMs.
inline uint32_t backoffDelayMs(uint32_t failuresInARow, uint32_t firstMs, uint32_t maxMs) {
    if (failuresInARow == 0) return 0;
    uint32_t d = firstMs;
    for (uint32_t i = 1; i < failuresInARow && d < maxMs; i++) d = (d > maxMs / 2) ? maxMs : d * 2;
    return d > maxMs ? maxMs : d;
}

// ── The connection ───────────────────────────────────────────────────────

enum class Level { Debug, Info, Warn, Error };

// What the sketch knows about the board's network right now (for the readings and the log).
struct Telemetry {
    std::string ip;
    int rssi = 0;
    uint32_t heap = 0;
};

// Everything the session needs from the outside world. The sketch implements it with a WiFiClient,
// fmt2jpg(), the detection loop's snapshot and the log; the tests implement it with fakes that can
// fail on cue.
class IUplinkEnv {
public:
    virtual ~IUplinkEnv() {}
    virtual uint32_t nowMs() = 0;

    // Opens the TCP connection (blocks up to timeoutMs). On failure `why` says what went wrong.
    virtual bool open(const std::string& host, int port, uint32_t timeoutMs, std::string& why) = 0;
    virtual bool isOpen() = 0;                                              // false once the other end has closed
    virtual size_t send(const uint8_t* data, size_t len, uint32_t stallMs) = 0;   // bytes written; fewer than len = failed
    virtual size_t receive(uint8_t* buf, size_t cap) = 0;                   // what has arrived; never waits
    virtual void close() = 0;

    // The detection loop's latest frame + readings. Returns false before the first frame. The frame
    // (frameBytes long) is copied into `frame` only when snap.seq differs from `haveSeq`.
    virtual bool takeSnapshot(Snapshot& snap, uint8_t* frame, uint32_t haveSeq) = 0;
    virtual bool encodeJpeg(const uint8_t* gray, std::string& jpeg) = 0;
    virtual Telemetry telemetry() = 0;

    virtual void log(Level level, const std::string& message) = 0;
    virtual void relayReachable() = 0;   // the uplink just came up: a good moment to let queued log entries out
};

struct UplinkConfig {
    std::string host;
    int port = 0;
    std::string detectorId;
    std::string apiKey;
    Config report;                     // the thresholds etc. the readings carry
    size_t frameBytes = 96 * 96;
    uint32_t connectTimeoutMs = 4000;  // for the TCP connection
    uint32_t answerTimeoutMs = 5000;   // for the relay's answer to the uplink request
    uint32_t writeStallMs = 3000;      // a relay that accepts nothing for this long is given up on (STREAM_WR_TMO_S)
    uint32_t minFrameGapMs = 100;      // 1000 / STREAM_MAX_FPS
    uint32_t heartbeatMs = 1000;
    uint32_t retryFirstMs = 2000;
    uint32_t retryMaxMs = 30000;       // ANN_RETRY
};

// The detector's connection to the relay as a state machine. Call step() every few milliseconds from
// the network task; it never blocks for longer than one connect / one write timeout.
//
//   WaitingForWifi -> (Wi-Fi up) -> connect -> AwaitingAnswer -> (101) -> Streaming
//        ^                              |  fail (any reason, logged)  |  lost (logged)
//        |                              v                             v
//        +-------- (Wi-Fi down) ---- Backoff <------------------------+
//
// EVERY way this can go wrong is logged with its cause and what to do about it, because the board
// is usually installed where nobody can plug a cable in — the log in the relay's file is the only
// witness. (A failure repeating every few seconds is collapsed by the log itself.)
class UplinkSession {
public:
    enum class State { WaitingForWifi, Backoff, AwaitingAnswer, Streaming };

    UplinkSession(const UplinkConfig& cfg, IUplinkEnv& env)
        : cfg_(cfg), env_(env), policy_(cfg.minFrameGapMs, cfg.heartbeatMs), state_(State::WaitingForWifi),
          frame_(cfg.frameBytes, 0), attempts_(0), failures_(0), retryAt_(0), answerDeadline_(0),
          connectedAt_(0), picturesThisConnection_(0), firstPictureLogged_(false) {}

    void step(bool wifiUp) {
        uint32_t now = env_.nowMs();
        if (!wifiUp) {
            wifiDown();
            return;
        }
        switch (state_) {
            case State::WaitingForWifi: beginAttempt(); break;
            case State::Backoff:        if ((int32_t)(now - retryAt_) >= 0) beginAttempt(); break;
            case State::AwaitingAnswer: awaitAnswer(now); break;
            case State::Streaming:      stream(now); break;
        }
    }

    State state() const { return state_; }
    bool streaming() const { return state_ == State::Streaming; }
    const LinkStats& stats() const { return stats_; }
    uint32_t attempts() const { return attempts_; }
    const std::string& lastFailure() const { return lastFailure_; }

    // One line for the periodic status report.
    std::string describe() {
        char b[160];
        switch (state_) {
            case State::Streaming:
                return "relay link up for " + formatDuration((uint32_t)(env_.nowMs() - connectedAt_)) + ", " +
                       plural(stats_.frames, "picture") + " sent, " + plural(stats_.jpegFails, "JPEG failure") + ", " +
                       plural(stats_.reconnects, "reconnect");
            case State::WaitingForWifi:
                return "relay link down (waiting for Wi-Fi)";
            case State::AwaitingAnswer:
                return "relay link opening (waiting for the relay's answer)";
            case State::Backoff:
            default:
                snprintf(b, sizeof(b), "relay link down after %u attempt%s: ", (unsigned)attempts_, attempts_ == 1 ? "" : "s");
                return std::string(b) + (lastFailure_.empty() ? "no reason recorded" : lastFailure_);
        }
    }

private:
    void log(Level l, const std::string& m) { env_.log(l, m); }
    std::string relayAddress() const { return cfg_.host + ":" + std::to_string(cfg_.port); }

    void wifiDown() {
        if (state_ == State::WaitingForWifi) return;
        if (state_ == State::AwaitingAnswer || state_ == State::Streaming) {
            // The network went away; that is not the relay's fault, so no backoff when it returns.
            log(Level::Warn, std::string("Wi-Fi is down: the relay connection is closed — it is re-opened when Wi-Fi is back"));
            if (state_ == State::Streaming) stats_.reconnects++;
            env_.close();
        }
        state_ = State::WaitingForWifi;
        failures_ = 0;
    }

    void failAttempt(const std::string& what) {
        failures_++;
        lastFailure_ = what;
        uint32_t wait = backoffDelayMs(failures_, cfg_.retryFirstMs, cfg_.retryMaxMs);
        log(Level::Warn, what + " — retrying in " + std::to_string((unsigned)((wait + 999) / 1000)) + " s");
        state_ = State::Backoff;
        retryAt_ = env_.nowMs() + wait;
    }

    void beginAttempt() {
        attempts_++;
        log(Level::Debug, "connecting to the relay at " + relayAddress() + " (attempt " + std::to_string((unsigned)attempts_) + ")");
        std::string why;
        if (!env_.open(cfg_.host, cfg_.port, cfg_.connectTimeoutMs, why)) {
            failAttempt("could not reach the relay at " + relayAddress() + ": " + why);
            return;
        }
        std::string req = buildUplinkRequest(cfg_.host, cfg_.port, cfg_.detectorId, cfg_.apiKey);
        if (env_.send((const uint8_t*)req.data(), req.size(), cfg_.writeStallMs) != req.size()) {
            env_.close();
            failAttempt("connected to the relay at " + relayAddress() + " but could not send it the uplink request");
            return;
        }
        head_.clear();
        answerDeadline_ = env_.nowMs() + cfg_.answerTimeoutMs;
        state_ = State::AwaitingAnswer;
    }

    void awaitAnswer(uint32_t now) {
        uint8_t buf[256];
        size_t n;
        while (head_.size() <= 4096 && (n = env_.receive(buf, sizeof(buf))) > 0) head_.append((const char*)buf, n);
        bool closed = !env_.isOpen();
        UplinkHead h = parseUplinkHead(head_, closed);
        switch (h.kind) {
            case UplinkHead::Incomplete:
                if ((int32_t)(now - answerDeadline_) >= 0) {
                    env_.close();
                    failAttempt("the relay at " + relayAddress() + " did not answer the uplink request within " +
                                std::to_string((unsigned)(cfg_.answerTimeoutMs / 1000)) + " s — wrong HTTP_PORT, or a relay older than this firmware (update nodejs/camera-relay)");
                }
                return;
            case UplinkHead::Accepted:
                accepted(now);
                return;
            case UplinkHead::Refused:
                env_.close();
                failAttempt(explainRefusal(h.status, h.detail, cfg_.host, cfg_.port));
                return;
            case UplinkHead::ClosedSilently:
                env_.close();
                failAttempt("the relay at " + relayAddress() + " hung up without answering the uplink request — "
                            "a relay older than this firmware does that: update nodejs/camera-relay");
                return;
            case UplinkHead::Malformed:
            default:
                env_.close();
                failAttempt("the relay at " + relayAddress() + " did not answer like a web server (" + h.detail +
                            ") — is HTTP_PORT really the relay's HTTP port?");
                return;
        }
    }

    void accepted(uint32_t now) {
        state_ = State::Streaming;
        connectedAt_ = now;
        failures_ = 0;
        picturesThisConnection_ = 0;
        firstPictureLogged_ = false;
        policy_.reset();
        unsigned fps = cfg_.minFrameGapMs > 0 ? (unsigned)(1000 / cfg_.minFrameGapMs) : 0;
        log(Level::Info, "uplink to the relay at " + relayAddress() + " is up (attempt " + std::to_string((unsigned)attempts_) +
                         "): sending 96x96 pictures and readings as '" + cfg_.detectorId + "', up to " + std::to_string(fps) + " pictures/s");
        env_.relayReachable();
    }

    void lose(uint32_t now, const std::string& why) {
        uint32_t upMs = (uint32_t)(now - connectedAt_);
        env_.close();
        stats_.reconnects++;
        failures_ = 1;
        lastFailure_ = "lost the connection after " + formatDuration(upMs) + " (" + why + ")";
        log(Level::Warn, "lost the connection to the relay at " + relayAddress() + " after " + formatDuration(upMs) + " (" + why +
                         "); it had carried " + plural(picturesThisConnection_, "picture") + " — reconnecting");
        state_ = State::Backoff;
        retryAt_ = env_.nowMs() + backoffDelayMs(1, cfg_.retryFirstMs, cfg_.retryMaxMs);
    }

    void stream(uint32_t now) {
        // Nothing is expected from the relay after the 101: keep the receive buffers empty, and notice a close.
        uint8_t sink[128];
        while (env_.receive(sink, sizeof(sink)) > 0) {}
        if (!env_.isOpen()) {
            lose(now, "the relay closed the connection");
            return;
        }
        if (!policy_.mayLook(now)) return;

        Snapshot snap;
        bool valid = env_.takeSnapshot(snap, frame_.data(), policy_.sentSeq());
        SendPolicy::Decision d = policy_.decide(now, valid, snap.seq);
        if (d == SendPolicy::Nothing) return;

        std::string jpeg;
        bool picture = false;
        if (d == SendPolicy::Frame) {
            if (env_.encodeJpeg(frame_.data(), jpeg) && !jpeg.empty() && jpeg.size() <= MAX_JPEG_BYTES) {
                picture = true;
            } else {
                stats_.jpegFails++;
                jpeg.clear();
                // Constant text on purpose: the log collapses an identical message that keeps repeating.
                log(Level::Warn, "could not encode the 96x96 frame as JPEG — sending the readings without a picture (the dashboard shows \"no picture\" until this works; low on memory?)");
            }
        }

        Telemetry t = env_.telemetry();
        stats_.heap = t.heap;
        uint32_t sendAt = env_.nowMs();
        std::string status = buildStatusJson(cfg_.report, snap, sendAt, t.ip, t.rssi, sendAt, stats_);
        std::string msg = buildFrameMessage(status, picture ? (const uint8_t*)jpeg.data() : nullptr, picture ? jpeg.size() : 0);
        if (msg.empty()) {
            log(Level::Error, "the readings are too long to send (" + std::to_string((unsigned)status.size()) + " bytes) — this is a firmware bug");
            policy_.onFrameSent(sendAt, snap.seq);
            return;
        }

        size_t sent = env_.send((const uint8_t*)msg.data(), msg.size(), cfg_.writeStallMs);
        if (sent != msg.size()) {
            lose(env_.nowMs(), sent == 0 ? "the relay stopped accepting data" : "a message was only partly written — the relay stopped accepting data");
            return;
        }

        uint32_t doneAt = env_.nowMs();
        if (d == SendPolicy::Frame) policy_.onFrameSent(doneAt, snap.seq);
        else policy_.onHeartbeatSent(doneAt);
        if (picture) {
            stats_.frames++;
            picturesThisConnection_++;
            if (!firstPictureLogged_) {
                firstPictureLogged_ = true;
                log(Level::Info, "first picture sent to the relay (" + std::to_string((unsigned)jpeg.size()) + " bytes of JPEG)");
            }
        }
    }

    UplinkConfig cfg_;
    IUplinkEnv& env_;
    SendPolicy policy_;
    State state_;
    std::vector<uint8_t> frame_;
    LinkStats stats_;
    std::string head_;
    std::string lastFailure_;
    uint32_t attempts_;
    uint32_t failures_;
    uint32_t retryAt_;
    uint32_t answerDeadline_;
    uint32_t connectedAt_;
    uint32_t picturesThisConnection_;
    bool firstPictureLogged_;
};

}  // namespace person_report

#endif  // PERSON_REPORT_LOGIC_H
