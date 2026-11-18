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
// New with the motion area: MOTION_X0, MOTION_Y0, MOTION_X1, MOTION_Y1 - the part of the
// picture that is watched for motion (the whole 96x96 picture is 0, 0, 96, 96).
// New with the motion auto-calibration (motion_baseline.h): MOTION_EMA_LEN (0 = off, the fixed
// MOTION_THRESH as before) and, only while that is not 0, MOTION_EMA_PCT.
//
// Settings that used to be fixed in the code have a default (PERSON_META below): a board
// that has none stored uses it. The defaults of the detection settings are the values the
// example template (Arduino/templates/example.person.template.txt) and the old config.h
// always carried, so a blank board now asks only for the live view's identity (its Wi-Fi,
// the relay it pushes to, its own name) - the tuning is there to be CHANGED, not typed in.
// The values that say where and who this board is (WIFI, SERVER_HOST, HTTP_PORT, API_KEY,
// DETECTOR_ID) and the alarm pin (PERSON_GPIO, which depends on how the board is wired)
// have no default and stay required.
//
// What is NOT a setting (developer switches, edit and re-flash): TENSOR_ARENA_SIZE
// (tied to the model), PRINT_DETECTION_SCORES, PRINT_STARTUP_INFO — see the top
// of the .ino.

#pragma once

#include "scene_logic.h"
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

// The four MOTION_* numbers together must make a usable motion area: inside the picture and big enough
// that a sample pixel falls in it (person_scene::motionAreaUsable). Each number is also range-checked on
// its own, so this only judges them as a set - and, like the threshold rule, only once all four are
// known and are numbers (a missing or malformed one is reported on its own).
inline bool personMotionAreaConsistent(const IValues& v, std::string& err) {
    static const char* const names[4] = { "MOTION_X0", "MOTION_Y0", "MOTION_X1", "MOTION_Y1" };
    long long n[4] = { 0, 0, 0, 0 };
    for (int i = 0; i < 4; ++i) {
        std::string text;
        if (!v.get(names[i], text) || !parseInt(text, n[i])) return true;
    }
    person_scene::MotionArea area(static_cast<int>(n[0]), static_cast<int>(n[1]), static_cast<int>(n[2]), static_cast<int>(n[3]));
    std::string why;
    if (person_scene::motionAreaUsable(area, person_scene::FRAME_SIZE, person_scene::FRAME_SIZE, why)) return true;
    err = "MOTION_X0/Y0/X1/Y1 (" + numText(static_cast<double>(n[0])) + "," + numText(static_cast<double>(n[1])) + "," +
          numText(static_cast<double>(n[2])) + "," + numText(static_cast<double>(n[3])) + "): " + why +
          " - send all four in one line to change them together";
    return false;
}

// Every rule that spans several of the detector's settings; the first one that fails is reported.
inline bool personRulesHold(const IValues& v, std::string& err) {
    return personThresholdsConsistent(v, err) && personMotionAreaConsistent(v, err);
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

    { "MOTION_X0",     Kind::Int,       0,    person_scene::FRAME_SIZE, Cond::Always, nullptr,        nullptr,
      "motion area, left edge in pixels of the 96x96 picture (0 = the picture's left edge); only what lies inside the area counts as motion" },
    { "MOTION_Y0",     Kind::Int,       0,    person_scene::FRAME_SIZE, Cond::Always, nullptr,        nullptr,
      "motion area, top edge in pixels (0 = the picture's top edge)" },
    { "MOTION_X1",     Kind::Int,       0,    person_scene::FRAME_SIZE, Cond::Always, nullptr,        nullptr,
      "motion area, right edge in pixels, first column outside the area (96 = the picture's right edge); at least 10 more than MOTION_X0" },
    { "MOTION_Y1",     Kind::Int,       0,    person_scene::FRAME_SIZE, Cond::Always, nullptr,        nullptr,
      "motion area, bottom edge in pixels, first row outside the area (96 = the picture's bottom edge); at least 10 more than MOTION_Y0" },

    { "MOTION_EMA_LEN", Kind::Int,      0,    person_scene::MAX_MOTION_EMA_LEN, Cond::Always, nullptr,  nullptr,
      "motion auto-calibration: the motion threshold follows a moving average of the motion over this many frames (a few minutes' worth), so wind and rain raise it; MOTION_THRESH stays its lowest value; 0 = off, the threshold stays fixed" },
    { "MOTION_EMA_PCT", Kind::Int,      0,    person_scene::MAX_MOTION_EMA_PERCENT, Cond::WhenNotEquals, "MOTION_EMA_LEN", "0",
      "motion auto-calibration: how far above the moving average the threshold lies, in percent (30 is a good start)" },
    { "MOTION_CLIP",    Kind::Float,    1.1,  10,      Cond::Always,     nullptr,          nullptr,
      "motion auto-calibration: one motion reading is learnt as at most this many times the threshold in force, so a person walking through the picture barely raises the bar against the next one" },
    { "DARK_HYST",      Kind::Int,      0,    255,     Cond::Always,     nullptr,          nullptr,
      "darkness is left again only when the brightness is this much above the DARK_THRESH it was entered at, so dusk or a flickering lamp does not flip the gate on every frame" },
    { "SCORE_FRESH_MS", Kind::Int,      100,  60000,   Cond::Always,     nullptr,          nullptr,
      "a detection score older than this is not shown (the model is paused: dark or nothing moving), so an old number cannot mislead someone aiming the detector" },
    { "CAM_VFLIP",      Kind::Bool,     0,    0,       Cond::Always,     nullptr,          nullptr,
      "1: flip the picture upside down (with CAM_HMIRROR 1 = turned 180 degrees). Set the camera the same" },
    { "CAM_HMIRROR",    Kind::Bool,     0,    0,       Cond::Always,     nullptr,          nullptr,
      "1: mirror the picture left to right. Set the camera the same" },

    { "WIFI",            Kind::Wifi,      0,    0,       Cond::Always,     nullptr,          nullptr,
      "the networks to join (strongest one in range wins, fails over if it drops)" },
    { "SERVER_HOST",     Kind::Host,      0,    0,       Cond::Always,     nullptr,          nullptr,
      "the relay's IP address or hostname (your Pi): the detector connects OUT to it, so it can sit behind a NAT router" },
    { "HTTP_PORT",       Kind::Int,       1,    65535,   Cond::Always,     nullptr,          nullptr,
      "relay's HTTP port - port in the relay's config.js (the live view uses it too, no extra port)" },
    { "API_KEY",         Kind::Secret,    0,    0,       Cond::Always,     nullptr,          nullptr,
      "must match camKey in the relay's config.js" },
    { "DETECTOR_ID",     Kind::Id,        0,    0,       Cond::Always,     nullptr,          nullptr,
      "this detector's name: it must equal the 'detector' of its camera in the dashboard's config.php; NOT a recorder's CAMERA_ID" },
    { "STREAM_MAX_FPS",  Kind::Int,       1,    30,      Cond::Always,     nullptr,          nullptr,
      "upper limit of the pictures sent per second (the real rate is the detection rate)" },
    { "STREAM_JPEG_Q",   Kind::Int,       1,    100,     Cond::Always,     nullptr,          nullptr,
      "JPEG quality of the picture, higher = better picture" },
    { "STREAM_WR_TMO_S", Kind::Int,       1,    60,      Cond::Always,     nullptr,          nullptr,
      "a relay connection that accepts nothing for this many seconds is dropped and opened again" },
    { "STREAM_CONN_MS",  Kind::Int,       500,  60000,   Cond::Always,     nullptr,          nullptr,
      "giving up on opening the TCP connection to the relay after this long (ms)" },
    { "STREAM_ANS_MS",   Kind::Int,       500,  60000,   Cond::Always,     nullptr,          nullptr,
      "the relay has this long (ms) to answer the uplink request before the connection is given up on" },
    { "STREAM_BEAT_MS",  Kind::Int,       100,  60000,   Cond::Always,     nullptr,          nullptr,
      "while nobody watches a frame: a heartbeat (the readings, no picture) goes out at least this often (ms), so the relay keeps the detector online while it is paused" },
    { "ANN_HEARTBEAT",   Kind::Int,       1,    86400,   Cond::Always,     nullptr,          nullptr,
      "seconds between status lines (Wi-Fi, link, memory) in the relay's log" },
    { "ANN_RETRY",       Kind::Int,       1,    3600,    Cond::Always,     nullptr,          nullptr,
      "longest wait, in seconds, between attempts to reach the relay again (the first retries come sooner)" },
    { "ANN_FIRST_S",     Kind::Int,       1,    3600,    Cond::Always,     nullptr,          nullptr,
      "first wait, in seconds, before the relay is tried again after a failure (a relay restart should cost seconds, not half a minute); the later waits double up to ANN_RETRY" },
    // F-21, the cable-free first setup (see the setup mode of the sketch). Both settings are OPTIONAL: a board
    // that has neither is still complete, so boards deployed before this feature keep working untouched.
    { "SETUP_MODE",      Kind::Bool,      0,    0,       Cond::Optional,    nullptr,          nullptr,
      "1 = at the next restart this board opens its own setup WiFi and waits there, not working normally, until it is configured or exited; it switches itself off after use (absent or 0 = off)" },
    { "SETUP_PASSWORD",  Kind::Secret,    8,    63,      Cond::Optional,    nullptr,          nullptr,
      "master password of the setup WiFi, the same on every board (8 to 63 characters); until it is set a built-in default is used, which the setup form makes you replace" },
};

// The readable name, group and fallback of each setting (see KeyMeta in settings_logic.h). A setting with a
// default is no longer asked for on a blank board: it simply uses that value - the one the example template
// and the old config.h always carried, or the constant that used to be fixed in the code - until somebody
// changes it. The values that say WHERE and WHO this board is (WIFI, SERVER_HOST, HTTP_PORT, API_KEY,
// DETECTOR_ID) and the alarm pin (PERSON_GPIO: it depends on how the board is wired, and driving the wrong
// pin would mean rewiring) have no default and stay required. MOTION_EMA_PCT has none either: it is only
// asked for while the auto-calibration is on, and its usual value (30) is in the help text - the same
// arrangement LOG_MIN_LEVEL has on the recorder, but there the fixed default always applied; here a board
// that predates the feature must keep being asked, because nothing else tells the owner the choice exists.
//
// Categories follow the Atlas design's detector page: Detection, Picture & live view, Connection (the
// detector's share of Connection - Wi-Fi sleep, HTTP timeouts - arrives with T5b).
static const KeyMeta PERSON_META[] = {
    // name              default  label                                   category          tier          apply
    { "DETECT_THRESH",   "0.6",   "Person detected above (score)",        "Detection",      Tier::Basic,    Apply::Live },
    { "CLEAR_THRESH",    "0.5",   "Person cleared below (score)",         "Detection",      Tier::Basic,    Apply::Live },
    { "LOOP_DELAY_MS",   "10",    "Pause between detections (ms)",        "Detection",      Tier::Advanced, Apply::Live },
    { "DARK_THRESH",     "40",    "Darkness threshold (0 = off)",         "Detection",      Tier::Basic,    Apply::Live },
    { "DARK_HYST",       "5",     "Darkness hysteresis",                  "Detection",      Tier::Advanced, Apply::Live },
    { "MOTION_THRESH",   "300",   "Motion threshold (0 = off)",           "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_HOLD_S",   "10",    "Detection hold after motion (s)",      "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_X0",       "0",     "Motion area left edge",                "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_Y0",       "0",     "Motion area top edge",                 "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_X1",       "96",    "Motion area right edge",               "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_Y1",       "96",    "Motion area bottom edge",              "Detection",      Tier::Basic,    Apply::Live },
    { "MOTION_EMA_LEN",  "0",     "Motion auto-calibration length (frames)", "Detection",   Tier::Advanced, Apply::Live },
    { "MOTION_EMA_PCT",  nullptr, "Auto-calibration margin (%)",          "Detection",      Tier::Advanced, Apply::Live },
    { "MOTION_CLIP",     "2.0",   "Motion spike clip factor",             "Detection",      Tier::Expert,   Apply::Live },
    { "SCORE_FRESH_MS",  "1500",  "Detection score stays fresh for (ms)", "Detection",      Tier::Advanced, Apply::Live },
    { "CAM_VFLIP",       "0",     "Flip the picture upside down",         "Detection",      Tier::Basic,    Apply::Reboot },
    { "CAM_HMIRROR",     "0",     "Mirror the picture",                   "Detection",      Tier::Basic,    Apply::Reboot },
    { "STREAM_MAX_FPS",  "10",    "Live view frames per second (max)",    "Picture & live view", Tier::Basic,    Apply::Reboot },
    { "STREAM_JPEG_Q",   "80",    "Live view JPEG quality",               "Picture & live view", Tier::Basic,    Apply::Reboot },
    { "STREAM_WR_TMO_S", "3",     "Relay write timeout (s)",              "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "STREAM_CONN_MS",  "4000",  "Relay connect timeout (ms)",           "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "STREAM_ANS_MS",   "5000",  "Relay answer timeout (ms)",            "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "STREAM_BEAT_MS",  "1000",  "Live view keep-alive (ms)",            "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "ANN_HEARTBEAT",   "600",   "Seconds between status lines",         "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "ANN_RETRY",       "30",    "Longest wait before reaching the relay again (s)", "Picture & live view", Tier::Advanced, Apply::Reboot },
    { "ANN_FIRST_S",     "2",     "First wait before reaching the relay again (s)",   "Picture & live view", Tier::Advanced, Apply::Reboot },
};
static const size_t PERSON_META_COUNT = sizeof(PERSON_META) / sizeof(PERSON_META[0]);

static const Schema PERSON_SCHEMA = {
    PERSON_KEYS,
    sizeof(PERSON_KEYS) / sizeof(PERSON_KEYS[0]),
    personRulesHold,
    PERSON_META,
    PERSON_META_COUNT
};

// The settings as the sketch uses them. The in-struct defaults mirror PERSON_META: they are what
// a PersonSettings built without loading (the glue tests' g_cfg) starts with, and loadPersonSettings
// overwrites every field from the store anyway.
struct PersonSettings {
    int personGpio = 13;
    float detectThreshold = 0.60f;
    float clearThreshold = 0.50f;
    int loopDelayMs = 10;
    int darkThreshold = 40;         // DARK_THRESH: brightness below this = dark; 0 = darkness check off
    int darkHysteresis = 5;         // DARK_HYST: brightness must rise this far above the threshold to count as light again
    uint32_t motionThreshold = 300; // MOTION_THRESH: 0 = motion check off
    uint32_t motionHoldSec = 10;
    person_scene::MotionArea motionArea;   // the part of the picture watched for motion; default = all of it
    uint32_t motionEmaLength = 0;   // frames the motion average spans; 0 = auto-calibration off
    uint32_t motionEmaPercent = person_scene::DEFAULT_MOTION_EMA_PERCENT;   // only read while the above is not 0
    double motionClipFactor = person_scene::DEFAULT_CLIP_FACTOR;   // MOTION_CLIP: one reading counts for at most this many times the threshold in force
    uint32_t scoreFreshMs = 1500;   // SCORE_FRESH_MS: an older score is not shown (the model is paused)
    bool camVflip = false;          // CAM_VFLIP
    bool camHmirror = false;        // CAM_HMIRROR

    std::vector<WifiNet> wifi;
    std::string serverHost;
    int httpPort = 0;
    std::string apiKey;
    std::string detectorId;
    int streamMaxFps = 10;
    int streamJpegQuality = 80;
    int streamWriteTimeoutSec = 3;
    uint32_t streamConnectTimeoutMs = 4000;   // STREAM_CONN_MS: opening the TCP connection
    uint32_t streamAnswerTimeoutMs = 5000;    // STREAM_ANS_MS: the relay's answer to the uplink request
    uint32_t streamHeartbeatMs = 1000;        // STREAM_BEAT_MS: the keep-alive while nobody watches
    uint32_t announceHeartbeatSec = 600;
    uint32_t announceRetrySec = 30;
    uint32_t announceFirstRetrySec = 2;       // ANN_FIRST_S: the first backoff wait (the later ones double, up to ANN_RETRY)
};

// The settings this board needs before it can ask the relay for the OTHERS
// (RemoteFill in settings_logic.h): how to join the network, where the relay is,
// the key it wants, and which board is asking. When one of these is missing the
// serial console is the only way in. Keep in sync with the schema above.
inline std::vector<std::string> personRemotePrerequisites() {
    static const char* const keys[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "DETECTOR_ID" };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// The settings the dashboard may NOT change (they stay serial-only): everything that connects the
// board to the relay, and the alarm pin. A wrong value in one of
// them would leave a board nobody can reach without a USB cable (or drive the wrong pin). What is left -
// the thresholds and the stream tuning - is what the dashboard's CALIBRATE page edits. Keep in sync
// with the schema above.
inline std::vector<std::string> personLockedKeys() {
    // F-21: SETUP_PASSWORD (the setup WiFi's master password) is serial-only / setup-form-only, like API_KEY: over
    // plain HTTP a man-in-the-middle could otherwise choose the password of the next setup session. SETUP_MODE is
    // NOT locked: switching it on from the dashboard is the point of the feature.
    static const char* const keys[] = { "PERSON_GPIO", "WIFI", "SERVER_HOST", "HTTP_PORT",
                                        "API_KEY", "DETECTOR_ID", "SETUP_PASSWORD" };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// Fills `out` from flash. false (with `err` naming the first problem) if any
// needed setting is missing or no longer valid — the caller must not run then.
inline bool loadPersonSettings(ISettingsStore& flash, PersonSettings& out, std::string& err) {
    DefaultingStore store(flash, PERSON_SCHEMA.meta, PERSON_SCHEMA.metaCount);   // what is stored, else the default
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
    s.darkHysteresis = static_cast<int>(storedInt(store, "DARK_HYST"));
    s.motionThreshold = static_cast<uint32_t>(storedInt(store, "MOTION_THRESH"));
    s.motionHoldSec = static_cast<uint32_t>(storedInt(store, "MOTION_HOLD_S"));
    s.motionArea = person_scene::MotionArea(static_cast<int>(storedInt(store, "MOTION_X0")),
                                            static_cast<int>(storedInt(store, "MOTION_Y0")),
                                            static_cast<int>(storedInt(store, "MOTION_X1")),
                                            static_cast<int>(storedInt(store, "MOTION_Y1")));
    s.motionEmaLength = static_cast<uint32_t>(storedInt(store, "MOTION_EMA_LEN"));
    if (s.motionEmaLength > 0) s.motionEmaPercent = static_cast<uint32_t>(storedInt(store, "MOTION_EMA_PCT"));   // not asked for while off
    double clip = person_scene::DEFAULT_CLIP_FACTOR;
    parseFloat(store.get("MOTION_CLIP"), clip);
    s.motionClipFactor = clip;
    s.scoreFreshMs = static_cast<uint32_t>(storedInt(store, "SCORE_FRESH_MS"));
    s.camVflip = store.get("CAM_VFLIP") == "1";
    s.camHmirror = store.get("CAM_HMIRROR") == "1";

    std::string wifiErr;
    parseWifiList(store.get("WIFI"), s.wifi, wifiErr);
    s.serverHost = store.get("SERVER_HOST");
    s.httpPort = static_cast<int>(storedInt(store, "HTTP_PORT"));
    s.apiKey = store.get("API_KEY");
    s.detectorId = store.get("DETECTOR_ID");
    s.streamMaxFps = static_cast<int>(storedInt(store, "STREAM_MAX_FPS"));
    s.streamJpegQuality = static_cast<int>(storedInt(store, "STREAM_JPEG_Q"));
    s.streamWriteTimeoutSec = static_cast<int>(storedInt(store, "STREAM_WR_TMO_S"));
    s.streamConnectTimeoutMs = static_cast<uint32_t>(storedInt(store, "STREAM_CONN_MS"));
    s.streamAnswerTimeoutMs = static_cast<uint32_t>(storedInt(store, "STREAM_ANS_MS"));
    s.streamHeartbeatMs = static_cast<uint32_t>(storedInt(store, "STREAM_BEAT_MS"));
    s.announceHeartbeatSec = static_cast<uint32_t>(storedInt(store, "ANN_HEARTBEAT"));
    s.announceRetrySec = static_cast<uint32_t>(storedInt(store, "ANN_RETRY"));
    s.announceFirstRetrySec = static_cast<uint32_t>(storedInt(store, "ANN_FIRST_S"));

    out = s;
    return true;
}

}  // namespace esp32cam_settings
