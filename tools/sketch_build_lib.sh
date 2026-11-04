#!/usr/bin/env bash
# sketch_build_lib.sh — what every script that builds the firmware needs to know about it: which
# sketches there are, where they live and which board they are built for. Sourced by ota-deploy.sh
# and tools/compile_sketches.sh, never run on its own.

SKETCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH_TYPES="recorder detector"

# The AI-Thinker ESP32-CAM with the "Minimal SPIFFS" partition scheme: two app slots, big enough for
# the person detector (see "Over-the-air firmware updates" in INSTALL.md).
SKETCH_DEFAULT_FQBN="esp32:esp32:esp32cam:PartitionScheme=min_spiffs"

# sketch_dir TYPE — the folder of that sketch. Fails (prints nothing) for a type that does not exist.
sketch_dir() {
    case "$1" in
        recorder) echo "$SKETCH_ROOT/Arduino/ESP32_CAM_Recorder" ;;
        detector) echo "$SKETCH_ROOT/Arduino/ESP32_CAM_TFLite_Person" ;;
        *)        return 1 ;;
    esac
}

# sketch_name TYPE — the sketch's name: its folder name, which is also the name of its .ino file.
sketch_name() {
    local dir
    dir="$(sketch_dir "$1")" || return 1
    basename "$dir"
}

# load_sketch_build_settings CONFIG_FILE — sets FQBN and EXTRA_COMPILE_ARGS: the defaults, then whatever
# the config file (plain bash, the ota.conf of ota.example.conf) says. A missing file is fine here;
# callers that cannot do without it check for it first.
load_sketch_build_settings() {
    FQBN="$SKETCH_DEFAULT_FQBN"
    EXTRA_COMPILE_ARGS=""
    [ -f "$1" ] || return 0
    # shellcheck disable=SC1090
    . "$1"
}
