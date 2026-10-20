// settings_schema.h — WHICH settings the person-detector sketch has (the key
// table), the one rule that spans several of them, and PersonSettings, the
// typed copy the sketch reads at run time. Pure C++11 like settings_logic.h (no
// Arduino includes), unit-tested on a desktop: see tests/cpp/test_person_settings.cpp.
//
// This table replaces the old config.h. Key names are at most 15 characters
// (a flash/NVS limit), which is why a few differ from the old config.h names:
//   PERSON_DETECTED_GPIO          -> PERSON_GPIO
//   PERSON_DETECTION_THRESHOLD    -> DETECT_THRESH
//   PERSON_CLEAR_THRESHOLD        -> CLEAR_THRESH
//   DETECTION_LOOP_DELAY_MS       -> LOOP_DELAY_MS
//   STREAM_JPEG_QUALITY           -> STREAM_JPEG_Q
//   STREAM_WRITE_TIMEOUT_S        -> STREAM_WR_TMO_S
//   ANNOUNCE_HEARTBEAT_SECONDS    -> ANN_HEARTBEAT
//   ANNOUNCE_RETRY_SECONDS        -> ANN_RETRY
//
// New in the scene gate (scene_logic.h): DARK_THRESH, MOTION_THRESH, MOTION_HOLD_S.
//
// There are no defaults. Everything about the live view (Wi-Fi, the relay it
// pushes to, and the tuning of that stream) is only asked for while
// STREAM_ENABLED=1, so a detector that must not use Wi-Fi at all is configured
// with eight settings.
//
// The live view is PUSHED: the detector connects out to the relay and keeps one
// connection open, sending its 96x96 picture and the numbers behind its alarm
// line up it (see report_logic.h). It serves nothing, so there is no port,
// user or password for a viewer to be given. (STREAM_USER, STREAM_PASS and
// STREAM_PORT belonged to the LAN server this replaced; a board that still has
// them stored in flash simply ignores them.)
//
// What is NOT a setting (developer switches, edit and re-flash): TENSOR_ARENA_SIZE
// (tied to the model), PRINT_DETECTION_SCORES, PRINT_STARTUP_INFO — see the top
// of the .ino.

#pragma once

#include "settings_logic.h"

namespace esp32cam_settings {

// CLEAR_THRESH is the score a detected person must fall BELOW before the GPIO
// goes LOW again. Above DETECT_THRESH it would never switch off at the right
// moment (hysteresis would be inverted), so that combination is refused.
inline bool personThresholdsConsistent(const IValues& v, std::string& err) {
    std::string detect, clear;
    if (!v.get("DETECT_THRESH", detect) || !v.get("CLEAR_THRESH", clear)) return true;   // not both known yet
    double d = 0, c = 0;
    if (!parseFloat(detect, d) || !parseFloat(clear, c)) return true;                     // reported on their own
    if (c > d) {
        err = "CLEAR_THRESH (" + clear + ") must not be higher than DETECT_THRESH (" + detect +
              ") - send both in one line to change them together";
        return false;
    }
    return true;
}

static const KeyDef PERSON_KEYS[] = {
    // name              kind             min   max      cond              condKey           condValue  help
    { "PERSON_GPIO",     Kind::Pin,       0,    0,       Cond::Always,     nullptr,          nullptr,
      "GPIO that goes HIGH while a person is detected (4 is the on-board flash LED)" },
    { "DETECT_THRESH",   Kind::Float,     0.01, 1,       Cond::Always,     nullptr,          nullptr,
      "person score that counts as detected: 0.6 = 60%" },
    { "CLEAR_THRESH",    Kind::Float,     0.01, 1,       Cond::Always,     nullptr,          nullptr,
      "score the person must fall BELOW before the GPIO goes LOW again (not higher than DETECT_THRESH)" },
    { "LOOP_DELAY_MS",   Kind::Int,       0,    1000,    Cond::Always,     nullptr,          nullptr,
      "pause between detections, milliseconds" },
    { "DARK_THRESH",   Kind::Int,       0,    255,     Cond::Always,     nullptr,          nullptr,
      "average brightness (0-255) below which the picture counts as dark and detection is paused; 0 = darkness check off" },
    { "MOTION_THRESH", Kind::Int,       0,    1000000, Cond::Always,     nullptr,          nullptr,
      "detection runs only after motion: summed pixel change between frames at or above this (about 100-1000 is typical); 0 = motion check off" },
    { "MOTION_HOLD_S", Kind::Int,       0,    3600,    Cond::Always,     nullptr,          nullptr,
      "seconds detection stays on after the last motion (a person standing still stays detected anyway); 0 = only while moving" },

    { "STREAM_ENABLED",  Kind::Bool,      0,    0,       Cond::Always,     nullptr,          nullptr,
      "1: join Wi-Fi and send the live view (picture + values) to the relay's dashboard; 0: no Wi-Fi at all (everything below is then not needed)" },
    { "WIFI",            Kind::Wifi,      0,    0,       Cond::WhenEquals, "STREAM_ENABLED", "1",
      "the networks to join (strongest one in range wins, fails over if it drops)" },
    { "SERVER_HOST",     Kind::Host,      0,    0,       Cond::WhenEquals, "STREAM_ENABLED", "1",
      "the relay's IP address or hostname (your Pi): the detector connects OUT to it, so it can sit behind a NAT router" },
    { "HTTP_PORT",       Kind::Int,       1,    65535,   Cond::WhenEquals, "STREAM_ENABLED", "1",
      "relay's HTTP port - port in the relay's config.js (the live view uses it too, no extra port)" },
    { "API_KEY",         Kind::Secret,    0,    0,       Cond::WhenEquals, "STREAM_ENABLED", "1",
      "must match camKey in the relay's config.js" },
    { "DETECTOR_ID",     Kind::Id,        0,    0,       Cond::WhenEquals, "STREAM_ENABLED", "1",
      "this detector's name: it must equal the 'detector' of its camera in the dashboard's config.php; NOT a recorder's CAMERA_ID" },
    { "STREAM_MAX_FPS",  Kind::Int,       1,    30,      Cond::WhenEquals, "STREAM_ENABLED", "1",
      "upper limit of the pictures sent per second (the real rate is the detection rate)" },
    { "STREAM_JPEG_Q",   Kind::Int,       1,    100,     Cond::WhenEquals, "STREAM_ENABLED", "1",
      "JPEG quality of the picture, higher = better picture" },
    { "STREAM_WR_TMO_S", Kind::Int,       1,    60,      Cond::WhenEquals, "STREAM_ENABLED", "1",
      "a relay connection that accepts nothing for this many seconds is dropped and opened again" },
    { "ANN_HEARTBEAT",   Kind::Int,       1,    86400,   Cond::WhenEquals, "STREAM_ENABLED", "1",
      "seconds between status lines (Wi-Fi, link, memory) in the relay's log" },
    { "ANN_RETRY",       Kind::Int,       1,    3600,    Cond::WhenEquals, "STREAM_ENABLED", "1",
      "longest wait, in seconds, between attempts to reach the relay again (the first retries come sooner)" },
};

static const Schema PERSON_SCHEMA = {
    PERSON_KEYS,
    sizeof(PERSON_KEYS) / sizeof(PERSON_KEYS[0]),
    personThresholdsConsistent
};

// The settings as the sketch uses them. With STREAM_ENABLED=0 the live-view
// fields hold the neutral values below (nothing reads them then).
struct PersonSettings {
    int personGpio = 13;
    float detectThreshold = 0.60f;
    float clearThreshold = 0.50f;
    int loopDelayMs = 10;
    int darkThreshold = 0;          // 0 = darkness check off
    uint32_t motionThreshold = 0;   // 0 = motion check off
    uint32_t motionHoldSec = 0;

    bool streamEnabled = false;
    std::vector<WifiNet> wifi;
    std::string serverHost;
    int httpPort = 0;
    std::string apiKey;
    std::string detectorId;
    int streamMaxFps = 10;
    int streamJpegQuality = 80;
    int streamWriteTimeoutSec = 3;
    uint32_t announceHeartbeatSec = 600;
    uint32_t announceRetrySec = 30;
};

// The settings this board needs before it can ask the relay for the OTHERS
// (RemoteFill in settings_logic.h): how to join the network, where the relay is,
// the key it wants, and which board is asking. When one of these is missing the
// serial console is the only way in. Keep in sync with the schema above.
inline std::vector<std::string> personRemotePrerequisites() {
    static const char* const keys[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "DETECTOR_ID" };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// Fills `out` from flash. false (with `err` naming the first problem) if any
// needed setting is missing or no longer valid — the caller must not run then.
inline bool loadPersonSettings(ISettingsStore& store, PersonSettings& out, std::string& err) {
    std::vector<Problem> problems = findProblems(PERSON_SCHEMA, store);
    if (!problems.empty()) {
        err = problems[0].key + (problems[0].missing ? " is not set" : " is invalid: " + problems[0].reason);
        return false;
    }

    PersonSettings s;
    s.personGpio = static_cast<int>(storedInt(store, "PERSON_GPIO"));
    double d = 0.6, c = 0.5;
    parseFloat(store.get("DETECT_THRESH"), d);
    parseFloat(store.get("CLEAR_THRESH"), c);
    s.detectThreshold = static_cast<float>(d);
    s.clearThreshold = static_cast<float>(c);
    s.loopDelayMs = static_cast<int>(storedInt(store, "LOOP_DELAY_MS"));
    s.darkThreshold = static_cast<int>(storedInt(store, "DARK_THRESH"));
    s.motionThreshold = static_cast<uint32_t>(storedInt(store, "MOTION_THRESH"));
    s.motionHoldSec = static_cast<uint32_t>(storedInt(store, "MOTION_HOLD_S"));

    s.streamEnabled = store.get("STREAM_ENABLED") == "1";
    if (s.streamEnabled) {
        std::string wifiErr;
        parseWifiList(store.get("WIFI"), s.wifi, wifiErr);
        s.serverHost = store.get("SERVER_HOST");
        s.httpPort = static_cast<int>(storedInt(store, "HTTP_PORT"));
        s.apiKey = store.get("API_KEY");
        s.detectorId = store.get("DETECTOR_ID");
        s.streamMaxFps = static_cast<int>(storedInt(store, "STREAM_MAX_FPS"));
        s.streamJpegQuality = static_cast<int>(storedInt(store, "STREAM_JPEG_Q"));
        s.streamWriteTimeoutSec = static_cast<int>(storedInt(store, "STREAM_WR_TMO_S"));
        s.announceHeartbeatSec = static_cast<uint32_t>(storedInt(store, "ANN_HEARTBEAT"));
        s.announceRetrySec = static_cast<uint32_t>(storedInt(store, "ANN_RETRY"));
    }

    out = s;
    return true;
}

}  // namespace esp32cam_settings
