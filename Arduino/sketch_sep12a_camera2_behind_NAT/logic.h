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

// The exact URL sendRecordRequest() POSTs to:
//   http://<host>:<httpPort>/record/<targetId>?seconds=<seconds>
inline std::string buildRecordUrl(const std::string &host, int httpPort,
                                   const std::string &targetId, int seconds) {
    return "http://" + host + ":" + std::to_string(httpPort) +
           "/record/" + targetId + "?seconds=" + std::to_string(seconds);
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

// Applies one control byte read from the relay's push socket to the
// streaming-enabled flag: 0x00 = pause, 0x01 = resume. Anything else is
// ignored (defensive — only 0/1 are meaningful on this channel).
inline void applyControlByte(int cmd, bool &streamEnabled) {
    if (cmd == 0) streamEnabled = false;
    else if (cmd == 1) streamEnabled = true;
}

} // namespace esp32cam_logic
