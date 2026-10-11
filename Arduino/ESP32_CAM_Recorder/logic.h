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
// No duration is sent: how long to record is stored on the relay and edited
// from the dashboard, so it can be changed without reflashing the board.
inline std::string buildAlarmUrl(const std::string &host, int httpPort,
                                  const std::string &targetId) {
    return "http://" + host + ":" + std::to_string(httpPort) +
           "/alarm/" + targetId;
}

// Where the camera delivers its log messages (errors, warnings, notable
// events) so they can be read on the relay instead of a serial monitor — see
// remote_log.h. The request carries the API key in an X-Api-Key header.
inline std::string buildLogUrl(const std::string &host, int httpPort) {
    return "http://" + host + ":" + std::to_string(httpPort) + "/log";
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

// The relay announces what it understands with single raw bytes right after
// we authenticate (nodejs/camera-relay/lib/protocol.js, RELAY_CAP_*). We must
// only send the in-band alarm to a relay that has said it understands it: an
// OLDER relay would take those 6 bytes for a video frame, show a corrupt
// frame (a black screen) on the stream and lose the alarm. Old relays never
// send the capability byte, so they simply never get the in-band message.
const uint8_t RELAY_CAP_INBAND_ALARM = 0x02;

// Applies one byte read from the relay to the "does this relay understand
// in-band alarms" flag. The flag must be reset to false whenever a NEW
// connection is made — capability is per connection (the relay could have
// been downgraded or replaced in between). Any other byte is ignored here:
// 0x00/0x01 were the old pause/resume bytes, and unknown values must be
// ignored so a newer relay can add capabilities without breaking this board.
inline void applyRelayByte(int b, bool &relaySupportsInBandAlarm) {
    if (b == RELAY_CAP_INBAND_ALARM) relaySupportsInBandAlarm = true;
}

// How to report an alarm right now:
//   InBand — the push connection is up AND the relay has announced it
//            understands in-band alarms: write the 6-byte message on it.
//            This never waits for the relay, so the camera keeps capturing.
//   Http   — otherwise, if WiFi is up: the plain HTTP request every relay
//            version understands. It blocks loop() while it runs, which costs
//            frames — but it is correct, and when there is no push connection
//            nothing is streaming anyway.
//   Skip   — no WiFi at all: nothing can be sent.
enum class AlarmRoute { InBand, Http, Skip };

inline AlarmRoute chooseAlarmRoute(bool pushConnected, bool relaySupportsInBandAlarm, bool wifiUp) {
    if (pushConnected && relaySupportsInBandAlarm) return AlarmRoute::InBand;
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
//
// `maxMs` caps the gap. TCP already makes a slow push wait for the link, so a
// gap of 1.5x a 20-second push (a 30-second pause with nothing sent) only
// makes a weak link's picture even older; the cap keeps the camera sending.
// The default is "no cap".
inline unsigned long computePushDelayMs(unsigned long lastPushMs, float intervalMul, unsigned long maxMs = ~0UL) {
    unsigned long gap = (unsigned long)((float)lastPushMs * intervalMul);
    return gap > maxMs ? maxMs : gap;
}

// ── Adaptive JPEG quality ────────────────────────────────────────────
// A VGA frame is ~26 KB. On a strong link that is a blink; at -87 dBm it can
// take 10-45 seconds, the write stalls, and the camera has to drop and
// re-open its connection — over and over, so almost nothing arrives. The
// remedy is to send SMALLER frames when the link is slow: a higher JPEG
// quality number means heavier compression and a smaller file, and the
// picture comes back (one step at a time) when the link does. The resolution
// never changes, so recordings and the dashboard always see the same size.
//
// Quality numbers: LOWER = better picture, bigger file (the camera's own scale).

const int JPEG_QUALITY_DEGRADE_STEP = 6;            // per slow frame
const int JPEG_QUALITY_RECOVER_STEP = 2;            // per run of fast frames
const int JPEG_QUALITY_FAST_STREAK = 5;             // fast frames in a row before improving
const unsigned long JPEG_QUALITY_VERY_SLOW_FACTOR = 4; // this many times "slow" degrades twice as hard

struct JpegQualityAdapter {
    int best = 12;        // the configured quality: never improve beyond this
    int worst = 45;       // never degrade beyond this
    int current = 12;
    int fastStreak = 0;
};

inline JpegQualityAdapter makeJpegQualityAdapter(int best, int worst) {
    JpegQualityAdapter a;
    a.best = best;
    a.worst = worst < best ? best : worst;
    a.current = best;
    return a;
}

// Call after each frame push with how long it took and whether it got through.
// Returns the quality to use from now on (the caller applies it when it changed).
//   - a failed push, or one slower than `slowMs`: shrink the frames right away
//     (twice as hard when it was VERY slow)
//   - a run of pushes faster than `fastMs`: improve the picture a little
//   - anything in between: hold, and restart the run
inline int adaptJpegQuality(JpegQualityAdapter &a, unsigned long pushMs, bool pushOk,
                            unsigned long slowMs, unsigned long fastMs) {
    if (!pushOk || pushMs > slowMs) {
        a.fastStreak = 0;
        int step = JPEG_QUALITY_DEGRADE_STEP;
        if (!pushOk || pushMs > slowMs * JPEG_QUALITY_VERY_SLOW_FACTOR) step *= 2;
        a.current = a.current + step > a.worst ? a.worst : a.current + step;
        return a.current;
    }
    if (pushMs >= fastMs) {
        a.fastStreak = 0;
        return a.current;
    }
    if (++a.fastStreak < JPEG_QUALITY_FAST_STREAK) return a.current;
    a.fastStreak = 0;
    a.current = a.current - JPEG_QUALITY_RECOVER_STEP < a.best ? a.best : a.current - JPEG_QUALITY_RECOVER_STEP;
    return a.current;
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
