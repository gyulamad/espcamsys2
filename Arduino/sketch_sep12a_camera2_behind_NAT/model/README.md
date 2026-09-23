# AI-alarm person-detection model

`ai_person_detect.h` expects a file called `person_detect_model_data.h`
in this folder, defining the model as a C array named
`g_person_detect_model_data` (the exact shape the reference example ships
it in). It is **not vendored in this repo** — it's a ~250-300KB generated
binary-as-C-array, not hand-editable source, and belongs with the library
install rather than a hand-copied diff.

## Get it

The file comes straight from the `espresif/esp-tflite-micro` library
(v1.3.3, the version pinned in `ai_person_detect.h`) that
`AI_ALARM_IMPLEMENTATION_PLAN.md` §3/§8 asked to be picked and pinned for
this feature:

```bash
# from your Arduino libraries folder, e.g. ~/Arduino/libraries
git clone --branch v1.3.3 https://github.com/espressif/esp-tflite-micro.git

cp esp-tflite-micro/examples/person_detection/main/person_detect_model_data.cc \
   <this-sketch-folder>/
cp esp-tflite-micro/examples/person_detection/main/person_detect_model_data.h \
   <this-sketch-folder>/model/
```

If the upstream example's `.h`/`.cc` split doesn't match exactly what
`ai_person_detect.h` includes (`#include "model/person_detect_model_data.h"`
expects the array declared in the header, not just the .cc), either adjust
that one `#include` line to match whatever the library actually ships, or
merge the two files into a single `person_detect_model_data.h` — either
way, `ai_person_detect.h` only needs `g_person_detect_model_data` (a
`const unsigned char[]`) to be visible after that include.

## Without it

The sketch still compiles and runs fine with this folder empty: `ai_person_detect.h`
falls back to a no-op stub (see its `#if __has_include(...)` guard), AI
monitoring is reported unavailable once at boot (`[ai-alarm] model not
vendored...`), and every other part of the sketch — streaming, the alarm
GPIO trigger, the AI on/off command channel itself — is unaffected. Person
detection just won't actually detect anything until this file is in place.
