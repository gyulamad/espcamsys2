#!/usr/bin/env bash
# sketch_build_lib.sh — what every script that builds the firmware needs to know about it: which
# sketches there are, where they live and which board they are built for. Sourced by ota-deploy.sh
# and tools/compile_sketches.sh, never run on its own.

SKETCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH_TYPES="recorder detector"

# The AI-Thinker ESP32-CAM with the "Minimal SPIFFS" partition scheme: two app slots, big enough for
# the person detector (see "Over-the-air firmware updates" in DEPLOY.md).
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

# ── the pinned toolchain ─────────────────────────────────────────────────
# toolchain.versions says which esp32 core the firmware is built with (never "latest": see that file).
# ensure_pinned_toolchain installs exactly that core into a private arduino-cli data folder, so the
# result does not depend on whatever core the machine happens to have, and the machine's own arduino-cli
# setup is not touched. SKETCH_TOOLCHAIN=system skips all of this and uses the arduino-cli setup as it is
# (for a machine that manages its own, and for the tests with a fake arduino-cli).
#
# SKETCH_TOOLCHAIN_DIR  where the pinned core lives (default: ~/.cache/espcamsys-toolchain); the first run
#                       downloads it (several hundred MB), later runs find it there.
#
# Returns 0 when the pinned core is installed; otherwise prints why and returns 1.
ensure_pinned_toolchain() {
    [ "${SKETCH_TOOLCHAIN:-pinned}" = system ] && return 0
    # shellcheck source=toolchain.versions
    . "$SKETCH_ROOT/toolchain.versions" || { echo "cannot read $SKETCH_ROOT/toolchain.versions" >&2; return 1; }
    [ -n "$ESP32_CORE_VERSION" ] && [ -n "$ESP32_BOARD_INDEX_URL" ] || { echo "toolchain.versions has no ESP32_CORE_VERSION / ESP32_BOARD_INDEX_URL" >&2; return 1; }

    export ARDUINO_DIRECTORIES_DATA="${SKETCH_TOOLCHAIN_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/espcamsys-toolchain}"
    export ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS="$ESP32_BOARD_INDEX_URL"

    local have
    have="$(pinned_core_installed)"
    if [ "$have" != "$ESP32_CORE_VERSION" ]; then
        echo "== Installing the pinned esp32 core $ESP32_CORE_VERSION into $ARDUINO_DIRECTORIES_DATA" >&2
        arduino-cli core update-index >&2 || { echo "arduino-cli could not update the board index" >&2; return 1; }
        arduino-cli core install "esp32:esp32@$ESP32_CORE_VERSION" >&2 || { echo "arduino-cli could not install esp32:esp32@$ESP32_CORE_VERSION" >&2; return 1; }
        have="$(pinned_core_installed)"
    fi
    [ "$have" = "$ESP32_CORE_VERSION" ] || { echo "the esp32 core installed is '${have:-none}', toolchain.versions pins $ESP32_CORE_VERSION" >&2; return 1; }

    local cli
    cli="$(arduino-cli version 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "Version:") { print $(i + 1); exit } }')"
    if [ -n "$ARDUINO_CLI_VERSION" ] && [ -n "$cli" ] && [ "$cli" != "$ARDUINO_CLI_VERSION" ]; then
        echo "WARNING: arduino-cli $cli, but the build was verified with $ARDUINO_CLI_VERSION (toolchain.versions)" >&2
    fi
    return 0
}

# The version of the esp32 core installed in the current arduino-cli data folder (empty if none).
pinned_core_installed() {
    arduino-cli core list 2>/dev/null | awk '$1 == "esp32:esp32" {print $2; exit}'
}
