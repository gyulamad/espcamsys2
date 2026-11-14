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
#   ./run_tests.sh --no-sketch-compile
#                                   leave out the real compile of the two sketches
#                                   (see below), e.g. on a machine without arduino-cli
#   ./run_tests.sh --coverage N     also measure line coverage and FAIL if any
#                                   of the five areas below is under N percent
#                                   (0-100): the two Arduino sketches (gcov),
#                                   the dashboard's PHP logic, the relay's
#                                   Node.js logic and the relay's server.js
#   ./run_tests.sh --verbose [N]    how much of the test output to show (tools/test_output.sh):
#                                     0  a dot for every passed test case, the failed ones in full
#                                        (the default)
#                                     1  the same, and the text of the groups too (suite titles, test
#                                        file names, summaries)
#                                     2  everything: every test case on a line of its own
#                                   --verbose without a number is --verbose 2; --verbose=N works too
#   ./run_tests.sh -h | --help
#
# The sketches themselves are compiled too (tools/compile_sketches.sh): the tests below only build
# parts of them against desktop fakes, so only this catches a patch that leaves a sketch not compiling.
# It needs arduino-cli with the esp32 core 3.x (INSTALL.md, "Compiling the sketches"); without it the run
# FAILS, like any other missing tool, unless --no-sketch-compile says that leaving it out is intended.
#
# Coverage is measured per area and N applies to EACH of them, so a
# well-tested one can't hide an untested one:
#   Recorder:        logic.h, remote_log.h, settings_logic.h, settings_schema.h
#                    and the remote-logging and settings blocks of
#                    ESP32_CAM_Recorder.ino
#   Person detector: report_logic.h (what is sent to the relay for the dashboard,
#                    and the connection that carries it), scene_logic.h
#                    (darkness/motion gate), motion_baseline.h (the motion
#                    threshold's auto-calibration), settings_schema.h, and the detection,
#                    settings, remote-logging and uplink code of
#                    ESP32_CAM_TFLite_Person.ino (setPersonDetected, detectPerson,
#                    loop, the settings block, WifiUplinkEnv, the log glue)
# (The "Relay settings link" class in each sketch — the real Wi-Fi + HTTP half of asking
# the relay for missing settings — needs a radio; the glue tests run against a fake of it.)
# These are the only sketch code that can run on a desktop; setup() and the
# camera/WiFi/model initialisation need the real hardware. Needs gcov (same
# GCC version as g++, >= 9) and node.
#   Dashboard PHP:   php/cameras/lib/*.php (the logic the PHP unit tests run;
#                    the page scripts are covered by the e2e tests only and are
#                    not measured). Needs a PHP coverage driver: PCOV or Xdebug.
#   Relay Node.js:   nodejs/camera-relay/lib/*.js (the logic the Node.js unit
#                    tests run). Needs Node 12+; nothing to install.
#   Relay server.js: the relay itself, as run by the end-to-end tests (the
#                    relay processes they start record the coverage).
#
# Exit code: 0 if every suite passed (and coverage, if requested, met the
# minimum), 1 if any suite failed, coverage was too low, or something couldn't run.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$ROOT_DIR/tests/cpp/build"

overall_status=0

# ── Arguments ────────────────────────────────────────────────────────────
COVERAGE_MIN=""
COMPILE_SKETCHES=1
VERBOSE=0
ORIGINAL_ARGS=("$@")
while [ $# -gt 0 ]; do
    case "$1" in
        --verbose)
            # the number is optional: a bare --verbose shows everything
            if [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then VERBOSE="$2"; shift 2; else VERBOSE=2; shift; fi ;;
        --verbose=*)
            VERBOSE="${1#--verbose=}"; shift ;;
        --no-sketch-compile)
            COMPILE_SKETCHES=0; shift ;;
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

if ! [[ "$VERBOSE" =~ ^[012]$ ]]; then
    echo "--verbose level must be 0, 1 or 2 (got: $VERBOSE)" >&2
    exit 2
fi

# The levels below 2 show the output of this run through tools/test_output.sh (dots for the passed test
# cases): this script starts itself again inside it, and RUN_TESTS_FILTERED keeps that from repeating.
# Level 2 is this script as it is. The exit code is this script's own either way.
if [ -z "${RUN_TESTS_FILTERED:-}" ]; then
    RUN_TESTS_FILTERED=1 exec "$ROOT_DIR/tools/test_output.sh" "$VERBOSE" \
        "${BASH_SOURCE[0]}" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi

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

# The text of a group of tests (a suite's title, a test file's name) helps to follow a run, but the quietest
# level (--verbose 0, the default) leaves it out: only the dots and the failures are left there.
heading() {
    [ "$VERBOSE" -ge 1 ] || return 0
    hr
    echo "$1"
    hr
}
group_text() {
    [ "$VERBOSE" -ge 1 ] || return 0
    echo "$1"
}

# Installs a test-only package folder from its lockfile (npm ci) when its packages are missing, or when the
# lockfile is newer than what is installed (a patch changed a version). Does nothing otherwise, so a normal
# run costs nothing. Never aborts the run: with no npm or no network it says so and the test that needs the
# packages reports SKIP. $1 = folder with package.json + package-lock.json, $2 = what the packages are for.
ensure_npm_deps() {
    local dir="$1" why="$2"
    [ -f "$dir/package-lock.json" ] || return 0
    if [ -d "$dir/node_modules" ] && [ ! "$dir/package-lock.json" -nt "$dir/node_modules" ]; then
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo "NOTE: npm not found, so the packages for $why ($dir) are not installed — that test will SKIP."
        return 0
    fi
    echo "Installing the packages for $why (npm ci in $dir) ..."
    if ! (cd "$dir" && npm ci --no-audit --no-fund); then
        echo "NOTE: npm ci failed in $dir (no network?) — $why may SKIP or fail."
    fi
    return 0
}

# ── Arduino / C++ logic tests ────────────────────────────────────────────
# Built with a plain desktop g++ (no Arduino core needed — logic.h has no
# hardware dependencies) and run under gdb in batch mode, so a crash prints
# a backtrace instead of just "Aborted". A clean run behaves exactly like
# running the binary directly; `quit $_exitcode` makes gdb itself exit with
# the test binary's real exit code so this script can check it.
heading "C++ (Arduino logic) tests"

mkdir -p "$BUILD_DIR"
# Stale coverage data from an earlier run would be merged into this one.
rm -f "$BUILD_DIR"/*.gcda "$BUILD_DIR"/*.gcno

# Compiles tests/cpp/<name>.cpp and runs it (under gdb when available, for a
# backtrace on a crash — see the note above).
run_cpp_test() {
    local name="$1"
    shift
    local bin="$BUILD_DIR/$name"
    group_text "--- $name"
    # -Werror=unused-function: a TEST(...) that main() never RUN_TESTs is an unused function, and it would
    # otherwise sit there silently, never running (three did, once). It must break the build instead.
    if ! g++ -std=c++17 -Wall -Wextra -Werror=unused-function ${COV_FLAGS[@]+"${COV_FLAGS[@]}"} "$@" -o "$bin" "$ROOT_DIR/tests/cpp/$name.cpp"; then
        echo "FAIL: could not compile $name"
        overall_status=1
    elif command -v gdb >/dev/null 2>&1; then
        gdb -q -batch -ex run -ex bt -ex 'quit $_exitcode' --args "$bin"
        [ $? -ne 0 ] && overall_status=1
    else
        group_text "gdb not found on PATH — running the test binary directly instead"
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
    group_text "--- remote_log.h as C++11 (the ESP32 toolchain's dialect)"
    if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
           -include "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/remote_log.h" -x c++ /dev/null; then
        echo "ok"
    else
        echo "FAIL: remote_log.h does not compile as C++11"
        overall_status=1
    fi

    # The person detector's connection to the relay and what it reports (also compiled by the sketch).
    group_text "--- report_logic.h as C++11 (the ESP32 toolchain's dialect)"
    if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
           -include "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/report_logic.h" -x c++ /dev/null; then
        echo "ok"
    else
        echo "FAIL: report_logic.h does not compile as C++11"
        overall_status=1
    fi

    # The settings engine and the Recorder's key table (flash-stored settings,
    # see settings_logic.h): also compiled by the sketch, so also C++11.
    # ...and the darkness/motion gate, with the moving average behind its motion threshold.
    for h in scene_logic.h motion_baseline.h; do
        group_text "--- $h as C++11 (the ESP32 toolchain's dialect)"
        if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
               -include "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/$h" -x c++ /dev/null; then
            echo "ok"
        else
            echo "FAIL: $h does not compile as C++11"
            overall_status=1
        fi
    done

    for h in ESP32_CAM_Recorder/settings_logic.h ESP32_CAM_Recorder/settings_schema.h \
             ESP32_CAM_TFLite_Person/settings_schema.h ESP32_CAM_Recorder/ota_logic.h \
             ESP32_CAM_Recorder/relay_find_logic.h \
             ESP32_CAM_Recorder/relay_health.h ESP32_CAM_Recorder/setup_session.h \
             ESP32_CAM_Recorder/setup_boot.h; do
        group_text "--- $h as C++11 (the ESP32 toolchain's dialect)"
        if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
               -include "$ROOT_DIR/Arduino/$h" -x c++ /dev/null; then
            echo "ok"
        else
            echo "FAIL: $h does not compile as C++11"
            overall_status=1
        fi
    done

    # The optional build-time default master password (setup_credentials.local.h, see
    # Arduino/templates/setup_credentials.example.h): one a WPA2 access point would refuse must stop the
    # BUILD (setup_logic.h static_asserts it); at run time a blank board would have no setup WiFi at all.
    for pw in '"Owner-Secret-9"'; do
        group_text "--- setup_logic.h accepts the default password $pw"
        if g++ -std=c++11 -fsyntax-only -DSETUP_DEFAULT_PASSWORD_OVERRIDE="$pw" \
               -include "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/setup_logic.h" -x c++ /dev/null 2>/dev/null; then
            echo "ok"
        else
            echo "FAIL: a valid default password $pw was refused"
            overall_status=1
        fi
    done
    for pw in '"short"' '"has\ttab-in-it"' '"caf\xc3\xa9-password"' \
              '"0123456789012345678901234567890123456789012345678901234567890123"'; do
        group_text "--- setup_logic.h refuses the default password $pw"
        if g++ -std=c++11 -fsyntax-only -DSETUP_DEFAULT_PASSWORD_OVERRIDE="$pw" \
               -include "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/setup_logic.h" -x c++ /dev/null 2>/dev/null; then
            echo "FAIL: the default password $pw compiled, but a WPA2 access point would refuse it"
            overall_status=1
        else
            echo "ok (the build stops)"
        fi
    done

    # settings_logic.h is deliberately copied into every sketch folder that uses
    # it (an Arduino sketch can only include files from its own folder). The
    # copies must be identical: edit one, copy it over the others.
    group_text "--- settings_logic.h copies are identical"
    SETTINGS_ORIGINAL="$ROOT_DIR/Arduino/ESP32_CAM_Recorder/settings_logic.h"
    settings_copies_ok=1
    settings_copies_found=0
    for copy in "$ROOT_DIR"/Arduino/*/settings_logic.h; do
        [ -e "$copy" ] || continue
        settings_copies_found=$((settings_copies_found + 1))
        if ! cmp -s "$SETTINGS_ORIGINAL" "$copy"; then
            echo "FAIL: $copy differs from $SETTINGS_ORIGINAL"
            settings_copies_ok=0
        fi
    done
    if [ "$settings_copies_ok" = 1 ] && [ "$settings_copies_found" -ge 1 ]; then
        echo "ok ($settings_copies_found copies)"
    else
        [ "$settings_copies_found" -ge 1 ] || echo "FAIL: no settings_logic.h found"
        overall_status=1
    fi

    # The over-the-air update (ota_logic.h: the decisions, ota.h: the Arduino glue) and the remote
    # log's logic (remote_log.h) are copied into both sketch folders the same way, and the copies
    # must be identical too.
    for shared in ota_logic.h ota.h remote_log.h settings_sync.h relay_find_logic.h relay_find.h relay_health.h setup_session.h setup_boot.h setup_logic.h setup_mode.h; do
        group_text "--- $shared copies are identical"
        SHARED_ORIGINAL="$ROOT_DIR/Arduino/ESP32_CAM_Recorder/$shared"
        shared_ok=1
        shared_found=0
        for copy in "$ROOT_DIR"/Arduino/*/"$shared"; do
            [ -e "$copy" ] || continue
            shared_found=$((shared_found + 1))
            if ! cmp -s "$SHARED_ORIGINAL" "$copy"; then
                echo "FAIL: $copy differs from $SHARED_ORIGINAL"
                shared_ok=0
            fi
        done
        if [ "$shared_ok" = 1 ] && [ "$shared_found" -ge 2 ]; then
            echo "ok ($shared_found copies)"
        else
            [ "$shared_found" -ge 2 ] || echo "FAIL: expected a $shared in both sketch folders, found $shared_found"
            overall_status=1
        fi
    done

    run_cpp_test test_alarm_logic
    run_cpp_test test_remote_log
    run_cpp_test test_person_scene_logic
    run_cpp_test test_person_motion_baseline
    run_cpp_test test_person_report_logic
    run_cpp_test test_relay_health
    # The setup-mode session (F-21): when the board's own setup WiFi opens, how long it stays, when the board restarts.
    run_cpp_test test_setup_mode_session
    # The setup boot (F-21): whether this boot is a setup boot, the WiFi's name and password, the wiring of
    # form + session + access point, SETUP_MODE=0 — against each sketch's real key table; and the optional
    # build-time default password.
    run_cpp_test test_setup_boot_recorder
    run_cpp_test test_setup_boot_person
    run_cpp_test test_setup_credentials
    # setup_mode.h compiled for real against fakes of the Arduino core (tests/cpp/ota_fakes/): the access point, DNS and
    # HTTP server, and the ArduinoSetupHardware that SetupBoot runs on; the last tests put the real form and session on top.
    run_cpp_test test_setup_mode_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"
    run_cpp_test test_settings_logic
    run_cpp_test test_settings_remote
    run_cpp_test test_settings_change
    run_cpp_test test_person_settings
    run_cpp_test test_ota_logic
    # Finding the relay again when its address changed: the decisions, then relay_find.h against fakes.
    run_cpp_test test_relay_find_logic
    run_cpp_test test_relay_find_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"
    # ota.h is compiled for real against fakes of the Arduino core (tests/cpp/ota_fakes/).
    run_cpp_test test_ota_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"
    # settings_sync.h (changing a board's stored settings from the dashboard) the same way.
    run_cpp_test test_settings_sync_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"

    # The dashboard's copy of the Recorder's settings table is generated from the firmware's own.
    group_text "--- the dashboard's settings table is up to date with the firmware's"
    if ! "$ROOT_DIR/tools/gen_device_schema.sh" --check; then
        overall_status=1
    fi

    # The sketch's remote-logging glue is tested by compiling the code it
    # ACTUALLY contains: extract the marked block from the .ino and build it
    # against fake Arduino/FreeRTOS/HTTP objects. If the markers go missing the
    # extract is empty and the compile below fails loudly.
    sed -n '/Remote logging glue ──/,/end of remote logging glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" > "$BUILD_DIR/log_glue.inc"
    run_cpp_test test_sketch_log_glue

    # The Recorder's settings glue (flash storage, serial port, the 5 s window)
    # is tested the same way, against fake Preferences/Serial/millis()/ESP.restart().
    sed -n '/Settings glue ──/,/end of settings glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" > "$BUILD_DIR/settings_glue.inc"
    # The block now also builds a SetupBoot (F-21) over a fake ArduinoSetupHardware (tests/cpp/setup_boot_fakes.h,
    # included by settings_glue_fakes.h); setup_boot.h is found through the sketch's folder.
    run_cpp_test test_settings_glue -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"
    # ...and the setup mode as the block wires it: nothing touched when not in setup, the setup WiFi alone
    # for an armed board, next to the serial prompt for a blank one, and every way out ends in a restart.
    run_cpp_test test_setup_glue_recorder -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"

    # The sketch's few lines that join settings_sync.h to its flash store, schema and restart:
    # extracted from the .ino and compiled against fakes (fails loudly if a name or marker changes).
    sed -n '/Settings changed from the dashboard ──/,/end of settings changed from the dashboard/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" > "$BUILD_DIR/sync_glue.inc"
    run_cpp_test test_settings_sync_sketch -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"

    # ...and the person detector's, likewise (its CALIBRATE page uses the same mechanism).
    sed -n '/Settings changed from the dashboard ──/,/end of settings changed from the dashboard/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" > "$BUILD_DIR/person_sync_glue.inc"
    run_cpp_test test_person_settings_sync_sketch -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person"

    # ...and the person detector's, likewise.
    sed -n '/Settings glue ──/,/end of settings glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" > "$BUILD_DIR/person_settings_glue.inc"
    run_cpp_test test_person_settings_glue -I "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person"
    run_cpp_test test_setup_glue_person -I "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person"

    # The detector's remote-logging glue and its uplink glue (the socket, JPEG encoder, snapshot, the
    # Wi-Fi / heartbeat lines, the network task, start-up and the boot report) are tested the same way: extract the marked blocks from the .ino and build
    # them against fake Arduino / FreeRTOS / WiFi / HTTP objects.
    sed -n '/Remote logging glue ──/,/end of remote logging glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" > "$BUILD_DIR/person_log_glue.inc"
    run_cpp_test test_person_log_glue
    sed -n '/Uplink glue ──/,/end of uplink glue/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" > "$BUILD_DIR/uplink_glue.inc"
    sed -n -e '/The task ──/,/end of network task and start/p' -e '/Boot report ──/,/end of boot report/p' \
        "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" > "$BUILD_DIR/network_glue.inc"
    run_cpp_test test_person_uplink_glue

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
        heading "C++ coverage (gcov), minimum ${COVERAGE_MIN}%"
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

# ── The sketches themselves ──────────────────────────────────────────────
# The C++ tests above compile parts of the sketches against fakes; this compiles each sketch folder as a
# whole with the real toolchain. Exit 1 = a sketch does not compile, 2 = no toolchain: both fail the run.
heading "Arduino sketches compile (arduino-cli, the real toolchain)"
if [ "$COMPILE_SKETCHES" = 0 ]; then
    echo "SKIPPED (--no-sketch-compile): the sketches were NOT compiled"
else
    "$ROOT_DIR/tools/compile_sketches.sh"
    [ $? -ne 0 ] && overall_status=1
fi

# ── Node.js logic tests ──────────────────────────────────────────────────
heading "Node.js (camera-relay logic) tests"

if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # With --coverage, Node itself records V8 coverage for every unit-test
    # process (NODE_V8_COVERAGE — built in, no nyc/c8 needed) and
    # tests/node/coverage_report.js turns it into a line-coverage report of
    # nodejs/camera-relay/lib/*.js. The variable is set only for these unit
    # tests (never for the end-to-end tests below, which start relay servers).
    NODE_COV_DIR=""
    if [ -n "$COVERAGE_MIN" ]; then
        NODE_COV_DIR="$(mktemp -d)"
    fi

    for f in "$ROOT_DIR"/tests/node/test_*.js; do
        group_text "-- $(basename "$f")"
        if [ -n "$NODE_COV_DIR" ]; then
            NODE_V8_COVERAGE="$NODE_COV_DIR" node "$f"
        else
            node "$f"
        fi
        [ $? -ne 0 ] && overall_status=1
    done

    # ── Coverage gate (only with --coverage N) ───────────────────────────
    if [ -n "$NODE_COV_DIR" ]; then
        heading "Node.js coverage, minimum ${COVERAGE_MIN}%"
        node "$ROOT_DIR/tests/node/coverage_report.js" "$NODE_COV_DIR" "$ROOT_DIR" "$COVERAGE_MIN"
        [ $? -ne 0 ] && overall_status=1
        rm -rf "$NODE_COV_DIR"
    fi
fi

# ── Python (person detector script) tests ────────────────────────────────
# tools/person_scan.py decides whether a recording shows a person. Needs python3 with numpy and OpenCV
# (sudo apt install python3-opencv); without them the suite is reported as a failure like any missing tool.
heading "Python (person detector) tests"
if ! command -v python3 >/dev/null 2>&1; then
    echo "FAIL: python3 not found on PATH"
    overall_status=1
elif ! python3 -c 'import cv2, numpy' >/dev/null 2>&1; then
    echo "FAIL: python3 needs numpy and OpenCV for the detector tests (sudo apt install python3-opencv)"
    overall_status=1
else
    python3 -I -m unittest discover -s "$ROOT_DIR/tests/python" -t "$ROOT_DIR/tests/python"
    [ $? -ne 0 ] && overall_status=1
fi

# ── End-to-end tests ─────────────────────────────────────────────────────
# Both spawn the real relay on their own ports (never the real 8080/8081)
# with a throwaway settings file — a real settings.json is never touched.
# Both need the relay's packages in nodejs/camera-relay/ (the relay itself needs express):
# this script installs them with `npm ci` when they are missing (see ensure_npm_deps).
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
#   - tests/e2e/test_dashboard_csrf_e2e.js: the dashboard's record.php / recordings.php POSTs
#     (start, stop, delete, delete all, seen) refuse a cross-site request, send the control key
#     and X-Actor to the relay, cap seconds, and leave an audit line; the old settings.php POST is gone.
#   - tests/dom/test_nav_bar_browser.js: the navigation bar and the dashboard's grid / list switch in a real
#     Chromium (LOG OUT at the right end, list = one column, remembered, ?layout= wins, phone width).
#   - tests/dom/test_files_list_layout_browser.js: the footage list's rows in a real Chromium: on a phone the buttons
#     (PLAY / GET / DEL, RESTORE in the archive) are on a line of their own, floated right, at the same place in
#     every row, and nothing runs off the screen; on a wide screen they stay at the end of the name's line.
#   - tests/dom/test_simple_view_fullscreen_browser.js: the simple view's two ways into full screen in a real Chromium:
#     the FULL SCREEN button shows the whole page (status line in view, button pressed), a click on the picture shows
#     the picture box alone (status line covered).
#   - tests/e2e/test_dashboard_logout_e2e.js: the LOG OUT button (real php -S): on every page's navigation bar as a
#     plain POST form; logout.php answers a logged-in same-origin POST with 401 + the login's own realm and
#     a "logged out" page; a GET or a cross-site POST is refused and never prompts; one audit line per real
#     logout; logging out never feeds the guess throttle. Override the port with E2E_LOGOUT_PORT.
#   - tests/e2e/test_dashboard_simple_pages_e2e.js: the simple camera pages (real php -S): the dashboard's
#     SIMPLE LIST / SIMPLE VIEW buttons, both pages behind the login, one thumbnail per camera linking to its
#     large view, the camera asked for (default the first; unknown 404, array / traversal ids refused), the
#     camera list and slideshow time handed to the script (setting, default, settings.json), hostile names
#     staying text, the scripts served. Override the port with E2E_SIMPLE_PORT.
#   - tests/e2e/test_dashboard_switch_e2e.js: the dashboard's recording-switch.php
#     proxy (real php -S in front of a recording fake relay) — login, the
#     anti-forgery header, POST only, key added server-side and never sent to
#     the browser, input validation. Skips itself if php is missing. Override the
#     ports with E2E_SWDASH_PORT / E2E_SWDASH_RELAY_PORT / E2E_SWDASH_DEAD_PORT.
#   - tests/e2e/test_dashboard_reboot_e2e.js: the dashboard's reboot.php (reset a camera, its person
#     detector, the relay, PHP, the Pi) — real php -S in front of a recording fake relay: login, anti-forgery header, POST
#     only, control key added server-side, the relay's refusals passed back,
#     bad input never forwarded; the relay and host targets with a fake relay and a fake power helper.
#     Skips itself if php is missing. Override the ports with
#     E2E_REBOOT_PORT / E2E_REBOOT_RELAY_PORT / E2E_REBOOT_DEAD_PORT.
#   - tests/e2e/test_wifi_info_e2e.js: the Wi-Fi network and signal of cameras and detectors through a real relay —
#     the greeting byte that announces the in-band Wi-Fi report, a camera's report in GET /status, refused reports
#     (control characters, too long, not connected, too short) changing nothing, a resting detector's live-view poll
#     (?ssid=&rssi=) in GET /detectors, hostile query values ignored, the log naming a new network but never a
#     refused one. Override the ports with E2E_WIFI_PORT / E2E_WIFI_PUSH_PORT.
#   - tests/e2e/test_dashboard_wifi_e2e.js: status.php and detector-status.php in front of a fake relay — the
#     network and signal passed on checked again, a reading the relay got wrong dropped, the detector's own
#     rssi/ssid readings moved into `wifi`, no network name written into the page. Skips itself if php is missing.
#     Override the ports with E2E_DWIFI_PORT (and the next one up).
#   - tests/dom/test_wifi_dom.js: the Wi-Fi chips on the real dashboard page in jsdom — a chip per camera and a
#     line per detector (a resting one too), a hostile network name shown as text only, chips following the data.
#     Needs php and jsdom. Override the port with E2E_WIFIDOM_PORT (and the next one up).
#   - tests/dom/test_camera_settings_dom.js: the camera settings page in jsdom saving a change — a board that
#     predates the JPEG quality keys (JPEG_Q_* / SIZE_DROP, F-14) is not asked for values it cannot have yet
#     (the version-skew regression), while a board that has the keys must still give the range when it switches
#     the drop on; what the page posts is what the relay is handed. Needs php and jsdom. Override the port with
#     E2E_CAMSETDOM_PORT (and the next one up).
#   - tests/e2e/test_camera_device_e2e.js: what the dashboard may know about a camera's board through a real relay —
#     its address and connection time in GET /status, the firmware, uptime and free memory taken from the camera's
#     POST /log batches, hostile values dropped, no camera added by a log request, nothing invented for a camera that
#     never logs or stopped sending. Override the ports with E2E_DEVINFO_PORT / E2E_DEVINFO_PUSH_PORT.
#   - tests/dom/test_device_info_dom.js: the board line of a camera's card on the real dashboard page in jsdom (and the
#     detector's info line, built by the same code) — shown, following the data, a hostile firmware name as text only.
#     Needs php and jsdom. Override the port with E2E_DEVDOM_PORT (and the next one up).
#   - tests/e2e/test_logging_e2e.js: the relay's log file and POST /log — key
#     authentication, entries filed under the time they HAPPENED with the
#     sender's IP, no forged lines, rotation, relay-observed events (camera
#     connected/dropped), an unusable log location. Override the ports with
#     E2E_LOG_PORT / E2E_LOG_PUSH_PORT.
#   - tests/e2e/test_device_settings_e2e.js: the settings the relay stages for
#     boards that are missing some (GET/PUT /device-settings) — camera key to
#     ask, control key to stage, a device's own line beating the fleet line, the
#     exact text kept, names (never values) in the log, bad ids/types/bodies and
#     path traversal refused. Override the ports with E2E_DEVSET_PORT /
#     E2E_DEVSET_PUSH_PORT.
#   - tests/e2e/test_ota_e2e.js: the firmware the relay hands to the boards (PUT/GET /ota/...) —
#     control key to publish, camera key to ask and download, images that are not ESP32 images
#     refused, byte-exact download with the announced md5, the log lines (published, downloading,
#     "now runs X (was Y)", update failed), /ota/status, downgrade, restart. Override the ports
#     with E2E_OTA_PORT / E2E_OTA_PUSH_PORT.
#   - tests/e2e/test_ota_deploy_e2e.js: ota-deploy.sh against a real relay, with a fake arduino-cli in
#     a throwaway git repo — the version is the git revision (dirty tree: .t<epoch>), fw_version.h
#     written and removed, the right binary published per type, a failed build / oversized image /
#     refused upload stops the run (and `all` publishes nothing unless every sketch built), and
#     --wait succeeds or fails depending on whether the (simulated) cameras updated. Skips itself
#     if bash, git or curl is missing. Override the ports with E2E_OTADEP_PORT / E2E_OTADEP_PUSH_PORT.
#   - tests/e2e/test_push_connection_e2e.js: how the relay treats a camera's push
#     connection on a bad WiFi link — a reconnect after the old connection went
#     quiet is not an id clash (and the ghost is closed), two boards really
#     sending at once still are, silent connections are dropped while slow
#     trickling ones are kept. Override the ports with E2E_PUSHCONN_PORT /
#     E2E_PUSHCONN_PUSH_PORT.
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
#   - tests/e2e/test_relay_camera_id_e2e.js: a camera id can never leave the recordings folder or
#     grow the relay's memory without bound. Percent-encoded traversal ids (..%2F..%2F...) are
#     refused (400) by every route that takes an id — list, download, delete, mark-seen, record,
#     stop, alarm, stream, snapshot — and a decoy folder outside recordings/ keeps its clip and
#     gains no folder; a push connection with a traversal id is dropped; ordinary ids still work;
#     the relay remembers at most 64 camera ids and refuses (503) a 65th on every way in, while
#     cameras it already knows keep working. Override the ports with E2E_CAMID_PORT /
#     E2E_CAMID_PUSH_PORT.
#   - tests/e2e/test_relay_dashboard_auth_e2e.js: what only the dashboard does needs the relay's control
#     key (POST /settings, POST /record/..., DELETE /recordings/..., POST /recordings/.../seen): refused
#     (401) with no key, a wrong or empty key, the camera key or the key in the query string — and a
#     refused request changes nothing; works with the key, and who did it is logged; answers 503 (closed,
#     not open) when no controlKey is configured; reads and POST /alarm stay open; no key in the log.
#     Override the ports with E2E_DASHAUTH_PORT / E2E_DASHAUTH_PUSH_PORT.
#   - tests/e2e/test_relay_upload_auth_e2e.js: POST /upload/:id checks the camera key BEFORE it reads the
#     body: a 3 MB body with a wrong or missing key is a 403 with one WARN line (no 500, no stack trace);
#     with the key a picture is stored, an oversized body is a 413 and an empty one a 400; only POST is
#     an upload. Override the ports with E2E_UPLOAD_PORT / E2E_UPLOAD_PUSH_PORT.
#   - tests/e2e/test_relay_lockout_e2e.js: guessing a key gets slower, then impossible. Wrong camera keys
#     lock the address out (429 + Retry-After) on every camera-key route, the push port and the detector
#     uplink, even for the right key; a missing key is not a guess; the control key is counted apart; a
#     spoofed X-Forwarded-For does not help; the lock ends on time and the next is twice as long; one
#     LOCKED OUT line per lock, no key in the log. Also: POST /system-settings refuses folder settings that
#     point outside the relay's folder. Takes about 20 seconds. Override the ports with E2E_LOCKOUT_PORT /
#     E2E_LOCKOUT_PUSH_PORT.
#   - tests/e2e/test_relay_mux_e2e.js: GET /mux on a real relay — the one live connection that carries every camera's
#     and detector's pictures and readings (framing, limits, heartbeat, slow viewers, read key).
#   - tests/e2e/test_dashboard_mux_e2e.js: mux.php (real php -S) in front of a fake relay — only what was asked for
#     passes, detectors are renamed to their camera, nothing of a misbehaving relay leaks.
#   - tests/e2e/test_relay_read_auth_e2e.js: what the cameras SEE needs the control key — /stream, /snapshot,
#     /status, /settings, /detectors, /detector/<id>/stream, /record/<id>, /recordings/..., /recording/state
#     answer 401 to no key, a wrong or empty key, the camera key or the key in the query string, and say
#     nothing about the cameras; with the key they return the real picture/recording/list/stream; /alarm,
#     /upload, the push port and the device routes are as before; with no controlKey the reads are let
#     through, with a startup warning, and what changes things is still refused. Override the ports with
#     E2E_READAUTH_PORT / E2E_READAUTH_PUSH_PORT.
# With --coverage, the relay processes these tests start also record V8
# coverage (NODE_V8_COVERAGE is inherited by the relay they spawn; the relay
# writes it when the test stops it), which is how server.js — the relay itself —
# gets a coverage figure. The variable is set per test run, never exported to
# the rest of this script.
E2E_COV_DIR=""
if [ -n "$COVERAGE_MIN" ]; then
    E2E_COV_DIR="$(mktemp -d)"
fi
run_node_e2e() {
    if [ -n "$E2E_COV_DIR" ]; then
        NODE_V8_COVERAGE="$E2E_COV_DIR" node "$1"
    else
        node "$1"
    fi
}

heading "Shell tests (the dashboard's privileged power helper)"
"$ROOT_DIR/tests/shell/test_camdash_power.sh"
[ $? -ne 0 ] && overall_status=1

heading "Shell tests (the sketch compile check, tools/compile_sketches.sh, against a fake arduino-cli)"
"$ROOT_DIR/tests/shell/test_compile_sketches.sh"
[ $? -ne 0 ] && overall_status=1

heading "Shell tests (the output levels, tools/test_output.sh, and --verbose)"
"$ROOT_DIR/tests/shell/test_test_output.sh"
[ $? -ne 0 ] && overall_status=1

heading "Shell tests (the helpers that check what the sources contain, tests/shell/lib/source_checks.sh)"
"$ROOT_DIR/tests/shell/test_source_checks.sh"
[ $? -ne 0 ] && overall_status=1

# Static check, no setup needed: the eight security patches are still in the relay, the dashboard, the sketches,
# the Apache config and the tests. It is the quick check on its own too: tests/shell/test_security_patches.sh.
heading "Shell tests (the security patches 0001-0008 are in the sources and not undone)"
"$ROOT_DIR/tests/shell/test_security_patches.sh"
[ $? -ne 0 ] && overall_status=1

# The relay itself needs its packages (express ...) for every end-to-end test below: installed here from
# the lockfile when missing or out of date (a normal run costs nothing). Needs node and npm on the PATH.
ensure_npm_deps "$ROOT_DIR/nodejs/camera-relay" "the relay (end-to-end tests)"

heading "End-to-end (alarm settings) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_alarm_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (person detector uplink, relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_detector_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (the detector firmware's real uplink code against the real relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_detector_firmware_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard person-detector row) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_detector_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (Wi-Fi network and signal of cameras and detectors, relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_wifi_info_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (the board of a camera: address, firmware, uptime, memory) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_camera_device_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (Wi-Fi network and signal on the dashboard) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_wifi_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (small live pictures reach the browser one by one, dashboard) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_stream_smooth_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (detector live view switch, relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_detector_view_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (detector live view switch, dashboard) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_detector_view_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (recording ON/OFF switch, relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_recording_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (recording ON/OFF switch, dashboard proxy) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_reboot_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard CSRF guard: record, delete, settings) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_csrf_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard login: unsafe config refused, guess throttle) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_login_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard LOG OUT button) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_logout_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (simple camera pages: list, large view, slideshow time) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_simple_pages_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (PHP security headers) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_security_headers_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (real Apache: shipped vhost, headers, denied files) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_apache_hardening_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (deploy.sh: web folder, config carry-over) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_deploy_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (relay redirects never followed; relay_url restricted) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_redirect_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (hostile relay: stream types, Range, statuses, array params, leaks) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_trust_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (settings saved in data/settings.json: atomic, locked, damage-proof) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_config_overrides_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM helper (closing a jsdom window without a late frame crashing the run) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_dom_helpers.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM (the real dashboard page in jsdom: nothing from the relay or config becomes markup) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # needs the jsdom package (tests/dom/package.json): installed here when missing or out of date; the
    # test says SKIP if that was not possible
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_index_dom.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM (the dashboard page after the phone was locked: pictures start over) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_resume_dom.js"
    [ $? -ne 0 ] && overall_status=1
fi

# Auto-install playwright (package + browsers) so the browser tests below run
# instead of SKIP. npx playwright install is idempotent: it downloads what is
# missing and skips what is already there, so running it every time is safe.
# (0018 only installed the chromium browser, but newer playwright also needs
# chrome-headless-shell — npx playwright install with no browser argument
# installs everything the installed playwright version expects.)
if command -v node >/dev/null 2>&1; then
    if ! (cd "$ROOT_DIR/tests/dom" && node -e "require('playwright')" 2>/dev/null); then
        echo "(playwright package not found — installing...)"
        (cd "$ROOT_DIR/tests/dom" && npm install playwright >/dev/null 2>&1) || true
    fi
    if (cd "$ROOT_DIR/tests/dom" && node -e "require('playwright')" 2>/dev/null); then
        (cd "$ROOT_DIR/tests/dom" && npx playwright install >/dev/null 2>&1) || echo "(playwright browser install failed — the browser tests will SKIP)"
    fi
fi

heading "Browser (the icon chooser bubble of the settings pages, in a real Chromium) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # needs the playwright package with a browser, and php; the test says SKIP (and passes) when one is missing
    run_node_e2e "$ROOT_DIR/tests/dom/test_icon_picker_browser.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "Browser (navigation bar, grid / list switch) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # needs the playwright package with a browser, and php; the test says SKIP (and passes) when one is missing
    run_node_e2e "$ROOT_DIR/tests/dom/test_nav_bar_browser.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "Browser (footage list layout on a phone and on a wide screen) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # needs the playwright package with a browser, and php; the test says SKIP (and passes) when one is missing
    run_node_e2e "$ROOT_DIR/tests/dom/test_files_list_layout_browser.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "Browser (simple view: FULL SCREEN button and click on the picture) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    # needs the playwright package with a browser, and php; the test says SKIP (and passes) when one is missing
    run_node_e2e "$ROOT_DIR/tests/dom/test_simple_view_fullscreen_browser.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM (the Wi-Fi network and signal chips on the dashboard page) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_wifi_dom.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM (the camera settings page saving a change) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_camera_settings_dom.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "DOM (the board line of a camera's card on the dashboard page) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    ensure_npm_deps "$ROOT_DIR/tests/dom" "the DOM test (jsdom)"
    run_node_e2e "$ROOT_DIR/tests/dom/test_device_info_dom.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (relay logging) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_logging_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (firmware over the air, relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_ota_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (ota-deploy.sh) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_ota_deploy_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (camera push connection on a weak link) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_push_connection_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard FILES count on first load) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_counts_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (recording pre-roll) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_preroll_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (settings staged on the relay for boards missing some) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_device_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (relay HTTP/TCP behaviour and failure handling) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_api_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (reads need the control key) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_read_auth_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (the relay's one multiplexed live connection, GET /mux) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_mux_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (the dashboard's mux.php in front of a fake relay) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_mux_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (key guessing lockout, folder settings confined) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_lockout_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (HTTP upload checks the key before reading the body) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_upload_auth_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (dashboard-only relay routes need the control key) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_dashboard_auth_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (camera id validation and camera cap) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_camera_id_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (cameras find the relay again: UDP discovery) test"
# tests/e2e/test_discovery_e2e.js: a real relay answers on UDP, and the question is asked by the firmware's
# real search code (relay_find_logic.h, compiled by tests/cpp/relay_find_tool.cpp) — so the C++ and the
# JavaScript are proven to agree over real sockets. Junk gets no answer; the wrong key finds nothing;
# a sweep finds the relay with the broadcast cut off (a NAT router). Needs g++. Ports: E2E_DISC_PORT,
# E2E_DISC_PUSH_PORT, E2E_DISC_UDP.
if ! command -v node >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
    echo "FAIL: node and g++ are needed on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_discovery_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (settings page: relay + dashboard, save and restart) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_system_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (camera settings page: change queued on the relay, simulated board, cameras add/remove) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_camera_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

heading "End-to-end (ALL FILES page: login, cameras handed over safely, per-camera lists, deletes) test"
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_all_recordings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

# ── Coverage gate for server.js (only with --coverage N) ─────────────────
if [ -n "$E2E_COV_DIR" ]; then
    heading "Relay server.js coverage (from the end-to-end tests), minimum ${COVERAGE_MIN}%"
    if ! command -v node >/dev/null 2>&1; then
        echo "FAIL: node not found on PATH"
        overall_status=1
    else
        node "$ROOT_DIR/tests/node/coverage_report.js" "$E2E_COV_DIR" "$ROOT_DIR" "$COVERAGE_MIN" server
        [ $? -ne 0 ] && overall_status=1
    fi
    rm -rf "$E2E_COV_DIR"
fi

# ── PHP logic tests ───────────────────────────────────────────────────────
heading "PHP (dashboard logic) tests"

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
        group_text "-- $(basename "$f")"
        php ${PHP_COV_FLAGS[@]+"${PHP_COV_FLAGS[@]}"} "$f"
        [ $? -ne 0 ] && overall_status=1
    done

    # ── Coverage gate (only with --coverage N) ───────────────────────────
    if [ -n "$PHP_COV_DIR" ]; then
        heading "PHP coverage, minimum ${COVERAGE_MIN}%"
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
