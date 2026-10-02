// logic.h — the sketch's "business logic", pulled out of the .ino so it can
// be compiled and unit-tested as plain desktop C++ (g++, run under gdb),
// completely independent of the Arduino core / ESP32 SDK.
//
// Rules for anything added to this file:
//   - No Arduino/ESP includes (no <Arduino.h>, no WiFi/HTTPClient/etc).
//   - No hardware I/O (no digitalRead/millis/Serial/network calls) — those
//     stay in the .ino, which reads the hardware and calls these functions
//     with plain values.
//   - Only standard C++ (<string>, <cstdint>, <cstddef>) so it builds with
//     any desktop compiler.
//
// See tests/cpp/test_alarm_logic.cpp for the unit tests covering this file.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace esp32cam_logic {

// ── Alarm debounce/edge-detection ──────────────────────────────────────

// Debounce state for one digital input, carried across loop() iterations.
// -1 means "not read yet" for both fields.
struct AlarmDebounceState {
    int rawState = -1;
    int stableState = -1;
    unsigned long lastChangeMs = 0;
};

// Feeds one new raw digitalRead() value through the debounce state
// machine. Returns true exactly on the call where a *settled* transition
// into activeState is detected — i.e. the one moment an alarm should fire.
//
// Mirrors checkAlarmTrigger()'s logic exactly:
//   - A reading that just changed resets the settle timer and never
//     triggers on its own.
//   - A reading that hasn't held steady for debounceMs yet never triggers.
//   - The very first stable reading after boot never triggers (so a
//     sensor that powers up already in its active position doesn't fire
//     before anything has actually "happened") — see hadPriorReading.
inline bool alarmDebounceUpdate(AlarmDebounceState &st, int raw, unsigned long nowMs,
                                 unsigned long debounceMs, int activeState) {
    if (raw != st.rawState) {
        st.rawState = raw;
        st.lastChangeMs = nowMs;
        return false; // reading just moved — wait for it to settle
    }

    if (nowMs - st.lastChangeMs < debounceMs) return false; // still settling

    if (raw != st.stableState) {
        bool hadPriorReading = (st.stableState != -1);
        st.stableState = raw;
        return hadPriorReading && st.stableState == activeState;
    }

    return false; // already stable at this value, nothing changed
}

// Which camera id an alarm-triggered recording request should target —
// this camera alone, or every camera the relay knows about.
inline std::string alarmRecordTargetId(bool recordAllCameras, const std::string &cameraId) {
    return recordAllCameras ? std::string("all") : cameraId;
}

// The exact URL sendAlarmRequest() POSTs to:
//   http://<host>:<httpPort>/alarm/<targetId>
// No duration is sent: how long to record and how long to keep the camera
// on are stored on the relay and edited from the dashboard, so they can be
// changed without reflashing the board.
inline std::string buildAlarmUrl(const std::string &host, int httpPort,
                                  const std::string &targetId) {
    return "http://" + host + ":" + std::to_string(httpPort) +
           "/alarm/" + targetId;
}

// ── Push connection ──────────────────────────────────────────────────

// The one-time auth line sent right after the push socket connects:
// "<cameraId>\t<apiKey>\n" — must match the relay's own parsing.
inline std::string buildAuthLine(const std::string &cameraId, const std::string &apiKey) {
    return cameraId + "\t" + apiKey + "\n";
}

// Encodes the 4-byte big-endian length prefix written before each pushed
// JPEG frame. `out` must have room for 4 bytes.
inline void encodeFrameLengthPrefix(uint32_t len, uint8_t out[4]) {
    out[0] = (uint8_t)(len >> 24);
    out[1] = (uint8_t)(len >> 16);
    out[2] = (uint8_t)(len >> 8);
    out[3] = (uint8_t)(len);
}

// ── In-band alarm message ────────────────────────────────────────────
// Instead of a separate (blocking) HTTP request, an alarm is reported as a
// tiny control message written down the SAME persistent push connection the
// frames use, between two frames. Same framing as a frame — [4-byte
// big-endian length][payload] — but the payload is [CONTROL_MARKER][type]
// rather than a JPEG. A JPEG always starts 0xFF 0xD8, so the relay can never
// confuse the two. These values must match nodejs/camera-relay/lib/protocol.js
// (CONTROL_MARKER, MSG_ALARM, MSG_ALARM_ALL); tests/node/test_protocol.js and
// tests/cpp/test_alarm_logic.cpp pin the same 6 bytes on both sides.
const uint8_t CONTROL_MARKER = 0x00;
const uint8_t MSG_ALARM      = 0x01; // start/extend a recording on THIS camera
const uint8_t MSG_ALARM_ALL  = 0x02; // start/extend a recording on EVERY camera
const size_t  ALARM_MESSAGE_LEN = 6; // 4-byte length prefix + 2-byte payload

inline void encodeAlarmMessage(bool allCameras, uint8_t out[ALARM_MESSAGE_LEN]) {
    encodeFrameLengthPrefix(2, out);
    out[4] = CONTROL_MARKER;
    out[5] = allCameras ? MSG_ALARM_ALL : MSG_ALARM;
}

// How to report an alarm right now:
//   InBand — the push connection is up: write the 6-byte message on it. This
//            never waits for the relay, so the camera keeps capturing.
//   Http   — no push connection (so no frames are flowing anyway, and
//            blocking costs nothing) but WiFi is up: the old HTTP request.
//   Skip   — no WiFi at all: nothing can be sent.
enum class AlarmRoute { InBand, Http, Skip };

inline AlarmRoute chooseAlarmRoute(bool pushConnected, bool wifiUp) {
    if (pushConnected) return AlarmRoute::InBand;
    return wifiUp ? AlarmRoute::Http : AlarmRoute::Skip;
}

// True if a push (length prefix + payload) went out completely and the
// socket is still connected — i.e. no reconnect is needed next loop.
inline bool pushWriteSucceeded(size_t written, uint32_t frameLen, bool stillConnected) {
    return written == (size_t)(4 + frameLen) && stillConnected;
}

// Adaptive gap after each push: scales with how long the last push
// actually took. Fast/idle link -> short gap -> max fps; congested link
// -> pushMs grows -> gap grows with it -> backs off automatically.
inline unsigned long computePushDelayMs(unsigned long lastPushMs, float intervalMul) {
    return (unsigned long)((float)lastPushMs * intervalMul);
}

// True once a stalled write (no forward progress at all) has gone on long
// enough that it's not worth waiting any longer for — used by the
// push-frame write loop to give up on a badly stuck connection instead of
// blocking loop() forever, rather than to judge a single short write() as
// already failed.
inline bool writeStalled(unsigned long lastProgressMs, unsigned long nowMs, unsigned long timeoutMs) {
    return (nowMs - lastProgressMs) >= timeoutMs;
}

} // namespace esp32cam_logic
