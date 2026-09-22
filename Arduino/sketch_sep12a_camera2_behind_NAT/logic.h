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

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

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

// ── AI-alarm command channel (relay -> device, same push socket) ────────
// See AI_ALARM_IMPLEMENTATION_PLAN.md §7 step 1 and the matching comment
// on encodeCommandFrame() in the relay's lib/protocol.js. This is
// plumbing only for now: the relay always sends a hardcoded no-op
// payload, and the only thing the device does with a successfully parsed
// command is log it (see the .ino's loop()) — no behavior changes yet.

// Tag bytes for relay->device messages on the push socket. 0x00/0x01 are
// the pre-existing single-byte pause/resume control values (see
// applyControlByte() above); COMMAND_FRAME_TAG is new and starts a
// [tag][2-byte big-endian length][JSON payload] frame instead, so both
// message shapes can share one byte stream without ambiguity.
const int CONTROL_BYTE_PAUSE = 0x00;
const int CONTROL_BYTE_RESUME = 0x01;
const int COMMAND_FRAME_TAG = 0x02;

// Safety cap on a command frame's declared length, matching the relay's
// own MAX_COMMAND_FRAME_LEN (lib/protocol.js) — a declared length beyond
// this can only be a corrupted/desynced stream, not a real payload, since
// the JSON this channel actually carries is a handful of bytes.
const size_t MAX_COMMAND_FRAME_LEN = 2048;

// Parsed AI-alarm command state, as sent by the relay in a command frame.
struct AiAlarmCommand {
    bool aiEnabled = false;
    long livePeekUntilEpoch = 0;
    bool valid = false; // false if the payload couldn't be parsed — caller should ignore it and keep the previous known-good state
};

// Extracts a decimal integer value for `key` from a small flat JSON
// object string, e.g. pulling 1699999999 out of
// `...,"live_peek_until_epoch":1699999999}`. Returns false if the key
// isn't present or isn't followed by a plain (optionally negative)
// integer.
inline bool extractJsonIntField(const std::string &json, const std::string &key, long &out) {
    std::string needle = "\"" + key + "\":";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos += needle.length();
    size_t end = pos;
    if (end < json.size() && json[end] == '-') end++;
    size_t digitsStart = end;
    while (end < json.size() && std::isdigit((unsigned char)json[end])) end++;
    if (end == digitsStart) return false; // no digits found after the optional '-'
    out = std::stol(json.substr(pos, end - pos));
    return true;
}

// Extracts a JSON boolean (unquoted `true`/`false`) value for `key`.
// Returns false if the key isn't present or its value is neither.
inline bool extractJsonBoolField(const std::string &json, const std::string &key, bool &out) {
    std::string needle = "\"" + key + "\":";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos += needle.length();
    if (json.compare(pos, 4, "true") == 0) { out = true; return true; }
    if (json.compare(pos, 5, "false") == 0) { out = false; return true; }
    return false;
}

// Parses a command-frame JSON payload of the fixed shape
// {"ai_enabled":<bool>,"live_peek_until_epoch":<int>}. This is a
// purpose-built extractor for that one known shape, not a general JSON
// parser — kept dependency-free and desktop-testable like the rest of
// this file, consistent with the sketch's other hand-rolled wire
// protocols (auth line, frame length prefix) rather than pulling in a
// JSON library for two fields. If either field is missing/malformed,
// `valid` is false and the whole command should be ignored.
inline AiAlarmCommand parseAiAlarmCommand(const std::string &json) {
    AiAlarmCommand cmd;
    bool aiEnabled = false;
    long epoch = 0;
    bool okBool = extractJsonBoolField(json, "ai_enabled", aiEnabled);
    bool okInt = extractJsonIntField(json, "live_peek_until_epoch", epoch);
    cmd.valid = okBool && okInt;
    if (cmd.valid) {
        cmd.aiEnabled = aiEnabled;
        cmd.livePeekUntilEpoch = epoch;
    }
    return cmd;
}

// Result of draining as much of the relay->device byte stream as is fully
// buffered: any legacy control bytes seen (in order), any complete
// command-frame JSON payloads seen (in order, still un-parsed — call
// parseAiAlarmCommand() on each), and whatever's left over (a partial
// tag/length/payload) for the caller to keep buffering across loop() calls.
struct DownstreamDrainResult {
    std::vector<int> controlBytes;
    std::vector<std::string> commandPayloads;
    std::string rest;
    bool malformed = false; // a command frame declared a length over MAX_COMMAND_FRAME_LEN — caller should drop the connection, same guard as the relay's own drainFrames()
};

// Same style/purpose as the relay's drainFrames() (lib/protocol.js), but
// for the device side parsing relay->device traffic out of a plain
// std::string buffer the .ino accumulates from repeated
// pushClient.available()/read() calls — kept as a pure function over a
// string so it's unit-testable without a real socket.
inline DownstreamDrainResult drainDownstream(const std::string &buf) {
    DownstreamDrainResult result;
    size_t pos = 0;
    while (pos < buf.size()) {
        unsigned char tag = (unsigned char)buf[pos];
        if ((int)tag == CONTROL_BYTE_PAUSE || (int)tag == CONTROL_BYTE_RESUME) {
            result.controlBytes.push_back((int)tag);
            pos += 1;
            continue;
        }
        if ((int)tag == COMMAND_FRAME_TAG) {
            if (pos + 3 > buf.size()) break; // tag + 2-byte length not fully here yet
            size_t len = ((unsigned char)buf[pos + 1] << 8) | (unsigned char)buf[pos + 2];
            if (len > MAX_COMMAND_FRAME_LEN) {
                result.malformed = true;
                result.rest.clear();
                return result;
            }
            if (pos + 3 + len > buf.size()) break; // payload not fully here yet
            result.commandPayloads.push_back(buf.substr(pos + 3, len));
            pos += 3 + len;
            continue;
        }
        // Unrecognized tag byte — skip it defensively rather than getting
        // permanently stuck, mirroring applyControlByte()'s "anything else
        // is ignored" stance.
        pos += 1;
    }
    result.rest = buf.substr(pos);
    return result;
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
