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

// ── Alarm hold (level) refresh ─────────────────────────────────────────
// The relay records for a fixed time after each alarm message, so one message
// per RISING edge is not enough for a sensor that stays active (a motion /
// brightness / person detector whose output goes high and STAYS high): the
// recording would run out while the alarm line is still up and only restart on
// the next edge. While the line is held active the alarm is therefore re-sent
// every refreshMs, which makes the relay extend the same recording. Keep
// refreshMs well below the relay's alarmRecordSeconds (its minimum is 1 s).
//
// Held-ness is only honoured after a real edge ("armed"): a sensor that powers
// up already active must not fire at boot, same rule as alarmDebounceUpdate().
struct AlarmHoldState {
    bool armed = false;            // an edge happened and the line has not gone inactive since
    unsigned long lastSentMs = 0;  // when the alarm was last sent (edge or refresh)
};

// Call once per loop(). `edge` is "a new alarm edge was latched since the last
// call", `inputActive` the line's current level compared with the active level.
// Returns true when an alarm message should be sent now.
inline bool alarmHoldUpdate(AlarmHoldState &st, bool edge, bool inputActive,
                            unsigned long nowMs, unsigned long refreshMs) {
    if (edge) {
        st.armed = true;
        st.lastSentMs = nowMs;
        return true;
    }
    if (!inputActive) {
        st.armed = false; // released: nothing to keep alive
        return false;
    }
    if (!st.armed) return false;
    if (nowMs - st.lastSentMs < refreshMs) return false;
    st.lastSentMs = nowMs;
    return true;
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

// ── In-band Wi-Fi report ─────────────────────────────────────────────
// Every few seconds the camera tells the relay which Wi-Fi network it is on and how strong the signal is, so the
// dashboard can show it next to the camera. Same framing as the alarm message — [4-byte length][CONTROL_MARKER]
// [MSG_WIFI][rssi: signed byte][ssid bytes] — written on the push connection between two frames, and only to a
// relay that announced (RELAY_CAP_WIFI_INFO) that it understands it. These values must match
// nodejs/camera-relay/lib/protocol.js (MSG_WIFI, RELAY_CAP_WIFI_INFO); tests/cpp/test_alarm_logic.cpp and
// tests/node/test_protocol.js pin the same bytes on both sides.
const uint8_t MSG_WIFI = 0x03;
const uint8_t RELAY_CAP_WIFI_INFO = 0x03;
const size_t  WIFI_SSID_MAX_LEN = 32;                                // an 802.11 network name is at most 32 bytes
const size_t  WIFI_MESSAGE_MAX_LEN = 4 + 3 + WIFI_SSID_MAX_LEN;     // length prefix + marker + type + rssi + name
const unsigned long WIFI_REPORT_INTERVAL_MS = 10000;

// Applies one byte read from the relay to the "does this relay understand Wi-Fi reports" flag. Like
// applyRelayByte(): per connection (reset it to false on every new one), every other byte is ignored.
inline void applyRelayWifiByte(int b, bool &relaySupportsWifiInfo) {
    if (b == RELAY_CAP_WIFI_INFO) relaySupportsWifiInfo = true;
}

// Writes the Wi-Fi report for `ssid` / `rssi` (dBm) into `out`. Returns the number of bytes to send, or 0 when there
// is nothing true to report: no network name, one longer than 32 bytes, or a signal that is not a connected one
// (the board gives 0 when it is not connected; real values are -127..-1). Nothing is sent then, never a guess.
inline size_t encodeWifiMessage(const std::string &ssid, int rssi, uint8_t out[WIFI_MESSAGE_MAX_LEN]) {
    if (ssid.empty() || ssid.size() > WIFI_SSID_MAX_LEN) return 0;
    if (rssi < -127 || rssi > -1) return 0;
    const uint32_t payloadLen = (uint32_t)(3 + ssid.size());
    encodeFrameLengthPrefix(payloadLen, out);
    out[4] = CONTROL_MARKER;
    out[5] = MSG_WIFI;
    out[6] = (uint8_t)(int8_t)rssi;
    for (size_t i = 0; i < ssid.size(); i++) out[7 + i] = (uint8_t)ssid[i];
    return 4 + (size_t)payloadLen;
}

// Is it time to send the next Wi-Fi report? The first one goes out as soon as the relay has announced support (the
// dashboard should not wait 10 s for it after a reconnect), then one per `intervalMs`. Wrap-safe: millis() overflows
// after ~49 days, and the unsigned difference still comes out right.
inline bool wifiReportDue(unsigned long nowMs, unsigned long lastReportMs, bool reportedOnThisConnection,
                          unsigned long intervalMs = WIFI_REPORT_INTERVAL_MS) {
    if (!reportedOnThisConnection) return true;
    return (unsigned long)(nowMs - lastReportMs) >= intervalMs;
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
// first remedy is to send SMALLER frames when the link is slow: a higher JPEG
// quality number means heavier compression and a smaller file, and the
// picture comes back (one step at a time) when the link does. When even the
// coarsest quality still cannot get a frame through, the frame SIZE drops a
// rung too (see the frame-size ladder below) — the two levers together can
// shrink a VGA frame from ~26 KB down to roughly 1-2 KB.
//
// Quality numbers: LOWER = better picture, bigger file (the camera's own
// scale). The OV2640's scale ends at 63 — its driver clamps anything above —
// so 63 is the coarsest frame the sensor can be asked for at all. The best
// (finest) and worst (coarsest) quality, whether the adapter runs at all, and
// whether the frame-size ladder runs, are settings the dashboard can change
// (JPEG_Q_MIN / JPEG_Q_MAX / JPEG_Q_DROP / SIZE_DROP in settings_schema.h);
// the sketch applies them when it builds the adapters.

const int JPEG_QUALITY_DEGRADE_STEP = 6;            // per slow frame
const int JPEG_QUALITY_RECOVER_STEP = 2;            // per run of fast frames
const int JPEG_QUALITY_FAST_STREAK = 5;             // fast frames in a row before improving
const unsigned long JPEG_QUALITY_VERY_SLOW_FACTOR = 4; // this many times "slow" degrades twice as hard

struct JpegQualityAdapter {
    int best = 12;        // the configured quality: never improve beyond this
    int worst = 63;       // never degrade beyond this (the OV2640's ceiling: its driver clamps above 63)
    int current = 12;
    int fastStreak = 0;
    bool enabled = true;  // false: hold the configured quality, never adapt (the JPEG_Q_DROP setting)
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
//   - disabled: hold the configured quality whatever the link does
//   - a failed push, or one slower than `slowMs`: shrink the frames right away
//     (twice as hard when it was VERY slow)
//   - a run of pushes faster than `fastMs`: improve the picture a little
//   - anything in between: hold, and restart the run
inline int adaptJpegQuality(JpegQualityAdapter &a, unsigned long pushMs, bool pushOk,
                            unsigned long slowMs, unsigned long fastMs) {
    if (!a.enabled) return a.current;   // JPEG_Q_DROP=0: the link never moves the quality
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

// ── Adaptive frame size (the resolution ladder) ──────────────
// The SECOND lever, used only when the quality lever is exhausted: compression
// alone shrinks a VGA frame by ~2-3x (quality 12 -> 63), but a very slow link
// (-87 dBm) needs more. Dropping the frame size multiplies whatever shrink the
// quality achieved — each rung down is ~2.5-4x fewer pixels — so the smallest
// rung (QQVGA, 160x120) at the coarsest quality is a frame of roughly 1-2 KB:
// small enough to squeeze through a link on which a full frame takes tens of
// seconds. The camera walks DOWN one rung at a time and climbs back the same
// way, so the dashboard and the recordings see the size the link can currently
// carry. (A recording whose camera changed size mid-clip is normalised by the
// relay when it encodes the clip.)
//
// The ladder is walked on RUNG INDICES, not sensor constants, so this stays
// plain desktop C++ (the .ino owns the framesize_t table it maps a rung to).
// A HIGHER index means a SMALLER frame; rung 0 is the configured size.

const int FRAME_SIZE_UP_FAST_STREAK = 10; // fast pushes in a row before adding pixels back

struct FrameSizeLadder {
    int best = 0;        // the configured (largest) rung: never climb above it
    int worst = 0;       // the smallest rung: never drop below it
    int current = 0;     // the rung in use
    int fastStreak = 0;  // fast pushes in a row while eligible to climb
};

inline FrameSizeLadder makeFrameSizeLadder(int best, int worst) {
    FrameSizeLadder l;
    l.best = best;
    l.worst = worst < best ? best : worst;
    l.current = best;
    return l;
}

// Call right after adaptJpegQuality(), on the same push result. `qualityExhausted` /
// `qualityAtFinest` are the quality adapter's "does the compression lever have nothing
// left to give / is it fully recovered" — the size lever is only touched when the first
// one holds: the quality is at its coarsest, OR the quality adapter is switched off
// (JPEG_Q_DROP=0 — the user pinned the quality, so this lever alone decides; the .ino
// computes that). Returns the rung in use; the caller reconfigures the sensor when it
// changed.
//   - quality exhausted AND a very slow (or failed) push: step DOWN one rung.
//     The quality is deliberately NOT reset: the frame is already as compressed as it
//     gets, and keeping it that way makes the smaller frame as small as possible right
//     away. It also damps oscillation: to climb again the quality must first recover
//     (a long run of fast pushes), then the rung must prove itself for a while longer.
//   - quality fully recovered AND the rung below the configured one AND a run of fast
//     pushes: step UP one rung, the honest test of a link that seems good again.
//   - anything else: hold, and restart any climb run.
inline int adaptFrameSize(FrameSizeLadder &l, bool qualityExhausted, bool qualityAtFinest,
                          unsigned long pushMs, bool pushOk,
                          unsigned long slowMs, unsigned long fastMs) {
    if (qualityExhausted && (!pushOk || pushMs > slowMs * JPEG_QUALITY_VERY_SLOW_FACTOR)) {
        l.fastStreak = 0;
        if (l.current >= l.worst) return l.current; // already the smallest rung
        l.current++;
        return l.current;
    }

    if (qualityAtFinest && l.current > l.best) {
        if (pushOk && pushMs < fastMs) {
            if (++l.fastStreak >= FRAME_SIZE_UP_FAST_STREAK) {
                l.fastStreak = 0;
                l.current--;
            }
            return l.current;
        }
        l.fastStreak = 0;
        return l.current;
    }

    l.fastStreak = 0;
    return l.current;
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
