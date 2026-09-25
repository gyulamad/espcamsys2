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