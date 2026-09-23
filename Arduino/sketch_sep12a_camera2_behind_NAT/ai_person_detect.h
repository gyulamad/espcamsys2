// ai_person_detect.h — wraps the TFLite Micro person-detection model this
// sketch is built against, so the rest of the sketch (and logic.h, which
// must stay hardware-free — see its own header comment) never touches the
// TFLite Micro API directly. Only the .ino includes this file.
//
// Library choice (recorded here per AI_ALARM_IMPLEMENTATION_PLAN.md §3/§8's
// "pick and pin a specific library/version during implementation and
// record the choice back into this doc or the repo README" instruction —
// also mirrored into the plan doc and INSTALL.md):
//
//   espressif/esp-tflite-micro, pinned to v1.3.3 — the actively maintained
//   port of TensorFlow Lite Micro for ESP32 (successor to the older
//   tflite-micro-esp-examples the plan originally named; same org, this is
//   its current home). https://github.com/espressif/esp-tflite-micro
//
//   Install as an Arduino library: clone/download the repo into your
//   Arduino libraries folder (~/Arduino/libraries/esp-tflite-micro) at the
//   v1.3.3 tag. See INSTALL.md's Arduino setup section for the exact
//   steps — it is NOT available as a plain .zip via Library Manager, so it
//   needs the manual clone.
//
// Model: Google's reference "person detection" INT8 model from the
// TensorFlow Lite for Microcontrollers examples — 96x96 grayscale input,
// two-class [not_person, person] int8 output (see AI_ALARM_IMPLEMENTATION_PLAN.md
// §3). It's the exact model esp-tflite-micro's own `person_detection`
// example ships as `person_detect_model_data.cc`/`.h`. NOT vendored into
// this repo — it's a ~300KB generated binary-as-C-array, not hand-editable
// source, and belongs with the library install, not hand-copied into a
// diff. Copy it from that example folder into model/person_detect_model_data.h
// next to this file — see model/README.md for the exact steps.
//
// The sketch compiles and runs fine without the model in place: AI
// inference is simply reported unavailable (logged once at boot) and
// nothing else in the sketch is affected. Only actual person detection
// needs it.

#pragma once

#include <cstdint>
#include <cstring>

#include "logic.h"

#if __has_include("model/person_detect_model_data.h")
  #define AI_ALARM_MODEL_AVAILABLE 1
  #include "model/person_detect_model_data.h"
  #include <tensorflow/lite/micro/micro_interpreter.h>
  #include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
  #include <tensorflow/lite/schema/schema_generated.h>
#else
  #define AI_ALARM_MODEL_AVAILABLE 0
#endif

namespace ai_person_detect {

#if AI_ALARM_MODEL_AVAILABLE
namespace detail {
  constexpr size_t kTensorArenaSize = 96 * 1024;

  // The tensor arena is large, so keep it in the ESP32-CAM's PSRAM
  // instead of consuming scarce internal DRAM.
  uint8_t *tensorArena = nullptr;

  const tflite::Model *model = nullptr;
  tflite::MicroInterpreter *interpreter = nullptr;
  bool ready = false;
}
#endif

// Must be called once from setup(), after the camera/PSRAM are up. Returns
// false if the model/interpreter failed to initialize — callers should
// treat AI detection as unavailable (runInference() below then always
// returns a default/non-detected result) and keep the rest of the sketch
// running regardless.
inline bool begin() {
#if AI_ALARM_MODEL_AVAILABLE
    using namespace detail;
    
    if (!psramFound()) {
        Serial.println("[ai-alarm] PSRAM not available, AI monitoring disabled");
        return false;
    }

    tensorArena = static_cast<uint8_t *>(ps_malloc(kTensorArenaSize));

    if (!tensorArena) {
        Serial.println("[ai-alarm] failed to allocate tensor arena in PSRAM");
        return false;
    }
    
    model = tflite::GetModel(g_person_detect_model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        Serial.println("[ai-alarm] model schema version mismatch, AI monitoring disabled");
        return false;
    }
    static tflite::MicroMutableOpResolver<5> opResolver;
    opResolver.AddAveragePool2D();
    opResolver.AddConv2D();
    opResolver.AddDepthwiseConv2D();
    opResolver.AddReshape();
    opResolver.AddSoftmax();
    static tflite::MicroInterpreter staticInterpreter(model, opResolver, tensorArena, kTensorArenaSize);
    interpreter = &staticInterpreter;
    if (interpreter->AllocateTensors() != kTfLiteOk) {
        Serial.println("[ai-alarm] AllocateTensors() failed, AI monitoring disabled");
        return false;
    }
    ready = true;
    Serial.println("[ai-alarm] person-detection model loaded");
    return true;
#else
    Serial.println("[ai-alarm] model not vendored (model/person_detect_model_data.h missing) "
                    "-- AI monitoring disabled, see model/README.md");
    return false;
#endif
}

inline bool modelReady() {
#if AI_ALARM_MODEL_AVAILABLE
    return detail::ready;
#else
    return false;
#endif
}

// Runs one inference on a 96x96 grayscale frame (produced by
// esp32cam_logic::downsampleRgb888ToGray() — see logic.h) and returns the
// detection result via logic.h's pure evaluatePersonScores(), so the
// actual confidence/threshold math is unit-tested independent of this
// hardware-only wrapper (see tests/cpp/test_alarm_logic.cpp). Safe to call
// even if begin() failed or was never called — returns a default
// (not-detected) result in that case.
inline esp32cam_logic::PersonDetectionResult runInference(const uint8_t grayscale96x96[96 * 96], float confidenceThreshold) {
#if AI_ALARM_MODEL_AVAILABLE
    using namespace detail;
    if (!ready) return esp32cam_logic::PersonDetectionResult{};
    TfLiteTensor *input = interpreter->input(0);
    for (int i = 0; i < 96 * 96; i++) {
        input->data.int8[i] = esp32cam_logic::quantizeGrayscaleToInt8(grayscale96x96[i]);
    }
    if (interpreter->Invoke() != kTfLiteOk) {
        Serial.println("[ai-alarm] inference Invoke() failed");
        return esp32cam_logic::PersonDetectionResult{};
    }
    TfLiteTensor *output = interpreter->output(0);
    // Reference model's output tensor layout: index 0 = not_person score,
    // index 1 = person score (same order the model's own person_detection.cc
    // example reads it in).
    return esp32cam_logic::evaluatePersonScores(output->data.int8[0], output->data.int8[1], confidenceThreshold);
#else
    (void)grayscale96x96;
    (void)confidenceThreshold;
    return esp32cam_logic::PersonDetectionResult{};
#endif
}

} // namespace ai_person_detect
