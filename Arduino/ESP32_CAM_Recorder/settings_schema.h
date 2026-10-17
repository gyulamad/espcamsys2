// settings_schema.h — WHICH settings the Recorder sketch has (the key table),
// and RecorderSettings, the typed copy of them the sketch reads at run time.
// Pure C++11 like settings_logic.h (no Arduino includes), so it is unit-tested
// on a desktop: see tests/cpp/test_settings_logic.cpp.
//
// This table replaces the old config.h. Key names are at most 15 characters
// (a flash/NVS limit), which is why a few differ from the old config.h names:
//   ALARM_ACTIVE_STATE          -> ALARM_ACTIVE
//   ALARM_RECORD_ALL_CAMERAS    -> ALARM_ALL_CAMS
//   PUSH_INTERVAL_MUL           -> PUSH_GAP_MUL
//   REMOTE_LOG_*                -> LOG_*   (see the table)
//
// There are no defaults. A setting listed "only needed when X" is skipped
// while X switches its feature off.

#pragma once

#include "settings_logic.h"

namespace esp32cam_settings {

static const KeyDef RECORDER_KEYS[] = {
    // name              kind             min   max      cond                 condKey            condValue  help
    { "WIFI",            Kind::Wifi,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "the networks to join (strongest one in range wins, fails over if it drops)" },
    { "SERVER_HOST",     Kind::Host,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "the relay's IP address or hostname (your Pi)" },
    { "PUSH_PORT",       Kind::Int,       1,    65535,   Cond::Always,        nullptr,           nullptr,
      "relay's raw push port - pushPort in the relay's config.js" },
    { "HTTP_PORT",       Kind::Int,       1,    65535,   Cond::Always,        nullptr,           nullptr,
      "relay's HTTP port - port in the relay's config.js" },
    { "CAMERA_ID",       Kind::Id,        0,    0,       Cond::Always,        nullptr,           nullptr,
      "unique per camera - must match its id in the dashboard's config.php" },
    { "API_KEY",         Kind::Secret,    0,    0,       Cond::Always,        nullptr,           nullptr,
      "must match camKey in the relay's config.js" },
    { "PUSH_GAP_MUL",    Kind::Float,     0.1,  10,      Cond::Always,        nullptr,           nullptr,
      "pause after each frame = last push time x this (1.5 is a good start)" },

    { "ALARM_GPIO_PIN",  Kind::PinOrOff,  0,    0,       Cond::Always,        nullptr,           nullptr,
      "GPIO the alarm input is wired to; -1 turns the alarm feature off" },
    { "ALARM_ACTIVE",    Kind::Level,     0,    0,       Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "pin level that means alarm (LOW with a button to GND)" },
    { "ALARM_ALL_CAMS",  Kind::Bool,      0,    0,       Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "1: an alarm starts recording on every camera; 0: only this one" },

    { "LOG_ENABLED",     Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: also send the log to the relay; 0: serial port only" },
    { "LOG_MIN_LEVEL",   Kind::Int,       0,    3,       Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "lowest level sent to the relay: 0=DEBUG 1=INFO 2=WARN 3=ERROR" },
    { "LOG_ECHO",        Kind::Bool,      0,    0,       Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "1: serial shows everything; 0: only what is not sent to the relay" },
    { "LOG_RETRY_MAX",   Kind::Int,       0,    255,     Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "retries after a failed delivery, then serial only until the relay is back" },
    { "LOG_RETRY_SEC",   Kind::Int,       1,    86400,   Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "seconds between retries" },
    { "LOG_FLUSH_SEC",   Kind::Int,       1,    3600,    Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "routine entries wait this long so they go out together" },
    { "LOG_REPEAT_SEC",  Kind::Int,       0,    3600,    Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "an identical message inside this window is counted, not repeated" },
    { "LOG_HEARTBEAT",   Kind::Int,       1,    86400,   Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "seconds between status lines in the relay's log" },
    { "LOG_LOW_HEAP",    Kind::Int,       0,    400000,  Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "warn when free heap falls below this many bytes" },
};

static const Schema RECORDER_SCHEMA = {
    RECORDER_KEYS,
    sizeof(RECORDER_KEYS) / sizeof(RECORDER_KEYS[0]),
    nullptr   // no rule spanning several settings
};

// The settings as the sketch uses them. Values of settings that are "not
// needed" (alarm off, remote log off) hold the neutral values below — the
// sketch still reads some of them (the heartbeat timer, the low-heap warning)
// even with remote logging off.
struct RecorderSettings {
    std::vector<WifiNet> wifi;
    std::string serverHost;
    int pushPort = 0;
    int httpPort = 0;
    std::string cameraId;
    std::string apiKey;
    float pushGapMul = 1.5f;

    int alarmGpioPin = -1;            // -1: alarm feature off
    bool alarmActiveHigh = false;     // false: the pin is LOW when the alarm is on
    bool alarmRecordAll = false;

    bool logEnabled = false;
    int logMinLevel = 1;
    bool logEcho = true;
    int logRetryMax = 3;
    uint32_t logRetrySec = 300;
    uint32_t logFlushSec = 10;
    uint32_t logRepeatSec = 30;
    uint32_t logHeartbeatSec = 600;
    uint32_t logLowHeapBytes = 30000;
};

// The settings this board needs before it can ask the relay for the OTHERS
// (RemoteFill in settings_logic.h): how to join the network, where the relay is,
// the key it wants, and which board is asking. When one of these is missing the
// serial console is the only way in. Keep in sync with the schema above.
inline std::vector<std::string> recorderRemotePrerequisites() {
    static const char* const keys[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "CAMERA_ID" };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// The settings the dashboard's settings page may NOT change on a running board
// (applyChangeLine in settings_logic.h): everything this board needs to reach the relay,
// plus the push port. A wrong value there would leave a board nobody can reach without a
// USB cable, so these stay serial-only. Keep in sync with the schema above.
inline std::vector<std::string> recorderLockedKeys() {
    static const char* const keys[] = { "WIFI", "SERVER_HOST", "PUSH_PORT", "HTTP_PORT", "CAMERA_ID", "API_KEY" };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// Fills `out` from flash. false (with `err` naming the first problem) if any
// needed setting is missing or no longer valid — the caller must not run then.
inline bool loadRecorderSettings(ISettingsStore& store, RecorderSettings& out, std::string& err) {
    std::vector<Problem> problems = findProblems(RECORDER_SCHEMA, store);
    if (!problems.empty()) {
        err = problems[0].key + (problems[0].missing ? " is not set" : " is invalid: " + problems[0].reason);
        return false;
    }

    RecorderSettings s;
    std::string wifiErr;
    parseWifiList(store.get("WIFI"), s.wifi, wifiErr);
    s.serverHost = store.get("SERVER_HOST");
    s.pushPort = static_cast<int>(storedInt(store, "PUSH_PORT"));
    s.httpPort = static_cast<int>(storedInt(store, "HTTP_PORT"));
    s.cameraId = store.get("CAMERA_ID");
    s.apiKey = store.get("API_KEY");
    double mul = 1.5;
    parseFloat(store.get("PUSH_GAP_MUL"), mul);
    s.pushGapMul = static_cast<float>(mul);

    s.alarmGpioPin = static_cast<int>(storedInt(store, "ALARM_GPIO_PIN"));
    if (s.alarmGpioPin >= 0) {
        s.alarmActiveHigh = store.get("ALARM_ACTIVE") == "HIGH";
        s.alarmRecordAll = store.get("ALARM_ALL_CAMS") == "1";
    }

    s.logEnabled = store.get("LOG_ENABLED") == "1";
    if (s.logEnabled) {
        s.logMinLevel = static_cast<int>(storedInt(store, "LOG_MIN_LEVEL"));
        s.logEcho = store.get("LOG_ECHO") == "1";
        s.logRetryMax = static_cast<int>(storedInt(store, "LOG_RETRY_MAX"));
        s.logRetrySec = static_cast<uint32_t>(storedInt(store, "LOG_RETRY_SEC"));
        s.logFlushSec = static_cast<uint32_t>(storedInt(store, "LOG_FLUSH_SEC"));
        s.logRepeatSec = static_cast<uint32_t>(storedInt(store, "LOG_REPEAT_SEC"));
        s.logHeartbeatSec = static_cast<uint32_t>(storedInt(store, "LOG_HEARTBEAT"));
        s.logLowHeapBytes = static_cast<uint32_t>(storedInt(store, "LOG_LOW_HEAP"));
    }

    out = s;
    return true;
}

}  // namespace esp32cam_settings
