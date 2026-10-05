// example.config.h — template. Copy this file to config.h, in this same
// sketch folder, and fill in your real values. config.h is gitignored, so
// your Wi-Fi passwords and API key never get committed.
//
//   cp example.config.h config.h

struct WifiNetwork { const char* ssid; const char* password; };

// List every extender's network here. The camera connects to whichever has
// the strongest signal and automatically fails over if one drops — so you
// don't need to know in advance which extender a given camera is "closest" to.
WifiNetwork WIFI_NETWORKS[] = {
  { "extender-1-ssid", "extender-1-password" },
  { "extender-2-ssid", "extender-2-password" },
  { "extender-3-ssid", "extender-3-password" },
};
const int WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

const char* SERVER_HOST   = "192.168.4.9";     // your Pi's IP or hostname
const int   PUSH_PORT     = 8081;              // relay's raw push port — must match pushPort in server's config.js
const int   HTTP_PORT     = 8080;              // relay's HTTP port — must match port in server's config.js;
                                                // used for the alarm-trigger recording call below
const char* CAMERA_ID     = "cam2";            // MUST be unique per camera — must match its id in config.php
const char* API_KEY       = "change-me";       // must match camKey in server's config.js

const float PUSH_INTERVAL_MUL = 1.5;   // gap after each push = last push time * this multiplier —
                                        // self-adapts: fast/idle link -> small gap -> max fps;
                                        // congested link -> pushMs grows -> gap grows with it,
                                        // backing off automatically instead of adding to the jam

// ── Alarm trigger ──────────────────────────────────────────────────────
// Placeholder hardware for now: a simple push button wired to a GPIO pin.
// The intent is to swap this for a real alarm sensor's output later
// without changing any of the logic in the .ino file — just these
// constants. Wiring assumed for the default values below: pin to GND
// through a button, with the pin's internal pull-up enabled in the sketch,
// so it reads HIGH normally and LOW while the button is held down.
const int  ALARM_GPIO_PIN           = 13;    // which GPIO the alarm input is wired to; -1 turns the
                                              // whole feature off (no pin claimed, no polling, no HTTP calls)
const int  ALARM_ACTIVE_STATE       = LOW;   // HIGH or LOW — the pin level that means "alarm!"
// (How long an alarm records, and how long the camera stays on, is NOT set
// here any more — it is stored on the relay and edited from the dashboard's
// "ALARM" fields, so it can be changed without reflashing the boards.)
const bool ALARM_RECORD_ALL_CAMERAS = false; // false: alarm here only starts/extends recording on this
                                              // camera (CAMERA_ID); true: on every camera the relay knows about

// ── Remote logging (all optional — shown with their defaults) ───────────
// Assembled cameras have no serial monitor attached, so everything this board
// logs (errors, warnings, WiFi/relay connection changes, the reset reason at
// boot, a status heartbeat) is ALSO sent to the relay's POST /log, which
// appends it to a text file on the Pi (nodejs/camera-relay/logs/camera.log).
// Each entry carries where in the firmware it came from, and for warnings and
// errors the events leading up to it, plus free heap, WiFi signal and uptime.
// The serial port still gets everything too (and is all there is if the relay
// can't be reached).
//
// If delivery fails, entries stay in memory and are retried; after
// REMOTE_LOG_RETRY_MAX failed retries the board gives up and logs to serial
// only, until its connection to the relay comes back.
//
//   #define REMOTE_LOG_ENABLED                true  // false: serial only
//   #define REMOTE_LOG_MIN_LEVEL              1     // sent to the relay: 0=DEBUG 1=INFO 2=WARN 3=ERROR
//   #define REMOTE_LOG_ECHO_TO_SERIAL         true  // false: serial shows only what is NOT sent to the relay
//   #define REMOTE_LOG_RETRY_MAX              3     // retries after a failed delivery, then serial only
//   #define REMOTE_LOG_RETRY_PERIOD_SECONDS   300   // wait between retries (5 minutes)
//   #define REMOTE_LOG_FLUSH_SECONDS          10    // routine entries wait this long so they go out together
//                                                   // (WARN and ERROR are sent at once)
//   #define REMOTE_LOG_REPEAT_WINDOW_SECONDS  30    // the same message repeating inside this window is counted,
//                                                   // not repeated ("last message repeated N more times")
//   #define REMOTE_LOG_HEARTBEAT_SECONDS      600   // a status line this often; a gap shows when a camera went quiet
//   #define REMOTE_LOG_LOW_HEAP_BYTES         30000 // warn when free heap falls below this
