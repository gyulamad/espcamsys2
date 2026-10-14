#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include <Preferences.h>   // flash storage for the settings (part of the ESP32 core)
#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>   // ESP_ARDUINO_VERSION_MAJOR/MINOR/PATCH
#endif

// Wi-Fi networks (one per extender), relay host, camera id, API key and every
// other per-camera setting live in the board's FLASH, not in the source. A
// freshly flashed board has none and asks for them on the serial port; after
// that, each boot shows them and waits 5 s for a "y" to change them. What the
// settings are: settings_schema.h. How they are typed, checked and stored:
// settings_logic.h (plain C++, unit-tested on a desktop — see tests/cpp/). The
// glue to the real flash and serial port is the "Settings glue" block below.
#include "settings_logic.h"
#include "settings_schema.h"

// All the sketch's actual decision-making (debounce, URL/line building,
// frame framing, etc.) lives in logic.h as plain, hardware-free C++ so it
// can be unit-tested on a desktop with g++/gdb — see tests/cpp/. This file
// only reads the hardware and calls into it.
#include "logic.h"
#include "remote_log.h"   // what the camera reports to the relay's log (see the glue block below)
#include <esp_system.h>   // esp_reset_reason()
using namespace esp32cam_logic;
using esp32cam_settings::RecorderSettings;

// The camera's settings, filled in by setupSettings() at the very start of
// setup() and only read afterwards.
RecorderSettings g_cfg;

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
// implementation detail here rather than a setting, unlike the ALARM_*
// settings, which are the "business" parameters someone tuning the alarm
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
// port still gets everything too, unless the LOG_ECHO setting says
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
// The settings it uses are the LOG_* ones (settings_schema.h). This object is
// built before they have been read from flash, so it starts serial-only;
// remoteLogStart() applies the real configuration from g_cfg.

// FW_GIT is the git revision this binary was built from: ota-deploy.sh writes it into
// fw_version.h (gitignored) just before compiling. A sketch built by hand has none and says "dev".
// The over-the-air update compares it with the version the relay publishes (see ota.h).
#if __has_include("fw_version.h")
#include "fw_version.h"
#endif
#ifndef FW_GIT
#define FW_GIT "dev"
#endif
#define FW_BUILD FW_GIT " " __DATE__ " " __TIME__   // identifies which firmware build wrote a log line

void logEcho(void*, LogLevel, const char* line) {
  Serial.println(line);
}

// The configuration the settings ask for (LOG_*).
RemoteLogConfig buildRemoteLogConfig() {
  RemoteLogConfig c;
  c.remoteEnabled   = g_cfg.logEnabled;
  c.remoteMinLevel  = logLevelFromInt(g_cfg.logMinLevel);
  c.echoAlways      = g_cfg.logEcho;
  c.flushIntervalMs = (uint32_t)g_cfg.logFlushSec * 1000UL;
  c.retryPeriodMs   = (uint32_t)g_cfg.logRetrySec * 1000UL;
  c.maxRetries      = (uint8_t)(g_cfg.logRetryMax < 0 ? 0 : (g_cfg.logRetryMax > 255 ? 255 : g_cfg.logRetryMax));
  c.repeatWindowMs  = (uint32_t)g_cfg.logRepeatSec * 1000UL;
  return c;
}

// What the log object is built with, before the settings exist: serial only.
RemoteLogConfig serialOnlyLogConfig() {
  RemoteLogConfig c;
  c.remoteEnabled   = false;
  c.remoteMinLevel  = LogLevel::Info;
  c.echoAlways      = true;
  c.flushIntervalMs = 10000;
  c.retryPeriodMs   = 300000;
  c.maxRetries      = 3;
  c.repeatWindowMs  = 30000;
  return c;
}

RemoteLog remoteLogInstance(serialOnlyLogConfig(), logEcho, nullptr);
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
  std::string url = buildLogUrl(g_cfg.serverHost, g_cfg.httpPort);
  http.begin(String(url.c_str()));
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Api-Key", g_cfg.apiKey.c_str());
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
    send = remoteLogInstance.prepareBatch(now, wifiUp, g_cfg.cameraId.c_str(), FW_BUILD, body, lastSeq);
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
                  detail.c_str(), (unsigned)failed, (unsigned)g_cfg.logRetrySec);
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
  remoteLogInstance.reconfigure(buildRemoteLogConfig());   // from the settings read in setupSettings()
  remoteLogMutex = xSemaphoreCreateMutex();
  if (!g_cfg.logEnabled || !remoteLogMutex) return;   // no mutex, no safe way to share: serial only
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

// ── Firmware update glue ────────────────────────────────────────────────
// Over-the-air updates, server-driven: a background task asks the relay every minute or
// so which firmware is current and, when it differs from FW_GIT, downloads it, flashes it
// and restarts. What it decides: ota_logic.h (unit-tested); the HTTP and flash calls: ota.h.
// Its messages go to the remote log, so the relay's log file shows each step. It runs in
// its own task, never in loop() — HTTP in loop() would stall the stream.
#define OTA_INFO(...) RLOG_INFO(__VA_ARGS__)
#define OTA_WARN(...) RLOG_WARN(__VA_ARGS__)
#include "ota.h"

OtaUpdater otaUpdater("recorder");

void otaTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    otaUpdater.tick(g_cfg.serverHost, g_cfg.httpPort, g_cfg.apiKey, g_cfg.cameraId);
  }
}

// Call once, after the settings are loaded. Pinned to core 0 (where the WiFi stack runs).
void otaStart() {
  xTaskCreatePinnedToCore(otaTask, "ota", 10240, nullptr, 1, nullptr, 0);
}
// ── end of firmware update glue ─────────────────────────────────────────

// Writes `len` bytes to the push socket, retrying partial writes instead of
// treating one short write() as a hard failure. A single write() can
// legitimately return fewer bytes than requested when the TCP send buffer
// fills faster than the relay drains it — common with a weak WiFi signal
// pushing a VGA-sized JPEG frame — and simply calling write() again with
// the remainder is enough to finish the job in that case. Only gives up if
// nothing gets through for PUSH_WRITE_TIMEOUT_MS straight, or the socket
// actually disconnects mid-write.
//
// Giving up costs a dropped connection and a reconnect, which on a weak link is
// itself slow and loses the frame — so it is worth riding out a bad few seconds
// first. (The relay's "is this a second sender?" window must stay shorter than
// this: see LIVE_WINDOW_MS in nodejs/camera-relay/lib/connection.js.)
const unsigned long PUSH_WRITE_TIMEOUT_MS = 8000;
const unsigned long PUSH_SLOW_WARN_MS = 2000;   // a frame that takes longer than this to push is worth a warning —
                                                // and is also when the frames start to be made smaller
const unsigned long PUSH_FAST_MS = 600;         // pushes faster than this, for a while, let the picture improve again
const unsigned long PUSH_MAX_GAP_MS = 1000;     // the pause after a push never exceeds this, however slow it was

// Weak WiFi can't carry full-size frames, so the JPEG quality adapts to the
// link (see adaptJpegQuality() in logic.h). Quality numbers: LOWER = better
// picture, bigger file. The configured quality (set in initCamera()) is the
// best it will ever use; this is the coarsest it will go down to.
const int JPEG_QUALITY_WORST = 45;
JpegQualityAdapter jpegQuality = makeJpegQualityAdapter(12, JPEG_QUALITY_WORST);

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
  if (!pushClient.connect(g_cfg.serverHost.c_str(), g_cfg.pushPort)) {
    return false;
  }
  pushClient.setNoDelay(true);
  std::string authLine = buildAuthLine(g_cfg.cameraId, g_cfg.apiKey);
  pushClient.print(authLine.c_str());
  pushAuthed = true;
  RLOG_INFO("push connection to %s:%d established", g_cfg.serverHost.c_str(), g_cfg.pushPort);
  remoteLogRelayReachable(); // if remote logging had given up, the relay is evidently back
  return true;
}

// FALLBACK alarm report: POSTs http://<SERVER_HOST>:<HTTP_PORT>/alarm/<id>. Used
// only when the in-band alarm can't be (see triggerAlarmRecording()). It
// blocks loop() for up to setTimeout() while it runs — harmless when the push
// connection is down (nothing is streaming anyway), a gap in the footage when
// it's up but the relay is too old for the in-band message. No duration is sent:
// the relay holds the alarm setting (how long to record), editable from the
// dashboard, so it can be changed without reflashing this board. Logged, not
// retried — the next alarm edge gets another chance.
void sendAlarmRequest(const String &id) {
  HTTPClient http;
  std::string url = buildAlarmUrl(g_cfg.serverHost, g_cfg.httpPort, id.c_str());
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
// every camera the relay currently knows about, per the ALARM_ALL_CAMS setting.
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
  std::string targetId = alarmRecordTargetId(g_cfg.alarmRecordAll, g_cfg.cameraId);

  switch (chooseAlarmRoute(pushClient.connected(), relaySupportsInBandAlarm, wifiUp)) {
    case AlarmRoute::InBand: {
      uint8_t msg[ALARM_MESSAGE_LEN];
      encodeAlarmMessage(g_cfg.alarmRecordAll, msg);
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
// the ALARM_ACTIVE level; edges that arrive while a previous trigger is still
// being processed collapse into one, which is fine since a repeat trigger
// only extends the recording anyway.
void checkAlarmTrigger() {
  if (g_cfg.alarmGpioPin < 0) return; // feature turned off — see the ALARM_GPIO_PIN setting
  if (!alarmPending) return;

  alarmPending = false;
  RLOG_INFO("alarm input triggered");
  triggerAlarmRecording();
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
  jpegQuality = makeJpegQualityAdapter(config.jpeg_quality, JPEG_QUALITY_WORST);

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

// Prints this board's identity FIRST, before camera/WiFi init even runs — so
// it is visible even if init fails, and you can confirm which physical board
// this is before re-flashing it.
void printIdentityBanner() {
  Serial.println();
  Serial.println("========================================");
  Serial.printf("  CAMERA_ID: %s\n", g_cfg.cameraId.c_str());
  Serial.println("========================================");
  Serial.println();
}

// The reset reason is the first thing to look at when a camera "just
// rebooted": a BROWNOUT means the power supply dipped, a watchdog means
// something hung, a PANIC means the firmware crashed.
void logBootInfo() {
  int resetReason = (int)esp_reset_reason();
  if (isAbnormalReset(resetReason)) {
    RLOG_ERROR("booted after an abnormal restart: %s", resetReasonName(resetReason));
  } else {
    RLOG_INFO("booted (%s)", resetReasonName(resetReason));
  }
  RLOG_INFO("firmware built %s, camera id %s, free heap %u bytes, PSRAM %s",
            FW_BUILD, g_cfg.cameraId.c_str(), (unsigned)ESP.getFreeHeap(), psramFound() ? "yes" : "no");
#ifdef ESP_ARDUINO_VERSION_MAJOR
  RLOG_INFO("Arduino-ESP32 core %d.%d.%d, ESP-IDF %s", ESP_ARDUINO_VERSION_MAJOR,
            ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH, ESP.getSdkVersion());
#endif
}

// Internal pull-up so the default push-button wiring (pin -> button ->
// GND) reads a clean HIGH when idle and LOW when pressed with no extra
// hardware. A future alarm sensor with its own active-driven output can
// still be read fine through the pull-up; swap to plain INPUT here if
// its datasheet calls for it. Skipped entirely when the feature is off
// (ALARM_GPIO_PIN = -1) — no pin claimed, nothing to configure.
void setupAlarmInput() {
  if (g_cfg.alarmGpioPin < 0) return;

  pinMode(g_cfg.alarmGpioPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(g_cfg.alarmGpioPin), onAlarmEdge,
                  g_cfg.alarmActiveHigh ? RISING : FALLING);
  alarmPending = false;
}

// Brings WiFi up and blocks until one of the configured networks connects.
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // disable modem-sleep power saving — it's the other
                          // big source of added latency on ESP32 WiFi

  for (size_t i = 0; i < g_cfg.wifi.size(); i++) {
    wifiMulti.addAP(g_cfg.wifi[i].ssid.c_str(), g_cfg.wifi[i].pass.c_str());
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

// ── Relay settings link ─────────────────────────────────────────────────
// The Wi-Fi and HTTP half of "ask the relay for the settings this board is
// missing" (see RemoteFill in settings_logic.h, which makes every decision; this
// only joins Wi-Fi and makes one request). It reads what it needs straight from
// flash, because g_cfg can't be loaded yet — that is the whole situation. It runs
// before the camera and before remote logging start, so nothing else competes
// for the radio or the heap. It needs real Wi-Fi, so the desktop tests don't run
// it; the settings glue below is tested against a fake of this class.
class RelaySettingsLink : public esp32cam_settings::IRemoteLink {
public:
  RelaySettingsLink(esp32cam_settings::ISettingsStore& store, const char* type, const char* idKey)
      : store_(store), type_(type), idKey_(idKey) {}

  void startConnecting() override {
    std::vector<esp32cam_settings::WifiNet> nets;
    std::string err;
    esp32cam_settings::parseWifiList(store_.get("WIFI"), nets, err);
    WiFi.mode(WIFI_STA);
    for (size_t i = 0; i < nets.size(); i++) multi_.addAP(nets[i].ssid.c_str(), nets[i].pass.c_str());
  }

  bool online() override { return multi_.run(4000) == WL_CONNECTED; }

  esp32cam_settings::FetchResult fetch(const std::string& needKeys, std::string& line) override {
    // Every value read here was checked by RemoteFill (remoteFillPossible) before it started.
    std::string url = "http://" + store_.get("SERVER_HOST") + ":" + store_.get("HTTP_PORT") +
                      "/device-settings/" + type_ + "/" + store_.get(idKey_) + "?need=" + needKeys;
    HTTPClient http;
    http.begin(String(url.c_str()));
    http.setTimeout(5000);
    http.addHeader("X-Api-Key", store_.get("API_KEY").c_str());
    int code = http.GET();
    esp32cam_settings::FetchResult result = esp32cam_settings::FetchResult::Failed;
    if (code == 200) {
      line = http.getString().c_str();
      result = esp32cam_settings::FetchResult::Got;
    } else if (code == 404) {
      result = esp32cam_settings::FetchResult::NothingStaged;   // nothing staged on the relay (yet)
    }
    http.end();
    return result;
  }

private:
  esp32cam_settings::ISettingsStore& store_;
  std::string type_;
  std::string idKey_;
  WiFiMulti multi_;   // its own: the sketch's global one is for the camera's normal connection
};

// ── Settings glue ───────────────────────────────────────────────────────
// Connects the settings engine (settings_logic.h) to the real flash storage and
// the real serial port, and runs the start-up conversation. All the decisions —
// what is missing, what is valid, what to print, the 5 s window — are made in
// settings_logic.h and unit-tested there; this block only supplies the flash,
// the serial port and the clock, and is itself tested against fakes of them
// (tests/cpp/test_settings_glue.cpp compiles this very block).
using esp32cam_settings::BootConfigFlow;
using esp32cam_settings::IConsole;
using esp32cam_settings::ISettingsStore;
using esp32cam_settings::RECORDER_SCHEMA;
using esp32cam_settings::RemoteFill;
using esp32cam_settings::loadRecorderSettings;
using esp32cam_settings::recorderRemotePrerequisites;

const uint32_t SETTINGS_WINDOW_MS = 5000;          // how long boot waits for a "y" before starting normally
// A board that is MISSING settings (typically after a firmware update added one) first gives the
// serial port SETTINGS_WINDOW_MS to itself, then asks the relay for them (RemoteFill):
const uint32_t REMOTE_CONNECT_MS = 20000;          // how long it gets to join Wi-Fi before restarting to try again
const uint32_t REMOTE_WINDOW_MS = 30000;           // how long it then waits for the relay to supply them
const uint32_t REMOTE_POLL_MS = 5000;              // and how often it asks meanwhile
const char* const SETTINGS_NAMESPACE = "espcam";   // flash (NVS) namespace the settings live in

// The settings in flash, via the core's Preferences library (NVS). Survives
// uploading a new sketch; wiped by "Erase All Flash Before Sketch Upload".
class PreferencesStore : public ISettingsStore {
public:
  PreferencesStore() : ok_(prefs_.begin(SETTINGS_NAMESPACE, false)) {}
  ~PreferencesStore() { prefs_.end(); }
  bool ok() const { return ok_; }

  bool has(const std::string& key) override { return prefs_.isKey(key.c_str()); }
  std::string get(const std::string& key) override {
    String v = prefs_.getString(key.c_str(), "");
    return std::string(v.c_str());
  }
  bool set(const std::string& key, const std::string& value) override {
    return prefs_.putString(key.c_str(), value.c_str()) == value.size();
  }
  void clearAll() override { prefs_.clear(); }

private:
  Preferences prefs_;
  bool ok_;
};

// The serial port: bytes in without waiting, lines out.
class SerialConsole : public IConsole {
public:
  int read() override { return Serial.available() > 0 ? Serial.read() : -1; }
  void println(const std::string& line) override { Serial.println(line.c_str()); }
};

void restartBoard() {
  Serial.flush();
  delay(500);
  ESP.restart();   // does not return
}

// Shows the settings, asks for any that are missing (or lets the user change
// them within the 5 s window), then loads them into g_cfg. If settings were
// changed the board restarts instead of returning, so the new values start clean.
void setupSettings() {
  PreferencesStore store;
  SerialConsole console;
  if (!store.ok()) {
    Serial.println("WARNING: the flash settings storage could not be opened - settings can't be read or saved.");
  }

  BootConfigFlow flow(RECORDER_SCHEMA, store, console, SETTINGS_WINDOW_MS);
  // Missing settings can also come from the relay (staged there by the operator), so a firmware
  // update that needs one more setting doesn't need a USB cable. Only gaps are ever filled, and
  // only if nobody types: see RemoteFill in settings_logic.h.
  RelaySettingsLink link(store, "recorder", "CAMERA_ID");
  RemoteFill remote(RECORDER_SCHEMA, store, link, console, recorderRemotePrerequisites(),
                    REMOTE_CONNECT_MS, REMOTE_WINDOW_MS, REMOTE_POLL_MS);
  flow.attachRemote(&remote, SETTINGS_WINDOW_MS);
  BootConfigFlow::Status status;
  while ((status = flow.step(millis())) == BootConfigFlow::Running) delay(5);

  if (status == BootConfigFlow::Restart) {
    restartBoard();
    return;
  }

  std::string err;
  if (!loadRecorderSettings(store, g_cfg, err)) {
    // Not reachable after the conversation above (it only lets the boot go on
    // when everything is valid), but the camera must never run on bad settings.
    Serial.printf("The stored settings can't be used (%s). Restarting so they can be fixed...\n", err.c_str());
    restartBoard();
  }
}
// ── end of settings glue ────────────────────────────────────────────────

// Which Arduino-ESP32 core and ESP-IDF built this firmware — the first thing to
// know when something behaves differently from another camera.
void printCoreVersion() {
#ifdef ESP_ARDUINO_VERSION_MAJOR
  Serial.printf("Arduino-ESP32 core %d.%d.%d, ESP-IDF %s\n", ESP_ARDUINO_VERSION_MAJOR,
                ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH, ESP.getSdkVersion());
#else
  Serial.printf("Arduino-ESP32 core 1.x (very old), ESP-IDF %s\n", ESP.getSdkVersion());
#endif
}

void setup() {
  // The settings conversation can be fed a long pasted line (a camera's whole
  // configuration); the default 256-byte receive buffer would lose part of it.
  // Must be set before Serial.begin().
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  delay(200); // give the serial monitor a moment to attach

  printCoreVersion();

  // First of all, before the camera, WiFi or remote logging start: show the
  // settings, ask for missing ones, or offer to change them. Returns only when
  // the boot should go on, with g_cfg filled in.
  setupSettings();

  printIdentityBanner();

  // Remote logging starts here, so everything below can report to the relay
  // (entries wait in memory until WiFi is up and are filed under the time they
  // really happened).
  remoteLogStart();
  logBootInfo();

  setupAlarmInput();

  // Camera MUST be initialized before WiFi comes up, not after: the WiFi
  // driver claims a large chunk of internal DRAM for its buffers as soon as
  // it starts, and the camera's DMA frame buffers need a big contiguous
  // block of that same internal RAM. Camera-after-WiFi is exactly what
  // produces "cam_dma_config: frame buffer malloc failed" even on boards
  // that work fine otherwise. If it does fail, we don't return early
  // though — WiFi still needs to come up regardless (see cameraReady above
  // for why), so the failure is only logged here, not fatal to setup().
  cameraReady = initCamera();

  connectWifi();

  // Last, so its stack does not take the memory the camera and the WiFi driver need.
  otaStart();
}

// Periodic identity reminder — so opening the Serial Monitor at any point
// (not just right at boot) still tells you which camera this is.
void logIdentityReminder() {
  static unsigned long lastIdentityPrint = 0;
  if (millis() - lastIdentityPrint <= 10000) return;

  RLOG_DEBUG("[%s] RSSI: %d dBm, uptime: %lus%s",
             g_cfg.cameraId.c_str(), WiFi.RSSI(), millis() / 1000,
             cameraReady ? "" : " (camera not ready)");
  if (ESP.getFreeHeap() < g_cfg.logLowHeapBytes) {
    RLOG_WARN("low free heap (below %u bytes) — a memory leak or fragmentation can end in a crash",
              (unsigned)g_cfg.logLowHeapBytes);
  }
  lastIdentityPrint = millis();
}

// A status line in the relay's log every LOG_HEARTBEAT seconds. A gap
// in these shows when a camera went quiet; the numbers show whether memory
// was shrinking or the signal weakening beforehand.
void logHeartbeat() {
  static unsigned long lastHeartbeat = millis();
  if (millis() - lastHeartbeat <= (unsigned long)g_cfg.logHeartbeatSec * 1000UL) return;

  RLOG_INFO("heartbeat: WiFi '%s', IP %s, RSSI %d dBm, uptime %lus, free heap %u (lowest ever %u), push connection %s",
            WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI(),
            millis() / 1000, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
            pushClient.connected() ? "up" : "down");
  lastHeartbeat = millis();
}

// Cheap when already connected — only scans/reconnects if the link dropped,
// and will fail over to a different extender if the current one is gone.
// Logs each transition once, not every loop. Returns whether WiFi is up.
bool checkWifi() {
  static bool wifiWasUp = true;        // setup() only returns once WiFi is connected
  static unsigned long wifiLostAt = 0;
  bool wifiUp = wifiMulti.run() == WL_CONNECTED;
  if (wifiUp == wifiWasUp) return wifiUp;

  wifiWasUp = wifiUp;
  if (!wifiUp) {
    wifiLostAt = millis();
    RLOG_WARN("WiFi connection lost — reconnecting");
  } else {
    // Same "WiFi '<ssid>', IP <ip>" wording as at boot and in the heartbeat, so
    // one grep shows which network this camera is on and what address it has —
    // a reconnect may well land on another extender with another address.
    RLOG_INFO("reconnected to WiFi '%s', IP %s, RSSI %d dBm after %lus",
              WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI(),
              (millis() - wifiLostAt) / 1000);
  }
  return wifiUp;
}

// Retry periodically rather than being stuck forever. This can only
// recover a genuinely transient failure (e.g. a one-off timing/power
// glitch at boot) — if the camera failed because WiFi already claimed
// the internal DRAM it needs (see the ordering note in setup()), these
// retries will keep failing for the same reason every time, since WiFi
// is already up by the time loop() runs. That's a "camera never came up
// at all" problem to fix at the setup()/hardware level, not something a
// retry can paper over — but retrying here is still strictly better
// than crash-looping ever did.
void retryCameraInit() {
  static unsigned long lastCameraRetry = 0;
  if (millis() - lastCameraRetry <= 5000) return;

  RLOG_WARN("camera not ready — retrying init");
  cameraReady = initCamera();
  if (cameraReady) RLOG_INFO("camera init succeeded on retry");
  lastCameraRetry = millis();
}

// Read what the relay wrote to us. Right after we authenticate it sends two
// single bytes: a legacy "resume" (for old firmware that could be paused —
// nothing to do here) and the capability announcement, which is what
// switches alarms over to the in-band message. Everything is consumed so
// the receive buffer can't slowly fill up; unknown bytes are ignored.
void readRelayBytes() {
  while (pushClient.available()) applyRelayByte(pushClient.read(), relaySupportsInBandAlarm);
}

// At most once per 30 s: a weak link is slow on every frame.
void warnSlowPush(unsigned long pushMs, uint32_t len) {
  static unsigned long lastSlowWarn = 0;
  if (millis() - lastSlowWarn <= 30000UL) return;

  RLOG_WARN("slow frame push: %lu ms for %u bytes — weak WiFi, or the relay is congested",
            pushMs, (unsigned)len);
  lastSlowWarn = millis();
}

// Sets the camera's JPEG quality (lower number = better picture, bigger file).
void applyJpegQuality(int quality) {
  sensor_t *sensor = esp_camera_sensor_get();
  if (!sensor) return;
  sensor->set_quality(sensor, quality);
}

// Shrinks the frames while the link is slow and brings the picture back when
// it recovers, so a weak WiFi signal gives a slower, coarser picture instead
// of a connection that keeps breaking.
void adaptJpegQualityToLink(unsigned long pushMs, bool pushOk) {
  int before = jpegQuality.current;
  int after = adaptJpegQuality(jpegQuality, pushMs, pushOk, PUSH_SLOW_WARN_MS, PUSH_FAST_MS);
  if (after == before) return;

  applyJpegQuality(after);
  RLOG_INFO("%s: JPEG quality %d -> %d (lower = better picture, best %d, coarsest %d)",
            after > before ? "link is slow, sending smaller frames" : "link recovered, improving the picture",
            before, after, jpegQuality.best, jpegQuality.worst);
}

// Pushes one frame ([4-byte length][JPEG]) down the push connection and
// returns how long that took. A failed write drops the connection (loop()
// reconnects next turn).
unsigned long pushFrame(const camera_fb_t *fb) {
  uint32_t len = fb->len;
  uint8_t lenPrefix[4];
  encodeFrameLengthPrefix(len, lenPrefix);

  unsigned long t0 = millis();
  size_t written = writePushBytes(lenPrefix, 4);
  if (written == 4) {
    written += writePushBytes(fb->buf, fb->len);
  }
  unsigned long pushMs = millis() - t0;

  bool pushOk = pushWriteSucceeded(written, len, pushClient.connected());
  adaptJpegQualityToLink(pushMs, pushOk);

  if (!pushOk) {
    RLOG_WARN("push write failed after %lu ms (wrote %u of %u bytes, %s) — dropping the connection, reconnecting",
              pushMs, (unsigned)written, (unsigned)(len + 4),
              pushClient.connected() ? "still connected" : "disconnected");
    pushClient.stop();
    return pushMs;
  }
  if (pushMs > PUSH_SLOW_WARN_MS) warnSlowPush(pushMs, len);
  return pushMs;
}

void loop() {
  logIdentityReminder();
  logHeartbeat();

  if (!checkWifi()) {
    delay(500);
    return;
  }

  // Polled every loop, independent of push-connection/camera state below,
  // so the alarm keeps working even while this camera is mid-reconnect or
  // waiting on the camera to come up.
  checkAlarmTrigger();

  if (!cameraReady) {
    retryCameraInit();
    delay(200);
    return;
  }

  if (!ensurePushConnection()) {
    RLOG_WARN("push connection to %s:%d failed — will keep retrying", g_cfg.serverHost.c_str(), g_cfg.pushPort);
    delay(500);
    return;
  }

  readRelayBytes();

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    RLOG_ERROR("frame capture failed (the camera returned no frame) — the camera or its power supply may be faulty");
    delay(200);
    return;
  }

  unsigned long pushMs = pushFrame(fb);
  esp_camera_fb_return(fb);

  // Gap scales with how long the last push actually took: fast/idle link ->
  // short gap -> max fps; congested link -> pushMs grows -> gap grows with
  // it -> backs off automatically instead of adding to the jam — but only up
  // to PUSH_MAX_GAP_MS: on a weak link the push itself is already the slow
  // part, and a long pause just makes the picture older.
  delay(computePushDelayMs(pushMs, g_cfg.pushGapMul, PUSH_MAX_GAP_MS));
}
