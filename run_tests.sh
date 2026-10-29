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
#                                   of the five areas below is under N percent
#                                   (0-100): the two Arduino sketches (gcov),
#                                   the dashboard's PHP logic, the relay's
#                                   Node.js logic and the relay's server.js
#   ./run_tests.sh -h | --help
#
# Coverage is measured per area and N applies to EACH of them, so a
# well-tested one can't hide an untested one:
#   Recorder:        logic.h, remote_log.h, settings_logic.h, settings_schema.h
#                    and the remote-logging and settings blocks of
#                    ESP32_CAM_Recorder.ino
#   Person detector: report_logic.h (what is sent to the relay for the dashboard,
#                    and the connection that carries it), scene_logic.h
#                    (darkness/motion gate), settings_schema.h, and the detection,
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
    shift
    local bin="$BUILD_DIR/$name"
    echo "--- $name"
    if ! g++ -std=c++17 -Wall -Wextra ${COV_FLAGS[@]+"${COV_FLAGS[@]}"} "$@" -o "$bin" "$ROOT_DIR/tests/cpp/$name.cpp"; then
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

    # The person detector's connection to the relay and what it reports (also compiled by the sketch).
    echo "--- report_logic.h as C++11 (the ESP32 toolchain's dialect)"
    if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
           -include "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/report_logic.h" -x c++ /dev/null; then
        echo "ok"
    else
        echo "FAIL: report_logic.h does not compile as C++11"
        overall_status=1
    fi

    # The settings engine and the Recorder's key table (flash-stored settings,
    # see settings_logic.h): also compiled by the sketch, so also C++11.
    # ...and the darkness/motion gate.
    echo "--- scene_logic.h as C++11 (the ESP32 toolchain's dialect)"
    if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
           -include "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person/scene_logic.h" -x c++ /dev/null; then
        echo "ok"
    else
        echo "FAIL: scene_logic.h does not compile as C++11"
        overall_status=1
    fi

    for h in ESP32_CAM_Recorder/settings_logic.h ESP32_CAM_Recorder/settings_schema.h \
             ESP32_CAM_TFLite_Person/settings_schema.h ESP32_CAM_Recorder/ota_logic.h; do
        echo "--- $h as C++11 (the ESP32 toolchain's dialect)"
        if g++ -std=c++11 -fsyntax-only -Wall -Wextra -pedantic \
               -include "$ROOT_DIR/Arduino/$h" -x c++ /dev/null; then
            echo "ok"
        else
            echo "FAIL: $h does not compile as C++11"
            overall_status=1
        fi
    done

    # settings_logic.h is deliberately copied into every sketch folder that uses
    # it (an Arduino sketch can only include files from its own folder). The
    # copies must be identical: edit one, copy it over the others.
    echo "--- settings_logic.h copies are identical"
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
    for shared in ota_logic.h ota.h remote_log.h settings_sync.h; do
        echo "--- $shared copies are identical"
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
    run_cpp_test test_person_report_logic
    run_cpp_test test_settings_logic
    run_cpp_test test_settings_remote
    run_cpp_test test_settings_change
    run_cpp_test test_person_settings
    run_cpp_test test_ota_logic
    # ota.h is compiled for real against fakes of the Arduino core (tests/cpp/ota_fakes/).
    run_cpp_test test_ota_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"
    # settings_sync.h (changing a board's stored settings from the dashboard) the same way.
    run_cpp_test test_settings_sync_glue -I "$ROOT_DIR/tests/cpp/ota_fakes" -I "$ROOT_DIR/Arduino/ESP32_CAM_Recorder"

    # The dashboard's copy of the Recorder's settings table is generated from the firmware's own.
    echo "--- the dashboard's settings table is up to date with the firmware's"
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
    run_cpp_test test_settings_glue

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
    run_cpp_test test_person_settings_glue

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
        echo "-- $(basename "$f")"
        if [ -n "$NODE_COV_DIR" ]; then
            NODE_V8_COVERAGE="$NODE_COV_DIR" node "$f"
        else
            node "$f"
        fi
        [ $? -ne 0 ] && overall_status=1
    done

    # ── Coverage gate (only with --coverage N) ───────────────────────────
    if [ -n "$NODE_COV_DIR" ]; then
        hr
        echo "Node.js coverage, minimum ${COVERAGE_MIN}%"
        hr
        node "$ROOT_DIR/tests/node/coverage_report.js" "$NODE_COV_DIR" "$ROOT_DIR" "$COVERAGE_MIN"
        [ $? -ne 0 ] && overall_status=1
        rm -rf "$NODE_COV_DIR"
    fi
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
#   - tests/e2e/test_dashboard_csrf_e2e.js: the dashboard's record.php / recordings.php POSTs
#     (start, stop, delete, delete all, seen) refuse a cross-site request, send the control key
#     and X-Actor to the relay, cap seconds, and leave an audit line; the old settings.php POST is gone.
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

hr
echo "End-to-end (alarm settings) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_alarm_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (person detector uplink, relay) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_detector_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (the detector firmware's real uplink code against the real relay) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_detector_firmware_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (dashboard person-detector row) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_detector_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording ON/OFF switch, relay) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_recording_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording ON/OFF switch, dashboard proxy) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_switch_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (dashboard CSRF guard: record, delete, settings) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_csrf_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (dashboard login: unsafe config refused, guess throttle) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_login_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (PHP security headers) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_security_headers_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (real Apache: shipped vhost, headers, denied files) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_apache_hardening_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (deploy.sh: web folder, config carry-over) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_deploy_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (relay redirects never followed; relay_url restricted) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_redirect_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (hostile relay: stream types, Range, statuses, array params, leaks) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_trust_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (settings saved in data/settings.json: atomic, locked, damage-proof) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_config_overrides_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "DOM (the real dashboard page in jsdom: nothing from the relay or config becomes markup) test"
hr
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

hr
echo "End-to-end (relay logging) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_logging_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (firmware over the air, relay) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_ota_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (ota-deploy.sh) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_ota_deploy_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (camera push connection on a weak link) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_push_connection_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (dashboard FILES count on first load) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_dashboard_counts_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (recording pre-roll) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_preroll_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (settings staged on the relay for boards missing some) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_device_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (relay HTTP/TCP behaviour and failure handling) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_relay_api_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (settings page: relay + dashboard, save and restart) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_system_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

hr
echo "End-to-end (camera settings page: change queued on the relay, simulated board, cameras add/remove) test"
hr
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH"
    overall_status=1
else
    run_node_e2e "$ROOT_DIR/tests/e2e/test_camera_settings_e2e.js"
    [ $? -ne 0 ] && overall_status=1
fi

# ── Coverage gate for server.js (only with --coverage N) ─────────────────
if [ -n "$E2E_COV_DIR" ]; then
    hr
    echo "Relay server.js coverage (from the end-to-end tests), minimum ${COVERAGE_MIN}%"
    hr
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
