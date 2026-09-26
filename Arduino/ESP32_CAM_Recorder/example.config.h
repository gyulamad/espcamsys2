// example.config.h — template. Copy this file to config.h, in this same
// sketch folder, and fill in your real values. config.h is gitignored, so
// your Wi-Fi passwords and API key never get committed.
//
//   cp example.config.h config.h

// WiFi networks, OTA hostname/password and related settings now live in
// OTA.config.h (copy it from example.OTA.config.h) instead of here — see
// OTA.h for how the sketch uses them.

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
const int  ALARM_RECORD_SECONDS     = 60;    // footage length per trigger; a repeat trigger mid-recording
                                              // extends it by this many seconds from that moment, same as
                                              // pressing the dashboard's RECORD button again
const bool ALARM_RECORD_ALL_CAMERAS = false; // false: alarm here only starts/extends recording on this
                                              // camera (CAMERA_ID); true: on every camera the relay knows about
