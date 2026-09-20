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
#   ./run_tests.sh
#
# Exit code: 0 if every suite passed, 1 if any suite failed or couldn't run.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$ROOT_DIR/tests/cpp/build"

overall_status=0

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
CPP_BIN="$BUILD_DIR/test_alarm_logic"

if ! command -v g++ >/dev/null 2>&1; then
    echo "FAIL: g++ not found on PATH"
    overall_status=1
elif ! g++ -std=c++17 -Wall -Wextra -o "$CPP_BIN" "$ROOT_DIR/tests/cpp/test_alarm_logic.cpp"; then
    echo "FAIL: could not compile C++ tests"
    overall_status=1
elif command -v gdb >/dev/null 2>&1; then
    gdb -q -batch -ex run -ex bt -ex 'quit $_exitcode' --args "$CPP_BIN"
    [ $? -ne 0 ] && overall_status=1
else
    echo "gdb not found on PATH — running the test binary directly instead"
    "$CPP_BIN"
    [ $? -ne 0 ] && overall_status=1
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

# ── PHP logic tests ───────────────────────────────────────────────────────
hr
echo "PHP (dashboard logic) tests"
hr

if ! command -v php >/dev/null 2>&1; then
    echo "FAIL: php not found on PATH"
    overall_status=1
else
    for f in "$ROOT_DIR"/tests/php/test_*.php; do
        echo "-- $(basename "$f")"
        php "$f"
        [ $? -ne 0 ] && overall_status=1
    done
fi

hr
if [ "$overall_status" -eq 0 ]; then
    echo "ALL TEST SUITES PASSED"
else
    echo "ONE OR MORE TEST SUITES FAILED"
fi
hr

exit "$overall_status"
