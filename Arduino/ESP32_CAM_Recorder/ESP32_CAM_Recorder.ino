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
#include "remote_log.h"   // what the camera reports to the relay's log (see the glue block below)
#include <esp_system.h>   // esp_reset_reason()
using namespace esp32cam_logic;

WiFiMulti wifiMulti;
WiFiClient pushClient;   // ONE persistent connection to the relay's raw push
                         // port, held open for the sketch's whole runtime —
                         // frames are written straight to it with no
                         // per-frame HTTP request/response round trip
bool pushAuthed = false;

// Whether the relay on the CURRENT push connection has announced that it
// understands in-band alarm messages (see logic.h, RELAY_CAP_INBAND_ALARM).
// False until the announcement byte arrives, and reset on every new
// connection. Until it's true, alarms go out as an HTTP request instead — so
// a relay that predates the in-band alarm can never mistake the alarm bytes
// for a video frame (corrupt stream, lost alarm).
bool relaySupportsInBandAlarm = false;

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

// ── Remote logging glue ─────────────────────────────────────────────────
// Assembled cameras have no serial monitor attached, so when something goes
// wrong there is nobody to read what the board printed. Everything this sketch
// logs is therefore ALSO sent to the relay (POST /log), which writes it into a
// log file on the Pi — with the call site, how the board got there (the events
// just before a warning/error), free heap, WiFi signal and uptime. The serial
// port still gets everything too, unless REMOTE_LOG_ECHO_TO_SERIAL says
// otherwise, and is all that remains if the relay can't be reached.
//
// What to send and when, the in-memory queue, the retry/give-up policy: all in
// remote_log.h, as plain C++ unit-tested on a desktop. This block only supplies
// the clock, the serial port and the HTTP call.
//
// The HTTP request runs in its OWN background task, never in loop(): over weak
// WiFi it can take seconds, and the capture loop must never stop streaming for
// it (that stall is exactly the gap in the footage the in-band alarm removed).
//
// Usage anywhere below:  RLOG_INFO("connected, RSSI %d", rssi);  — printf-style,
// at levels RLOG_DEBUG / RLOG_INFO / RLOG_WARN / RLOG_ERROR. (Not LOG_*: the
// ESP32 toolchain's syslog headers already define those names.)
//
// All settings are optional in config.h (see example.config.h); these are the
// defaults, so a config.h written before this feature still compiles.
#ifndef REMOTE_LOG_ENABLED
#define REMOTE_LOG_ENABLED true          // false: serial only, nothing is sent
#endif
#ifndef REMOTE_LOG_MIN_LEVEL
#define REMOTE_LOG_MIN_LEVEL 1           // sent to the relay: 0=DEBUG 1=INFO 2=WARN 3=ERROR (and above)
#endif
#ifndef REMOTE_LOG_ECHO_TO_SERIAL
#define REMOTE_LOG_ECHO_TO_SERIAL true   // false: serial shows only what is NOT sent to the relay
#endif
#ifndef REMOTE_LOG_FLUSH_SECONDS
#define REMOTE_LOG_FLUSH_SECONDS 10      // routine entries wait up to this long so they go out together (WARN/ERROR go at once)
#endif
#ifndef REMOTE_LOG_RETRY_MAX
#define REMOTE_LOG_RETRY_MAX 3           // retries after a failed delivery, then serial only until the relay is back
#endif
#ifndef REMOTE_LOG_RETRY_PERIOD_SECONDS
#define REMOTE_LOG_RETRY_PERIOD_SECONDS 300  // wait between retries (5 minutes)
#endif
#ifndef REMOTE_LOG_REPEAT_WINDOW_SECONDS
#define REMOTE_LOG_REPEAT_WINDOW_SECONDS 30  // an identical message inside this window is counted, not repeated
#endif
#ifndef REMOTE_LOG_HEARTBEAT_SECONDS
#define REMOTE_LOG_HEARTBEAT_SECONDS 600     // a status line (uptime, heap, signal) this often — a gap in them shows when a camera went quiet
#endif
#ifndef REMOTE_LOG_LOW_HEAP_BYTES
#define REMOTE_LOG_LOW_HEAP_BYTES 30000      // warn when free heap falls below this
#endif

#define FW_BUILD __DATE__ " " __TIME__   // identifies which firmware build wrote a log line

void logEcho(void*, LogLevel, const char* line) {
  Serial.println(line);
}

RemoteLogConfig buildRemoteLogConfig() {
  RemoteLogConfig c;
  c.remoteEnabled   = REMOTE_LOG_ENABLED;
  c.remoteMinLevel  = logLevelFromInt(REMOTE_LOG_MIN_LEVEL);
  c.echoAlways      = REMOTE_LOG_ECHO_TO_SERIAL;
  c.flushIntervalMs = (uint32_t)REMOTE_LOG_FLUSH_SECONDS * 1000UL;
  c.retryPeriodMs   = (uint32_t)REMOTE_LOG_RETRY_PERIOD_SECONDS * 1000UL;
  c.maxRetries      = (uint8_t)(REMOTE_LOG_RETRY_MAX < 0 ? 0 : (REMOTE_LOG_RETRY_MAX > 255 ? 255 : REMOTE_LOG_RETRY_MAX));
  c.repeatWindowMs  = (uint32_t)REMOTE_LOG_REPEAT_WINDOW_SECONDS * 1000UL;
  return c;
}

RemoteLog remoteLogInstance(buildRemoteLogConfig(), logEcho, nullptr);
SemaphoreHandle_t remoteLogMutex = nullptr;   // guards remoteLogInstance: loop() logs, the uplink task sends

// Holds the mutex for the duration of a scope. (A no-op before the mutex
// exists, i.e. before remoteLogStart() — setup() is single-threaded then.)
struct RemoteLogLock {
  RemoteLogLock()  { if (remoteLogMutex) xSemaphoreTake(remoteLogMutex, portMAX_DELAY); }
  ~RemoteLogLock() { if (remoteLogMutex) xSemaphoreGive(remoteLogMutex); }
};

void logWrite(LogLevel level, const char *file, int line, const char *func, const char *fmt, ...)
    __attribute__((format(printf, 5, 6)));

void logWrite(LogLevel level, const char *file, int line, const char *func, const char *fmt, ...) {
  char msg[LOG_MSG_MAX * 2];   // formatted at full length; the core cuts it cleanly to fit
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);

  char site[LOG_SITE_MAX];
  formatCallSite(site, sizeof(site), file, line, func);

  int32_t rssi = (WiFi.status() == WL_CONNECTED) ? (int32_t)WiFi.RSSI() : 0;
  RemoteLogLock lock;
  remoteLogInstance.log(level, millis(), site, msg, (int32_t)ESP.getFreeHeap(), rssi);
}

#define RLOG_DEBUG(...) logWrite(LogLevel::Debug, __FILE__, __LINE__, __func__, __VA_ARGS__)
#define RLOG_INFO(...)  logWrite(LogLevel::Info,  __FILE__, __LINE__, __func__, __VA_ARGS__)
#define RLOG_WARN(...)  logWrite(LogLevel::Warn,  __FILE__, __LINE__, __func__, __VA_ARGS__)
#define RLOG_ERROR(...) logWrite(LogLevel::Error, __FILE__, __LINE__, __func__, __VA_ARGS__)

// One HTTP delivery. true only for a 2xx answer — the relay says 200 only once
// the entries are in its file, so anything else (no connection, wrong key,
// relay can't write its log) leaves them in memory for a retry.
bool postLogBatch(const std::string &body, String &detail) {
  HTTPClient http;
  std::string url = buildLogUrl(SERVER_HOST, HTTP_PORT);
  http.begin(String(url.c_str()));
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Api-Key", API_KEY);
  int code = http.POST((uint8_t *)body.data(), body.size());
  detail = (code > 0) ? String("HTTP ") + code : http.errorToString(code);
  http.end();
  return code >= 200 && code < 300;
}

// One pass of the uplink: ask the core whether a delivery is due, make the HTTP
// request if so (OUTSIDE the lock — it can be slow), and report the outcome.
// Separate from the task below so it is a plain function.
void remoteLogPump() {
  uint32_t now = millis();
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  std::string body;
  uint32_t lastSeq = 0;
  bool send;
  {
    RemoteLogLock lock;
    remoteLogInstance.tick(now, (int32_t)ESP.getFreeHeap(), wifiUp ? (int32_t)WiFi.RSSI() : 0);
    send = remoteLogInstance.prepareBatch(now, wifiUp, CAMERA_ID, FW_BUILD, body, lastSeq);
  }
  if (!send) return;

  String detail;
  bool ok = postLogBatch(body, detail);

  uint8_t failed;
  bool gaveUp;
  {
    RemoteLogLock lock;
    remoteLogInstance.onSendResult(millis(), ok, lastSeq);
    failed = remoteLogInstance.failedAttempts();
    gaveUp = remoteLogInstance.uplinkState() == LogUplink::GaveUp;
  }
  if (ok) return;

  // Reported on the serial port ONLY: logging a logging failure through the
  // same channel would just feed itself.
  if (gaveUp) {
    Serial.printf("[log] giving up on remote logging after %u failed deliveries (%s) — serial only until the relay is reachable again\n",
                  (unsigned)failed, detail.c_str());
  } else {
    Serial.printf("[log] could not deliver log entries (%s) — delivery %u failed, retrying in %u s\n",
                  detail.c_str(), (unsigned)failed, (unsigned)REMOTE_LOG_RETRY_PERIOD_SECONDS);
  }
}

void remoteLogTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(250));
    remoteLogPump();
  }
}

// Starts the background uplink. Call once, early in setup(). Pinned to core 0
// (where the WiFi stack runs) so it never competes with loop() on core 1.
void remoteLogStart() {
  remoteLogMutex = xSemaphoreCreateMutex();
  if (!REMOTE_LOG_ENABLED || !remoteLogMutex) return;   // no mutex, no safe way to share: serial only
  xTaskCreatePinnedToCore(remoteLogTask, "remoteLog", 8192, nullptr, 1, nullptr, 0);
}

// The relay is reachable again (our push connection just came up): if remote
// logging had been given up on, resume it.
void remoteLogRelayReachable() {
  bool resumed;
  {
    RemoteLogLock lock;
    resumed = remoteLogInstance.onRelayReachable();
  }
  if (resumed) RLOG_INFO("remote logging resumed — the relay is reachable again");
}
// ── end of remote logging glue ──────────────────────────────────────────

// Writes `len` bytes to the push socket, retrying partial writes instead of
// treating one short write() as a hard failure. A single write() can
// legitimately return fewer bytes than requested when the TCP send buffer
// fills faster than the relay drains it — common with a weak WiFi signal
// pushing a VGA-sized JPEG frame — and simply calling write() again with
// the remainder is enough to finish the job in that case. Only gives up if
// nothing gets through for PUSH_WRITE_TIMEOUT_MS straight, or the socket
// actually disconnects mid-write.
const unsigned long PUSH_WRITE_TIMEOUT_MS = 4000;
const unsigned long PUSH_SLOW_WARN_MS = 2000;   // a frame that takes longer than this to push is worth a warning

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
  relaySupportsInBandAlarm = false; // capability is per connection: wait for this relay to announce it
  pushClient.stop();
  if (!pushClient.connect(SERVER_HOST, PUSH_PORT)) {
    return false;
  }
  pushClient.setNoDelay(true);
  std::string authLine = buildAuthLine(CAMERA_ID, API_KEY);
  pushClient.print(authLine.c_str());
  pushAuthed = true;
  RLOG_INFO("push connection to %s:%d established", SERVER_HOST, PUSH_PORT);
  remoteLogRelayReachable(); // if remote logging had given up, the relay is evidently back
  return true;
}

// FALLBACK alarm report: POSTs http://SERVER_HOST:HTTP_PORT/alarm/<id>. Used
// only when the in-band alarm can't be (see triggerAlarmRecording()). It
// blocks loop() for up to setTimeout() while it runs — harmless when the push
// connection is down (nothing is streaming anyway), a gap in the footage when
// it's up but the relay is too old for the in-band message. No duration is sent:
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
    RLOG_INFO("alarm request for '%s' -> HTTP %d", id.c_str(), code);
  } else {
    RLOG_ERROR("alarm request for '%s' failed: %s", id.c_str(), http.errorToString(code).c_str());
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
// The HTTP request is the fallback when there is no push connection, or the
// relay on this connection hasn't announced it understands the in-band
// message (an older relay, or this connection is brand new and the
// announcement hasn't been read yet). That check is what makes it safe to run
// this firmware against any relay version.
void triggerAlarmRecording() {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  std::string targetId = alarmRecordTargetId(ALARM_RECORD_ALL_CAMERAS, CAMERA_ID);

  switch (chooseAlarmRoute(pushClient.connected(), relaySupportsInBandAlarm, wifiUp)) {
    case AlarmRoute::InBand: {
      uint8_t msg[ALARM_MESSAGE_LEN];
      encodeAlarmMessage(ALARM_RECORD_ALL_CAMERAS, msg);
      if (writePushBytes(msg, ALARM_MESSAGE_LEN) == ALARM_MESSAGE_LEN) {
        RLOG_INFO("alarm sent in-band on the push connection");
        return;
      }
      // A partial write leaves the byte stream stopped halfway through a
      // message, which the relay can't make sense of — the connection is
      // unusable. Drop it (loop() reconnects) and fall back to HTTP so this
      // alarm isn't lost; the stream is down at this point anyway.
      RLOG_WARN("in-band alarm send failed — dropping the push connection, falling back to HTTP");
      pushClient.stop();
      if (wifiUp) sendAlarmRequest(String(targetId.c_str()));
      return;
    }
    case AlarmRoute::Http:
      if (pushClient.connected()) {
        RLOG_INFO("relay hasn't announced in-band alarm support (old relay, or just connected) — using the HTTP request");
      } else {
        RLOG_WARN("alarm: no push connection — using the HTTP request");
      }
      sendAlarmRequest(String(targetId.c_str()));
      return;
    case AlarmRoute::Skip:
      RLOG_WARN("alarm triggered but WiFi is down — the record request was NOT sent");
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
    RLOG_INFO("alarm input triggered");
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
    RLOG_ERROR("camera init failed: 0x%x (%s)", (unsigned)err, esp_err_to_name(err));
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

  // Remote logging starts here, so everything below can report to the relay
  // (entries wait in memory until WiFi is up and are filed under the time they
  // really happened). The reset reason is the first thing to look at when a
  // camera "just rebooted": a BROWNOUT means the power supply dipped, a
  // watchdog means something hung, a PANIC means the firmware crashed.
  remoteLogStart();
  int resetReason = (int)esp_reset_reason();
  if (isAbnormalReset(resetReason)) {
    RLOG_ERROR("booted after an abnormal restart: %s", resetReasonName(resetReason));
  } else {
    RLOG_INFO("booted (%s)", resetReasonName(resetReason));
  }
  RLOG_INFO("firmware built %s, camera id %s, free heap %u bytes, PSRAM %s",
            FW_BUILD, CAMERA_ID, (unsigned)ESP.getFreeHeap(), psramFound() ? "yes" : "no");

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
  Serial.println();
  RLOG_INFO("connected to WiFi '%s', IP %s, RSSI %d dBm",
            WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

void loop() {
  // Periodic identity reminder — so opening the Serial Monitor at any point
  // (not just right at boot) still tells you which camera this is.
  static unsigned long lastIdentityPrint = 0;
  if (millis() - lastIdentityPrint > 10000) {
    RLOG_DEBUG("[%s] RSSI: %d dBm, uptime: %lus%s",
               CAMERA_ID, WiFi.RSSI(), millis() / 1000,
               cameraReady ? "" : " (camera not ready)");
    if (ESP.getFreeHeap() < REMOTE_LOG_LOW_HEAP_BYTES) {
      RLOG_WARN("low free heap (below %u bytes) — a memory leak or fragmentation can end in a crash",
                (unsigned)REMOTE_LOG_LOW_HEAP_BYTES);
    }
    lastIdentityPrint = millis();
  }

  // A status line in the relay's log every REMOTE_LOG_HEARTBEAT_SECONDS. A gap
  // in these shows when a camera went quiet; the numbers show whether memory
  // was shrinking or the signal weakening beforehand.
  static unsigned long lastHeartbeat = millis();
  if (millis() - lastHeartbeat > (unsigned long)REMOTE_LOG_HEARTBEAT_SECONDS * 1000UL) {
    RLOG_INFO("heartbeat: uptime %lus, RSSI %d dBm, free heap %u (lowest ever %u), push connection %s",
              millis() / 1000, WiFi.RSSI(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
              pushClient.connected() ? "up" : "down");
    lastHeartbeat = millis();
  }

  // Cheap when already connected — only scans/reconnects if the link dropped,
  // and will fail over to a different extender if the current one is gone.
  static bool wifiWasUp = true;        // setup() only returns once WiFi is connected
  static unsigned long wifiLostAt = 0;
  bool wifiUp = wifiMulti.run() == WL_CONNECTED;
  if (wifiUp != wifiWasUp) {           // log the transition once, not every loop
    wifiWasUp = wifiUp;
    if (!wifiUp) {
      wifiLostAt = millis();
      RLOG_WARN("WiFi connection lost — reconnecting");
    } else {
      RLOG_INFO("WiFi reconnected to '%s' after %lus, RSSI %d dBm",
                WiFi.SSID().c_str(), (millis() - wifiLostAt) / 1000, WiFi.RSSI());
    }
  }
  if (!wifiUp) {
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
      RLOG_WARN("camera not ready — retrying init");
      cameraReady = initCamera();
      if (cameraReady) RLOG_INFO("camera init succeeded on retry");
      lastCameraRetry = millis();
    }
    delay(200);
    return;
  }

  if (!ensurePushConnection()) {
    RLOG_WARN("push connection to %s:%d failed — will keep retrying", SERVER_HOST, PUSH_PORT);
    delay(500);
    return;
  }

  // Read what the relay wrote to us. Right after we authenticate it sends two
  // single bytes: a legacy "resume" (for old firmware that could be paused —
  // nothing to do here) and the capability announcement, which is what
  // switches alarms over to the in-band message. Everything is consumed so
  // the receive buffer can't slowly fill up; unknown bytes are ignored.
  while (pushClient.available()) applyRelayByte(pushClient.read(), relaySupportsInBandAlarm);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    RLOG_ERROR("frame capture failed (the camera returned no frame) — the camera or its power supply may be faulty");
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
    RLOG_WARN("push write failed after %lu ms (wrote %u of %u bytes, %s) — dropping the connection, reconnecting",
              pushMs, (unsigned)written, (unsigned)(len + 4),
              pushClient.connected() ? "still connected" : "disconnected");
    pushClient.stop();
  } else if (pushMs > PUSH_SLOW_WARN_MS) {
    // At most once per 30 s: a weak link is slow on every frame.
    static unsigned long lastSlowWarn = 0;
    if (millis() - lastSlowWarn > 30000UL) {
      RLOG_WARN("slow frame push: %lu ms for %u bytes — weak WiFi, or the relay is congested",
                pushMs, (unsigned)len);
      lastSlowWarn = millis();
    }
  }

  esp_camera_fb_return(fb);

  // Gap scales with how long the last push actually took: fast/idle link ->
  // short gap -> max fps; congested link -> pushMs grows -> gap grows with
  // it -> backs off automatically instead of adding to the jam.
  delay(computePushDelayMs(pushMs, PUSH_INTERVAL_MUL));
}
