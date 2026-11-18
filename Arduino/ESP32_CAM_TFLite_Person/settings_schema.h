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
// The Hardware & internals keys (F-29 T5c: PIN_*, CAM_*, STK_*, SER_*, BOOT_FAIL_MS) are the board's
// pin map and the boot-time values of the camera driver, its two background tasks and the serial
// port. Every one is read once at boot, so a change takes effect at the next restart (Apply::Reboot,
// Expert tier in PERSON_META below), and every default is the value the sketch hard-coded before, so
// an updated board behaves exactly as it did. SER_BAUD and SER_RXBUF_B are special: the boot
// conversation itself needs the serial port, so the sketch reads them straight from flash before the
// settings engine runs (see earlySerialSetup in the .ino).
//
// What is NOT a setting — the developer switches T5c keeps compile-time, each with its reason (the
// same list is in docs/SETTINGS_KEYS.md):
//   TENSOR_ARENA_SIZE      sizes the arena the interpreter plans its tensors into; tied to the model
//                          compiled in below, so it changes only with a firmware build.
//   IMAGE_WIDTH/HEIGHT/CHANNELS, person_scene::FRAME_SIZE
//                          the model's input geometry; the model data and the scene sampler are
//                          compiled around them (a static_assert pins the two together).
//   MicroMutableOpResolver<5>
//                          the 5 sizes the static operator table: one slot per operator the compiled
//                          model uses.
//   TENSOR_ARENA_IN_PSRAM  a build switch (-DTENSOR_ARENA_IN_PSRAM=0) for WHERE the arena is
//                          allocated; at run time psramFound() already falls back to internal RAM,
//                          so there is nothing for a field setting to decide.
//   PRINT_DETECTION_SCORES, PRINT_STARTUP_INFO, PRINT_SCENE_READINGS
//                          serial-only debug verbosity, deliberately not per-board settings.
// See the top of the .ino.

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

    // ── Hardware & internals (F-29 T5c) ──────────────────────────────────
    // The AI-Thinker board's pin map and the boot-time values of the camera driver, the two
    // background tasks and the serial port. Each is read once at boot, so a change takes effect at
    // the next restart (Apply::Reboot, Expert tier in PERSON_META below), and each default is the
    // value this sketch hard-coded before it became a setting, so an updated board behaves exactly
    // as it did. A wrong pin map breaks the CAMERA — the board restarts, saying why in its log —
    // but not its relay link, so the dashboard can still repair it; that is why none of these are
    // locked. The pins are plain whole numbers (not the PERSON_GPIO kind) because they are the
    // board's wiring, not a choice among the pins a user may drive: any GPIO number, -1 = not wired.
    { "PIN_PWDN",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's PWDN (power down) line is wired to; the default is the AI-Thinker ESP32-CAM's wiring, so change this only for a rewired or a different board" },
    { "PIN_RESET",       Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's RESET line is wired to (-1 = not wired, as on the AI-Thinker ESP32-CAM)" },
    { "PIN_XCLK",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's XCLK (clock in) line is wired to" },
    { "PIN_SIOD",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's SIOD (I2C data) line is wired to" },
    { "PIN_SIOC",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's SIOC (I2C clock) line is wired to" },
    { "PIN_Y9",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y9 is wired to" },
    { "PIN_Y8",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y8 is wired to" },
    { "PIN_Y7",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y7 is wired to" },
    { "PIN_Y6",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y6 is wired to" },
    { "PIN_Y5",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y5 is wired to" },
    { "PIN_Y4",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y4 is wired to" },
    { "PIN_Y3",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y3 is wired to" },
    { "PIN_Y2",          Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's data line Y2 is wired to" },
    { "PIN_VSYNC",       Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's VSYNC line is wired to" },
    { "PIN_HREF",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's HREF line is wired to" },
    { "PIN_PCLK",        Kind::Int,       -1,   39,      Cond::Always,      nullptr,          nullptr,
      "camera pin: GPIO the sensor's PCLK (pixel clock) line is wired to" },
    { "CAM_XCLK_HZ",     Kind::Int,       2000000, 40000000, Cond::Always, nullptr,       nullptr,
      "the sensor's clock in Hz (20000000 is what the sketch always ran it at; lower it only if the camera misbehaves)" },
    { "CAM_FB_COUNT",    Kind::Int,       1,    4,       Cond::Always,      nullptr,          nullptr,
      "frames the camera driver keeps ready (2 is what the sketch always used: the newest finished frame is served while the next is captured)" },
    { "CAM_INIT_TRIES",  Kind::Int,       1,    10,      Cond::Always,      nullptr,          nullptr,
      "attempts to start the camera, each with a fresh power-cycle of the sensor, before the board restarts (3 is what the sketch always used)" },
    { "STK_LOG_B",       Kind::Int,       4096, 65536,   Cond::Always,      nullptr,          nullptr,
      "stack of the task that delivers the log to the relay, bytes (8192 is what the sketch always used; too small a stack can crash the board)" },
    { "STK_NET_B",       Kind::Int,       8192, 65536,   Cond::Always,      nullptr,          nullptr,
      "stack of the network task (live view, settings, firmware update), bytes (16384 is what the sketch always used; too small a stack can crash the board)" },
    { "SER_BAUD",        Kind::Int,       9600, 5000000, Cond::Always,      nullptr,          nullptr,
      "serial console speed in baud (115200 is what the sketch always used; a change takes effect at the next boot — open the terminal at the new speed then)" },
    { "SER_RXBUF_B",     Kind::Int,       256,  65536,   Cond::Always,      nullptr,          nullptr,
      "serial receive buffer in bytes, big enough for a pasted settings line (2048 is what the sketch always used)" },
    { "BOOT_FAIL_MS",    Kind::Int,       1000, 3600000, Cond::Always,      nullptr,          nullptr,
      "when the camera or the model cannot start, the board waits this long — its log goes to the relay first — and restarts (30000 is what the sketch always used)" },
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
// Categories follow the Atlas design's detector page: Detection, Picture & live view, Hardware & internals
// (Connection - the detector's share, Wi-Fi sleep and HTTP timeouts - arrives with T5b).
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

    // The Hardware & internals group, F-29 T5c. A setting with a default is no longer asked for on a
    // blank board: it simply uses that value, which is what the sketch did before the value became a
    // setting, until somebody changes it. Every row is Expert tier and Apply::Reboot: the values are
    // read once at boot. The network, logging, update and setup rows are T5b's: they land in this
    // table as that task is done.
    { "PIN_PWDN",       "32",       "Camera pin: PWDN",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_RESET",      "-1",       "Camera pin: RESET",                     "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_XCLK",       "0",        "Camera pin: XCLK",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_SIOD",       "26",       "Camera pin: SIOD",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_SIOC",       "27",       "Camera pin: SIOC",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y9",         "35",       "Camera pin: Y9",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y8",         "34",       "Camera pin: Y8",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y7",         "39",       "Camera pin: Y7",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y6",         "36",       "Camera pin: Y6",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y5",         "21",       "Camera pin: Y5",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y4",         "19",       "Camera pin: Y4",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y3",         "18",       "Camera pin: Y3",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_Y2",         "5",        "Camera pin: Y2",                        "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_VSYNC",      "25",       "Camera pin: VSYNC",                     "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_HREF",       "23",       "Camera pin: HREF",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "PIN_PCLK",       "22",       "Camera pin: PCLK",                      "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "CAM_XCLK_HZ",    "20000000", "Camera clock (Hz)",                     "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "CAM_FB_COUNT",   "2",        "Camera frame buffers",                  "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "CAM_INIT_TRIES", "3",        "Camera start attempts",                 "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "STK_LOG_B",      "8192",     "Log task stack (bytes)",                "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "STK_NET_B",      "16384",    "Network task stack (bytes)",            "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "SER_BAUD",       "115200",   "Serial speed (baud)",                   "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "SER_RXBUF_B",    "2048",     "Serial receive buffer (bytes)",         "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "BOOT_FAIL_MS",   "30000",    "Restart after a failed start (ms)",     "Hardware & internals", Tier::Expert, Apply::Reboot },
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

    // Hardware & internals (F-29 T5c): the pin map and the boot-time values of the camera driver, the
    // two background tasks and the restart after a failed start. Each is read once at boot, so a
    // changed value needs a restart (Apply::Reboot); every default is the old hard-coded value. The
    // serial port's two settings (SER_BAUD, SER_RXBUF_B) are NOT here: the boot conversation needs
    // the port before the settings engine runs, so the sketch reads them straight from flash
    // (earlySerialSetup in the .ino).
    int pinPwdn = 32;             // PIN_PWDN
    int pinReset = -1;            // PIN_RESET (-1: the board has no reset line)
    int pinXclk = 0;              // PIN_XCLK
    int pinSiod = 26;             // PIN_SIOD
    int pinSioc = 27;             // PIN_SIOC
    int pinY9 = 35;               // PIN_Y9
    int pinY8 = 34;               // PIN_Y8
    int pinY7 = 39;               // PIN_Y7
    int pinY6 = 36;               // PIN_Y6
    int pinY5 = 21;               // PIN_Y5
    int pinY4 = 19;               // PIN_Y4
    int pinY3 = 18;               // PIN_Y3
    int pinY2 = 5;                // PIN_Y2
    int pinVsync = 25;            // PIN_VSYNC
    int pinHref = 23;             // PIN_HREF
    int pinPclk = 22;             // PIN_PCLK
    int camXclkHz = 20000000;     // CAM_XCLK_HZ
    int camFbCount = 2;           // CAM_FB_COUNT
    int camInitTries = 3;         // CAM_INIT_TRIES
    uint32_t stkLogBytes = 8192;   // STK_LOG_B
    uint32_t stkNetBytes = 16384;  // STK_NET_B
    uint32_t bootFailRestartMs = 30000;   // BOOT_FAIL_MS
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

    // Hardware & internals (F-29 T5c): stored values, else the defaults the sketch always used.
    s.pinPwdn = static_cast<int>(storedInt(store, "PIN_PWDN"));
    s.pinReset = static_cast<int>(storedInt(store, "PIN_RESET"));
    s.pinXclk = static_cast<int>(storedInt(store, "PIN_XCLK"));
    s.pinSiod = static_cast<int>(storedInt(store, "PIN_SIOD"));
    s.pinSioc = static_cast<int>(storedInt(store, "PIN_SIOC"));
    s.pinY9 = static_cast<int>(storedInt(store, "PIN_Y9"));
    s.pinY8 = static_cast<int>(storedInt(store, "PIN_Y8"));
    s.pinY7 = static_cast<int>(storedInt(store, "PIN_Y7"));
    s.pinY6 = static_cast<int>(storedInt(store, "PIN_Y6"));
    s.pinY5 = static_cast<int>(storedInt(store, "PIN_Y5"));
    s.pinY4 = static_cast<int>(storedInt(store, "PIN_Y4"));
    s.pinY3 = static_cast<int>(storedInt(store, "PIN_Y3"));
    s.pinY2 = static_cast<int>(storedInt(store, "PIN_Y2"));
    s.pinVsync = static_cast<int>(storedInt(store, "PIN_VSYNC"));
    s.pinHref = static_cast<int>(storedInt(store, "PIN_HREF"));
    s.pinPclk = static_cast<int>(storedInt(store, "PIN_PCLK"));
    s.camXclkHz = static_cast<int>(storedInt(store, "CAM_XCLK_HZ"));
    s.camFbCount = static_cast<int>(storedInt(store, "CAM_FB_COUNT"));
    s.camInitTries = static_cast<int>(storedInt(store, "CAM_INIT_TRIES"));
    s.stkLogBytes = static_cast<uint32_t>(storedInt(store, "STK_LOG_B"));
    s.stkNetBytes = static_cast<uint32_t>(storedInt(store, "STK_NET_B"));
    s.bootFailRestartMs = static_cast<uint32_t>(storedInt(store, "BOOT_FAIL_MS"));

    out = s;
    return true;
}

}  // namespace esp32cam_settings
