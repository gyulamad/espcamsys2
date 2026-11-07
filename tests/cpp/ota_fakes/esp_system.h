// esp_system.h — desktop fake of the ESP-IDF system header. The real header
// declares esp_random() (the chip's hardware RNG); on the desktop we route it
// through the fake core's `randomValue` field so a test can script it. The
// Arduino sketches include this for esp_random() (review ARD-015).
#include "fake_core.h"

inline uint32_t esp_random() { return (uint32_t) fake::g().randomValue; }
