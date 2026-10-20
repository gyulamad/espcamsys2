// test_person_detect_glue.cpp — runs the person-detector sketch's ACTUAL
// detection code (ESP32_CAM_TFLite_Person.ino) on a desktop, against fake
// Arduino / camera / TFLite Micro objects.
//
// What runs here: the model constants and globals, setPersonDetected()
// (GPIO + serial on a state change only), detectPerson() (frame capture,
// size check, uint8 -> int8 conversion, inference, de-quantisation) and
// loop() (the detection hysteresis). What cannot: setup(), camera and model
// initialisation — they need the real hardware and the real TFLite library.
//
// The sketch code is not copied here: run_tests.sh extracts it from the .ino
// into build/person_glue.inc just before compiling (see run_tests.sh for the
// exact sections), so this always tests the code that will really be flashed —
// and fails to compile, loudly, if those sections or the functions disappear.
// Thresholds etc. are the sketch's settings (settings_schema.h): g_cfg below holds
// what setup() would have read from flash.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_detect_glue test_person_detect_glue.cpp

#include "framework.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#include "../../Arduino/ESP32_CAM_TFLite_Person/scene_logic.h"
using esp32cam_settings::PersonSettings;

// What setup() has read from flash. PersonSettings' defaults are the typical
// values the tests below are written around: GPIO 13, detect at 0.60, clear
// below 0.50, 10 ms between detections.
static PersonSettings g_cfg;

// The developer switches at the top of the sketch.
#define PRINT_DETECTION_SCORES 1
#define PRINT_STARTUP_INFO 1
#define PRINT_SCENE_READINGS 1
#define TENSOR_ARENA_SIZE (100 * 1024)

// ── fake Arduino / camera / TFLite Micro environment ────────────────────

#define HIGH 1
#define LOW 0

static std::string g_serial;   // everything the sketch printed
struct FakeSerial {
    void println(const char* s) { g_serial += s; g_serial += "\n"; }
    void println() { g_serial += "\n"; }
    void printf(const char* fmt, ...) __attribute__((format(printf, 2, 3))) {
        char buf[512];
        va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
        g_serial += buf;
    }
} Serial;

struct GpioWrite { int pin; int level; };
static std::vector<GpioWrite> g_gpio;
static void digitalWrite(int pin, int level) { g_gpio.push_back({pin, level}); }

static uint32_t g_millis = 0;
static uint32_t millis() { return g_millis; }

static std::vector<uint32_t> g_delays;
static void delay(uint32_t ms) { g_delays.push_back(ms); }

// -- camera: one frame the test controls; counts get/return so the tests can
//    assert the frame buffer is handed back exactly once on every path --
struct camera_fb_t { uint8_t* buf; int width; int height; };
static camera_fb_t g_fb;
static bool g_fbAvailable = true;
static int g_fbGets = 0, g_fbReturns = 0;
static camera_fb_t* esp_camera_fb_get() { g_fbGets++; return g_fbAvailable ? &g_fb : nullptr; }
static void esp_camera_fb_return(camera_fb_t*) { g_fbReturns++; }

// -- TFLite Micro: just the parts the sketch touches --
enum TfLiteStatus { kTfLiteOk = 0, kTfLiteError = 1 };
struct TfLiteTensor {
    union { int8_t* int8; uint8_t* uint8; } data;
    struct { float scale; int32_t zero_point; } params;
};
namespace tflite {
struct Model {};
struct MicroInterpreter {
    TfLiteStatus status = kTfLiteOk;
    int invokes = 0;
    TfLiteTensor* out = nullptr;
    TfLiteStatus Invoke() { invokes++; return status; }
    TfLiteTensor* output(int) { return out; }
};
}  // namespace tflite

// -- the log: the sketch reports camera / model failures with RLOG_*() so they reach the relay's log file
//    as well as the serial port. The real one queues them for a Wi-Fi task; this echoes to the "serial
//    port" like the real one does and records the level, so the tests can say WHERE a failure goes.
struct LogLine { char level; std::string text; };
static std::vector<LogLine> g_rlog;
static void fakeLog(char level, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void fakeLog(char level, const char* fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    g_rlog.push_back({level, buf});
    g_serial += buf;
    g_serial += "\n";
}
#define RLOG_DEBUG(...) fakeLog('D', __VA_ARGS__)
#define RLOG_INFO(...)  fakeLog('I', __VA_ARGS__)
#define RLOG_WARN(...)  fakeLog('W', __VA_ARGS__)
#define RLOG_ERROR(...) fakeLog('E', __VA_ARGS__)
static bool logged(char level, const char* part) {
    for (size_t i = 0; i < g_rlog.size(); i++) if (g_rlog[i].level == level && g_rlog[i].text.find(part) != std::string::npos) return true;
    return false;
}

// -- dashboard report: the sketch hands its readings to three small hooks (their real versions
//    keep a snapshot for a Wi-Fi task and cannot run here); these record the calls.
struct SceneCall { int brightness; uint32_t motion; person_scene::SceneState state; std::vector<uint8_t> frame; };
static std::vector<SceneCall> g_sceneCalls;
static std::vector<float> g_scoreCalls;
static std::vector<bool> g_pinCalls;
static void reportSceneFrame(const uint8_t* gray, int brightness, uint32_t motion, person_scene::SceneState state) {
    g_sceneCalls.push_back({brightness, motion, state, std::vector<uint8_t>(gray, gray + 96 * 96)});
}
static void reportScore(float score) { g_scoreCalls.push_back(score); }
static void reportPersonState(bool detected) { g_pinCalls.push_back(detected); }

// ── the sketch's real code ──────────────────────────────────────────────
#include "build/person_glue.inc"

// ── test fixture ────────────────────────────────────────────────────────

static std::vector<uint8_t> g_pixels;
static int8_t g_inBuf[IMAGE_SIZE];
static int8_t g_outBuf[2];
static TfLiteTensor g_inTensor, g_outTensor;
static tflite::MicroInterpreter g_interp;

// Fresh world: a good 96x96 frame, a working model, no person, nothing printed.
// Output scale 1/128 (exact in binary) so test scores are exact floats.
static void reset() {
    g_serial.clear(); g_gpio.clear(); g_delays.clear();
    g_fbGets = g_fbReturns = 0;
    g_rlog.clear();
    g_sceneCalls.clear(); g_scoreCalls.clear(); g_pinCalls.clear();
    g_sceneCalls.clear(); g_scoreCalls.clear(); g_pinCalls.clear();
    g_pixels.assign(IMAGE_SIZE, 0);
    g_fb.buf = g_pixels.data(); g_fb.width = IMAGE_WIDTH; g_fb.height = IMAGE_HEIGHT;
    g_fbAvailable = true;
    memset(g_inBuf, 0, sizeof(g_inBuf));
    g_outBuf[0] = g_outBuf[1] = 0;
    g_inTensor.data.int8 = g_inBuf;
    g_outTensor.data.int8 = g_outBuf;
    g_outTensor.params.scale = 1.0f / 128.0f;
    g_outTensor.params.zero_point = 0;
    g_interp = tflite::MicroInterpreter();
    g_interp.out = &g_outTensor;
    input = &g_inTensor;
    interpreter = &g_interp;
    personDetected = false;
    // The scene gate starts switched off (the settings' neutral values), as in a
    // detector configured with DARK_THRESH=0 and MOTION_THRESH=0.
    g_cfg = PersonSettings();
    g_millis = 0;
    g_sampler = person_scene::SceneSampler(IMAGE_WIDTH, IMAGE_HEIGHT);
    configureScene();
}

// Fills the whole frame with one gray value.
static void fillFrame(uint8_t gray) {
    g_pixels.assign(IMAGE_SIZE, gray);
    g_fb.buf = g_pixels.data();
}

// Switches the scene gate on the way the settings do.
static void sceneGate(int dark, uint32_t motion, uint32_t holdSec) {
    g_cfg.darkThreshold = dark;
    g_cfg.motionThreshold = motion;
    g_cfg.motionHoldSec = holdSec;
    configureScene();
}

static bool has(const std::string& hay, const char* needle) { return hay.find(needle) != std::string::npos; }

// Runs one loop() iteration with the model reporting this raw person value.
static void loopWith(int8_t rawPerson) {
    g_outBuf[1] = rawPerson;
    g_outBuf[0] = 0;
    g_serial.clear();
    loop();
}

// With scale 1/128: 76 = 0.594 (just under the 0.60 detect threshold),
// 77 = 0.602 (just over), 64 = 0.500 (exactly the clear threshold), 63 = 0.492.

// ── setPersonDetected ───────────────────────────────────────────────────

TEST(set_detected_true_drives_gpio_high_and_says_so) {
    reset();
    setPersonDetected(true);
    TEST_ASSERT(personDetected, "state is now detected");
    TEST_ASSERT_EQ(g_gpio.size(), (size_t)1, "exactly one GPIO write");
    TEST_ASSERT_EQ(g_gpio[0].pin, g_cfg.personGpio, "written to the configured pin");
    TEST_ASSERT_EQ(g_gpio[0].level, HIGH, "pin driven HIGH");
    TEST_ASSERT(has(g_serial, "PERSON DETECTED - GPIO HIGH"), "serial reports detection");
}

TEST(set_detected_false_drives_gpio_low_and_says_so) {
    reset();
    personDetected = true;
    setPersonDetected(false);
    TEST_ASSERT(!personDetected, "state is now clear");
    TEST_ASSERT_EQ(g_gpio.size(), (size_t)1, "exactly one GPIO write");
    TEST_ASSERT_EQ(g_gpio[0].level, LOW, "pin driven LOW");
    TEST_ASSERT(has(g_serial, "NO PERSON - GPIO LOW"), "serial reports clearing");
}

TEST(set_detected_same_state_does_nothing) {
    reset();
    setPersonDetected(false);   // already false
    TEST_ASSERT(g_gpio.empty(), "no digitalWrite when already clear");
    TEST_ASSERT(g_serial.empty(), "no serial noise when already clear");
    personDetected = true;
    setPersonDetected(true);    // already true
    TEST_ASSERT(g_gpio.empty(), "no digitalWrite when already detected");
    TEST_ASSERT(g_serial.empty(), "no serial noise when already detected");
}

// ── detectPerson ────────────────────────────────────────────────────────

TEST(detect_fails_cleanly_when_camera_gives_no_frame) {
    reset();
    g_fbAvailable = false;
    float p = -1, n = -1;
    TEST_ASSERT(!detectPerson(p, n), "returns false");
    TEST_ASSERT(has(g_serial, "Camera capture failed"), "says why");
    TEST_ASSERT_EQ(g_fbReturns, 0, "nothing to hand back");
    TEST_ASSERT_EQ(g_interp.invokes, 0, "model not run");
    TEST_ASSERT(p == -1 && n == -1, "scores left untouched");
}

TEST(detect_rejects_wrong_width_and_returns_the_frame) {
    reset();
    g_fb.width = IMAGE_WIDTH + 1;
    float p, n;
    TEST_ASSERT(!detectPerson(p, n), "returns false");
    TEST_ASSERT(has(g_serial, "Unexpected frame size: 97x96"), "reports the real size");
    TEST_ASSERT_EQ(g_fbReturns, 1, "frame buffer returned");
    TEST_ASSERT_EQ(g_interp.invokes, 0, "model not run");
}

TEST(detect_rejects_wrong_height_and_returns_the_frame) {
    reset();
    g_fb.height = IMAGE_HEIGHT - 1;
    float p, n;
    TEST_ASSERT(!detectPerson(p, n), "returns false");
    TEST_ASSERT(has(g_serial, "Unexpected frame size: 96x95"), "reports the real size");
    TEST_ASSERT_EQ(g_fbReturns, 1, "frame buffer returned");
}

TEST(detect_converts_pixels_by_flipping_the_high_bit) {
    reset();
    g_pixels[0] = 0;     // -> -128
    g_pixels[1] = 127;   // -> -1
    g_pixels[2] = 128;   // ->  0
    g_pixels[3] = 255;   // -> 127
    g_pixels[IMAGE_SIZE - 1] = 200;  // last pixel is converted too (200^0x80 = 72)
    float p, n;
    TEST_ASSERT(detectPerson(p, n), "returns true");
    TEST_ASSERT_EQ((int)g_inBuf[0], -128, "0 -> -128");
    TEST_ASSERT_EQ((int)g_inBuf[1], -1, "127 -> -1");
    TEST_ASSERT_EQ((int)g_inBuf[2], 0, "128 -> 0");
    TEST_ASSERT_EQ((int)g_inBuf[3], 127, "255 -> 127");
    TEST_ASSERT_EQ((int)g_inBuf[IMAGE_SIZE - 1], 72, "last pixel converted");
}

TEST(detect_returns_the_frame_exactly_once_on_success) {
    reset();
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT_EQ(g_fbGets, 1, "one capture");
    TEST_ASSERT_EQ(g_fbReturns, 1, "one return");
    TEST_ASSERT_EQ(g_interp.invokes, 1, "model run once");
}

TEST(detect_fails_when_inference_fails_but_still_returns_the_frame) {
    reset();
    g_interp.status = kTfLiteError;
    float p = -1, n = -1;
    TEST_ASSERT(!detectPerson(p, n), "returns false");
    TEST_ASSERT(has(g_serial, "Invoke() failed"), "says why");
    TEST_ASSERT_EQ(g_fbReturns, 1, "frame buffer returned");
    TEST_ASSERT(p == -1 && n == -1, "scores left untouched");
}

TEST(detect_reads_person_from_index_1_and_no_person_from_index_0) {
    reset();
    g_outBuf[0] = 32;    // no person  = 0.25
    g_outBuf[1] = 96;    // person     = 0.75
    float p = 0, n = 0;
    TEST_ASSERT(detectPerson(p, n), "returns true");
    TEST_ASSERT(p == 0.75f, "person score from output[1]");
    TEST_ASSERT(n == 0.25f, "no-person score from output[0]");
}

TEST(detect_dequantises_with_scale_and_zero_point) {
    reset();
    g_outTensor.params.scale = 1.0f / 256.0f;
    g_outTensor.params.zero_point = -128;
    g_outBuf[1] = 127;   // (127 + 128) / 256
    g_outBuf[0] = -128;  // (-128 + 128) / 256 = 0
    float p = 0, n = 1;
    detectPerson(p, n);
    TEST_ASSERT(p == 255.0f / 256.0f, "(raw - zero_point) * scale");
    TEST_ASSERT(n == 0.0f, "zero at the zero point");
}

// ── loop(): detection hysteresis ────────────────────────────────────────

TEST(loop_stays_clear_just_below_the_detect_threshold) {
    reset();
    loopWith(76);
    TEST_ASSERT(!personDetected, "0.594 < 0.60 does not detect");
    TEST_ASSERT(g_gpio.empty(), "GPIO untouched");
    TEST_ASSERT(has(g_serial, "Person:  59%"), "score printed as a rounded percent");
}

TEST(loop_detects_just_above_the_detect_threshold) {
    reset();
    loopWith(77);
    TEST_ASSERT(personDetected, "0.602 >= 0.60 detects");
    TEST_ASSERT_EQ(g_gpio.size(), (size_t)1, "one GPIO write");
    TEST_ASSERT_EQ(g_gpio[0].level, HIGH, "GPIO HIGH");
    TEST_ASSERT(has(g_serial, "-> DETECT"), "serial says DETECT");
}

TEST(loop_keeps_detection_inside_the_hysteresis_band) {
    reset();
    loopWith(100);                       // detect
    g_gpio.clear();
    loopWith(70);                        // 0.547: below detect, above clear
    TEST_ASSERT(personDetected, "still detected inside the band");
    TEST_ASSERT(g_gpio.empty(), "no GPIO flapping");
    TEST_ASSERT(has(g_serial, "-> PERSON"), "serial says PERSON");
}

TEST(loop_keeps_detection_exactly_at_the_clear_threshold) {
    reset();
    loopWith(100);
    loopWith(64);                        // 0.5 exactly: clearing needs strictly below
    TEST_ASSERT(personDetected, "0.50 is not below 0.50");
}

TEST(loop_clears_just_below_the_clear_threshold) {
    reset();
    loopWith(100);
    g_gpio.clear();
    loopWith(63);                        // 0.492
    TEST_ASSERT(!personDetected, "cleared");
    TEST_ASSERT_EQ(g_gpio.size(), (size_t)1, "one GPIO write");
    TEST_ASSERT_EQ(g_gpio[0].level, LOW, "GPIO LOW");
    TEST_ASSERT(has(g_serial, "-> CLEAR"), "serial says CLEAR");
}

TEST(loop_does_not_redetect_inside_the_band_after_clearing) {
    reset();
    loopWith(100);
    loopWith(10);                        // cleared
    loopWith(70);                        // 0.547: above clear, below detect
    TEST_ASSERT(!personDetected, "needs the full detect threshold again");
}

TEST(loop_does_nothing_but_wait_when_detection_fails) {
    reset();
    g_fbAvailable = false;
    loop();
    TEST_ASSERT(!personDetected, "state unchanged");
    TEST_ASSERT(g_gpio.empty(), "GPIO untouched");
    TEST_ASSERT_EQ(g_delays.size(), (size_t)1, "still yields to FreeRTOS");
}

TEST(loop_always_delays_by_the_configured_time) {
    reset();
    loopWith(100);
    TEST_ASSERT_EQ(g_delays.size(), (size_t)1, "one delay per iteration");
    TEST_ASSERT_EQ((int)g_delays[0], g_cfg.loopDelayMs, "configured delay");
}


// ── the frame handed to the uplink ──────────────────────────────────────

TEST(detect_hands_the_raw_frame_to_the_uplink_before_returning_it) {
    reset();
    g_pixels[0] = 0; g_pixels[1] = 200; g_pixels[IMAGE_SIZE - 1] = 255;
    float p, n;
    TEST_ASSERT(detectPerson(p, n), "returns true");
    TEST_ASSERT_EQ(g_sceneCalls.size(), (size_t)1, "handed over exactly once");
    TEST_ASSERT_EQ((int)g_sceneCalls[0].frame[0], 0, "first pixel is the camera's, not the XOR-ed model input");
    TEST_ASSERT_EQ((int)g_sceneCalls[0].frame[1], 200, "second pixel is unconverted");
    TEST_ASSERT_EQ((int)g_sceneCalls[0].frame[IMAGE_SIZE - 1], 255, "last pixel is unconverted");
    TEST_ASSERT_EQ((int)g_inBuf[1], 72, "model input still converted as before (200 ^ 0x80)");
}

TEST(detect_hands_over_nothing_when_there_is_no_usable_frame) {
    reset();
    g_fbAvailable = false;
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT(g_sceneCalls.empty(), "no frame, nothing handed over");

    reset();
    g_fb.width = IMAGE_WIDTH + 1;
    detectPerson(p, n);
    TEST_ASSERT(g_sceneCalls.empty(), "a wrong-sized frame is not handed over either");
}

// ── failures are reported where somebody will read them ─────────────────
// A detector is installed where nobody can plug a cable in. A camera or a model that fails goes to the
// log at ERROR level (which the sketch sends to the relay's log file), not only to the serial port.

TEST(a_camera_that_gives_no_frame_is_reported_as_an_error_with_a_hint) {
    reset();
    g_fbAvailable = false;
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT(logged('E', "Camera capture failed"), "an ERROR line says the capture failed");
    TEST_ASSERT(logged('E', "ribbon cable"), "and what usually causes it");
    TEST_ASSERT(has(g_serial, "Camera capture failed"), "the serial port still gets it");
}

TEST(a_wrong_sized_frame_is_reported_with_both_sizes) {
    reset();
    g_fb.width = IMAGE_WIDTH + 1;
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT(logged('E', "Unexpected frame size: 97x96 (the model needs 96x96)"), "the real size and the needed one");
}

TEST(a_failed_inference_is_reported_as_an_error) {
    reset();
    g_interp.status = kTfLiteError;
    float p, n;
    TEST_ASSERT(!detectPerson(p, n), "reports failure");
    TEST_ASSERT(logged('E', "TFLite Invoke() failed"), "an ERROR line says the model failed");
    g_interp.status = kTfLiteOk;
}

// ── dashboard report hooks ──────────────────────────────────────────────

TEST(every_good_frame_is_reported_with_its_readings_and_gate_state) {
    reset();
    sceneGate(40, 300, 10);
    fillFrame(120);
    float p, n;
    detectPerson(p, n);                                   // first frame: bright, no motion yet -> still
    TEST_ASSERT_EQ(g_sceneCalls.size(), (size_t)1, "reported once");
    TEST_ASSERT_EQ(g_sceneCalls[0].brightness, 120, "brightness of the samples");
    TEST_ASSERT_EQ((int)g_sceneCalls[0].motion, 0, "no motion on the very first frame");
    TEST_ASSERT(g_sceneCalls[0].state == person_scene::SceneState::Idle, "gate verdict handed over");
    TEST_ASSERT_EQ((int)g_sceneCalls[0].frame[0], 120, "the raw camera frame, not the XOR-ed model input");

    fillFrame(0);
    detectPerson(p, n);
    TEST_ASSERT(g_sceneCalls[1].state == person_scene::SceneState::Dark, "dark frame reported as dark");
    TEST_ASSERT_EQ(g_sceneCalls[1].brightness, 0, "its brightness");
    TEST_ASSERT_EQ((int)g_sceneCalls[1].motion, 100 * 120, "motion = 100 samples x 120 change");
}

TEST(frames_paused_by_the_gate_are_still_reported) {
    reset();
    sceneGate(40, 300, 10);
    fillFrame(10);                                        // dark: the model is not run
    float p, n;
    TEST_ASSERT(!detectPerson(p, n), "model paused");
    TEST_ASSERT_EQ(g_sceneCalls.size(), (size_t)1, "the dashboard still sees the picture and numbers");
    TEST_ASSERT(g_scoreCalls.empty(), "but there is no score");
}

TEST(nothing_is_reported_for_a_frame_that_cannot_be_used) {
    reset();
    g_fbAvailable = false;
    float p, n;
    detectPerson(p, n);
    reset();
    g_fb.width = IMAGE_WIDTH + 1;
    detectPerson(p, n);
    TEST_ASSERT(g_sceneCalls.empty() && g_scoreCalls.empty(), "no frame, no report");
}

TEST(the_person_score_is_reported_after_every_inference) {
    reset();
    g_outBuf[1] = 96;                                     // 0.75
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT_EQ(g_scoreCalls.size(), (size_t)1, "one score");
    TEST_ASSERT(g_scoreCalls[0] == 0.75f, "the dequantised person score");

    reset();
    g_interp.status = kTfLiteError;
    detectPerson(p, n);
    TEST_ASSERT(g_scoreCalls.empty(), "a failed inference reports no score");
}

TEST(the_alarm_pin_level_is_reported_when_it_changes) {
    reset();
    setPersonDetected(true);
    setPersonDetected(true);                              // no change: not reported again
    setPersonDetected(false);
    TEST_ASSERT_EQ(g_pinCalls.size(), (size_t)2, "once per change");
    TEST_ASSERT(g_pinCalls[0] == true && g_pinCalls[1] == false, "HIGH then LOW");
}

// ── scene gate: darkness and motion ─────────────────────────────────────

TEST(a_dark_frame_does_not_run_the_model_and_says_so_once) {
    reset();
    sceneGate(40, 0, 0);
    fillFrame(10);
    float p = -1, n = -1;
    TEST_ASSERT(!detectPerson(p, n), "no detection result for a dark frame");
    TEST_ASSERT_EQ(g_interp.invokes, 0, "the model was not run");
    TEST_ASSERT(p == -1 && n == -1, "scores left untouched");
    TEST_ASSERT_EQ(g_fbGets, 1, "one capture");
    TEST_ASSERT_EQ(g_fbReturns, 1, "the frame was handed back");
    TEST_ASSERT(has(g_serial, "Scene: DARK (brightness 10 < 40)"), "serial explains why");
    TEST_ASSERT_EQ((int)g_inBuf[0], 0, "the model input was not even filled");
    g_serial.clear();
    detectPerson(p, n);
    TEST_ASSERT(!has(g_serial, "Scene:"), "the dark state is reported on the change only");
}

TEST(the_uplink_still_gets_every_frame_while_detection_is_paused) {
    reset();
    sceneGate(40, 300, 0);
    fillFrame(10);
    float p, n;
    detectPerson(p, n);
    detectPerson(p, n);
    TEST_ASSERT_EQ(g_sceneCalls.size(), (size_t)2, "both dark frames were handed to the uplink");
}

TEST(a_light_frame_without_motion_is_idle_and_a_moving_one_runs_the_model) {
    reset();
    sceneGate(40, 300, 0);
    fillFrame(120);
    float p = 0, n = 0;
    TEST_ASSERT(!detectPerson(p, n), "first frame: nothing to compare with yet, so idle");
    TEST_ASSERT(has(g_serial, "Scene: still"), "serial says it is waiting for motion");
    TEST_ASSERT(!detectPerson(p, n), "identical frame: still idle");
    TEST_ASSERT_EQ(g_interp.invokes, 0, "model not run on a still picture");
    fillFrame(130);                                   // every sample +10: motion 1000
    g_serial.clear();
    TEST_ASSERT(detectPerson(p, n), "the picture changed: run the model");
    TEST_ASSERT_EQ(g_interp.invokes, 1, "model run once");
    TEST_ASSERT(has(g_serial, "Scene: active"), "serial says detection is on");
    TEST_ASSERT_EQ((int)g_inBuf[0], 2, "and the (converted: 130 ^ 0x80) frame is in the model input");
}

TEST(detection_continues_for_the_hold_time_after_the_motion_stops) {
    reset();
    sceneGate(0, 300, 5);                             // hold 5 s
    float p, n;
    fillFrame(100); g_millis = 0;    detectPerson(p, n);
    fillFrame(150); g_millis = 1000; TEST_ASSERT(detectPerson(p, n), "motion at 1 s");
    g_millis = 4000;                 TEST_ASSERT(detectPerson(p, n), "3 s later, picture unchanged: still detecting");
    g_millis = 6000;                 TEST_ASSERT(detectPerson(p, n), "exactly 5 s after the motion: still detecting");
    g_millis = 6001;                 TEST_ASSERT(!detectPerson(p, n), "after the hold: idle again");
}

TEST(a_person_that_stands_still_stays_detected_in_a_motionless_picture) {
    reset();
    sceneGate(40, 300, 0);
    float p, n;
    fillFrame(100); loopWith(100);                    // first frame: idle, nothing happens
    TEST_ASSERT(!personDetected, "idle: the model has not run");
    fillFrame(150); loopWith(100);                    // movement: the model sees the person
    TEST_ASSERT(personDetected, "person detected on the moving frame");
    g_interp.invokes = 0;
    for (int i = 0; i < 3; ++i) loopWith(100);        // nobody moves any more
    TEST_ASSERT(personDetected, "still detected");
    TEST_ASSERT_EQ(g_interp.invokes, 3, "the model keeps running while a person is flagged, so it can clear");
    loopWith(10);                                     // the model now says: gone
    TEST_ASSERT(!personDetected, "cleared by the model, as before");
    g_interp.invokes = 0;
    g_millis += 1000;                                 // time passes, still nobody moves
    loopWith(100);
    TEST_ASSERT_EQ(g_interp.invokes, 0, "and the model rests again until something moves");
    (void)p; (void)n;
}

TEST(when_it_goes_dark_a_flagged_person_is_dropped_without_asking_the_model) {
    reset();
    sceneGate(40, 0, 0);
    fillFrame(120);
    loopWith(100);
    TEST_ASSERT(personDetected, "detected in the light");
    g_gpio.clear();
    fillFrame(10);
    loopWith(100);                                    // the model would still say 'person' (false positive)
    TEST_ASSERT(!personDetected, "dropped: in the dark that can only be a false positive");
    TEST_ASSERT_EQ(g_gpio.size(), (size_t)1, "one GPIO write");
    TEST_ASSERT_EQ(g_gpio[0].level, LOW, "GPIO LOW");
    TEST_ASSERT_EQ(g_interp.invokes, 1, "the model ran only for the light frame");
    TEST_ASSERT(has(g_serial, "NO PERSON - GPIO LOW") && has(g_serial, "Scene: DARK"), "and it said why");
}

TEST(no_false_positive_in_the_dark_even_if_the_model_would_report_one) {
    reset();
    sceneGate(40, 0, 0);
    fillFrame(5);
    for (int i = 0; i < 5; ++i) loopWith(120);        // model output 'person 94%' for every frame
    TEST_ASSERT(!personDetected, "never detected");
    TEST_ASSERT(g_gpio.empty(), "GPIO never touched");
}

TEST(with_both_checks_off_every_frame_is_detected_on_as_before) {
    reset();
    fillFrame(0);                                     // black and still
    loopWith(100);
    TEST_ASSERT(personDetected, "runs on everything");
    TEST_ASSERT(!has(g_serial, "Scene:"), "and says nothing about the scene");
}

TEST(the_scene_readings_can_be_printed_for_every_frame_for_tuning_the_thresholds) {
    reset();
    sceneGate(40, 300, 0);
    fillFrame(120);
    float p, n;
    detectPerson(p, n);
    TEST_ASSERT(has(g_serial, "Brightness: 120   Motion:     0"), "brightness and motion of the frame");
    fillFrame(130);
    g_serial.clear();
    detectPerson(p, n);
    TEST_ASSERT(has(g_serial, "Brightness: 130   Motion:  1000"), "100 samples, each changed by 10");
}

TEST(a_bad_frame_never_reaches_the_scene_gate) {
    reset();
    sceneGate(40, 300, 0);
    g_fb.width = IMAGE_WIDTH + 1;
    float p, n;
    TEST_ASSERT(!detectPerson(p, n), "rejected");
    TEST_ASSERT(!has(g_serial, "Scene:") && !has(g_serial, "Brightness:"), "no scene readings from a wrong-sized frame");
}

int main() {
    RUN_TEST(every_good_frame_is_reported_with_its_readings_and_gate_state);
    RUN_TEST(frames_paused_by_the_gate_are_still_reported);
    RUN_TEST(nothing_is_reported_for_a_frame_that_cannot_be_used);
    RUN_TEST(the_person_score_is_reported_after_every_inference);
    RUN_TEST(the_alarm_pin_level_is_reported_when_it_changes);
    RUN_TEST(set_detected_true_drives_gpio_high_and_says_so);
    RUN_TEST(set_detected_false_drives_gpio_low_and_says_so);
    RUN_TEST(set_detected_same_state_does_nothing);

    RUN_TEST(detect_fails_cleanly_when_camera_gives_no_frame);
    RUN_TEST(detect_rejects_wrong_width_and_returns_the_frame);
    RUN_TEST(detect_rejects_wrong_height_and_returns_the_frame);
    RUN_TEST(detect_converts_pixels_by_flipping_the_high_bit);
    RUN_TEST(detect_returns_the_frame_exactly_once_on_success);
    RUN_TEST(detect_fails_when_inference_fails_but_still_returns_the_frame);
    RUN_TEST(detect_reads_person_from_index_1_and_no_person_from_index_0);
    RUN_TEST(detect_dequantises_with_scale_and_zero_point);

    RUN_TEST(loop_stays_clear_just_below_the_detect_threshold);
    RUN_TEST(loop_detects_just_above_the_detect_threshold);
    RUN_TEST(loop_keeps_detection_inside_the_hysteresis_band);
    RUN_TEST(loop_keeps_detection_exactly_at_the_clear_threshold);
    RUN_TEST(loop_clears_just_below_the_clear_threshold);
    RUN_TEST(loop_does_not_redetect_inside_the_band_after_clearing);
    RUN_TEST(loop_does_nothing_but_wait_when_detection_fails);
    RUN_TEST(loop_always_delays_by_the_configured_time);

    RUN_TEST(detect_hands_the_raw_frame_to_the_uplink_before_returning_it);
    RUN_TEST(detect_hands_over_nothing_when_there_is_no_usable_frame);
    RUN_TEST(a_camera_that_gives_no_frame_is_reported_as_an_error_with_a_hint);
    RUN_TEST(a_wrong_sized_frame_is_reported_with_both_sizes);
    RUN_TEST(a_failed_inference_is_reported_as_an_error);

    RUN_TEST(a_dark_frame_does_not_run_the_model_and_says_so_once);
    RUN_TEST(the_uplink_still_gets_every_frame_while_detection_is_paused);
    RUN_TEST(a_light_frame_without_motion_is_idle_and_a_moving_one_runs_the_model);
    RUN_TEST(detection_continues_for_the_hold_time_after_the_motion_stops);
    RUN_TEST(a_person_that_stands_still_stays_detected_in_a_motionless_picture);
    RUN_TEST(when_it_goes_dark_a_flagged_person_is_dropped_without_asking_the_model);
    RUN_TEST(no_false_positive_in_the_dark_even_if_the_model_would_report_one);
    RUN_TEST(with_both_checks_off_every_frame_is_detected_on_as_before);
    RUN_TEST(the_scene_readings_can_be_printed_for_every_frame_for_tuning_the_thresholds);
    RUN_TEST(a_bad_frame_never_reaches_the_scene_gate);

    return test::summarize();
}
