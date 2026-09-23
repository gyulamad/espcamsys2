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
const int  ALARM_RECORD_SECONDS     = 60;    // footage length per trigger; a repeat trigger mid-recording
                                              // extends it by this many seconds from that moment, same as
                                              // pressing the dashboard's RECORD button again
const bool ALARM_RECORD_ALL_CAMERAS = false; // false: alarm here only starts/extends recording on this
                                              // camera (CAMERA_ID); true: on every camera the relay knows about

// ── AI Human Detection Alarm (plans/AI_ALARM_IMPLEMENTATION_PLAN.md) ───
// §7 step 3: monitoring-only person detection, logged to Serial only —
// this does NOT trigger recording yet (that's step 5). See
// Arduino/.../ai_person_detect.h and its model/README.md for the model
// this needs to actually detect anything; without it, AI monitoring is
// silently a no-op (logged once at boot) and the rest of the sketch is
// unaffected.
const bool AI_ALARM_ENABLED_DEFAULT = true;  // boot-time default for this device's own AI monitoring
                                              // on/off state; can be changed at runtime by the relay's
                                              // dashboard toggle (see logic.h's AiAlarmCommand) —
                                              // this is only what a freshly-booted/never-toggled-yet
                                              // device starts in
const unsigned long AI_INFERENCE_INTERVAL_MS = 350;  // ~2-3 inferences/sec during normal monitoring —
                                                       // see AI_ALARM_IMPLEMENTATION_PLAN.md §3 on the
                                                       // ~200-400ms/inference budget this fits inside
const float AI_CONFIDENCE_THRESHOLD = 0.6;   // person-detection confidence (0..1) that counts as a
                                              // detection worth logging; tune during field testing —
                                              // see logic.h's evaluatePersonScores()
