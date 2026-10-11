// ============================================================
// AI Thinker ESP32-CAM configuration
// ============================================================

// GPIO that becomes HIGH when a person is detected
// and LOW otherwise.
//
// GPIO 4 is connected to the onboard flash LED on the
// standard AI Thinker ESP32-CAM.
#define PERSON_DETECTED_GPIO 13


// ============================================================
// Person recognition
// ============================================================

// Person probability required to declare a person detected.
//
// 0.60 = 60%
// 0.70 = 70%
// 0.80 = 80%
//
// Espressif's v1.3.3 example uses 60%.
#define PERSON_DETECTION_THRESHOLD 0.60f


// Once a person has been detected, the score must fall below
// this value before the GPIO is switched LOW.
//
// This hysteresis prevents rapid GPIO ON/OFF switching when
// the recognition score fluctuates around the detection
// threshold.
//
// Example:
//
//   GPIO ON  at >= 60%
//   GPIO OFF at < 50%
#define PERSON_CLEAR_THRESHOLD 0.50f


// ============================================================
// Detection loop
// ============================================================

// Delay between inference cycles, in milliseconds.
#define DETECTION_LOOP_DELAY_MS 10


// ============================================================
// TFLite Micro
// ============================================================

// Tensor arena size.
//
// This is the base tensor arena size used by the Espressif
// v1.3.3 person-detection example.
#define TENSOR_ARENA_SIZE (100 * 1024)


// ============================================================
// Serial debugging
// ============================================================

// Print person/no-person scores for every inference.
#define PRINT_DETECTION_SCORES 1

// Print startup and initialization information.
#define PRINT_STARTUP_INFO 1

// ============================================================
// Live view (optional) — see an installed detector from a browser
// ============================================================
//
// With this on, the detector also joins Wi-Fi, serves what its camera sees as
// a password-protected video stream, and tells the relay which IP address it
// got (a line in the relay's log, nodejs/camera-relay/logs/camera.log):
//
//   ... INFO cam2-human@192.168.4.37 ...: human detector stream available at http://192.168.4.37/ — user 'viewer' (...)
//
// Open that address in a browser, log in, and you are looking at the 96x96
// grayscale picture the model gets — enough to aim the camera. Nothing is
// registered anywhere: a detector moved to another network simply announces its
// new address. To find the newest one:
//
//   grep "human detector stream" nodejs/camera-relay/logs/camera.log | tail -n 3
//
// Detection never waits for any of this. With no Wi-Fi in range the detector
// works exactly as it does without a live view.
//
// Set STREAM_ENABLED to 0 (or leave it out) for a detector that should not use
// Wi-Fi at all, e.g. one with a marginal power supply: Wi-Fi transmissions draw
// current spikes that can brown out a weak supply.
//
// The video is plain HTTP, so the password crosses your LAN unencrypted: use a
// password that is not reused anywhere else, and do not expose this port to the
// internet. The stream is NOT served while STREAM_PASSWORD is empty or still
// "change-me".
#define STREAM_ENABLED 1

struct WifiNetwork { const char* ssid; const char* password; };

// Every network the detector may join; it takes the strongest one in range and
// fails over if it drops (same as the recorder's config.h).
WifiNetwork WIFI_NETWORKS[] = {
  { "extender-1-ssid", "extender-1-password" },
  { "extender-2-ssid", "extender-2-password" },
  { "extender-3-ssid", "extender-3-password" },
};
const int WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

// The relay: where the address is announced. Same values as the recorder's
// config.h.
const char* SERVER_HOST = "192.168.4.9";   // your Pi's IP or hostname
const int   HTTP_PORT   = 8080;            // relay's HTTP port (port in its config.js)
const char* API_KEY     = "change-me";     // must match camKey in the relay's config.js

// How this detector is named in the relay's log. 1-64 characters of
// A-Z a-z 0-9 _ . -   Use something that tells detectors apart, and that is
// NOT a recorder's CAMERA_ID (that would mix up the two in the log).
const char* DETECTOR_ID = "cam2-human";

// What the browser asks for. (STREAM_USER must not contain ':'.)
const char* STREAM_USER     = "viewer";
const char* STREAM_PASSWORD = "change-me";

// Optional — shown with their defaults:
//   #define STREAM_PORT                 80    // the port the stream is served on
//   #define STREAM_MAX_FPS              10    // upper limit; the real rate is the detection rate
//   #define STREAM_JPEG_QUALITY         80    // 1-100, higher = better picture
//   #define STREAM_WRITE_TIMEOUT_S      3     // a viewer that stops reading is dropped after this
//   #define ANNOUNCE_HEARTBEAT_SECONDS  600   // the address is repeated in the relay's log this often
//   #define ANNOUNCE_RETRY_SECONDS      30    // wait after the relay could not be reached
