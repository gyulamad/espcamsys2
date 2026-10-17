// report_logic.h — what the person detector tells the relay about itself, as plain,
// hardware-free C++ (no Arduino, no WiFi, no FreeRTOS) so it can be unit tested on a
// desktop with g++ — see tests/cpp/test_person_report_logic.cpp.
//
// WHY: to AIM a detector and choose its thresholds per camera you want to see, on the
// dashboard under that camera's picture, what the detector sees (its 96x96 grayscale
// frame) and the numbers behind its alarm line: brightness, motion, person score, their
// thresholds, and the level of the alarm GPIO. The detector therefore reports them to the
// relay — POST /detector/<DETECTOR_ID> (see nodejs/camera-relay/lib/detectorstate.js for the
// receiving side, which checks every field) — and the relay shows them to any number of
// dashboard viewers, which the detector's own one-viewer LAN stream could not.
//
// This file decides WHAT the report says and WHEN one is due; ESP32_CAM_TFLite_Person.ino
// supplies the frame, the JPEG encoder, the HTTP request and the clock.
//
// Must stay valid C++11 (the ESP32 toolchain's dialect) — run_tests.sh checks.

#ifndef PERSON_REPORT_LOGIC_H
#define PERSON_REPORT_LOGIC_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string>

#include "scene_logic.h"
#include "stream_logic.h"   // appendJsonString(), base64Encode()

namespace person_report {

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

// What the detection loop last saw. Written by it (core 1), read by the reporting task.
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

// The detector's settings that the report carries (the thresholds the numbers are compared with).
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

inline std::string buildReportUrl(const std::string& host, int httpPort, const std::string& detectorId) {
    return "http://" + host + ":" + std::to_string(httpPort) + "/detector/" + detectorId;
}

// The body for POST /detector/<id>. `jpeg` may be null (no picture this time).
// One JSON object, no line breaks. Numbers are printed locale-independently (this is only ever
// built with snprintf of integers and a fixed "%d.%03d" for the scores).
inline std::string buildReportJson(const Config& cfg, const Snapshot& s, uint32_t nowMs, const std::string& ip,
                                   int rssi, uint32_t uptimeMs, const uint8_t* jpeg, size_t jpegLen) {
    auto fixed3 = [](float v) {
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        int milli = (int)(v * 1000.0f + 0.5f);
        char b[16];
        snprintf(b, sizeof(b), "%d.%03d", milli / 1000, milli % 1000);
        return std::string(b);
    };

    std::string out = "{\"ip\":";
    person_stream::appendJsonString(out, ip);
    out += ",\"fw\":";
    person_stream::appendJsonString(out, cfg.fw);

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

    if (jpeg != nullptr && jpegLen > 0) {
        out += ",\"jpeg\":\"";
        out += person_stream::base64Encode(std::string((const char*)jpeg, jpegLen));
        out += "\"";
    }
    out += "}";
    return out;
}

// When to send. A report is due when
//   - there is something new (the detection loop looked at another frame), at most every minGapMs
//     (the network and the dashboard need ~4 a second, not one per detection cycle), or
//   - nothing new came but the last one is older than heartbeatMs (the dashboard keeps showing the
//     detector as online while it is paused, e.g. with no frames because the camera stalled).
// After a failed delivery nothing is tried for retryMs, so an unreachable relay is not hammered.
// Never while Wi-Fi is down (that is not a delivery failure).
class ReportPolicy {
public:
    ReportPolicy(uint32_t minGapMs = 250, uint32_t heartbeatMs = 1000, uint32_t retryMs = 5000)
        : minGapMs_(minGapMs), heartbeatMs_(heartbeatMs), retryMs_(retryMs),
          haveSent_(false), sentAt_(0), sentSeq_(0), haveFail_(false), failAt_(0) {}

    bool due(uint32_t now, bool wifiUp, const Snapshot& s) const {
        if (!wifiUp || !s.valid) return false;
        if (haveFail_ && (uint32_t)(now - failAt_) < retryMs_) return false;
        if (!haveSent_) return true;
        uint32_t since = (uint32_t)(now - sentAt_);
        if (since < minGapMs_) return false;
        if (s.seq != sentSeq_) return true;
        return since >= heartbeatMs_;
    }

    // Call after an attempt. `seq` is the snapshot's seq that was sent.
    void onResult(uint32_t now, bool ok, uint32_t seq) {
        if (ok) { haveSent_ = true; sentAt_ = now; sentSeq_ = seq; haveFail_ = false; }
        else    { haveFail_ = true; failAt_ = now; }
    }

private:
    uint32_t minGapMs_, heartbeatMs_, retryMs_;
    bool haveSent_;
    uint32_t sentAt_;
    uint32_t sentSeq_;
    bool haveFail_;
    uint32_t failAt_;
};

}  // namespace person_report

#endif  // PERSON_REPORT_LOGIC_H
