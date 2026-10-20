#include <Arduino.h>
#include "esp_camera.h"
#include "esp_heap_caps.h"

#include <string>
#include <Preferences.h>   // flash storage for the settings (part of the ESP32 core)
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include "img_converters.h"              // fmt2jpg()

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>        // ESP_ARDUINO_VERSION_MAJOR/MINOR/PATCH
#endif

// This sketch needs the esp32 Arduino core 3.x (the esp-tflite-micro component
// it uses does not build on 2.x). Better a clear message than pages of errors.
// (Check yours: Arduino IDE > Tools > Board > Boards Manager > "esp32", or
// `arduino-cli core list`; the version is also printed at boot.)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR < 3
#error "ESP32_CAM_TFLite_Person needs the esp32 Arduino core 3.x - update it in the Boards Manager"
#endif

// Every per-camera setting (the GPIO, the thresholds, and the optional live
// view: Wi-Fi, the relay, ...) lives in the board's FLASH, not in the source. A
// freshly flashed board has none and asks for them on the serial port; after
// that, each boot shows them and waits 5 s for a "y" to change them.
// What the settings are: settings_schema.h. How they are typed, checked and
// stored: settings_logic.h (plain C++, unit-tested on a desktop — see tests/cpp/).
// The glue to the real flash and serial port is the "Settings glue" block below.
#include "settings_logic.h"
#include "settings_schema.h"
#include "scene_logic.h"   // darkness + motion gate: when is it worth running the model?
#include "report_logic.h"  // what is sent to the relay for the dashboard, and the connection that carries it
#include "remote_log.h"    // what this board reports to the relay's log (see the glue block below)
#include <esp_system.h>    // esp_reset_reason()
#include <errno.h>
#include <lwip/sockets.h>  // recv(): notice a connection the relay has closed (see WifiUplinkEnv::isOpen())

// ── Live view (optional) ────────────────────────────────────────────────
// With the STREAM_ENABLED setting on, the detector also joins Wi-Fi (any of
// several networks, like the recorder) and keeps ONE connection open to the
// relay, pushing its 96x96 grayscale picture and the numbers behind its alarm
// line up it. The dashboard shows them under the camera the detector belongs to,
// so the camera can be aimed and the thresholds tuned with visual confirmation.
// The detector connects OUT, so it can sit behind a NAT router: it serves
// nothing, and has no port, user or password for anyone to be given.
//
// A detector is installed where nobody can plug a cable in, so everything it has
// to say about itself — why it cannot reach the relay, what the relay answered,
// a camera or model that would not start, a picture it could not encode — goes
// to the relay's log file too, not only to the serial port (remote logging glue
// below). Detection never waits for any of it: all networking runs in its own
// tasks, and with no Wi-Fi the detector works exactly as before. With
// STREAM_ENABLED=0 no Wi-Fi is started at all.

// FW_GIT is the git revision this binary was built from: ota-deploy.sh writes it into
// fw_version.h (gitignored) just before compiling. A sketch built by hand has none and says "dev".
// The over-the-air update compares it with the version the relay publishes (see ota.h).
#if __has_include("fw_version.h")
#include "fw_version.h"
#endif
#ifndef FW_GIT
#define FW_GIT "dev"
#endif
#define FW_BUILD FW_GIT " " __DATE__ " " __TIME__   // which firmware build wrote a log line

// ── Developer switches (not per-camera settings: edit here and re-flash) ──
// Print person/no-person scores for every inference.
#define PRINT_DETECTION_SCORES 1
// Print startup and initialization information.
#define PRINT_STARTUP_INFO 1
// Print the scene gate's readings (average brightness and motion sum) for EVERY frame.
// Off by default (it is a lot of output); switch it on while choosing DARK_THRESH
// and MOTION_THRESH: watch the numbers in the dark, in daylight, and when you walk by.
#define PRINT_SCENE_READINGS 1
// Tensor arena size: the base size used by the Espressif v1.3.3
// person-detection example. Tied to the model compiled in below.
#define TENSOR_ARENA_SIZE (100 * 1024)

using esp32cam_settings::PersonSettings;

// The camera's settings, filled in by setupSettings() at the very start of
// setup() and only read afterwards.
PersonSettings g_cfg;

// What remote_log.h provides (the same file the recorder uses).
using esp32cam_logic::LogLevel;
using esp32cam_logic::LogUplink;
using esp32cam_logic::RemoteLog;
using esp32cam_logic::RemoteLogConfig;
using esp32cam_logic::LOG_MSG_MAX;
using esp32cam_logic::LOG_SITE_MAX;
using esp32cam_logic::formatCallSite;
using esp32cam_logic::isAbnormalReset;
using esp32cam_logic::resetReasonName;

// ── Remote logging glue ─────────────────────────────────────────────────
// A detector is installed where nobody can plug a cable in: when something goes wrong there is nobody to read
// what the board printed. Everything this sketch reports about itself — why it cannot reach the relay, what
// the relay answered, a camera or a model that would not start, a picture it could not encode, when the alarm
// line moved — is therefore ALSO sent to the relay (POST /log), which writes it into its log file on the Pi
// with the call site, the free heap, the Wi-Fi signal and the uptime. The serial port still gets everything,
// and is all that remains while the relay cannot be reached.
//
// What to send and when, the in-memory queue, the retry and give-up policy: remote_log.h (the same file the
// recorder uses), plain C++ unit-tested on a desktop. This block supplies the clock, the serial port and the
// HTTP call. The HTTP request runs in its OWN background task, never in loop(): over weak Wi-Fi it can take
// seconds, and detection must never wait for it.
//
// Usage anywhere below:  RLOG_INFO("connected, RSSI %d", rssi);  — printf-style, at levels RLOG_DEBUG /
// RLOG_INFO / RLOG_WARN / RLOG_ERROR. (Not LOG_*: the ESP32 toolchain's syslog headers define those names.)
//
// There are no LOG_* settings on the detector (they would make every board that is updated ask for them):
// remote logging is on whenever the live view is (STREAM_ENABLED=1), at INFO and above.

void logEcho(void*, LogLevel, const char* line) {
  Serial.println(line);
}

// The log's configuration: remote delivery only if the live view (and so Wi-Fi) is on.
RemoteLogConfig remoteLogConfigFor(bool remote) {
  RemoteLogConfig c;
  c.remoteEnabled   = remote;
  c.remoteMinLevel  = LogLevel::Info;
  c.echoAlways      = true;      // the serial port always gets everything too
  c.flushIntervalMs = 10000;     // routine entries wait this long so they go out together (warnings go at once)
  c.retryPeriodMs   = 30000;     // after a failed delivery
  c.maxRetries      = 3;         // ...then give up (serial only) until the uplink to the relay is up again
  c.repeatWindowMs  = 30000;     // an identical message inside this window is counted, not repeated
  return c;
}

// Built before the settings exist: serial only. remoteLogConfigure() applies the real configuration.
RemoteLog remoteLogInstance(remoteLogConfigFor(false), logEcho, nullptr);
SemaphoreHandle_t remoteLogMutex = nullptr;   // guards remoteLogInstance: loop() and the tasks log, one task sends

// Holds the mutex for the duration of a scope. (A no-op before remoteLogStart() creates it — setup() is
// single-threaded until then.)
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

// One HTTP delivery. true only for a 2xx answer — the relay says 200 only once the entries are in its file,
// so anything else (no connection, wrong key, relay can't write its log) leaves them in memory for a retry.
bool postLogBatch(const std::string &body, String &detail) {
  HTTPClient http;
  std::string url = person_report::buildLogUrl(g_cfg.serverHost, g_cfg.httpPort);
  http.begin(String(url.c_str()));
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Api-Key", g_cfg.apiKey.c_str());
  int code = http.POST((uint8_t *)body.data(), body.size());
  detail = (code > 0) ? String("HTTP ") + code : http.errorToString(code);
  http.end();
  return code >= 200 && code < 300;
}

// One pass of the delivery task: ask the core whether a delivery is due, make the HTTP request if so
// (OUTSIDE the lock — it can be slow), and report the outcome.
void remoteLogPump() {
  uint32_t now = millis();
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  std::string body;
  uint32_t lastSeq = 0;
  bool send;
  {
    RemoteLogLock lock;
    remoteLogInstance.tick(now, (int32_t)ESP.getFreeHeap(), wifiUp ? (int32_t)WiFi.RSSI() : 0);
    send = remoteLogInstance.prepareBatch(now, wifiUp, g_cfg.detectorId.c_str(), FW_BUILD, body, lastSeq);
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

  // Reported on the serial port ONLY: logging a logging failure through the same channel would feed itself.
  if (gaveUp) {
    Serial.printf("[log] giving up on remote logging after %u failed deliveries (%s) — serial only until the relay is reachable again\n",
                  (unsigned)failed, detail.c_str());
  } else {
    Serial.printf("[log] could not deliver log entries (%s) — delivery %u failed, retrying in 30 s\n",
                  detail.c_str(), (unsigned)failed);
  }
}

void remoteLogTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(250));
    remoteLogPump();
  }
}

// Applies the log's real configuration. Call once, right after setupSettings(): from then on what is logged
// is queued for the relay (and delivered as soon as Wi-Fi and the task below are up).
void remoteLogConfigure() {
  remoteLogInstance.reconfigure(remoteLogConfigFor(g_cfg.streamEnabled));
}

// Starts the delivery task. Called from startNetwork(), after the camera and the model have their memory.
// Pinned to core 0 (where the Wi-Fi stack runs) so it never competes with loop() on core 1.
void remoteLogStart() {
  remoteLogMutex = xSemaphoreCreateMutex();
  if (!g_cfg.streamEnabled || !remoteLogMutex) return;   // no mutex, no safe way to share: serial only
  xTaskCreatePinnedToCore(remoteLogTask, "remoteLog", 8192, nullptr, 1, nullptr, 0);
}

// The uplink to the relay just came up: if remote logging had been given up on, resume it.
void remoteLogRelayReachable() {
  bool resumed;
  {
    RemoteLogLock lock;
    resumed = remoteLogInstance.onRelayReachable();
  }
  if (resumed) RLOG_INFO("remote logging resumed — the relay is reachable again");
}
// ── end of remote logging glue ──────────────────────────────────────────

#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include "person_detect_model_data.h"


// ============================================================
// AI Thinker ESP32-CAM pin configuration
// ============================================================

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


// ============================================================
// Model parameters
// ============================================================

constexpr int IMAGE_WIDTH  = 96;
constexpr int IMAGE_HEIGHT = 96;
constexpr int IMAGE_CHANNELS = 1;
constexpr int IMAGE_SIZE =
    IMAGE_WIDTH * IMAGE_HEIGHT * IMAGE_CHANNELS;


// ============================================================
// TFLite Micro globals
// ============================================================

const tflite::Model *model = nullptr;

tflite::MicroInterpreter *interpreter = nullptr;

TfLiteTensor *input = nullptr;

uint8_t *tensor_arena = nullptr;


// ============================================================
// Detection state
// ============================================================

bool personDetected = false;


// ============================================================
// Scene gate (darkness + motion)
// ============================================================
//
// Every frame is sampled (every 10th pixel in both directions) for its average
// brightness and its change since the previous frame; the model only runs on
// frames that are bright enough and have seen motion lately — see scene_logic.h.

person_scene::SceneSampler g_sampler(IMAGE_WIDTH, IMAGE_HEIGHT);
person_scene::SceneGate g_gate;

// Hands the DARK_THRESH / MOTION_THRESH / MOTION_HOLD_S settings to the gate.
void configureScene()
{
    person_scene::SceneConfig scene;
    scene.darkBelow = g_cfg.darkThreshold;
    scene.motionAtLeast = g_cfg.motionThreshold;
    scene.holdMs = g_cfg.motionHoldSec * 1000UL;
    g_gate.configure(scene);
}


// ============================================================
// Camera initialization
// ============================================================

bool initCamera()
{
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

    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;

    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;

    config.xclk_freq_hz = 15000000;

    // The v1.3.3 model expects 96x96 grayscale input.
    config.pixel_format = PIXFORMAT_GRAYSCALE;
    config.frame_size = FRAMESIZE_96X96;

    config.jpeg_quality = 12;

    // Only one frame is needed.
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

    esp_err_t err = esp_camera_init(&config);

    if (err != ESP_OK)
    {
        RLOG_ERROR(
            "Camera init failed: 0x%x (%s)%s",
            (unsigned)err,
            esp_err_to_name(err),
            person_report::cameraErrorHint((int)err)
        );

        return false;
    }

    // Orientation: keep this identical to ESP32_CAM_Recorder, which leaves
    // the sensor at its default (no flip/mirror) and looks upright in this
    // mounting. The person-detection model also expects upright images.
    // If your board is mounted differently, change BOTH sketches together
    // (set_vflip + set_hmirror = 180-degree rotation).
    sensor_t *sensor = esp_camera_sensor_get();

    if (sensor)
    {
        sensor->set_vflip(sensor, 0);
        sensor->set_hmirror(sensor, 0);
    }

    return true;
}


// ============================================================
// TFLite Micro initialization
// ============================================================

bool initTFLite()
{
    // The official v1.3.3 example allocates the tensor arena
    // from internal RAM.
    tensor_arena = (uint8_t *)heap_caps_malloc(
        TENSOR_ARENA_SIZE,
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
    );

    if (!tensor_arena)
    {
        RLOG_ERROR(
            "Could not allocate the %d byte tensor arena - the largest free internal block is only %u bytes",
            TENSOR_ARENA_SIZE,
            (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
        );

        return false;
    }

#if PRINT_STARTUP_INFO
    Serial.printf(
        "Tensor arena: %d bytes\n",
        TENSOR_ARENA_SIZE
    );
#endif


    // --------------------------------------------------------
    // Load model
    // --------------------------------------------------------

    model = tflite::GetModel(
        g_person_detect_model_data
    );

    if (model->version() != TFLITE_SCHEMA_VERSION)
    {
        RLOG_ERROR(
            "Model schema version %d, expected %d - the model does not match the TFLite library",
            (int)model->version(),
            TFLITE_SCHEMA_VERSION
        );

        return false;
    }


    // --------------------------------------------------------
    // Register only the operators required by this model.
    //
    // These are the same five operators used by Espressif's
    // v1.3.3 person-detection example.
    // --------------------------------------------------------

    static tflite::MicroMutableOpResolver<5> resolver;

    resolver.AddAveragePool2D();
    resolver.AddConv2D();
    resolver.AddDepthwiseConv2D();
    resolver.AddReshape();
    resolver.AddSoftmax();


    // --------------------------------------------------------
    // Create interpreter
    // --------------------------------------------------------

    static tflite::MicroInterpreter static_interpreter(
        model,
        resolver,
        tensor_arena,
        TENSOR_ARENA_SIZE
    );

    interpreter = &static_interpreter;


    // --------------------------------------------------------
    // Allocate model tensors
    // --------------------------------------------------------

    if (interpreter->AllocateTensors() != kTfLiteOk)
    {
        RLOG_ERROR(
            "AllocateTensors() failed - the %d byte tensor arena is too small for the model",
            TENSOR_ARENA_SIZE
        );

        return false;
    }


    // --------------------------------------------------------
    // Get model input
    // --------------------------------------------------------

    input = interpreter->input(0);

#if PRINT_STARTUP_INFO
    Serial.printf(
        "Model input: %d x %d x %d\n",
        input->dims->data[1],
        input->dims->data[2],
        input->dims->data[3]
    );
#endif

    return true;
}


// ── Relay settings link ─────────────────────────────────────────────────
// The Wi-Fi and HTTP half of "ask the relay for the settings this board is
// missing" (see RemoteFill in settings_logic.h, which makes every decision; this
// only joins Wi-Fi and makes one request). It reads what it needs straight from
// flash, because g_cfg can't be loaded yet — that is the whole situation. It runs
// before the camera and the live view start, so nothing else competes
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
// (tests/cpp/test_person_settings_glue.cpp compiles this very block).
using esp32cam_settings::BootConfigFlow;
using esp32cam_settings::IConsole;
using esp32cam_settings::ISettingsStore;
using esp32cam_settings::PERSON_SCHEMA;
using esp32cam_settings::RemoteFill;
using esp32cam_settings::loadPersonSettings;
using esp32cam_settings::personRemotePrerequisites;

const uint32_t SETTINGS_WINDOW_MS = 5000;          // how long boot waits for a "y" before starting normally
// A board that is MISSING settings (typically after a firmware update added one) first gives the
// serial port SETTINGS_WINDOW_MS to itself, then asks the relay for them (RemoteFill). Only possible
// when the live-view settings (Wi-Fi, server, key, id) are stored: a detector run without the
// live view has no network settings and is configured over serial only.
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

  BootConfigFlow flow(PERSON_SCHEMA, store, console, SETTINGS_WINDOW_MS);
  // Missing settings can also come from the relay (staged there by the operator), so a firmware
  // update that needs one more setting doesn't need a USB cable. Only gaps are ever filled, and
  // only if nobody types: see RemoteFill in settings_logic.h.
  RelaySettingsLink link(store, "detector", "DETECTOR_ID");
  RemoteFill remote(PERSON_SCHEMA, store, link, console, personRemotePrerequisites(),
                    REMOTE_CONNECT_MS, REMOTE_WINDOW_MS, REMOTE_POLL_MS);
  flow.attachRemote(&remote, SETTINGS_WINDOW_MS);
  BootConfigFlow::Status status;
  while ((status = flow.step(millis())) == BootConfigFlow::Running) delay(5);

  if (status == BootConfigFlow::Restart) {
    restartBoard();
    return;
  }

  std::string err;
  if (!loadPersonSettings(store, g_cfg, err)) {
    // Not reachable after the conversation above (it only lets the boot go on
    // when everything is valid), but the detector must never run on bad settings.
    Serial.printf("The stored settings can't be used (%s). Restarting so they can be fixed...\n", err.c_str());
    restartBoard();
  }
}
// ── end of settings glue ────────────────────────────────────────────────

// Which Arduino-ESP32 core and ESP-IDF built this firmware — the first thing to
// know when something behaves differently from another board.
void printCoreVersion() {
#ifdef ESP_ARDUINO_VERSION_MAJOR
  Serial.printf("Arduino-ESP32 core %d.%d.%d, ESP-IDF %s\n", ESP_ARDUINO_VERSION_MAJOR,
                ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH, ESP.getSdkVersion());
#else
  Serial.printf("Arduino-ESP32 core 1.x (very old), ESP-IDF %s\n", ESP.getSdkVersion());
#endif
}


// ============================================================
// Wi-Fi and the uplink to the relay
// ============================================================
//
// Everything network-related runs in background tasks on core 0 (where the Wi-Fi stack lives); the
// detection loop on core 1 only ever calls the three report*() hooks below, none of which waits for
// long. So a missing network, a slow link or an unreachable relay cannot delay a detection.
//
// The network task:
//   1. keeps Wi-Fi connected, choosing among the WIFI setting's networks (as the recorder does), and
//      says in the log when it connects, when it is lost and for how long;
//   2. keeps the UPLINK to the relay up and sends on it, several times a second, the 96x96 picture and
//      the readings (brightness, motion, person score, thresholds, alarm pin level). The detector
//      connects OUT, so it can sit behind a NAT router; the relay hands the picture to the dashboard.
//      All the decisions, and EVERY failure message, live in report_logic.h (UplinkSession: unit-tested
//      against a fake socket, and run against the real relay by tests/e2e/test_detector_firmware_e2e.js);
//      WifiUplinkEnv below only supplies the socket, the JPEG encoder and the snapshot;
//   3. checks for a firmware update (does nothing unless one is due);
//   4. writes a status line to the relay's log every ANN_HEARTBEAT seconds.
// The remoteLog task (see the remote logging glue above) delivers the log entries to the relay.

WiFiMulti wifiMulti;

// ── The detection loop's snapshot ────────────────────────────
// The loop drops its latest readings and frame here (three tiny functions, none of which waits for
// long); the network task takes them from here to send. Created in startNetwork(); until then, and
// with the live view off, the hooks do nothing.

person_report::Snapshot reportSnap;           // guarded by reportMutex
uint8_t *reportFrame = nullptr;               // the frame that belongs to reportSnap
SemaphoreHandle_t reportMutex = nullptr;

// Called by the detection loop for every good frame.
void reportSceneFrame(const uint8_t *gray, int brightness, uint32_t motion, person_scene::SceneState state)
{
    if (!reportMutex || !reportFrame || xSemaphoreTake(reportMutex, pdMS_TO_TICKS(2)) != pdTRUE)
    {
        return;
    }

    memcpy(reportFrame, gray, IMAGE_SIZE);
    reportSnap.valid = true;
    reportSnap.seq++;
    reportSnap.brightness = brightness;
    reportSnap.motion = motion;
    reportSnap.gate = person_report::gateFor(state, g_cfg.darkThreshold, g_cfg.motionThreshold);
    reportSnap.detected = personDetected;
    xSemaphoreGive(reportMutex);
}

// Called after every inference.
void reportScore(float score)
{
    if (!reportMutex || xSemaphoreTake(reportMutex, pdMS_TO_TICKS(2)) != pdTRUE)
    {
        return;
    }

    reportSnap.hasScore = true;
    reportSnap.score = score;
    reportSnap.scoreAtMs = millis();
    xSemaphoreGive(reportMutex);
}

// Called whenever the alarm GPIO changes.
void reportPersonState(bool detected)
{
    if (reportMutex && xSemaphoreTake(reportMutex, pdMS_TO_TICKS(2)) == pdTRUE)
    {
        reportSnap.detected = detected;
        xSemaphoreGive(reportMutex);
    }

    // The relay's log keeps when the alarm line moved — what you want to know the morning after.
    RLOG_INFO("alarm line GPIO %d %s", g_cfg.personGpio, detected ? "HIGH: person detected" : "LOW: clear");
}

// ── Firmware update ─────────────────────────────────────────
// Over-the-air updates, server-driven: the network task asks the relay every minute or so which
// firmware is current and, when it differs from FW_GIT, downloads it, flashes it and restarts. What it
// decides: ota_logic.h (unit-tested); the HTTP and flash calls: ota.h. Its messages go to the remote
// log, so the relay's log file shows each step.
#define OTA_INFO(...) RLOG_INFO(__VA_ARGS__)
#define OTA_WARN(...) RLOG_WARN(__VA_ARGS__)
#include "ota.h"

OtaUpdater otaUpdater("detector");

// ── Uplink glue ─────────────────────────────────────────────
// What UplinkSession (report_logic.h) needs from the board: a socket, the JPEG encoder, the detection
// loop's snapshot, the board's address and signal, and the log.
class WifiUplinkEnv : public person_report::IUplinkEnv
{
public:
    uint32_t nowMs() override
    {
        return millis();
    }

    // Opens the TCP connection, telling a DNS failure from a connect failure (they have different cures).
    bool open(const std::string &host, int port, uint32_t timeoutMs, std::string &why) override
    {
        client_.stop();

        IPAddress ip;

        if (!WiFi.hostByName(host.c_str(), ip))
        {
            why = "cannot resolve '" + host + "' (DNS) - put the relay's IP address in SERVER_HOST";

            return false;
        }

        if (!client_.connect(ip, (uint16_t)port, (int32_t)timeoutMs))
        {
            char buf[120];

            snprintf(
                buf, sizeof(buf),
                "TCP connect failed - relay down, wrong SERVER_HOST/HTTP_PORT, or a firewall (Wi-Fi %d dBm)",
                (int)WiFi.RSSI()
            );

            why = buf;

            return false;
        }

        client_.setNoDelay(true);   // small messages, several a second: don't hold them back to fill a packet

        return true;
    }

    // Open while the relay has not closed its end. WiFiClient::connected() cannot say: it counts an
    // orderly close (a FIN) as still connected, and only a failed write shows it. So look at the socket
    // itself: a peek that returns 0 IS a close — which is how a relay that refuses and hangs up, or one
    // that is restarted, is noticed at once instead of two messages later.
    bool isOpen() override
    {
        if (!client_.connected())
        {
            return false;
        }

        int fd = client_.fd();

        if (fd < 0)
        {
            return false;
        }

        uint8_t c;
        int n = recv(fd, &c, 1, MSG_PEEK | MSG_DONTWAIT);

        if (n > 0)
        {
            return true;    // something is waiting to be read: still open (as connected() counts it)
        }

        if (n == 0)
        {
            return false;   // orderly close by the relay
        }

        return errno == EWOULDBLOCK || errno == EAGAIN;   // nothing to read yet = open; anything else = broken
    }

    // Writes everything or reports how far it got. A relay that accepts nothing for stallMs is given up
    // on (STREAM_WR_TMO_S) — as in the recorder's push connection.
    size_t send(const uint8_t *data, size_t len, uint32_t stallMs) override
    {
        size_t total = 0;
        uint32_t lastProgress = millis();

        while (total < len)
        {
            if (!client_.connected())
            {
                break;
            }

            size_t n = client_.write(data + total, len - total);

            if (n > 0)
            {
                total += n;
                lastProgress = millis();
            }
            else if ((uint32_t)(millis() - lastProgress) >= stallMs)
            {
                break;
            }
            else
            {
                delay(2);
            }
        }

        return total;
    }

    size_t receive(uint8_t *buf, size_t cap) override
    {
        int available = client_.available();

        if (available <= 0)
        {
            return 0;
        }

        int n = client_.read(buf, (size_t)available < cap ? (size_t)available : cap);

        return n > 0 ? (size_t)n : 0;
    }

    void close() override
    {
        client_.stop();
    }

    // The detection loop's latest readings and frame. The frame is copied only when it is a new one.
    bool takeSnapshot(person_report::Snapshot &snap, uint8_t *frame, uint32_t haveSeq) override
    {
        if (!reportMutex || !reportFrame || xSemaphoreTake(reportMutex, pdMS_TO_TICKS(20)) != pdTRUE)
        {
            return false;
        }

        bool valid = reportSnap.valid;

        if (valid)
        {
            snap = reportSnap;

            if (snap.seq != haveSeq)
            {
                memcpy(frame, reportFrame, IMAGE_SIZE);
            }
        }

        xSemaphoreGive(reportMutex);

        return valid;
    }

    bool encodeJpeg(const uint8_t *gray, std::string &jpeg) override
    {
        uint8_t *buf = nullptr;
        size_t len = 0;

        bool ok = fmt2jpg(
            (uint8_t *)gray, IMAGE_SIZE, IMAGE_WIDTH, IMAGE_HEIGHT, PIXFORMAT_GRAYSCALE,
            g_cfg.streamJpegQuality, &buf, &len
        );

        if (ok && buf && len > 0)
        {
            jpeg.assign((const char *)buf, len);
        }

        if (buf)
        {
            free(buf);
        }

        return ok && len > 0;
    }

    person_report::Telemetry telemetry() override
    {
        person_report::Telemetry t;

        t.ip = WiFi.localIP().toString().c_str();
        t.rssi = WiFi.RSSI();
        t.heap = ESP.getFreeHeap();

        return t;
    }

    // The session's messages go to the log (serial + the relay's file). "%s" keeps a '%' in a message
    // from being read as a format.
    void log(person_report::Level level, const std::string &message) override
    {
        switch (level)
        {
        case person_report::Level::Debug:
            RLOG_DEBUG("%s", message.c_str());
            break;
        case person_report::Level::Info:
            RLOG_INFO("%s", message.c_str());
            break;
        case person_report::Level::Warn:
            RLOG_WARN("%s", message.c_str());
            break;
        case person_report::Level::Error:
        default:
            RLOG_ERROR("%s", message.c_str());
            break;
        }
    }

    void relayReachable() override
    {
        remoteLogRelayReachable();
    }

private:
    WiFiClient client_;
};

// What the Wi-Fi is doing, once per event instead of once per pass.
void logWifi(const person_report::WifiEvent &ev)
{
    using person_report::WifiEvent;

    switch (ev.kind)
    {
    case WifiEvent::Connected:
        RLOG_INFO(
            "Wi-Fi connected to '%s', IP %s, %d dBm",
            WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI()
        );
        break;
    case WifiEvent::Reconnected:
        RLOG_INFO(
            "Wi-Fi back on '%s', IP %s, %d dBm (it was down for %s)",
            WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
            person_report::formatDuration(ev.downForMs).c_str()
        );
        break;
    case WifiEvent::Lost:
        RLOG_WARN("Wi-Fi connection lost - reconnecting");
        break;
    case WifiEvent::StillDown:
        // The same words every time, so the log collapses the repeats; the status says what is wrong.
        RLOG_WARN("Wi-Fi still not connected: %s", person_report::wifiStatusName((int)WiFi.status()));
        break;
    default:
        break;
    }
}

// The periodic status: where the board is, how it is doing, how the link is. Two short lines (the log
// keeps 160 bytes per message).
void logHeartbeat(person_report::UplinkSession &session)
{
    RLOG_INFO(
        "heartbeat: Wi-Fi '%s', IP %s, %d dBm, up %s, free heap %u (lowest %u)",
        WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
        person_report::formatDuration(millis()).c_str(),
        (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap()
    );

    RLOG_INFO("heartbeat: %s", session.describe().c_str());

    // JPEG encoding, the HTTP calls of the firmware update and the uplink all run on this task's stack.
    unsigned left = (unsigned)uxTaskGetStackHighWaterMark(nullptr);

    if (left < 1024)
    {
        RLOG_WARN("the network task has only %u bytes of stack left at its worst - raise its size in startNetwork()", left);
    }
}
// ── end of uplink glue ──────────────────────────────────────

// ── The task ────────────────────────────────────────────────

void networkTask(void *)
{
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);   // modem-sleep adds latency to every request

    for (size_t i = 0; i < g_cfg.wifi.size(); i++)
    {
        wifiMulti.addAP(g_cfg.wifi[i].ssid.c_str(), g_cfg.wifi[i].pass.c_str());
    }

    WifiUplinkEnv env;
    person_report::UplinkConfig ucfg;

    ucfg.host = g_cfg.serverHost;
    ucfg.port = g_cfg.httpPort;
    ucfg.detectorId = g_cfg.detectorId;
    ucfg.apiKey = g_cfg.apiKey;
    ucfg.frameBytes = IMAGE_SIZE;
    ucfg.writeStallMs = (uint32_t)g_cfg.streamWriteTimeoutSec * 1000UL;
    ucfg.minFrameGapMs = 1000UL / (uint32_t)g_cfg.streamMaxFps;    // STREAM_MAX_FPS is 1..30
    ucfg.retryMaxMs = (uint32_t)g_cfg.announceRetrySec * 1000UL;
    ucfg.report.detectorId = g_cfg.detectorId;
    ucfg.report.fw = FW_BUILD;
    ucfg.report.gpioPin = g_cfg.personGpio;
    ucfg.report.darkBelow = g_cfg.darkThreshold;
    ucfg.report.motionAtLeast = g_cfg.motionThreshold;
    ucfg.report.holdSec = g_cfg.motionHoldSec;
    ucfg.report.detectAt = g_cfg.detectThreshold;
    ucfg.report.clearAt = g_cfg.clearThreshold;

    person_report::UplinkSession session(ucfg, env);
    person_report::WifiWatch wifiWatch(10000);
    person_report::Every heartbeat((uint32_t)g_cfg.announceHeartbeatSec * 1000UL);

    for (;;)
    {
        // May block for several seconds while it scans / connects — fine, nothing else runs in this task
        // and detection is on the other core.
        bool up = wifiMulti.run() == WL_CONNECTED;

        logWifi(wifiWatch.update(millis(), up));

        if (up)
        {
            // Firmware update check (does nothing unless one is due).
            otaUpdater.tick(g_cfg.serverHost, g_cfg.httpPort, g_cfg.apiKey, g_cfg.detectorId);
        }

        session.step(up);

        if (heartbeat.due(millis()))
        {
            logHeartbeat(session);
        }

        vTaskDelay(pdMS_TO_TICKS(up ? 10 : 500));
    }
}

// Starts the live view. Called from setup() AFTER the camera and the model have their memory (the Wi-Fi
// driver claims a lot of internal RAM, and the tensor arena needs one big block of it). Returns false,
// leaving the detector running without a live view, if it can't start — and says why, loudly.
bool startNetwork()
{
    reportFrame = (uint8_t *)malloc(IMAGE_SIZE);
    reportMutex = xSemaphoreCreateMutex();

    if (!reportFrame || !reportMutex)
    {
        RLOG_ERROR("live view OFF: out of memory for the picture snapshot (free heap %u bytes)", (unsigned)ESP.getFreeHeap());

        // The hooks do nothing unless both exist.
        free(reportFrame);
        reportFrame = nullptr;

        if (reportMutex)
        {
            vSemaphoreDelete(reportMutex);
            reportMutex = nullptr;
        }

        return false;
    }

    remoteLogStart();

    // 16 KB: JPEG encoding, the HTTP calls of the firmware update (and its flash writes) and the uplink
    // all run on this stack. The heartbeat line reports how much of it was ever left.
    if (xTaskCreatePinnedToCore(networkTask, "network", 16384, nullptr, 1, nullptr, 0) != pdPASS)
    {
        RLOG_ERROR("live view OFF: could not start the network task (free heap %u bytes)", (unsigned)ESP.getFreeHeap());

        return false;
    }

    RLOG_INFO(
        "live view starting: Wi-Fi, then the relay at %s:%d as '%s'",
        g_cfg.serverHost.c_str(), g_cfg.httpPort, g_cfg.detectorId.c_str()
    );

    return true;
}
// ── end of network task and start ───────────────────────────


// ============================================================
// GPIO / detection state
// ============================================================

void setPersonDetected(bool detected)
{
    // Avoid repeatedly calling digitalWrite() when the state
    // has not changed.
    if (detected == personDetected)
    {
        return;
    }

    personDetected = detected;

    digitalWrite(
        g_cfg.personGpio,
        personDetected ? HIGH : LOW
    );

    // The dashboard shows the level of this pin.
    reportPersonState(personDetected);

    Serial.println(
        personDetected
            ? ">>> PERSON DETECTED - GPIO HIGH <<<"
            : ">>> NO PERSON - GPIO LOW <<<"
    );
}

// Text printed after a cycle's score line (only with PRINT_DETECTION_SCORES).
void printVerdict(const char *text)
{
#if PRINT_DETECTION_SCORES
    Serial.println(text);
#else
    (void)text;
#endif
}

// Detection hysteresis
//
// If currently OFF:
//     turn ON at >= the DETECT_THRESH setting
//
// If currently ON:
//     stay ON until the score falls below the CLEAR_THRESH setting
void updateDetectionState(float personScore)
{
    if (!personDetected)
    {
        if (!(personScore >= g_cfg.detectThreshold))
        {
            printVerdict("");
            return;
        }

        printVerdict("   -> DETECT");
        setPersonDetected(true);
        return;
    }

    if (!(personScore < g_cfg.clearThreshold))
    {
        printVerdict("   -> PERSON");
        return;
    }

    printVerdict("   -> CLEAR");
    setPersonDetected(false);
}


// ============================================================
// Run one camera + inference cycle
// ============================================================

// Captures a frame, lets the scene gate look at it (darkness, motion) and — only
// if the gate says the model should run — copies it into the model's input
// tensor, converting camera uint8 pixels to model int8 the way the v1.3.3
// implementation does: by flipping the high bit.
// `run` says whether the tensor now holds a frame to run the model on.
// The frame buffer is always handed back before returning.
bool captureFrameIntoInput(bool &run)
{
    run = false;

    camera_fb_t *fb = esp_camera_fb_get();

    if (!fb)
    {
        RLOG_ERROR("ERROR: Camera capture failed: no frame from the camera (loose ribbon cable? supply browning out?)");

        return false;
    }

    if (
        fb->width != IMAGE_WIDTH ||
        fb->height != IMAGE_HEIGHT
    )
    {
        RLOG_ERROR(
            "ERROR: Unexpected frame size: %dx%d (the model needs %dx%d)",
            fb->width,
            fb->height,
            IMAGE_WIDTH,
            IMAGE_HEIGHT
        );

        esp_camera_fb_return(fb);

        return false;
    }

    // Look at the picture first: too dark (the model sees noise as people) or
    // nothing moving (nothing to find) means the model is not run at all.
    person_scene::SceneReading reading =
        g_sampler.analyze((const uint8_t *)fb->buf);

    person_scene::SceneVerdict verdict =
        g_gate.update(millis(), reading, personDetected);

#if PRINT_SCENE_READINGS
    Serial.printf(
        "Brightness: %3d   Motion: %5u\n",
        reading.brightness,
        (unsigned)reading.motion
    );
#endif

    if (verdict.changed)
    {
        Serial.println(
            person_scene::describeScene(
                verdict.state, reading, g_gate.config()
            ).c_str()
        );
    }

    if (verdict.clearPerson)
    {
        // It went dark while a person was flagged: that can only be a false
        // detection, so don't keep the GPIO high for it.
        setPersonDetected(false);
    }

    if (verdict.run)
    {
        for (int i = 0; i < IMAGE_SIZE; i++)
        {
            input->data.int8[i] =
                ((uint8_t *)fb->buf)[i] ^ 0x80;
        }

        run = true;
    }

    // Hand the frame to the uplink (the dashboard's picture) together with the numbers the gate just
    // worked out. It sees every frame, also while detection is paused, so the picture never freezes;
    // never waits (see reportSceneFrame()).
    reportSceneFrame((const uint8_t *)fb->buf, reading.brightness, reading.motion, verdict.state);

    esp_camera_fb_return(fb);

    return true;
}

// Converts one quantized model output value to a floating point
// score — the same calculation Espressif's v1.3.3 example uses.
float dequantize(const TfLiteTensor *output, int8_t value)
{
    return (value - output->params.zero_point)
        * output->params.scale;
}

// Returns true only when the model ran and the scores are filled in. False
// means a failure OR that the scene gate paused detection for this frame
// (dark / nothing moving) — the caller just waits for the next frame either way.
bool detectPerson(
    float &personScore,
    float &noPersonScore
)
{
    bool run = false;

    if (!captureFrameIntoInput(run) || !run)
    {
        return false;
    }

    if (interpreter->Invoke() != kTfLiteOk)
    {
        RLOG_ERROR("ERROR: TFLite Invoke() failed");

        return false;
    }

    // v1.3.3 model output:
    //   index 0 = no person
    //   index 1 = person
    TfLiteTensor *output =
        interpreter->output(0);

    personScore =
        dequantize(output, output->data.int8[1]);

    noPersonScore =
        dequantize(output, output->data.int8[0]);

    reportScore(personScore);

    return true;
}


// ============================================================
// Arduino setup()
// ============================================================

// ── Boot report ─────────────────────────────────────────────
// The reset reason is the first thing to look at when a detector "just rebooted": a BROWNOUT means
// the power supply dipped, a watchdog means something hung, a PANIC means the firmware crashed.
void logBootInfo()
{
    int resetReason = (int)esp_reset_reason();

    if (isAbnormalReset(resetReason))
    {
        RLOG_ERROR("booted after an abnormal restart: %s", resetReasonName(resetReason));
    }
    else
    {
        RLOG_INFO("booted (%s)", resetReasonName(resetReason));
    }

    RLOG_INFO(
        "firmware built %s, detector id %s, free heap %u bytes, PSRAM %s",
        FW_BUILD,
        g_cfg.streamEnabled ? g_cfg.detectorId.c_str() : "(live view off)",
        (unsigned)ESP.getFreeHeap(),
        psramFound() ? "yes" : "NO"
    );

#ifdef ESP_ARDUINO_VERSION_MAJOR
    RLOG_INFO(
        "Arduino-ESP32 core %d.%d.%d, ESP-IDF %s",
        ESP_ARDUINO_VERSION_MAJOR, ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH, ESP.getSdkVersion()
    );
#endif

    RLOG_INFO(
        "settings: alarm GPIO %d, detect at %.0f%%, clear below %.0f%%, dark below %d, motion at %u, hold %u s",
        g_cfg.personGpio,
        g_cfg.detectThreshold * 100.0f,
        g_cfg.clearThreshold * 100.0f,
        g_cfg.darkThreshold,
        (unsigned)g_cfg.motionThreshold,
        (unsigned)g_cfg.motionHoldSec
    );

    if (g_cfg.streamEnabled)
    {
        RLOG_INFO(
            "live view: relay %s:%d, at most %d pictures/s, JPEG quality %d",
            g_cfg.serverHost.c_str(), g_cfg.httpPort, g_cfg.streamMaxFps, g_cfg.streamJpegQuality
        );
    }
    else
    {
        RLOG_INFO("live view is off (STREAM_ENABLED=0): no Wi-Fi, nothing is sent to the relay");
    }
}

// The detector cannot do its job (no camera, no model): say so where somebody will read it, then
// restart. This used to be an empty loop — a board that looked "operational" on a serial cable while
// its alarm line did nothing and the relay never heard a word. Restarting gives a transient fault
// (a camera that browned out at power-up) another chance, and every attempt leaves a line in the
// relay's log.
constexpr uint32_t STARTUP_FAILURE_RESTART_MS = 30000;

void startupFailed(const char *what)   // does not return: it ends in a restart (no [[noreturn]]: Arduino's generated prototype would not carry it)
{
    RLOG_ERROR("%s - the detector cannot work, restarting in %u s", what, (unsigned)(STARTUP_FAILURE_RESTART_MS / 1000));

    if (g_cfg.streamEnabled)
    {
        startNetwork();   // so the line above can reach the relay's log before the restart
    }

    uint32_t until = millis() + STARTUP_FAILURE_RESTART_MS;

    while ((int32_t)(millis() - until) < 0)
    {
        delay(100);
    }

    ESP.restart();

    while (true)
    {
        delay(1000);
    }
}
// ── end of boot report ──────────────────────────────────────

void setup()
{
    // The settings conversation can be fed a long pasted line (a camera's whole
    // configuration); the default 256-byte receive buffer would lose part of it.
    // Must be set before Serial.begin().
    Serial.setRxBufferSize(2048);
    Serial.begin(115200);

    delay(2000);

    printCoreVersion();

    // First of all, before the camera, the model or Wi-Fi start: show the
    // settings, ask for missing ones, or offer to change them. Returns only when
    // the boot should go on, with g_cfg filled in.
    setupSettings();

    // From now on what the sketch logs is also queued for the relay's log file (it goes out as soon
    // as Wi-Fi and the delivery task are up).
    remoteLogConfigure();
    logBootInfo();

    Serial.println();
    Serial.println("==============================");
    Serial.println("ESP32-CAM TFLite Micro");
    Serial.println("Person Detection v1.3.3");
    Serial.println("==============================");


#if PRINT_STARTUP_INFO

    Serial.printf(
        "PSRAM: %s\n",
        psramFound() ? "YES" : "NO"
    );

    Serial.printf(
        "Free PSRAM: %u bytes\n",
        ESP.getFreePsram()
    );

    Serial.printf(
        "Detection GPIO: %d\n",
        g_cfg.personGpio
    );

    Serial.printf(
        "Detection threshold: %.0f%%\n",
        g_cfg.detectThreshold * 100.0f
    );

    Serial.printf(
        "Clear threshold: %.0f%%\n",
        g_cfg.clearThreshold * 100.0f
    );

    Serial.printf(
        "Dark below brightness: %d (0 = check off)\n",
        g_cfg.darkThreshold
    );

    Serial.printf(
        "Motion threshold: %u (0 = check off), hold %u s\n",
        (unsigned)g_cfg.motionThreshold,
        (unsigned)g_cfg.motionHoldSec
    );

#endif


    configureScene();

    // --------------------------------------------------------
    // GPIO
    // --------------------------------------------------------

    pinMode(
        g_cfg.personGpio,
        OUTPUT
    );

    // Start in the safe "no person" state.
    digitalWrite(
        g_cfg.personGpio,
        LOW
    );


    // --------------------------------------------------------
    // Camera
    // --------------------------------------------------------

    if (!initCamera())
    {
        startupFailed("Camera initialization FAILED");
    }

    Serial.println(
        "Camera initialized."
    );


    // --------------------------------------------------------
    // TFLite Micro
    // --------------------------------------------------------

    if (!initTFLite())
    {
        startupFailed("TFLite initialization FAILED");
    }


    if (g_cfg.streamEnabled && !startNetwork())
    {
        RLOG_ERROR("the live view could not start - the detector runs without it (see the line above)");
    }

    Serial.println();
    RLOG_INFO("Detector ready.");
    Serial.println();
}


// ============================================================
// Arduino loop()
// ============================================================

// Score as a rounded percentage, for the serial output.
int toPercent(float score)
{
    return (int)(score * 100.0f + 0.5f);
}

void loop()
{
    float personScore = 0.0f;
    float noPersonScore = 0.0f;

    if (detectPerson(
        personScore,
        noPersonScore
    ))
    {
#if PRINT_DETECTION_SCORES
        Serial.printf(
            "Person: %3d%%   "
            "No person: %3d%%",
            toPercent(personScore),
            toPercent(noPersonScore)
        );
#endif

        updateDetectionState(personScore);
    }

    // Give FreeRTOS a little breathing room.
    delay(g_cfg.loopDelayMs);
}
