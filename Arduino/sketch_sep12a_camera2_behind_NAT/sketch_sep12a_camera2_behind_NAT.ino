#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>

// Wi-Fi networks (one per extender), relay host, camera id and API key live
// in config.h, a file in this same sketch folder that is gitignored (never
// committed). Copy example.config.h to config.h and fill in your real values:
//   cp example.config.h config.h
#include "config.h"

WiFiMulti wifiMulti;
WiFiClient pushClient;   // ONE persistent connection to the relay's raw push
                         // port, held open for the sketch's whole runtime —
                         // frames are written straight to it with no
                         // per-frame HTTP request/response round trip
bool pushAuthed = false;

// Whether we should be capturing/pushing right now. Synced from the relay
// over the same persistent connection — see server.js's /control endpoint,
// which the dashboard's per-camera power button calls. Defaults to on at
// boot; the relay also re-sends its current value right after we
// (re)authenticate, in case the dashboard paused us while we were offline.
bool streamEnabled = true;

// ── Alarm trigger state ──────────────────────────────────────────────
// Debounced edge-detection for ALARM_GPIO_PIN (see checkAlarmTrigger()).
// A short settle window is required before a reading is trusted, so a
// noisy/bouncy button press doesn't fire multiple times. Kept as an
// implementation detail here rather than in config.h, unlike the alarm
// constants, which are the "business" parameters someone tuning the alarm
// setup would actually want to change.
const unsigned long ALARM_DEBOUNCE_MS = 50;
int alarmRawState = -1;           // most recent raw digitalRead(); -1 = not read yet
int alarmStableState = -1;        // debounced state once it's held steady for ALARM_DEBOUNCE_MS
unsigned long alarmLastChangeMs = 0;

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
  pushClient.print(String(CAMERA_ID) + "\t" + API_KEY + "\n");
  pushAuthed = true;
  return true;
}

// POSTs http://SERVER_HOST:HTTP_PORT/record/<id>?seconds=ALARM_RECORD_SECONDS
// — the exact same endpoint the dashboard's RECORD button calls (via
// record.php), so the relay's existing start/extend behaviour just works:
// if that camera isn't already recording, this starts a fresh
// ALARM_RECORD_SECONDS-long recording; if it is, this extends it by
// ALARM_RECORD_SECONDS measured from now. Logged, not retried — the next
// alarm edge (or the relay's own auto-extend on a still-active sensor)
// gets another chance. This blocks loop() for up to setTimeout() while it
// runs, which briefly pauses frame pushing too — acceptable since alarm
// triggers are rare and short-lived, not something happening every loop.
void sendRecordRequest(const String &id) {
  HTTPClient http;
  String url = "http://" + String(SERVER_HOST) + ":" + String(HTTP_PORT) +
               "/record/" + id + "?seconds=" + String(ALARM_RECORD_SECONDS);
  http.begin(url);
  http.setTimeout(5000);
  int code = http.POST(""); // relay expects no body, same as the dashboard's proxy_post()
  if (code > 0) {
    Serial.printf("[alarm] record request for '%s' -> HTTP %d\n", id.c_str(), code);
  } else {
    Serial.printf("[alarm] record request for '%s' failed: %s\n", id.c_str(), http.errorToString(code).c_str());
  }
  http.end();
}

// Asks the relay to (re)start a recording — on just this camera, or on
// every camera the relay currently knows about, per ALARM_RECORD_ALL_CAMERAS.
void triggerAlarmRecording() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[alarm] triggered but WiFi is down — skipping record request");
    return;
  }
  if (ALARM_RECORD_ALL_CAMERAS) {
    sendRecordRequest("all");
  } else {
    sendRecordRequest(String(CAMERA_ID));
  }
}

// Debounced edge-detection on ALARM_GPIO_PIN. Only fires on a *transition*
// into ALARM_ACTIVE_STATE — not on every loop while the pin is held there —
// so a sustained alarm signal triggers once per press/contact rather than
// flooding the relay with requests. The very first stable reading after
// boot never fires on its own (see the `alarmStableState != -1` guard), so
// a sensor that happens to power up already in its active position doesn't
// kick off a recording before anything has actually "happened".
void checkAlarmTrigger() {
  if (ALARM_GPIO_PIN < 0) return; // feature turned off — see ALARM_GPIO_PIN in config.h

  int raw = digitalRead(ALARM_GPIO_PIN);

  if (raw != alarmRawState) {
    alarmRawState = raw;
    alarmLastChangeMs = millis();
    return; // reading just moved — wait for it to settle before trusting it
  }

  if (millis() - alarmLastChangeMs < ALARM_DEBOUNCE_MS) return; // still settling

  if (raw != alarmStableState) {
    bool hadPriorReading = (alarmStableState != -1);
    alarmStableState = raw;
    if (hadPriorReading && alarmStableState == ALARM_ACTIVE_STATE) {
      Serial.println("[alarm] triggered");
      triggerAlarmRecording();
    }
  }
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

  camera_config_t config;
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

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;   // 640x480 — bump up if bandwidth allows
    config.jpeg_quality = 12;            // lower number = higher quality, bigger file
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA;  // 320x240 — safer without PSRAM
    config.jpeg_quality = 15;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return;
  }

  // Internal pull-up so the default push-button wiring (pin -> button ->
  // GND) reads a clean HIGH when idle and LOW when pressed with no extra
  // hardware. A future alarm sensor with its own active-driven output can
  // still be read fine through the pull-up; swap to plain INPUT here if
  // its datasheet calls for it. Skipped entirely when the feature is off
  // (ALARM_GPIO_PIN < 0) — no pin claimed, nothing to configure.
  if (ALARM_GPIO_PIN >= 0) {
    pinMode(ALARM_GPIO_PIN, INPUT_PULLUP);
  }

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
                  streamEnabled ? "" : " (paused)");
    lastIdentityPrint = millis();
  }

  // Cheap when already connected — only scans/reconnects if the link dropped,
  // and will fail over to a different extender if the current one is gone.
  if (wifiMulti.run() != WL_CONNECTED) {
    delay(500);
    return;
  }

  // Polled every loop, independent of streamEnabled/push-connection state
  // below, so the alarm keeps working even while this camera is paused
  // from the dashboard or its push socket is mid-reconnect.
  checkAlarmTrigger();

  if (!ensurePushConnection()) {
    Serial.println("Push connect failed, will retry");
    delay(500);
    return;
  }

  // Drain any pending control bytes from the relay (dashboard power
  // button). Single raw byte, no framing needed — this rides the same
  // socket as our outgoing frames but in the other direction, so it never
  // collides with them: 0x00 = pause, 0x01 = resume. If several arrived
  // since we last checked, only the last one matters.
  while (pushClient.available()) {
    int cmd = pushClient.read();
    if (cmd == 0) streamEnabled = false;
    else if (cmd == 1) streamEnabled = true;
  }

  if (!streamEnabled) {
    // Paused from the dashboard — skip capture and push entirely, which is
    // where the actual power/bandwidth savings come from. We deliberately
    // keep WiFi and the push connection alive rather than sleeping, so the
    // dashboard can resume us instantly with no reconnect delay.
    delay(500);
    return;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Frame capture failed");
    delay(200);
    return;
  }

  uint32_t len = fb->len;
  uint8_t lenPrefix[4] = {
    (uint8_t)(len >> 24), (uint8_t)(len >> 16), (uint8_t)(len >> 8), (uint8_t)len
  };

  unsigned long t0 = millis();
  size_t written = pushClient.write(lenPrefix, 4);
  written += pushClient.write(fb->buf, fb->len);
  unsigned long pushMs = millis() - t0;

  if (written != 4 + len || !pushClient.connected()) {
    Serial.println("Push write failed — dropping connection, will reconnect next loop");
    pushClient.stop();
  }

  esp_camera_fb_return(fb);

  // Gap scales with how long the last push actually took: fast/idle link ->
  // short gap -> max fps; congested link -> pushMs grows -> gap grows with
  // it -> backs off automatically instead of adding to the jam.
  delay((unsigned long)(pushMs * PUSH_INTERVAL_MUL));
}
