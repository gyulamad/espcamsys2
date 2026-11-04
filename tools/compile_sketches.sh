#!/usr/bin/env bash
# compile_sketches.sh — does each sketch compile the way the Arduino toolchain compiles it?
#
# The C++ tests build only parts of the sketches (the logic headers, and blocks cut out of the .ino
# files) against desktop fakes. They cannot see a mistake that only the real compile sees: a name used
# before it is declared, a missing #include, a call that does not match the real core's API, a wrong
# type. This compiles the two sketch folders as they are, with arduino-cli, for the real board.
#
# Usage:
#   tools/compile_sketches.sh [recorder|detector|all]      (default: all)
#
# Every sketch is compiled even if an earlier one failed, so one run shows every broken sketch; the
# compiler's output is printed only for the ones that failed. Nothing is written into the repository
# and nothing is flashed or published (ota-deploy.sh does that).
#
# Needs: arduino-cli with the esp32 core 3.x and the esp-tflite-micro library (INSTALL.md, "Compiling the
# sketches"). The board and the extra compile arguments are the ones of ota-deploy.sh: ota.conf (see
# ota.example.conf) if you have one, else the defaults.
#
# Environment:
#   OTA_CONF          another config file than ota.conf (shared with ota-deploy.sh)
#   SKETCH_BUILD_DIR  keep the build files in this folder instead of a throwaway one: the next run only
#                     recompiles what changed, which is much faster (the TFLite library is big)
#
# Exit code: 0 every sketch compiled, 1 at least one did not, 2 wrong usage or the toolchain is missing
# (the sketches were not compiled, so nothing can be said about them).

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tools/sketch_build_lib.sh
. "$ROOT_DIR/tools/sketch_build_lib.sh"

usage() { sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ── arguments ────────────────────────────────────────────────────────────
WHAT=""
for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        recorder|detector|all)
            [ -z "$WHAT" ] || { echo "compile_sketches: only one of recorder|detector|all (try --help)" >&2; exit 2; }
            WHAT="$arg" ;;
        *) echo "compile_sketches: unknown argument: $arg (try --help)" >&2; exit 2 ;;
    esac
done
case "${WHAT:-all}" in
    all) TYPES="$SKETCH_TYPES" ;;
    *)   TYPES="$WHAT" ;;
esac

# ── the toolchain ────────────────────────────────────────────────────────
load_sketch_build_settings "${OTA_CONF:-$ROOT_DIR/ota.conf}"

if ! command -v arduino-cli >/dev/null 2>&1; then
    echo "compile_sketches: arduino-cli not found on PATH - install it and the esp32 core 3.x (INSTALL.md, \"Compiling the sketches\")" >&2
    exit 2
fi
# An unknown board means the core is not installed (or the FQBN is misspelled): say so, instead of
# letting every sketch "fail to compile" for a reason that has nothing to do with the sketch.
if ! arduino-cli board details --fqbn "$FQBN" >/dev/null 2>&1; then
    echo "compile_sketches: arduino-cli does not know the board $FQBN - install the esp32 core 3.x (arduino-cli core install esp32:esp32) and check FQBN in ota.conf" >&2
    exit 2
fi

TMP="$(mktemp -d)" || { echo "compile_sketches: cannot create a temporary folder" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
BUILD_ROOT="${SKETCH_BUILD_DIR:-$TMP/build}"

# ── compile ──────────────────────────────────────────────────────────────
# compile_one TYPE — compiles that sketch; the compiler's output is shown only when it fails.
compile_one() {
    local type="$1" dir name log
    dir="$(sketch_dir "$type")"
    name="$(sketch_name "$type")"
    log="$TMP/$type.log"
    echo "== Compiling $name for $FQBN"
    # EXTRA_COMPILE_ARGS is a list of words on purpose (it is in ota-deploy.sh too).
    # shellcheck disable=SC2086
    if arduino-cli compile --fqbn "$FQBN" $EXTRA_COMPILE_ARGS --build-path "$BUILD_ROOT/$type" "$dir" >"$log" 2>&1; then
        echo "   ok"
        return 0
    fi
    echo "   FAILED - the compiler said:"
    sed 's/^/   | /' "$log"
    return 1
}

failed=""
for t in $TYPES; do
    compile_one "$t" || failed="$failed $(sketch_name "$t")"
done

echo
if [ -n "$failed" ]; then
    echo "FAIL: did not compile:$failed"
    exit 1
fi
echo "ok: every sketch compiles"
