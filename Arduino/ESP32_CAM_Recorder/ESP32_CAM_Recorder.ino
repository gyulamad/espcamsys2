#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>

// Wi-Fi networks (one per extender), relay host, camera id and API key live
// in config.h, a file in this same sketch folder that is gitignored (never
// committed). Copy example.config.h to config.h and fill in your real values:
//   cp example.config.h config.h
#include "config.h"

// All the sketch's actual decision-making (debounce, URL/line building,
// frame framing, etc.) lives in logic.h as plain, hardware-free C++ so it
// can be unit-tested on a desktop with g++/gdb — see tests/cpp/. This file
// only reads the hardware and calls into it.
#include "logic.h"
using namespace esp32cam_logic;

WiFiMulti wifiMulti;
WiFiClient pushClient;   // ONE persistent connection to the relay's raw push
                         // port, held open for the sketch's whole runtime —
                         // frames are written straight to it with no
                         // per-frame HTTP request/response round trip
bool pushAuthed = false;

// There is deliberately no pause/resume switch: this camera captures and
// pushes continuously, always. The relay keeps a rolling pre-roll buffer of
// the last few seconds of every camera's frames and starts each recording
// with it, so footage begins BEFORE an alarm/record trigger — which only
// works if the camera was already streaming when the trigger happened.
// (Older firmware could be paused from the dashboard; a relay still sends
// one legacy "resume" byte on connect, which loop() just discards.)

// Whether esp_camera_init() has succeeded. WiFi is brought up unconditionally
// in setup() regardless of this — a camera fault must never leave WiFi
// uninitialized, which previously crashed the watchdog once loop() started
// calling wifiMulti.run() against a radio that was never put into station
// mode. See initCamera() / the camera-retry block in loop().
bool cameraReady = false;

// ── Alarm trigger state ──────────────────────────────────────────────
// Debounced edge-detection for ALARM_GPIO_PIN (see checkAlarmTrigger()).
// A short settle window is required before a reading is trusted, so a
// noisy/bouncy button press doesn't fire multiple times. Kept as an
// implementation detail here rather than in config.h, unlike the alarm
// constants, which are the "business" parameters someone tuning the alarm
// setup would actually want to change. The actual debounce state machine
// lives in logic.h (alarmDebounceUpdate()) — this is just its persistent
// state across loop() calls.
const unsigned long ALARM_DEBOUNCE_MS = 50;
// Set from the pin interrupt (onAlarmEdge), consumed in checkAlarmTrigger().
// The ISR only latches "an edge happened", so a quick press is never lost
// even when loop() is slow (frame push + delay).
volatile bool alarmPending = false;
volatile unsigned long alarmLastIsrMs = 0;

void IRAM_ATTR onAlarmEdge() {
  unsigned long now = millis();
  if (now - alarmLastIsrMs < ALARM_DEBOUNCE_MS) return;  // lockout against contact bounce
  alarmLastIsrMs = now;
  alarmPending = true;
}

// AI-Thinker ESP32-CAM pin map (default board used by most ESP32-CAM modules)
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// Writes `len` bytes to the push socket, retrying partial writes instead of
// treating one short write() as a hard failure. A single write() can
// legitimately return fewer bytes than requested when the TCP send buffer
// fills faster than the relay drains it — common with a weak WiFi signal
// pushing a VGA-sized JPEG frame — and simply calling write() again with
// the remainder is enough to finish the job in that case. Only gives up if
// nothing gets through for PUSH_WRITE_TIMEOUT_MS straight, or the socket
// actually disconnects mid-write.
const unsigned long PUSH_WRITE_TIMEOUT_MS = 4000;

size_t writePushBytes(const uint8_t *data, size_t len) {
  size_t total = 0;
  unsigned long lastProgress = millis();
  while (total < len) {
    if (!pushClient.connected()) break;
    size_t n = pushClient.write(data + total, len - total);
    if (n > 0) {
      total += n;
      lastProgress = millis();
    } else if (writeStalled(lastProgress, millis(), PUSH_WRITE_TIMEOUT_MS)) {
      break; // truly stuck — give up rather than hang loop() indefinitely
    } else {
      delay(1); // brief yield before retrying, rather than busy-spinning
    }
  }
  return total;
}

// Opens the persistent push connection if it isn't already open, sending
// the one-time auth line. Cheap to call every loop when already connected —
// just checks the socket state, no reconnect attempt unless it's actually down.
bool ensurePushConnection() {
  if (pushClient.connected()) return true;

  pushAuthed = false;
  pushClient.stop();
  if (!pushClient.connect(SERVER_HOST, PUSH_PORT)) {
    return false;
  }
  pushClient.setNoDelay(true);
  std::string authLine = buildAuthLine(CAMERA_ID, API_KEY);
  pushClient.print(authLine.c_str());
  pushAuthed = true;
  return true;
}

// FALLBACK alarm report: POSTs http://SERVER_HOST:HTTP_PORT/alarm/<id>. Only
// used when the push connection is down (see triggerAlarmRecording()) — in
// that case no frames are flowing anyway, so it doesn't matter that this
// blocks loop() for up to setTimeout() while it runs. No duration is sent:
// the relay holds the alarm setting (how long to record), editable from the
// dashboard, so it can be changed without reflashing this board. Logged, not
// retried — the next alarm edge gets another chance.
void sendAlarmRequest(const String &id) {
  HTTPClient http;
  std::string url = buildAlarmUrl(SERVER_HOST, HTTP_PORT, id.c_str());
  http.begin(String(url.c_str()));
  http.setTimeout(5000);
  int code = http.POST(""); // relay expects no body, same as the dashboard's proxy_post()
  if (code > 0) {
    Serial.printf("[alarm] alarm request for '%s' -> HTTP %d\n", id.c_str(), code);
  } else {
    Serial.printf("[alarm] alarm request for '%s' failed: %s\n", id.c_str(), http.errorToString(code).c_str());
  }
  http.end();
}

// Asks the relay to (re)start a recording — on just this camera, or on
// every camera the relay currently knows about, per ALARM_RECORD_ALL_CAMERAS.
// If this camera isn't already recording the relay starts a fresh recording,
// beginning with its pre-roll (the last few seconds this camera streamed
// BEFORE the alarm); if it is, the recording is extended from now — the same
// start/extend behaviour as the dashboard's RECORD button.
//
// The normal route is IN-BAND: a 6-byte control message written down the
// push connection we already hold open for frames (see logic.h,
// encodeAlarmMessage()). It never waits for the relay, so loop() carries on
// capturing frames with no gap — the old HTTP request stalled the camera for
// as long as it took, up to seconds on weak WiFi, exactly when the person was
// in view. This runs at the top of loop(), never mid-frame, so the message
// always lands cleanly between two frames, and the relay handles it in order
// with them: every frame sent before the alarm is already in its pre-roll.
//
// The HTTP request is the fallback only when there is no push connection.
void triggerAlarmRecording() {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  std::string targetId = alarmRecordTargetId(ALARM_RECORD_ALL_CAMERAS, CAMERA_ID);

  switch (chooseAlarmRoute(pushClient.connected(), wifiUp)) {
    case AlarmRoute::InBand: {
      uint8_t msg[ALARM_MESSAGE_LEN];
      encodeAlarmMessage(ALARM_RECORD_ALL_CAMERAS, msg);
      if (writePushBytes(msg, ALARM_MESSAGE_LEN) == ALARM_MESSAGE_LEN) {
        Serial.println("[alarm] sent in-band on the push connection");
        return;
      }
      // A partial write leaves the byte stream stopped halfway through a
      // message, which the relay can't make sense of — the connection is
      // unusable. Drop it (loop() reconnects) and fall back to HTTP so this
      // alarm isn't lost; the stream is down at this point anyway.
      Serial.println("[alarm] in-band send failed — dropping the push connection, falling back to HTTP");
      pushClient.stop();
      if (wifiUp) sendAlarmRequest(String(targetId.c_str()));
      return;
    }
    case AlarmRoute::Http:
      Serial.println("[alarm] no push connection — using the HTTP fallback");
      sendAlarmRequest(String(targetId.c_str()));
      return;
    case AlarmRoute::Skip:
      Serial.println("[alarm] triggered but WiFi is down — skipping record request");
      return;
  }
}

// Handles an alarm edge latched by onAlarmEdge(). Fires once per edge into
// ALARM_ACTIVE_STATE; edges that arrive while a previous trigger is still
// being processed collapse into one, which is fine since a repeat trigger
// only extends the recording anyway.
void checkAlarmTrigger() {
  if (ALARM_GPIO_PIN < 0) return; // feature turned off — see ALARM_GPIO_PIN in config.h

  if (alarmPending) {
    alarmPending = false;
    Serial.println("[alarm] triggered");
    triggerAlarmRecording();
  }
}

// Configures and initializes the OV2640 camera driver. Split out of setup()
// so it can also be retried from loop() if it fails at boot — a frame-buffer
// malloc failure here is usually a marginal power supply or PSRAM not being
// enabled in board settings, and can clear up on its own once the supply
// settles, without needing a full reboot.
bool initCamera() {
  // Zero-initialize: camera_config_t has gained new fields (fb_location,
  // grab_mode, ...) across esp32-camera library versions. Anything this
  // sketch doesn't explicitly set below must default to a safe value
  // instead of whatever was already sitting on the stack — an
  // uninitialized fb_location in particular can force a VGA frame buffer
  // into internal DRAM, where it doesn't fit, producing exactly the
  // "frame buffer malloc failed" error this function is guarding against.
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;   // 640x480 — bump up if bandwidth allows
    config.jpeg_quality = 12;            // lower number = higher quality, bigger file
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM; // VGA*2 buffers only fits in PSRAM
  } else {
    config.frame_size = FRAMESIZE_QVGA;  // 320x240 — safer without PSRAM
    config.jpeg_quality = 15;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  // Orientation: set explicitly (not left to driver defaults) and keep it
  // identical to ESP32_CAM_TFLite_Person, so the live video and the AI
  // detector always see the same picture. If your board is mounted
  // differently, change BOTH sketches together (vflip + hmirror = 180°).
  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_vflip(sensor, 0);
    sensor->set_hmirror(sensor, 0);
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(200); // give the serial monitor a moment to attach

  // Print identity FIRST, before camera/WiFi init even runs — so this is
  // visible even if init fails, and you can confirm which physical board
  // this is before re-flashing it.
  Serial.println();
  Serial.println("========================================");
  Serial.printf("  CAMERA_ID: %s\n", CAMERA_ID);
  Serial.println("========================================");
  Serial.println();

  // Internal pull-up so the default push-button wiring (pin -> button ->
  // GND) reads a clean HIGH when idle and LOW when pressed with no extra
  // hardware. A future alarm sensor with its own active-driven output can
  // still be read fine through the pull-up; swap to plain INPUT here if
  // its datasheet calls for it. Skipped entirely when the feature is off
  // (ALARM_GPIO_PIN < 0) — no pin claimed, nothing to configure.
  if (ALARM_GPIO_PIN >= 0) {
    pinMode(ALARM_GPIO_PIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(ALARM_GPIO_PIN), onAlarmEdge,
                    ALARM_ACTIVE_STATE == LOW ? FALLING : RISING);
    alarmPending = false;
  }

  // Camera MUST be initialized before WiFi comes up, not after: the WiFi
  // driver claims a large chunk of internal DRAM for its buffers as soon as
  // it starts, and the camera's DMA frame buffers need a big contiguous
  // block of that same internal RAM. Camera-after-WiFi is exactly what
  // produces "cam_dma_config: frame buffer malloc failed" even on boards
  // that work fine otherwise. If it does fail, we don't return early
  // though — WiFi still needs to come up regardless (see cameraReady above
  // for why), so the failure is only logged here, not fatal to setup().
  cameraReady = initCamera();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // disable modem-sleep power saving — it's the other
                          // big source of added latency on ESP32 WiFi

  for (int i = 0; i < WIFI_NETWORK_COUNT; i++) {
    wifiMulti.addAP(WIFI_NETWORKS[i].ssid, WIFI_NETWORKS[i].password);
  }

  Serial.print("Connecting to WiFi");
  while (wifiMulti.run() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.println("\n[" + String(CAMERA_ID) + "] Connected to " + WiFi.SSID() +
                  ", IP: " + WiFi.localIP().toString() +
                  ", RSSI: " + WiFi.RSSI());
}

void loop() {
  // Periodic identity reminder — so opening the Serial Monitor at any point
  // (not just right at boot) still tells you which camera this is.
  static unsigned long lastIdentityPrint = 0;
  if (millis() - lastIdentityPrint > 10000) {
    Serial.printf("[%s] RSSI: %d dBm, uptime: %lus%s\n",
                  CAMERA_ID, WiFi.RSSI(), millis() / 1000,
                  cameraReady ? "" : " (camera not ready)");
    lastIdentityPrint = millis();
  }

  // Cheap when already connected — only scans/reconnects if the link dropped,
  // and will fail over to a different extender if the current one is gone.
  if (wifiMulti.run() != WL_CONNECTED) {
    delay(500);
    return;
  }

  // Polled every loop, independent of push-connection/camera state below,
  // so the alarm keeps working even while this camera is mid-reconnect or
  // waiting on the camera to come up.
  checkAlarmTrigger();

  if (!cameraReady) {
    // Retry periodically rather than being stuck forever. This can only
    // recover a genuinely transient failure (e.g. a one-off timing/power
    // glitch at boot) — if the camera failed because WiFi already claimed
    // the internal DRAM it needs (see the ordering note in setup()), these
    // retries will keep failing for the same reason every time, since WiFi
    // is already up by the time loop() runs. That's a "camera never came up
    // at all" problem to fix at the setup()/hardware level, not something a
    // retry can paper over — but retrying here is still strictly better
    // than crash-looping ever did.
    static unsigned long lastCameraRetry = 0;
    if (millis() - lastCameraRetry > 5000) {
      Serial.println("Retrying camera init...");
      cameraReady = initCamera();
      lastCameraRetry = millis();
    }
    delay(200);
    return;
  }

  if (!ensurePushConnection()) {
    Serial.println("Push connect failed, will retry");
    delay(500);
    return;
  }

  // Discard anything the relay sent us. The only thing it ever writes down
  // this socket is a single legacy "resume" byte right after authenticating
  // (for old firmware that could be paused) — there is nothing to act on,
  // but leaving bytes unread would slowly fill the receive buffer.
  while (pushClient.available()) pushClient.read();

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Frame capture failed");
    delay(200);
    return;
  }

  uint32_t len = fb->len;
  uint8_t lenPrefix[4];
  encodeFrameLengthPrefix(len, lenPrefix);

  unsigned long t0 = millis();
  size_t written = writePushBytes(lenPrefix, 4);
  if (written == 4) {
    written += writePushBytes(fb->buf, fb->len);
  }
  unsigned long pushMs = millis() - t0;

  if (!pushWriteSucceeded(written, len, pushClient.connected())) {
    Serial.println("Push write failed — dropping connection, will reconnect next loop");
    pushClient.stop();
  }

  esp_camera_fb_return(fb);

  // Gap scales with how long the last push actually took: fast/idle link ->
  // short gap -> max fps; congested link -> pushMs grows -> gap grows with
  // it -> backs off automatically instead of adding to the jam.
  delay(computePushDelayMs(pushMs, PUSH_INTERVAL_MUL));
}
