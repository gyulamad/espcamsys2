#!/usr/bin/env bash
# run_tests.sh — runs every unit-test suite in this repo (Arduino/C++,
# Node.js, PHP) and prints a combined summary.
#
# No test framework or third-party dependency is required — just a C++
# compiler (g++), gdb, node, and php already on PATH. Any one missing is
# reported and its suite counted as a failure rather than silently skipped,
# since a "test suite" nobody can run isn't actually testing anything.
#
# Usage:
#   ./run_tests.sh                  run every suite
#   ./run_tests.sh --coverage N     also measure line coverage and FAIL if any
#                                   of the three areas below is under N percent
#                                   (0-100): the two Arduino sketches (gcov)
#                                   and the dashboard's PHP logic
#   ./run_tests.sh -h | --help
#
# Coverage is measured per area and N applies to EACH of them, so a
# well-tested one can't hide an untested one:
#   Recorder:        logic.h, remote_log.h and the remote-logging block of
#                    ESP32_CAM_Recorder.ino
#   Person detector: the detection code of ESP32_CAM_TFLite_Person.ino
#                    (setPersonDetected, detectPerson, loop)
# These are the only sketch code that can run on a desktop; setup() and the
# camera/WiFi/model initialisation need the real hardware. Needs gcov (same
# GCC version as g++, >= 9) and node.
#   Dashboard PHP:   php/cameras/lib/*.php (the logic the PHP unit tests run;
#                    the page scripts are covered by the e2e tests only and are
#                    not measured). Needs a PHP coverage driver: PCOV or Xdebug.
#
# Exit code: 0 if every suite passed (and coverage, if requested, met the
# minimum), 1 if any suite failed, coverage was too low, or something couldn't run.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$ROOT_DIR/tests/cpp/build"

overall_status=0

# ── Arguments ────────────────────────────────────────────────────────────
COVERAGE_MIN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --coverage)
            if [ $# -lt 2 ]; then echo "--coverage needs a number (minimum percent)" >&2; exit 2; fi
            COVERAGE_MIN="$2"; shift 2 ;;
        --coverage=*)
            COVERAGE_MIN="${1#--coverage=}"; shift ;;
        -h|--help)
            sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
    esac
done

# Instrumentation flags are only added when coverage was asked for, so a
# normal run builds exactly as before.
COV_FLAGS=()
if [ -n "$COVERAGE_MIN" ]; then
    if ! [[ "$COVERAGE_MIN" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
       ! awk -v n="$COVERAGE_MIN" 'BEGIN { exit !(n >= 0 && n <= 100) }'; then
        echo "--coverage value must be a number between 0 and 100 (got: $COVERAGE_MIN)" >&2
        exit 2
    fi
    COV_FLAGS=(--coverage -O0 -g)
fi

hr() { printf '%s\n' "------------------------------------------------------------"; }

# ── Arduino / C++ logic tests ────────────────────────────────────────────
# Built with a plain desktop g++ (no Arduino core needed — logic.h has no
# hardware dependencies) and run under gdb in batch mode, so a crash prints
# a backtrace instead of just "Aborted". A clean run behaves exactly like
# running the binary directly; `quit $_exitcode` makes gdb itself exit with
# the test binary's real exit code so this script can check it.
hr
echo "C++ (Arduino logic) tests"
hr

mkdir -p "$BUILD_DIR"
# Stale coverage data from an earlier run would be merged into this one.
rm -f "$BUILD_DIR"/*.gcda "$BUILD_DIR"/*.gcno

# Compiles tests/cpp/<name>.cpp and runs it (under gdb when available, for a
# backtrace on a crash — see the note above).
run_cpp_test() {
    local name="$1"
    local bin="$BUILD_DIR/$name"
    echo "--- $name"
    if ! g++ -std=c++17 -Wall -Wextra ${COV_FLAGS[@]+"${COV_FLAGS[@]}"} -o "$bin" "$ROOT_DIR/tests/cpp/$name.cpp"; then
        echo "FAIL: could not compile $name"
        overall_status=1
    elif command -v gdb >/dev/null 2>&1; then
        gdb -q -batch -ex run -ex bt -ex 'quit $_exitcode' --args "$bin"
        [ $? -ne 0 ] && overall_status=1
    else
        echo "gdb not found on PATH — running the test binary directly instead"
        "$bin"
        [ $? -ne 0 ] && overall_status=1
    fi
}

if ! command -v g++ >/dev/null 2>&1; then
    echo "FAIL: g++ not found on PATH"
    overall_status=1
else
    # The ESP32 Arduino toolchain compiles older C++ than the tests do, so the
    # header it will really build must also be valid as C++11 (strictly).
    echo "--- remote_log.h as C++11 (the ESP32 toolchain's dialect)"
    if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
           -include "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/remote_log.h" -x c++ /dev/null; then
        echo "ok"
    else
        echo "FAIL: remote_log.h does not compile as C++11"
        overall_status=1
    fi

    run_cpp_test test_alarm_logic
    run_cpp_test test_remote_log

    # The sketch's remote-logging glue is tested by compiling the code it
    # ACTUALLY contains: extract the marked block from the .ino and build it
    # against fake Arduino/FreeRTOS/HTTP objects. If the markers go missing the
    # extract is empty and the compile below fails loudly.
    sed -n '/Remote logging glue ──/,/end of remote logging glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" > "$BUILD_DIR/log_glue.inc"
    run_cpp_test test_sketch_log_glue

    # The person detector's detection code is tested the same way: extract the
    # real sections of the .ino (model constants/globals, setPersonDetected +
    # detectPerson, loop) and build them against fake Arduino/camera/TFLite
    # objects. The sections are found by their title comments; if one is
    # renamed the extract is incomplete and the compile below fails loudly.
    PERSON_INO="$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino"
    {
        sed -n '/^\/\/ Model parameters/,/^\/\/ Camera initialization/p' "$PERSON_INO"
        sed -n '/^\/\/ GPIO \/ detection state/,/^\/\/ Arduino setup()/p' "$PERSON_INO"
        sed -n '/^\/\/ Arduino loop()/,$p' "$PERSON_INO"
    } > "$BUILD_DIR/person_glue.inc"
    run_cpp_test test_person_detect_glue

    # ── Coverage gate (only with --coverage N) ───────────────────────────
    if [ -n "$COVERAGE_MIN" ]; then
        hr
        echo "C++ coverage (gcov), minimum ${COVERAGE_MIN}%"
        hr
        if ! command -v gcov >/dev/null 2>&1; then
            echo "FAIL: gcov not found on PATH"
            overall_status=1
        elif ! command -v node >/dev/null 2>&1; then
            echo "FAIL: node not found on PATH (needed to merge the gcov reports)"
            overall_status=1
        else
            node "$ROOT_DIR/tests/coverage_report.js" "$BUILD_DIR" "$ROOT_DIR" "$COVERAGE_MIN"
            [ $? -ne 0 ] && overall_status=1
        fi
    fi
fi

# ── Node.js logic tests ──────────────────────────────────────────────────
hr
echo "Node.js (camera-relay logic) tests"
hr

if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    for f in "$ROOT_DIR"/tests/node/test_*.js; do
        echo "-- $(basename "$f")"
        node "$f"
        [ $? -ne 0 ] && overall_status=1
    done
fi

# ── End-to-end tests ─────────────────────────────────────────────────────
# Both spawn the real relay on their own ports (never the real 8080/8081)
# with a throwaway settings file — a real settings.json is never touched.
# Both need `npm install` to have been run in nodejs/camera-relay/ (the relay
# itself needs express).
#   - tests/e2e/test_alarm_settings_e2e.js: over real HTTP, checks that an
#     alarm records for the length stored via /settings rather than a
#     hardcoded value, that it persists across a restart, etc. Override the
#     ports with E2E_SETTINGS_PORT / E2E_SETTINGS_PUSH_PORT if they collide.
#   - tests/e2e/test_recording_switch_e2e.js: the recording ON/OFF switch on a
#     real relay — control-key authentication, every way a recording can start
#     is blocked while OFF, per-camera and all-cameras, minutes semantics,
#     persistence across restarts, timers ending, no OFF-period footage in a
#     clip. Takes ~30 s. Override the ports with E2E_SWITCH_PORT /
#     E2E_SWITCH_PUSH_PORT.
#   - tests/e2e/test_dashboard_switch_e2e.js: the dashboard's recording-switch.php
#     proxy (real php -S in front of a recording fake relay) — login, the
#     anti-forgery header, POST only, key added server-side and never sent to
#     the browser, input validation. Skips itself if php is missing. Override the
#     ports with E2E_SWDASH_PORT / E2E_SWDASH_RELAY_PORT / E2E_SWDASH_DEAD_PORT.
#   - tests/e2e/test_logging_e2e.js: the relay's log file and POST /log — key
#     authentication, entries filed under the time they HAPPENED with the
#     sender's IP, no forged lines, rotation, relay-observed events (camera
#     connected/dropped), an unusable log location. Override the ports with
#     E2E_LOG_PORT / E2E_LOG_PUSH_PORT.
#   - tests/e2e/test_dashboard_counts_e2e.js: renders the real dashboard page
#     with php -S and checks each camera's FILES button already shows its
#     recording count in the HTML of the FIRST load (no JavaScript involved),
#     against a current relay, an older relay (simulated) and no relay at all.
#     Skips itself if php is missing. Override the ports with E2E_DASH_PORT /
#     E2E_DASH_RELAY_PORT / E2E_DASH_PUSH_PORT / E2E_DASH_FAKE_PORT / E2E_DASH_DEAD_PORT.
#   - tests/e2e/test_preroll_e2e.js: a fake camera pushes frames over the
#     real TCP protocol; checks that every recording starts with the
#     pre-roll window (including in the encoded .mp4 when ffmpeg/ffprobe are
#     installed). Takes ~20s of real time. Override the ports with
#     E2E_PREROLL_PORT / E2E_PREROLL_PUSH_PORT.
hr
echo "End-to-end (alarm settings) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_alarm_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording ON/OFF switch, relay) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_recording_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording ON/OFF switch, dashboard proxy) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_dashboard_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (relay logging) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_logging_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (dashboard FILES count on first load) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_dashboard_counts_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording pre-roll) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    node "$ROOT_DIR/tests/e2e/test_preroll_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

# ── PHP logic tests ───────────────────────────────────────────────────────
hr
echo "PHP (dashboard logic) tests"
hr

if ! command -v php >/dev/null 2>&1; then
    echo "FAIL: php not found on PATH"
    overall_status=1
else
    # With --coverage, every test process also records which lines of
    # php/cameras/lib/*.php it ran (tests/php/coverage_prepend.php, loaded via
    # auto_prepend_file so the tests need no changes). Needs a PHP coverage
    # driver: PCOV (preferred) or Xdebug. The driver may be already enabled in
    # php.ini, or installed but switched off — both are handled; if neither is
    # available the run fails with an install hint.
    PHP_COV_FLAGS=()
    PHP_COV_DIR=""
    if [ -n "$COVERAGE_MIN" ]; then
        if php -r 'exit(extension_loaded("pcov") ? 0 : 1);' 2>/dev/null; then
            PHP_COV_FLAGS=(-d pcov.enabled=1 -d "pcov.directory=$ROOT_DIR/php/cameras/lib")
        elif php -r 'exit(extension_loaded("xdebug") ? 0 : 1);' 2>/dev/null; then
            PHP_COV_FLAGS=(-d xdebug.mode=coverage)
            export XDEBUG_MODE=coverage    # the env var overrides php.ini
        elif php -d extension=pcov -r 'exit(extension_loaded("pcov") ? 0 : 1);' >/dev/null 2>&1; then
            PHP_COV_FLAGS=(-d extension=pcov -d pcov.enabled=1 -d "pcov.directory=$ROOT_DIR/php/cameras/lib")
        elif php -d zend_extension=xdebug -r 'exit(extension_loaded("xdebug") ? 0 : 1);' >/dev/null 2>&1; then
            PHP_COV_FLAGS=(-d zend_extension=xdebug -d xdebug.mode=coverage)
            export XDEBUG_MODE=coverage
        else
            echo "FAIL: --coverage needs a PHP coverage driver (PCOV or Xdebug); neither is available."
            echo "      e.g. Debian/Ubuntu/Raspberry Pi OS: sudo apt install php-pcov   (or php-xdebug)"
            overall_status=1
        fi
        if [ ${#PHP_COV_FLAGS[@]} -gt 0 ]; then
            PHP_COV_DIR="$(mktemp -d)"
            export CAMTEST_COVERAGE_DIR="$PHP_COV_DIR"
            export CAMTEST_COVERAGE_LIB="$ROOT_DIR/php/cameras/lib"
            PHP_COV_FLAGS+=(-d "auto_prepend_file=$ROOT_DIR/tests/php/coverage_prepend.php")
        fi
    fi

    for f in "$ROOT_DIR"/tests/php/test_*.php; do
        echo "-- $(basename "$f")"
        php ${PHP_COV_FLAGS[@]+"${PHP_COV_FLAGS[@]}"} "$f"
        [ $? -ne 0 ] && overall_status=1
    done

    # ── Coverage gate (only with --coverage N) ───────────────────────────
    if [ -n "$PHP_COV_DIR" ]; then
        hr
        echo "PHP coverage, minimum ${COVERAGE_MIN}%"
        hr
        php "$ROOT_DIR/tests/php/coverage_report.php" "$PHP_COV_DIR" "$ROOT_DIR" "$COVERAGE_MIN"
        [ $? -ne 0 ] && overall_status=1
        rm -rf "$PHP_COV_DIR"
        unset CAMTEST_COVERAGE_DIR CAMTEST_COVERAGE_LIB
    fi
fi

hr
if [ "$overall_status" -eq 0 ]; then
    echo "ALL TEST SUITES PASSED"
else
    echo "ONE OR MORE TEST SUITES FAILED"
fi
hr

exit "$overall_status"
