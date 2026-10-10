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
// Thresholds etc. come from example.config.h, the file users copy to config.h.
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

#include "../../Arduino/ESP32_CAM_TFLite_Person/example.config.h"

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
    TEST_ASSERT_EQ(g_gpio[0].pin, PERSON_DETECTED_GPIO, "written to the configured pin");
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
    TEST_ASSERT_EQ((int)g_delays[0], DETECTION_LOOP_DELAY_MS, "configured delay");
}

int main() {
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

    return test::summarize();
}
