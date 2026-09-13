// example.config.h — template. Copy this file to config.h, in this same
// sketch folder, and fill in your real values. config.h is gitignored, so
// your Wi-Fi password and API key never get committed.
//
//   cp example.config.h config.h

const char* WIFI_SSID     = "your-wifi-ssid";
const char* WIFI_PASSWORD = "your-wifi-password";
const char* SERVER_HOST   = "192.168.4.9";     // your Pi's IP or hostname
const int   SERVER_PORT   = 8080;
const char* CAMERA_ID     = "cam1";            // MUST be unique per camera — must match its id in config.php
const char* API_KEY       = "change-me";       // must match camKey in server's config.js

const unsigned long PUSH_INTERVAL_MS = 300;   // ~3 fps; lower = smoother, more bandwidth
