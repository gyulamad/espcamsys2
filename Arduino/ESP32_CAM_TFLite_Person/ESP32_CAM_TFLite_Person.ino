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
// view: Wi-Fi, relay, stream password, ...) lives in the board's FLASH, not in
// the source. A freshly flashed board has none and asks for them on the serial
// port; after that, each boot shows them and waits 5 s for a "y" to change them.
// What the settings are: settings_schema.h. How they are typed, checked and
// stored: settings_logic.h (plain C++, unit-tested on a desktop — see tests/cpp/).
// The glue to the real flash and serial port is the "Settings glue" block below.
#include "settings_logic.h"
#include "settings_schema.h"
#include "stream_logic.h"

// ── Live view (optional) ────────────────────────────────────────────────
// With the STREAM_ENABLED setting on, the detector also joins Wi-Fi (any of
// several networks, like the recorder), serves its picture as an authenticated
// MJPEG stream, and tells the relay its IP address via POST /log — so a freshly
// installed detector can be found and watched from a browser. Detection never
// waits for any of it: all networking runs in its own task, and with no Wi-Fi
// the detector works exactly as before. With STREAM_ENABLED=0 no Wi-Fi is
// started at all.

#define FW_BUILD __DATE__ " " __TIME__   // which firmware build wrote a log line

// ── Developer switches (not per-camera settings: edit here and re-flash) ──
// Print person/no-person scores for every inference.
#define PRINT_DETECTION_SCORES 1
// Print startup and initialization information.
#define PRINT_STARTUP_INFO 1
// Tensor arena size: the base size used by the Espressif v1.3.3
// person-detection example. Tied to the model compiled in below.
#define TENSOR_ARENA_SIZE (100 * 1024)

using esp32cam_settings::PersonSettings;

// The camera's settings, filled in by setupSettings() at the very start of
// setup() and only read afterwards.
PersonSettings g_cfg;

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
        Serial.printf(
            "Camera init failed: 0x%x\n",
            err
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
        Serial.println(
            "ERROR: Could not allocate tensor arena"
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
        Serial.printf(
            "ERROR: Model schema version %d, expected %d\n",
            model->version(),
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
        Serial.println(
            "ERROR: AllocateTensors() failed"
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
using esp32cam_settings::loadPersonSettings;

const uint32_t SETTINGS_WINDOW_MS = 5000;          // how long boot waits for a "y" before starting normally
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
// Wi-Fi, live view and relay announcement
// ============================================================
//
// Everything here runs in ONE background task on core 0 (where the Wi-Fi
// stack lives); the detection loop on core 1 only ever calls
// streamPublishFrame(), which never waits. So a missing network, a slow
// viewer or an unreachable relay cannot delay a detection.
//
// The task:
//   1. keeps Wi-Fi connected, choosing among the WIFI setting's networks (as the recorder does);
//   2. tells the relay (POST /log) the stream's address — on every new IP, then
//      repeated as a heartbeat — so you can see in the relay's log where it is;
//   3. serves  /  (a page showing the picture enlarged)  and  /stream (MJPEG),
//      both behind HTTP Basic authentication. One viewer at a time: opening
//      /stream again replaces the previous viewer.

WiFiMulti wifiMulti;
WiFiServer *streamServer = nullptr;       // created in startNetwork(), once the port setting is known
// Timing placeholders; startNetwork() replaces it with the configured one.
person_stream::AnnouncePolicy announcePolicy(600000UL, 30000UL);

std::string expectedAuth;                 // the Authorization header value that is let in
volatile bool streamWanted = false;       // a viewer is connected: the detector should share frames
uint8_t *sharedFrame = nullptr;           // newest 96x96 frame, written by the detection loop
uint8_t *viewerFrame = nullptr;           // the stream's private copy
uint32_t sharedFrameSeq = 0;
SemaphoreHandle_t frameMutex = nullptr;
uint32_t announceSeq = 0;

// Called from the detection loop with the raw grayscale frame. Costs nothing
// with no viewer, and never blocks: if the viewer's copy is in progress this
// frame is simply not offered.
void streamPublishFrame(const uint8_t *gray)
{
    if (!streamWanted || !sharedFrame || !frameMutex)
    {
        return;
    }

    if (xSemaphoreTake(frameMutex, 0) != pdTRUE)
    {
        return;
    }

    memcpy(sharedFrame, gray, IMAGE_SIZE);
    sharedFrameSeq++;
    xSemaphoreGive(frameMutex);
}

// ── Relay announcement ──────────────────────────────────────

bool postAnnouncement(const std::string &ip, person_stream::AnnounceReason reason)
{
    std::string url = person_stream::buildStreamUrl(ip, g_cfg.streamPort);
    std::string ssid = WiFi.SSID().c_str();
    int rssi = WiFi.RSSI();

    std::string message = person_stream::buildAnnounceMessage(
        reason, url, g_cfg.streamUser, ssid, ip, rssi, millis() / 1000);
    std::string body = person_stream::buildAnnounceJson(
        g_cfg.detectorId, FW_BUILD, message, millis(),
        (int32_t)ESP.getFreeHeap(), rssi, ++announceSeq);

    std::string logUrl = person_stream::buildLogUrl(g_cfg.serverHost, g_cfg.httpPort);

    HTTPClient http;
    http.begin(String(logUrl.c_str()));
    http.setTimeout(5000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Key", g_cfg.apiKey.c_str());
    int code = http.POST((uint8_t *)body.data(), body.size());
    http.end();

    if (code >= 200 && code < 300)
    {
        Serial.printf("Announced %s to the relay\n", url.c_str());
        return true;
    }

    Serial.printf(
        "Could not announce %s to the relay (HTTP %d) - retrying in %d s\n",
        url.c_str(), code, (int)g_cfg.announceRetrySec
    );
    return false;
}

// ── Serving ─────────────────────────────────────────────────

// Reads the request head; returns what arrived (possibly nothing).
std::string readRequestHead(WiFiClient &client, uint32_t timeoutMs)
{
    std::string head;
    uint32_t start = millis();

    while ((client.connected() || client.available()) &&
           (millis() - start) < timeoutMs &&
           head.size() < 1024)
    {
        while (client.available() && head.size() < 1024)
        {
            head += (char)client.read();

            if (person_stream::requestHeadComplete(head))
            {
                return head;
            }
        }

        delay(5);
    }

    return head;
}

bool sendAll(WiFiClient &client, const uint8_t *data, size_t length)
{
    return client.write(data, length) == length;
}

bool sendString(WiFiClient &client, const std::string &text)
{
    return sendAll(client, (const uint8_t *)text.data(), text.size());
}

// Reads and answers one request. Returns true ONLY for an authenticated
// request for the stream — the caller then streams on this client. Everything
// else is answered here and the connection closed.
bool answerRequest(WiFiClient &client, uint32_t readTimeoutMs)
{
    client.setTimeout(g_cfg.streamWriteTimeoutSec);   // seconds

    std::string head = readRequestHead(client, readTimeoutMs);

    if (head.empty())
    {
        // Browsers open speculative connections they never use.
        client.stop();
        return false;
    }

    switch (person_stream::routeFor(person_stream::parseRequest(head), expectedAuth))
    {
        case person_stream::Route::Stream:
            return true;

        case person_stream::Route::Index:
            sendString(client, person_stream::indexPage());
            break;

        case person_stream::Route::Unauthorized:
            sendString(client, person_stream::unauthorizedResponse());
            break;

        case person_stream::Route::MethodNotAllowed:
            sendString(client, person_stream::methodNotAllowedResponse());
            break;

        case person_stream::Route::NotFound:
            sendString(client, person_stream::notFoundResponse());
            break;

        case person_stream::Route::BadRequest:
        default:
            sendString(client, person_stream::badRequestResponse());
            break;
    }

    client.flush();
    client.stop();
    return false;
}

// Streams frames to an already-authenticated client until it goes away, the
// Wi-Fi drops, or a newer viewer asks for /stream (it replaces this one).
// Requests from other connections in the meantime (a browser's favicon
// request, say) are answered without interrupting the stream.
void serveStream(WiFiClient client)
{
    const uint32_t minGapMs = 1000UL / g_cfg.streamMaxFps;
    uint32_t lastSeq = 0;
    uint32_t lastSentAt = 0;
    bool needHead = true;

    streamWanted = true;

    while (WiFi.status() == WL_CONNECTED)
    {
        if (needHead)
        {
            if (!sendString(client, person_stream::streamResponseHead()))
            {
                break;
            }

            needHead = false;
            lastSeq = 0;
        }

        if (!client.connected())
        {
            break;
        }

        WiFiClient next = streamServer->available();

        if (next && answerRequest(next, 200))
        {
            client.stop();
            client = next;          // newest viewer wins
            needHead = true;
            continue;
        }

        if ((millis() - lastSentAt) < minGapMs)
        {
            delay(5);
            continue;
        }

        bool fresh = false;

        if (xSemaphoreTake(frameMutex, pdMS_TO_TICKS(50)) == pdTRUE)
        {
            if (sharedFrameSeq != lastSeq)
            {
                memcpy(viewerFrame, sharedFrame, IMAGE_SIZE);
                lastSeq = sharedFrameSeq;
                fresh = true;
            }

            xSemaphoreGive(frameMutex);
        }

        if (!fresh)
        {
            delay(10);
            continue;
        }

        uint8_t *jpeg = nullptr;
        size_t jpegLength = 0;

        if (!fmt2jpg(viewerFrame, IMAGE_SIZE, IMAGE_WIDTH, IMAGE_HEIGHT,
                     PIXFORMAT_GRAYSCALE, g_cfg.streamJpegQuality,
                     &jpeg, &jpegLength))
        {
            delay(50);
            continue;
        }

        bool sent =
            sendString(client, person_stream::streamPartHead(jpegLength)) &&
            sendAll(client, jpeg, jpegLength) &&
            sendString(client, "\r\n");

        free(jpeg);

        if (!sent)
        {
            break;
        }

        lastSentAt = millis();
    }

    streamWanted = false;
    client.stop();
}

// ── The task ────────────────────────────────────────────────

void networkTask(void *)
{
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);   // modem-sleep adds latency to every request

    for (size_t i = 0; i < g_cfg.wifi.size(); i++)
    {
        wifiMulti.addAP(g_cfg.wifi[i].ssid.c_str(), g_cfg.wifi[i].pass.c_str());
    }

    bool wasUp = false;
    bool serverStarted = false;

    for (;;)
    {
        // May block for several seconds while it scans / connects — fine,
        // nothing else runs in this task and detection is on the other core.
        bool up = wifiMulti.run() == WL_CONNECTED;

        if (up && !wasUp)
        {
            Serial.printf(
                "Wi-Fi connected to '%s', IP %s, %d dBm\n",
                WiFi.SSID().c_str(),
                WiFi.localIP().toString().c_str(),
                WiFi.RSSI()
            );

            // Tell the relay about every (re)connection — which network, which
            // address — the way the recorder logs each one.
            announcePolicy.invalidate();

            // The address may be new (another network, another lease):
            // listen afresh rather than trust the old socket.
            if (serverStarted)
            {
                streamServer->end();
            }

            streamServer->begin();
            serverStarted = true;
        }
        else if (!up && wasUp)
        {
            Serial.println("Wi-Fi connection lost - reconnecting");
        }

        wasUp = up;

        if (up)
        {
            std::string ip = WiFi.localIP().toString().c_str();

            std::string ssid = WiFi.SSID().c_str();

            person_stream::AnnounceReason reason =
                announcePolicy.due(millis(), true, ip, ssid);

            if (reason != person_stream::AnnounceReason::None && ip != "0.0.0.0")
            {
                bool ok = postAnnouncement(ip, reason);
                announcePolicy.onResult(millis(), ok, ip, ssid);
            }

            WiFiClient client = streamServer->available();

            if (client && answerRequest(client, 1000))
            {
                serveStream(client);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(up ? 20 : 500));
    }
}

// Starts the live view. Called from setup() AFTER the camera and the model
// have their memory (the Wi-Fi driver claims a lot of internal RAM, and the
// tensor arena needs one big block of it). Returns false, leaving the
// detector running without a live view, if it can't start.
bool startNetwork()
{
    if (!person_stream::credentialsUsable(g_cfg.streamUser.c_str(), g_cfg.streamPass.c_str()))
    {
        // (The settings checks already refuse these, so this is only a safety net.)
        Serial.println(
            "Live view OFF: STREAM_USER and STREAM_PASS are not usable - check the STREAM_ settings"
        );

        return false;
    }

    sharedFrame = (uint8_t *)malloc(IMAGE_SIZE);
    viewerFrame = (uint8_t *)malloc(IMAGE_SIZE);
    frameMutex = xSemaphoreCreateMutex();

    if (!sharedFrame || !viewerFrame || !frameMutex)
    {
        Serial.println("Live view OFF: out of memory");

        return false;
    }

    expectedAuth = person_stream::expectedAuthHeader(g_cfg.streamUser.c_str(), g_cfg.streamPass.c_str());

    streamServer = new WiFiServer(g_cfg.streamPort);
    announcePolicy = person_stream::AnnouncePolicy(
        (uint32_t)g_cfg.announceHeartbeatSec * 1000UL,
        (uint32_t)g_cfg.announceRetrySec * 1000UL);

    xTaskCreatePinnedToCore(networkTask, "network", 12288, nullptr, 1, nullptr, 0);

    Serial.printf(
        "Live view starting - watch the relay's log for its address (user '%s')\n",
        g_cfg.streamUser.c_str()
    );

    return true;
}


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

// Captures a frame and copies it into the model's input tensor,
// converting camera uint8 pixels to model int8 the way the v1.3.3
// implementation does: by flipping the high bit.
// The frame buffer is always handed back before returning.
bool captureFrameIntoInput()
{
    camera_fb_t *fb = esp_camera_fb_get();

    if (!fb)
    {
        Serial.println(
            "ERROR: Camera capture failed"
        );

        return false;
    }

    if (
        fb->width != IMAGE_WIDTH ||
        fb->height != IMAGE_HEIGHT
    )
    {
        Serial.printf(
            "ERROR: Unexpected frame size: %dx%d\n",
            fb->width,
            fb->height
        );

        esp_camera_fb_return(fb);

        return false;
    }

    for (int i = 0; i < IMAGE_SIZE; i++)
    {
        input->data.int8[i] =
            ((uint8_t *)fb->buf)[i] ^ 0x80;
    }

    // Offer the same frame to the live view (does nothing unless a viewer is
    // connected, and never waits — see streamPublishFrame()).
    streamPublishFrame((const uint8_t *)fb->buf);

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

bool detectPerson(
    float &personScore,
    float &noPersonScore
)
{
    if (!captureFrameIntoInput())
    {
        return false;
    }

    if (interpreter->Invoke() != kTfLiteOk)
    {
        Serial.println(
            "ERROR: TFLite Invoke() failed"
        );

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

    return true;
}


// ============================================================
// Arduino setup()
// ============================================================

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

#endif


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
        Serial.println(
            "Camera initialization FAILED"
        );

        while (true)
        {
            delay(1000);
        }
    }

    Serial.println(
        "Camera initialized."
    );


    // --------------------------------------------------------
    // TFLite Micro
    // --------------------------------------------------------

    if (!initTFLite())
    {
        Serial.println(
            "TFLite initialization FAILED"
        );

        while (true)
        {
            delay(1000);
        }
    }


    if (g_cfg.streamEnabled)
    {
        startNetwork();
    }

    Serial.println();
    Serial.println(
        "Detector ready."
    );
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
