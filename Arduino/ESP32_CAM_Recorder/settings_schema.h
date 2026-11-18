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
// A setting listed "only needed when X" is skipped while X switches its feature off. Settings that used to be
// fixed in the code have a default (RECORDER_META below): a board that has none stored uses it.
//
// The Hardware & internals keys (F-29 T3: PIN_*, CAM_*, STK_*, SER_*) and the log delivery period (LOG_PUMP_MS)
// are the board's pin map and the boot-time values of the camera driver, its two background tasks and the serial
// port. Every one is read once at boot, so a change takes effect at the next restart (Apply::Reboot, Expert tier
// in RECORDER_META below), and every default is the value the sketch hard-coded before, so an updated board
// behaves exactly as it did. SER_BAUD and SER_RXBUF_B are special: the boot conversation itself needs the serial
// port, so the sketch reads them straight from flash before the settings engine runs (earlySerialSetup in the
// .ino). The same keys exist, with the same labels, ranges and defaults, on the detector (T5c).
//
// What is NOT a setting — what T3 keeps compile-time, each with its reason (the same list is in
// docs/SETTINGS_KEYS.md):
//   LOG_MSG_MAX, LOG_TRACE_MAX, LOG_QUEUE_CAPACITY, LOG_BATCH_MAX, LOG_BREADCRUMBS, LOG_BREADCRUMB_TEXT,
//   LOG_SITE_MAX (remote_log.h)
//                          each sizes a static array of the log queue (RAM is tight: the whole queue is one fixed
//                          block, no heap churn), so no run-time value can resize it.
//   serialOnlyLogConfig()  what the log object holds BEFORE the settings are read: there is nothing to read yet.
//                          The real values are the LOG_* keys, applied by remoteLogStart().
//   SETTINGS_NAMESPACE     the NVS namespace ("espcam") every deployed board already holds its settings under;
//                          changing it would orphan them. It cannot live in the settings it names.
//   NVS_KEY_MAX_LENGTH, WPA2_PASS_MIN/MAX, SSID_MAX
//                          limits of the flash (15 characters per key) and of the Wi-Fi standard (8-63 character
//                          passphrase, 32 byte SSID): facts of the protocol, not choices.
//   LEDC_CHANNEL_0/LEDC_TIMER_0, PIXFORMAT_JPEG, CAMERA_GRAB_WHEN_EMPTY, CAMERA_FB_IN_PSRAM/_DRAM
//                          how the sketch drives the camera driver: the stream, the JPEG adapter and the frame-size
//                          ladder are built around them, and the PSRAM/DRAM choice follows from psramFound().
//   the first frame size (VGA with PSRAM, QVGA without)
//                          decided by psramFound() (the memory that exists), not by a preference; the frame-size
//                          ladder (a static table) and SIZE_DROP take it from there.
//   delay(200) after Serial.begin, the 250 ms/500 ms restart and relay-wait pauses, the 10 s identity line
//                          the timing of the start-up mechanism and the cadence of one serial line, not
//                          tuning knobs of a deployment.

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

    // The weak-link JPEG quality adapter (adaptJpegQuality in logic.h). LOWER
    // number = finer picture, bigger file (the OV2640's own scale, 0-63). The
    // three together let the dashboard tune how far the picture coarsens on a
    // slow link, or switch the adaptation off entirely (a fixed quality).
    { "JPEG_Q_DROP",     Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: on a slow link shrink the JPEG quality toward the coarsest and bring it back when it recovers; 0: hold the fixed quality whatever the link" },
    { "JPEG_Q_MIN",      Kind::Int,       1,    63,      Cond::WhenEquals,    "JPEG_Q_DROP",    "1",
      "the best quality (lowest number): what the camera sends on a good link. Lower = finer picture, bigger file. 12 is a good start" },
    { "JPEG_Q_MAX",      Kind::Int,       1,    63,      Cond::WhenEquals,    "JPEG_Q_DROP",    "1",
      "the coarsest quality (highest number) the adapter drops to on a slow link; 63 is the OV2640's ceiling. Not lower than JPEG_Q_MIN" },
    { "SIZE_DROP",       Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: when even the coarsest quality cannot get a frame through, also drop the resolution a step (down to QQVGA 160x120) and climb back when the link recovers; 0: never change the resolution" },

    // The pacing of the push and the two adapters (JPEG quality, frame size). They were fixed in the sketch;
    // the defaults are those values. Times are milliseconds.
    { "PUSH_WR_TMO_MS",  Kind::Int,       1000, 60000,   Cond::Always,        nullptr,           nullptr,
      "give up on a push that makes no progress for this long (ms). Keep it LONGER than the relay's live window (LIVE_WINDOW_MS)" },
    { "PUSH_SLOW_MS",    Kind::Int,       100,  60000,   Cond::Always,        nullptr,           nullptr,
      "a frame that takes longer than this to push (ms) is slow: warn, and start making the frames smaller" },
    { "PUSH_FAST_MS",    Kind::Int,       50,   60000,   Cond::Always,        nullptr,           nullptr,
      "pushes faster than this (ms), for a while, let the picture improve again. Below PUSH_SLOW_MS" },
    { "PUSH_MAX_GAP_MS", Kind::Int,       0,    60000,   Cond::Always,        nullptr,           nullptr,
      "the pause after a push never exceeds this (ms), however slow the push was" },
    { "Q_DEGRADE_STEP",  Kind::Int,       1,    62,      Cond::WhenEquals,    "JPEG_Q_DROP",    "1",
      "how many quality numbers coarser per slow frame (twice as many when very slow)" },
    { "Q_RECOVER_STEP",  Kind::Int,       1,    62,      Cond::WhenEquals,    "JPEG_Q_DROP",    "1",
      "how many quality numbers finer after a run of fast frames" },
    { "Q_FAST_STREAK",   Kind::Int,       1,    1000,    Cond::WhenEquals,    "JPEG_Q_DROP",    "1",
      "fast frames in a row before the picture improves a step" },
    { "Q_VSLOW_FACTOR",  Kind::Int,       2,    100,     Cond::Always,        nullptr,           nullptr,
      "a push this many times slower than PUSH_SLOW_MS counts as very slow (and a frame size is dropped)" },
    { "SIZE_UP_STREAK",  Kind::Int,       1,    1000,    Cond::WhenEquals,    "SIZE_DROP",      "1",
      "fast pushes in a row before the frame size goes up a step again" },
    { "WIFI_REPORT_MS",  Kind::Int,       200,  3600000, Cond::Always,        nullptr,           nullptr,
      "how often the camera tells the relay its Wi-Fi network and signal (ms)" },
    { "HTTP_TMO_MS",     Kind::Int,       500,  60000,   Cond::Always,        nullptr,           nullptr,
      "how long a plain HTTP call to the relay (log, settings) may take (ms)" },
    { "RELAY_DOWN_MS",   Kind::Int,       5000, 3600000, Cond::Always,        nullptr,           nullptr,
      "the push connection has been down this long (ms): look for the relay on the network again" },
    { "CAM_VFLIP",       Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: flip the picture upside down (with CAM_HMIRROR 1 = turned 180 degrees). Set the detector the same" },
    { "CAM_HMIRROR",     Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: mirror the picture left to right. Set the detector the same" },
    { "WIFI_SLEEP",      Kind::Bool,      0,    0,       Cond::Always,        nullptr,           nullptr,
      "1: let the Wi-Fi modem sleep (saves power, adds latency); 0: stay awake" },

    { "ALARM_GPIO_PIN",  Kind::PinOrOff,  0,    0,       Cond::Always,        nullptr,           nullptr,
      "GPIO the alarm input is wired to; -1 turns the alarm feature off" },
    { "ALARM_ACTIVE",    Kind::Level,     0,    0,       Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "pin level that means alarm (LOW with a button to GND)" },
    { "ALARM_ALL_CAMS",  Kind::Bool,      0,    0,       Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "1: an alarm starts recording on every camera; 0: only this one" },
    { "ALARM_DEBOUNCE",  Kind::Int,       0,    5000,    Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "ignore further edges of the alarm input for this long after one (ms): contact bounce" },
    { "ALARM_HOLD_MS",   Kind::Int,       100,  60000,   Cond::WhenNotEquals, "ALARM_GPIO_PIN",  "-1",
      "while the alarm line stays active the alarm is sent again this often (ms). Must stay below the relay's alarmRecordSeconds" },

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
    // F-21, the cable-free first setup (see the setup mode of the sketch). Both settings are OPTIONAL: a board
    // that has neither is still complete, so boards deployed before this feature keep working untouched.
    { "SETUP_MODE",      Kind::Bool,      0,    0,       Cond::Optional,      nullptr,           nullptr,
      "1 = at the next restart this board opens its own setup WiFi and waits there, not working normally, until it is configured or exited; it switches itself off after use (absent or 0 = off)" },
    { "SETUP_PASSWORD",  Kind::Secret,    8,    63,      Cond::Optional,      nullptr,           nullptr,
      "master password of the setup WiFi, the same on every board (8 to 63 characters); until it is set a built-in default is used, which the setup form makes you replace" },

    // ── Hardware & internals (F-29 T3) ───────────────────────────────────
    // The AI-Thinker board's pin map and the boot-time values of the camera driver, the two background
    // tasks and the serial port. Each is read once at boot, so a change takes effect at the next restart
    // (Apply::Reboot, Expert tier in RECORDER_META below), and each default is the value this sketch
    // hard-coded before it became a setting, so an updated board behaves exactly as it did. A wrong pin
    // map breaks the CAMERA — initCamera() fails and says why in the log — but not the board's relay link,
    // so the dashboard can still repair it; that is why none of these are locked. The pins are plain whole
    // numbers (not the ALARM_GPIO_PIN kind) because they are the board's wiring, not a choice among the
    // pins a user may drive: any GPIO number, -1 = not wired. Same keys, labels and ranges as the detector's.
    { "PIN_PWDN",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's PWDN (power down) line is wired to; the default is the AI-Thinker ESP32-CAM's wiring, so change this only for a rewired or a different board" },
    { "PIN_RESET",      Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's RESET line is wired to (-1 = not wired, as on the AI-Thinker ESP32-CAM)" },
    { "PIN_XCLK",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's XCLK (clock in) line is wired to" },
    { "PIN_SIOD",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's SIOD (I2C data) line is wired to" },
    { "PIN_SIOC",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's SIOC (I2C clock) line is wired to" },
    { "PIN_Y9",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y9 is wired to" },
    { "PIN_Y8",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y8 is wired to" },
    { "PIN_Y7",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y7 is wired to" },
    { "PIN_Y6",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y6 is wired to" },
    { "PIN_Y5",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y5 is wired to" },
    { "PIN_Y4",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y4 is wired to" },
    { "PIN_Y3",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y3 is wired to" },
    { "PIN_Y2",         Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's data line Y2 is wired to" },
    { "PIN_VSYNC",      Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's VSYNC line is wired to" },
    { "PIN_HREF",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's HREF line is wired to" },
    { "PIN_PCLK",       Kind::Int,       -1,   39,      Cond::Always,        nullptr,           nullptr,
      "camera pin: GPIO the sensor's PCLK (pixel clock) line is wired to" },
    { "CAM_XCLK_HZ",     Kind::Int,       2000000, 40000000, Cond::Always,   nullptr,           nullptr,
      "the sensor's clock in Hz (20000000 is what the sketch always ran it at; lower it only if the camera misbehaves)" },
    { "CAM_FB_COUNT",    Kind::Int,       1,    4,       Cond::Always,        nullptr,           nullptr,
      "frames the camera driver keeps ready on a board with PSRAM (2 is what the sketch always used: the newest finished frame is served while the next is captured). A board without PSRAM always uses 1" },
    { "STK_LOG_B",       Kind::Int,       4096, 65536,   Cond::Always,        nullptr,           nullptr,
      "stack of the task that delivers the log to the relay, bytes (8192 is what the sketch always used; too small a stack can crash the board)" },
    { "STK_OTA_B",       Kind::Int,       8192, 65536,   Cond::Always,        nullptr,           nullptr,
      "stack of the update task (firmware update, settings from the relay, relay search), bytes (10240 is what the sketch always used; too small a stack can crash the board)" },
    { "SER_BAUD",        Kind::Int,       9600, 5000000, Cond::Always,        nullptr,           nullptr,
      "serial console speed in baud (115200 is what the sketch always used; a change takes effect at the next boot — open the terminal at the new speed then)" },
    { "SER_RXBUF_B",     Kind::Int,       256,  65536,   Cond::Always,        nullptr,           nullptr,
      "serial receive buffer in bytes, big enough for a pasted settings line (2048 is what the sketch always used)" },
    { "LOG_PUMP_MS",     Kind::Int,       50,   10000,   Cond::WhenEquals,    "LOG_ENABLED",     "1",
      "how often the log task looks whether entries are due for delivery, in ms (250 is what the sketch always used; it does not change when entries are sent, only how promptly the task notices)" },
};

// The readable name, group and fallback of each setting (see KeyMeta in settings_logic.h). A setting with a
// default is no longer asked for on a blank board: it simply uses that value, which is what the sketch used
// before the value became a setting, until somebody changes it. The settings that say WHERE and WHO this board
// is (WIFI, SERVER_HOST, ports, CAMERA_ID, API_KEY), the safety switches (ALARM_GPIO_PIN, LOG_ENABLED) and what
// depends on how the sensor is wired (ALARM_ACTIVE, ALARM_ALL_CAMS) have no default and stay required.
static const KeyMeta RECORDER_META[] = {
    // name             default  label                                   category          tier          apply
    { "PUSH_GAP_MUL",   "1.5",   "Pause after each frame (x last push)", "Picture & link", Tier::Basic,    Apply::Live },
    { "JPEG_Q_DROP",    "1",     "Lower quality on a slow link",         "Picture & link", Tier::Basic,    Apply::Live },
    { "JPEG_Q_MIN",     "12",    "Best JPEG quality",                    "Picture & link", Tier::Basic,    Apply::Live },
    { "JPEG_Q_MAX",     "63",    "Coarsest JPEG quality",                "Picture & link", Tier::Basic,    Apply::Live },
    { "SIZE_DROP",      "1",     "Also shrink the frame size",           "Picture & link", Tier::Basic,    Apply::Live },
    { "ALARM_ACTIVE",   nullptr,   "Pin level that means alarm",           "Alarm input",    Tier::Basic,    Apply::Reboot },
    { "ALARM_ALL_CAMS", nullptr, "Alarm records on every camera",        "Alarm input",    Tier::Basic,    Apply::Reboot },
    { "LOG_MIN_LEVEL",  "1",     "Lowest level sent to the relay",       "Logging",        Tier::Basic,    Apply::Live },
    { "LOG_ECHO",       "1",     "Show everything on serial",            "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_RETRY_MAX",  "3",     "Retries after a failed delivery",      "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_RETRY_SEC",  "300",   "Seconds between retries",              "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_FLUSH_SEC",  "10",    "Seconds routine entries wait",         "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_REPEAT_SEC", "30",    "Window for counting repeats",          "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_HEARTBEAT",  "600",   "Seconds between status lines",         "Logging",        Tier::Advanced, Apply::Live },
    { "LOG_LOW_HEAP",   "30000", "Warn below this free heap (bytes)",    "Logging",        Tier::Advanced, Apply::Live },
    { "PUSH_WR_TMO_MS", "8000",  "Push write timeout (ms)",              "Picture & link", Tier::Advanced, Apply::Reboot },
    { "PUSH_SLOW_MS",   "2000",  "Slow push (ms)",                       "Picture & link", Tier::Advanced, Apply::Reboot },
    { "PUSH_FAST_MS",   "600",   "Fast push (ms)",                       "Picture & link", Tier::Advanced, Apply::Reboot },
    { "PUSH_MAX_GAP_MS","1000",  "Longest pause after a push (ms)",      "Picture & link", Tier::Advanced, Apply::Reboot },
    { "Q_DEGRADE_STEP", "6",     "Quality steps coarser per slow frame", "Picture & link", Tier::Expert,   Apply::Reboot },
    { "Q_RECOVER_STEP", "2",     "Quality steps finer per fast run",     "Picture & link", Tier::Expert,   Apply::Reboot },
    { "Q_FAST_STREAK",  "5",     "Fast frames before the picture improves", "Picture & link", Tier::Expert, Apply::Reboot },
    { "Q_VSLOW_FACTOR", "4",     "Very slow = this many times slow",     "Picture & link", Tier::Expert,   Apply::Reboot },
    { "SIZE_UP_STREAK", "10",    "Fast pushes before the size goes up",  "Picture & link", Tier::Expert,   Apply::Reboot },
    { "WIFI_REPORT_MS", "1000",  "Wi-Fi report interval (ms)",           "Connection",     Tier::Advanced, Apply::Reboot },
    { "HTTP_TMO_MS",    "5000",  "HTTP call timeout (ms)",               "Connection",     Tier::Advanced, Apply::Reboot },
    { "RELAY_DOWN_MS",  "30000", "Relay considered gone after (ms)",     "Connection",     Tier::Advanced, Apply::Reboot },
    { "CAM_VFLIP",      "0",     "Flip the picture upside down",         "Picture & link", Tier::Basic,    Apply::Reboot },
    { "CAM_HMIRROR",    "0",     "Mirror the picture",                   "Picture & link", Tier::Basic,    Apply::Reboot },
    { "WIFI_SLEEP",     "0",     "Let the Wi-Fi modem sleep",            "Connection",     Tier::Advanced, Apply::Reboot },
    { "ALARM_DEBOUNCE", "50",    "Alarm contact debounce (ms)",          "Alarm input",    Tier::Advanced, Apply::Reboot },
    { "ALARM_HOLD_MS",  "1000",  "Alarm repeat while active (ms)",       "Alarm input",    Tier::Advanced, Apply::Reboot },

    // The Hardware & internals group (and the log delivery period), F-29 T3. A setting with a default is no
    // longer asked for on a blank board: it simply uses that value, which is what the sketch did before the
    // value became a setting, until somebody changes it. Every row is Expert tier and Apply::Reboot: the
    // values are read once at boot.
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
    { "STK_LOG_B",      "8192",     "Log task stack (bytes)",                "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "STK_OTA_B",      "10240",    "Update task stack (bytes)",             "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "SER_BAUD",       "115200",   "Serial speed (baud)",                   "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "SER_RXBUF_B",    "2048",     "Serial receive buffer (bytes)",         "Hardware & internals", Tier::Expert, Apply::Reboot },
    { "LOG_PUMP_MS",    "250",      "Log delivery check interval (ms)",      "Logging", Tier::Expert, Apply::Reboot },
};
static const size_t RECORDER_META_COUNT = sizeof(RECORDER_META) / sizeof(RECORDER_META[0]);

// JPEG_Q_MIN (the finest quality) must not be above JPEG_Q_MAX (the coarsest):
// the adapter walks best -> worst, so an inverted range would mean "the finest
// the camera ever sends is coarser than the coarsest it drops to", which both
// makes no sense and would stop the adapter dead (it could never move off best
// because best already exceeds worst). Refused, like the detector's threshold
// pair, only once both are known numbers (a missing or malformed one is reported
// on its own). Send both in one line to swap them.
inline bool jpegQualityRangeHolds(const IValues& v, std::string& err) {
    std::string smin, smax;
    if (!v.get("JPEG_Q_MIN", smin) || !v.get("JPEG_Q_MAX", smax)) return true;   // not both known yet
    long long lo = 0, hi = 0;
    if (!parseInt(smin, lo) || !parseInt(smax, hi)) return true;                 // reported on their own
    if (lo > hi) {
        err = "JPEG_Q_MIN (" + smin + ") must not be higher than JPEG_Q_MAX (" + smax +
              ") - send both in one line to change them together";
        return false;
    }
    return true;
}

// PUSH_FAST_MS must be below PUSH_SLOW_MS: between them the quality holds, and a fast threshold at or above the
// slow one would leave no "hold" zone, so the picture would flip between coarser and finer on every frame.
inline bool pushSpeedRangeHolds(const IValues& v, std::string& err) {
    std::string sfast, sslow;
    if (!v.get("PUSH_FAST_MS", sfast) || !v.get("PUSH_SLOW_MS", sslow)) return true;
    long long fast = 0, slow = 0;
    if (!parseInt(sfast, fast) || !parseInt(sslow, slow)) return true;
    if (fast >= slow) {
        err = "PUSH_FAST_MS (" + sfast + ") must be below PUSH_SLOW_MS (" + sslow +
              ") - send both in one line to change them together";
        return false;
    }
    return true;
}

// Every rule over several settings of the Recorder, in turn; the first that fails refuses the line.
inline bool recorderRulesHold(const IValues& v, std::string& err) {
    return jpegQualityRangeHolds(v, err) && pushSpeedRangeHolds(v, err);
}

static const Schema RECORDER_SCHEMA = {
    RECORDER_KEYS,
    sizeof(RECORDER_KEYS) / sizeof(RECORDER_KEYS[0]),
    recorderRulesHold,  // JPEG_Q_MIN <= JPEG_Q_MAX and PUSH_FAST_MS < PUSH_SLOW_MS (numbers first)
    RECORDER_META,
    RECORDER_META_COUNT
};

// The settings as the sketch uses them. Values of settings that are "not
// needed" (alarm off, remote log off, quality drop off) hold the neutral
// values below — the sketch still reads some of them (the heartbeat timer, the
// low-heap warning) even with remote logging off.
struct RecorderSettings {
    std::vector<WifiNet> wifi;
    std::string serverHost;
    int pushPort = 0;
    int httpPort = 0;
    std::string cameraId;
    std::string apiKey;
    float pushGapMul = 1.5f;

    bool jpegQualityDrop = true;   // JPEG_Q_DROP: the quality adapter runs
    int jpegQualityMin = 12;       // JPEG_Q_MIN: best (finest) quality
    int jpegQualityMax = 63;       // JPEG_Q_MAX: worst (coarsest) quality
    bool frameSizeDrop = true;     // SIZE_DROP: the frame-size ladder runs

    int alarmGpioPin = -1;            // -1: alarm feature off
    bool alarmActiveHigh = false;     // false: the pin is LOW when the alarm is on
    bool alarmRecordAll = false;
    uint32_t alarmDebounceMs = 50;
    uint32_t alarmHoldMs = 1000;

    uint32_t pushWriteTimeoutMs = 8000;
    uint32_t pushSlowMs = 2000;
    uint32_t pushFastMs = 600;
    uint32_t pushMaxGapMs = 1000;
    int qualityDegradeStep = 6;
    int qualityRecoverStep = 2;
    int qualityFastStreak = 5;
    uint32_t qualityVerySlowFactor = 4;
    int sizeUpStreak = 10;
    uint32_t wifiReportMs = 1000;
    uint32_t httpTimeoutMs = 5000;
    uint32_t relayDownMs = 30000;
    bool camVflip = false;
    bool camHmirror = false;
    bool wifiSleep = false;

    bool logEnabled = false;
    int logMinLevel = 1;
    bool logEcho = true;
    int logRetryMax = 3;
    uint32_t logRetrySec = 300;
    uint32_t logFlushSec = 10;
    uint32_t logRepeatSec = 30;
    uint32_t logHeartbeatSec = 600;
    uint32_t logLowHeapBytes = 30000;
    uint32_t logPumpMs = 250;        // LOG_PUMP_MS: how often the log task looks for entries due

    // Hardware & internals (F-29 T3): the pin map and the boot-time values of the camera driver and the two
    // background tasks. Each is read once at boot, so a changed value needs a restart (Apply::Reboot);
    // every default is the old hard-coded value. The serial port's two settings (SER_BAUD, SER_RXBUF_B) are
    // NOT here: the boot conversation needs the port before the settings engine runs, so the sketch reads
    // them straight from flash (earlySerialSetup in the .ino).
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
    int camFbCount = 2;           // CAM_FB_COUNT (a board with PSRAM; without it the sketch uses 1)
    uint32_t stkLogBytes = 8192;   // STK_LOG_B
    uint32_t stkOtaBytes = 10240;  // STK_OTA_B
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
// USB cable, so these stay serial-only.
//
// (review ARD-009) the alarm GPIOs, the alarm-level, the all-cams flag and the
// remote-log enable switch are ALSO serial-only. Over plain HTTP a MITM could
// otherwise set ALARM_GPIO_PIN=-1 (silently disable the alarm feature), flip
// ALARM_ACTIVE (invert the alarm so line noise fires constantly), set
// ALARM_ALL_CAMS=1 (every alarm from this camera triggers recording on every
// camera, exhausting relay disk), or set LOG_ENABLED=0 (silence the remote
// log so the operator never sees the manipulation). All of these change the
// safety/operational posture of the board, not just its tuning, so they
// belong next to the network-and-identity locked set.
// Keep in sync with the schema above.
inline std::vector<std::string> recorderLockedKeys() {
    static const char* const keys[] = {
        "WIFI", "SERVER_HOST", "PUSH_PORT", "HTTP_PORT", "CAMERA_ID", "API_KEY",
        // F-21: the setup WiFi's master password is changed in the setup form or over the serial port only. If the
        // dashboard could set it (plain HTTP), a man-in-the-middle could choose the password of the next setup
        // session. SETUP_MODE itself is NOT locked: switching it on from the dashboard is the point of the feature.
        "SETUP_PASSWORD",
        // Operational safety: see comment above (review ARD-009)
        "ALARM_GPIO_PIN", "ALARM_ACTIVE", "ALARM_ALL_CAMS",
        "LOG_ENABLED",
    };
    return std::vector<std::string>(keys, keys + sizeof(keys) / sizeof(keys[0]));
}

// Fills `out` from flash. false (with `err` naming the first problem) if any
// needed setting is missing or no longer valid — the caller must not run then.
inline bool loadRecorderSettings(ISettingsStore& flash, RecorderSettings& out, std::string& err) {
    DefaultingStore store(flash, RECORDER_SCHEMA.meta, RECORDER_SCHEMA.metaCount);   // what is stored, else the default
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

    s.pushWriteTimeoutMs = static_cast<uint32_t>(storedInt(store, "PUSH_WR_TMO_MS"));
    s.pushSlowMs = static_cast<uint32_t>(storedInt(store, "PUSH_SLOW_MS"));
    s.pushFastMs = static_cast<uint32_t>(storedInt(store, "PUSH_FAST_MS"));
    s.pushMaxGapMs = static_cast<uint32_t>(storedInt(store, "PUSH_MAX_GAP_MS"));
    s.qualityVerySlowFactor = static_cast<uint32_t>(storedInt(store, "Q_VSLOW_FACTOR"));
    s.wifiReportMs = static_cast<uint32_t>(storedInt(store, "WIFI_REPORT_MS"));
    s.httpTimeoutMs = static_cast<uint32_t>(storedInt(store, "HTTP_TMO_MS"));
    s.relayDownMs = static_cast<uint32_t>(storedInt(store, "RELAY_DOWN_MS"));
    s.camVflip = store.get("CAM_VFLIP") == "1";
    s.camHmirror = store.get("CAM_HMIRROR") == "1";
    s.wifiSleep = store.get("WIFI_SLEEP") == "1";

    s.jpegQualityDrop = store.get("JPEG_Q_DROP") == "1";
    s.frameSizeDrop = store.get("SIZE_DROP") == "1";
    if (s.jpegQualityDrop) {
        s.jpegQualityMin = static_cast<int>(storedInt(store, "JPEG_Q_MIN"));
        s.jpegQualityMax = static_cast<int>(storedInt(store, "JPEG_Q_MAX"));
        s.qualityDegradeStep = static_cast<int>(storedInt(store, "Q_DEGRADE_STEP"));
        s.qualityRecoverStep = static_cast<int>(storedInt(store, "Q_RECOVER_STEP"));
        s.qualityFastStreak = static_cast<int>(storedInt(store, "Q_FAST_STREAK"));
    }
    if (s.frameSizeDrop) s.sizeUpStreak = static_cast<int>(storedInt(store, "SIZE_UP_STREAK"));

    s.alarmGpioPin = static_cast<int>(storedInt(store, "ALARM_GPIO_PIN"));
    if (s.alarmGpioPin >= 0) {
        s.alarmActiveHigh = store.get("ALARM_ACTIVE") == "HIGH";
        s.alarmRecordAll = store.get("ALARM_ALL_CAMS") == "1";
        s.alarmDebounceMs = static_cast<uint32_t>(storedInt(store, "ALARM_DEBOUNCE"));
        s.alarmHoldMs = static_cast<uint32_t>(storedInt(store, "ALARM_HOLD_MS"));
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
        s.logPumpMs = static_cast<uint32_t>(storedInt(store, "LOG_PUMP_MS"));
    }

    // Hardware & internals (F-29 T3): stored values, else the defaults the sketch always used.
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
    s.stkLogBytes = static_cast<uint32_t>(storedInt(store, "STK_LOG_B"));
    s.stkOtaBytes = static_cast<uint32_t>(storedInt(store, "STK_OTA_B"));

    out = s;
    return true;
}

}  // namespace esp32cam_settings
