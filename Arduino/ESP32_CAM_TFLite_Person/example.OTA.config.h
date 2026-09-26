// example.OTA.config.h — template. Copy this file to OTA.config.h, in
// this same sketch folder, and fill in your real values. OTA.config.h is
// gitignored (same convention as config.h — see .gitignore), so your
// WiFi passwords and OTA upload password never get committed.
//
//   cp example.OTA.config.h OTA.config.h

#pragma once

// ── Wi-Fi networks ───────────────────────────────────────────────────
// List every network this device should be able to use. OTA.h connects
// to whichever has the strongest signal (via WiFiMulti) and automatically
// fails over if the current one drops — this replaces the WIFI_NETWORKS
// block that used to live in this sketch's own config.h.
struct OtaWifiNetwork { const char* ssid; const char* password; };

OtaWifiNetwork OTA_WIFI_NETWORKS[] = {
  { "extender-1-ssid", "extender-1-password" },
  { "extender-2-ssid", "extender-2-password" },
  { "extender-3-ssid", "extender-3-password" },
};
const int OTA_WIFI_NETWORK_COUNT = sizeof(OTA_WIFI_NETWORKS) / sizeof(OTA_WIFI_NETWORKS[0]);

// How long OTA.setup() blocks waiting for the first connection before
// giving up, in milliseconds.
const unsigned long OTA_WIFI_CONNECT_TIMEOUT_MS = 20000;

// If the initial connect attempt in OTA.setup() times out, reboot the
// board and try again from scratch rather than continuing offline.
// Good for an unattended camera with nobody watching a serial monitor;
// set to 0 to instead keep running without WiFi/OTA and retry quietly
// from loop() (note: this camera's push-to-relay feature also needs
// WiFi, so on this particular sketch you generally want this left on).
#define OTA_REBOOT_ON_WIFI_TIMEOUT 1

// How often OTA.loop() re-checks the WiFi link, in milliseconds.
// WiFiMulti's run() is cheap once connected, but this still avoids
// calling it — and, once connected, ArduinoOTA.handle() — on literally
// every loop() iteration.
const unsigned long OTA_WIFI_RECHECK_INTERVAL_MS = 500;

// ── OTA (over-the-air firmware upload) ──────────────────────────────
// Name this device shows up as in Arduino IDE's Tools > Port network
// list and via mDNS (<hostname>.local). MUST be unique per device on
// the network — e.g. match it to CAMERA_ID in config.h.
const char* OTA_HOSTNAME = "espcam-recogniser";

// Password required to push an OTA update to this device. Leave as ""
// to disable password protection (not recommended — anyone on the same
// network could then flash arbitrary firmware to this device over OTA).
const char* OTA_PASSWORD = "change-me";

// UDP/TCP port ArduinoOTA listens on. 3232 is the ESP32 core default —
// only change this if it conflicts with something else on your network.
const int OTA_PORT = 3232;
