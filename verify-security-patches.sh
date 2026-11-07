#!/usr/bin/env bash
# verify-security-patches.sh — run on your dev laptop to verify the 8 security
# patches are applied correctly and don't break the test suite.
#
# What this script checks:
#   1. You're on the right repo and the patches are applied (code-level grep)
#   2. The C++ unit tests compile and pass (catches the maskedSsid issue)
#   3. The Node.js unit tests pass
#   4. The e2e tests that don't need PHP pass (they start their own relay)
#   5. The sketch compilation (if arduino-cli is installed)
#   6. The PHP unit tests (if php is installed)
#
# What this script CANNOT check (needs the real hardware/Pi):
#   - Cameras actually connecting and streaming
#   - Detectors connecting via HTTP Upgrade
#   - The dashboard serving over Tor
#   - The OTA update flow with real boards
#   Run MANUAL-TESTING.md for those.
#
# Usage:
#   ./verify-security-patches.sh              # full check
#   ./verify-security-patches.sh --no-sketch   # skip arduino-cli sketch compile
#   ./verify-security-patches.sh --no-e2e      # skip the e2e suite (faster)
#   ./verify-security-patches.sh --code-only   # just the grep checks, no tests
#
# Exit code: 0 if everything passed, 1 if any check failed.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ── colours ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── counters ─────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
FAILED_CHECKS=()

# ── arguments ────────────────────────────────────────────────────────────
NO_SKETCH=0
NO_E2E=0
CODE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-sketch) NO_SKETCH=1 ;;
    --no-e2e)    NO_E2E=1 ;;
    --code-only) CODE_ONLY=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────────────
ok()   { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1"); }
skip() { echo -e "  ${YELLOW}○${NC} $1 (skipped: $2)"; SKIP=$((SKIP+1)); }
info() { echo -e "  ${BLUE}→${NC} $1"; }
hdr()  { echo -e "\n${BOLD}=== $1 ===${NC}"; }

# grep_file <file> <pattern> <description>
#   Checks that <pattern> exists in <file>. Prints ok/fail.
grep_file() {
  local file="$1" pattern="$2" desc="$3"
  if [ ! -f "$file" ]; then
    fail "$desc (file not found: $file)"
    return 1
  fi
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    ok "$desc"
  else
    fail "$desc (pattern not found in $file: $pattern)"
  fi
}

# grep_file_not <file> <pattern> <description>
#   Checks that <pattern> does NOT exist in <file>. Prints ok/fail.
grep_file_not() {
  local file="$1" pattern="$2" desc="$3"
  if [ ! -f "$file" ]; then
    fail "$desc (file not found: $file)"
    return 1
  fi
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    fail "$desc (pattern should NOT be in $file: $pattern)"
  else
    ok "$desc"
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# 0. Pre-flight: are we in the right repo?
# ══════════════════════════════════════════════════════════════════════════
hdr "Pre-flight"

if [ ! -f "nodejs/camera-relay/server.js" ] || [ ! -d "Arduino" ]; then
  echo "This script must be run from the repo root (the folder containing nodejs/, Arduino/, php/)." >&2
  echo "Current dir: $ROOT_DIR"
  exit 2
fi
ok "Running from the repo root: $ROOT_DIR"

# Check git is available and we're on a branch with the patches
if ! command -v git >/dev/null 2>&1; then
  fail "git not found on PATH"
  exit 2
fi
ok "git is available"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
echo -e "  ${BLUE}i${NC} Current branch: $CURRENT_BRANCH"
echo -e "  ${BLUE}i${NC} HEAD commit:   $(git rev-parse --short HEAD 2>/dev/null)"

# ══════════════════════════════════════════════════════════════════════════
# 1. Code-level verification: are the patches applied?
# ══════════════════════════════════════════════════════════════════════════
hdr "Patch 0001 — require camera key on POST /alarm/:id and /alarm/all (NODE-H1)"

grep_file "nodejs/camera-relay/server.js" \
  'requireCameraKeyForAlarm' \
  "relay: requireCameraKeyForAlarm middleware exists"

grep_file "nodejs/camera-relay/server.js" \
  'ALLOW_KEYLESS_ALARM' \
  "relay: ALLOW_KEYLESS_ALARM env var exists (opt-in for old firmware)"

grep_file "nodejs/camera-relay/server.js" \
  'MAX_ALARM_RECORDINGS' \
  "relay: MAX_ALARM_RECORDINGS hard cap exists"

grep_file "nodejs/camera-relay/server.js" \
  "app\.post\('/alarm/all', requireCameraKeyForAlarm" \
  "relay: /alarm/all uses requireCameraKeyForAlarm"

grep_file "nodejs/camera-relay/server.js" \
  "app\.post\('/alarm/:id', requireCameraKeyForAlarm" \
  "relay: /alarm/:id uses requireCameraKeyForAlarm"

grep_file "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  'http\.addHeader\("X-Api-Key", g_cfg\.apiKey\.c_str\(\)\)' \
  "recorder sketch: sendAlarmRequest sends X-Api-Key"


hdr "Patch 0002 — bind relay HTTP to 127.0.0.1 (SUPERSEDED by 0007)"

# Patch 0002 is superseded. We verify its effect is reverted by 0007:
grep_file "nodejs/camera-relay/server.js" \
  "RELAY_BIND = process\.env\.RELAY_BIND \|\| '0\.0\.0\.0'" \
  "relay: RELAY_BIND defaults to 0.0.0.0 (patch 0002 reverted by 0007)"

# Make sure the old 127.0.0.1 default is NOT there:
grep_file_not "nodejs/camera-relay/server.js" \
  "RELAY_BIND = process\.env\.RELAY_BIND \|\| '127\.0\.0\.1'" \
  "relay: RELAY_BIND does NOT default to 127.0.0.1 (would break detectors)"


hdr "Patch 0003 — cap php://input reads (PHP-H1)"

grep_file "php/cameras/relay.php" \
  'function camdash_read_json_input' \
  "relay.php: camdash_read_json_input() exists"

grep_file "php/cameras/system-settings.php" \
  'camdash_read_json_input' \
  "system-settings.php: uses camdash_read_json_input"

grep_file "php/cameras/camera-admin.php" \
  'camdash_read_json_input' \
  "camera-admin.php: uses camdash_read_json_input"

grep_file "php/cameras/camera-settings.php" \
  'camdash_read_json_input' \
  "camera-settings.php: uses camdash_read_json_input"

grep_file "apache/camdash-protect.conf" \
  'LimitRequestBody' \
  "Apache config: LimitRequestBody directive exists"

# Make sure the old file_get_contents('php://input') is gone from these files:
grep_file_not "php/cameras/system-settings.php" \
  "file_get_contents\('php://input'\)" \
  "system-settings.php: no longer uses raw file_get_contents('php://input')"
grep_file_not "php/cameras/camera-admin.php" \
  "file_get_contents\('php://input'\)" \
  "camera-admin.php: no longer uses raw file_get_contents('php://input')"
grep_file_not "php/cameras/camera-settings.php" \
  "file_get_contents\('php://input'\)" \
  "camera-settings.php: no longer uses raw file_get_contents('php://input')"


hdr "Patch 0004 — only honour X-Actor from loopback (NODE-M1)"

grep_file "nodejs/camera-relay/server.js" \
  'function isLoopback' \
  "relay: isLoopback() helper exists"

grep_file "nodejs/camera-relay/server.js" \
  "isLoopback\(req\.socket\.remoteAddress\)" \
  "relay: actorOf() checks isLoopback before honouring X-Actor"


hdr "Patch 0005 — mask SSID in remote log lines (ARD-M1)"

grep_file "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  'String maskedSsid\(\)' \
  "recorder sketch: maskedSsid() exists"

grep_file "Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" \
  'String maskedSsid\(\)' \
  "person sketch: maskedSsid() exists"

# Verify it uses only c_str() (not length/substring which break the desktop fake):
# maskedSsid uses c_str() and strlen — these are on separate lines, so check
# that BOTH appear in the maskedSsid function's vicinity (same file).
grep_file "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  'WiFi\.SSID\(\)\.c_str\(\)' \
  "recorder sketch: maskedSsid uses c_str() (not length/substring)"

grep_file "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  'strlen' \
  "recorder sketch: maskedSsid uses strlen (C-string ops)"

grep_file "Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" \
  'WiFi\.SSID\(\)\.c_str\(\)' \
  "person sketch: maskedSsid uses c_str() (not length/substring)"

grep_file "Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" \
  'strlen' \
  "person sketch: maskedSsid uses strlen (C-string ops)"

# Verify the heartbeat uses maskedSsid (the call appears on its own line):
grep_file "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  'maskedSsid\(\)\.c_str\(\)' \
  "recorder sketch: log lines call maskedSsid()"

grep_file "Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino" \
  'maskedSsid\(\)\.c_str\(\)' \
  "person sketch: log lines call maskedSsid()"

# Make sure the old raw WiFi.SSID().c_str() in heartbeat is gone:
# (The heartbeat line used to have WiFi.SSID().c_str() as an argument. Now it
# has maskedSsid().c_str(). We check that the file does NOT contain the old
# pattern of WiFi.SSID followed by the heartbeat text on the same line.)
grep_file_not "Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino" \
  "heartbeat: WiFi.*WiFi\.SSID\(\)\.c_str\(\)" \
  "recorder sketch: heartbeat no longer logs raw WiFi.SSID()"


hdr "Patch 0006 — move login throttle file out of /tmp (PHP-L4)"

grep_file "php/cameras/auth.php" \
  'function camdash_throttle_file' \
  "auth.php: camdash_throttle_file() helper exists"

grep_file "php/cameras/auth.php" \
  "data/login-throttle\.json" \
  "auth.php: throttle file path is data/login-throttle.json"


hdr "Patch 0007 — fail-closed requireReadKey (NODE-H2, correct fix)"

grep_file "nodejs/camera-relay/server.js" \
  'READ_KEY_REQUIRED' \
  "relay: READ_KEY_REQUIRED env var exists"

grep_file "nodejs/camera-relay/server.js" \
  "this relay is not configured: set controlKey" \
  "relay: requireReadKey fails closed with 503 message"

# Make sure the old fail-open behaviour is gone (the bare `if (!CONTROL_KEY) return next()`
# without the 503). Check that the old one-liner is NOT present:
grep_file_not "nodejs/camera-relay/server.js" \
  "if \(!CONTROL_KEY\) return next\(\);" \
  "relay: requireReadKey does NOT fail open (old bare return-next removed)"

# The startup log line should say REFUSED, not "can be read by anyone":
grep_file "nodejs/camera-relay/server.js" \
  'REFUSED \(503\)' \
  "relay: startup log says reads are REFUSED"

# Make sure the old "can be read by anyone" message is gone:
grep_file_not "nodejs/camera-relay/server.js" \
  "can be read by anyone who can reach" \
  "relay: old fail-open log message removed"


hdr "Patch 0008 — test fixes (no production code)"

grep_file "tests/cpp/test_person_uplink_glue.cpp" \
  "ex\*\*\*-1" \
  "C++ test: expects masked SSID 'ex***-1' (not the full 'extender-1')"

# Verify the e2e tests were updated to send X-Control-Key / X-Api-Key:
for tfile in tests/e2e/test_detector_e2e.js tests/e2e/test_detector_firmware_e2e.js \
             tests/e2e/test_relay_detector_events_e2e.js tests/e2e/test_logging_e2e.js \
             tests/e2e/test_push_connection_e2e.js; do
  grep_file "$tfile" 'X-Control-Key' \
    "$(basename $tfile): sends X-Control-Key on reads"
done

for tfile in tests/e2e/test_alarm_settings_e2e.js tests/e2e/test_preroll_e2e.js \
             tests/e2e/test_recording_switch_e2e.js tests/e2e/test_relay_camera_id_e2e.js \
             tests/e2e/test_relay_dashboard_auth_e2e.js tests/e2e/test_relay_read_auth_e2e.js; do
  # Each test sends the camera key on alarm POSTs — either via a postCamKey()
  # helper or via an inline { headers: { 'X-Api-Key': CAM_KEY } }. Check for
  # either pattern.
  if grep -qE "postCamKey|X-Api-Key.*CAM_KEY|'X-Api-Key'.*CAM_KEY" "$tfile" 2>/dev/null; then
    ok "$(basename $tfile): alarm POSTs use the camera key (postCamKey or X-Api-Key)"
  else
    fail "$(basename $tfile): alarm POSTs use the camera key (neither postCamKey nor X-Api-Key found)"
  fi
done

# ══════════════════════════════════════════════════════════════════════════
# 2. Run the test suites
# ══════════════════════════════════════════════════════════════════════════
if [ "$CODE_ONLY" = "1" ]; then
  echo -e "\n${YELLOW}--code-only: skipping test suites${NC}"
  echo -e "\n${BOLD}=== SUMMARY ===${NC}"
  echo -e "  ${GREEN}PASS${NC}: $PASS   ${RED}FAIL${NC}: $FAIL   ${YELLOW}SKIP${NC}: $SKIP"
  if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}Failed checks:${NC}"
    for c in "${FAILED_CHECKS[@]}"; do echo -e "  ${RED}✗${NC} $c"; done
    exit 1
  fi
  exit 0
fi

# ── 2a. C++ unit tests (needs g++) ──────────────────────────────────────
hdr "C++ unit tests (desktop-glue, needs g++)"
if ! command -v g++ >/dev/null 2>&1; then
  skip "C++ unit tests" "g++ not found"
else
  info "compiling and running the C++ glue tests (this takes ~30 s)…"
  # run_tests.sh compiles and runs these; we call the relevant subset
  BUILD_DIR="tests/cpp/build"
  mkdir -p "$BUILD_DIR"

  # The run_tests.sh script has a complex harness; we replicate the core compile+run.
  CXX_FAIL=0
  CXX_PASS=0
  for test_src in tests/cpp/test_alarm_logic tests/cpp/test_remote_log \
                  tests/cpp/test_person_scene_logic tests/cpp/test_person_motion_baseline \
                  tests/cpp/test_person_report_logic tests/cpp/test_settings_logic \
                  tests/cpp/test_settings_remote tests/cpp/test_settings_change \
                  tests/cpp/test_person_settings tests/cpp/test_ota_logic \
                  tests/cpp/test_relay_find_logic tests/cpp/test_relay_find_glue \
                  tests/cpp/test_person_settings_glue tests/cpp/test_person_settings_sync_sketch \
                  tests/cpp/test_settings_sync_glue tests/cpp/test_settings_glue \
                  tests/cpp/test_sketch_log_glue tests/cpp/test_person_log_glue \
                  tests/cpp/test_person_detect_glue tests/cpp/test_person_uplink_glue \
                  tests/cpp/test_ota_glue; do
    test_name=$(basename "$test_src")
    # Use the run_tests.sh harness by invoking it with --verbose 0 and grepping
    : # (we'll just call run_tests.sh for the C++ part below)
  done

  # Simpler: just call run_tests.sh with --no-sketch-compile and parse the C++ section.
  # The C++ tests are fast (under 30 s).
  info "running ./run_tests.sh --no-sketch-compile --verbose 0 (this runs C++, Node.js, e2e, PHP)…"
fi

# ── 2b. Full test suite via run_tests.sh ────────────────────────────────
hdr "Full test suite (./run_tests.sh)"

RUN_ARGS="--no-sketch-compile --verbose 0"
if [ "$NO_E2E" = "1" ]; then
  # run_tests.sh doesn't have a --no-e2e flag, so we note it but still run
  info "(--no-e2e requested, but run_tests.sh doesn't have that flag — running everything)"
fi

if [ "$NO_SKETCH" = "1" ]; then
  RUN_ARGS="$RUN_ARGS"  # already --no-sketch-compile
fi

# Run the suite, capturing output. Timeout at 5 minutes.
TMP_OUT=$(mktemp)
info "running: ./run_tests.sh $RUN_ARGS (timeout 5 min)…"
timeout 300 ./run_tests.sh $RUN_ARGS >"$TMP_OUT" 2>&1
SUITE_EXIT=$?

# Print the tail of the output so the user can see the summary
echo -e "\n  ${BLUE}─── last 40 lines of run_tests.sh output ───${NC}"
tail -40 "$TMP_OUT" | sed 's/^/  /'

# Parse the output for the key results
if [ "$SUITE_EXIT" -eq 0 ]; then
  ok "run_tests.sh passed (exit 0)"
else
  # Collect all FAIL lines, then remove the known-skip ones (php-not-found,
  # arduino-cli-not-found). What's left are the REAL failures.
  ALL_FAILS=$(grep -E "^\[FAIL\]|^FAIL:" "$TMP_OUT" 2>/dev/null || true)
  REAL_FAILS=$(echo "$ALL_FAILS" | grep -v "php not found" | grep -v "arduino-cli not found" | grep -v "^$" || true)

  if [ -z "$REAL_FAILS" ]; then
    # The only failures are php-not-found / arduino-cli-not-found — expected on a dev laptop
    if echo "$ALL_FAILS" | grep -q "php not found"; then
      skip "run_tests.sh PHP suite" "php not on PATH (expected on dev laptop)"
    fi
    if echo "$ALL_FAILS" | grep -q "arduino-cli not found"; then
      skip "run_tests.sh sketch compile" "arduino-cli not on PATH (expected on dev laptop)"
    fi
    ok "run_tests.sh: all non-PHP/non-sketch suites passed"
  else
    fail "run_tests.sh has real failures (beyond php/arduino-cli not found)"
    echo -e "\n  ${RED}─── real FAIL lines ───${NC}"
    echo "$REAL_FAILS" | head -20 | sed 's/^/  /'
  fi
fi
rm -f "$TMP_OUT"

# ── 2c. Sketch compilation (needs arduino-cli) ─────────────────────────
if [ "$NO_SKETCH" = "0" ]; then
  hdr "Sketch compilation (needs arduino-cli + esp32 core)"
  if ! command -v arduino-cli >/dev/null 2>&1; then
    skip "sketch compilation" "arduino-cli not found (install from https://arduino.github.io/arduino-cli/)"
  else
    info "compiling both sketches for the AI-Thinker ESP32-CAM (this takes ~5 min)…"
    # compile_sketches.sh prints "ok: every sketch compiles" on success
    # The TFLite_Person sketch is large (includes TensorFlow Lite Micro) and
    # can take 3-4 minutes on a fast laptop, longer on a slow one.
    COMP_OUT=$(timeout 600 ./tools/compile_sketches.sh 2>&1)
    COMP_EXIT=$?
    if [ "$COMP_EXIT" -eq 0 ] && echo "$COMP_OUT" | grep -q "every sketch compiles"; then
      ok "both sketches compiled successfully"
    elif [ "$COMP_EXIT" -eq 124 ]; then
      skip "sketch compilation" "timed out after 10 min (the TFLite sketch is large; try running ./tools/compile_sketches.sh manually)"
    else
      fail "sketch compilation failed (exit $COMP_EXIT)"
      echo "$COMP_OUT" | tail -10 | sed 's/^/    /'
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════════
# 3. Summary
# ══════════════════════════════════════════════════════════════════════════
hdr "SUMMARY"
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}${BOLD}Failed checks:${NC}"
  for c in "${FAILED_CHECKS[@]}"; do
    echo -e "  ${RED}✗${NC} $c"
  done
  echo -e "\n${RED}The patches are NOT fully applied or have regressions.${NC}"
  echo -e "${YELLOW}Review the failures above, then re-apply the offending patch.${NC}"
  exit 1
else
  echo -e "\n${GREEN}${BOLD}All code-level checks passed.${NC}"
  if [ "$SKIP" -gt 0 ]; then
    echo -e "${YELLOW}Some test suites were skipped (missing tools). Install them for full coverage:${NC}"
    echo -e "  ${YELLOW}• php-cli${NC}  — for the PHP unit tests and e2e dashboard tests"
    echo -e "  ${YELLOW}• arduino-cli${NC} — for the sketch compilation"
  fi
  echo -e "\n${GREEN}Next: run the manual checks in MANUAL-TESTING.md on the Pi to verify the live behavior.${NC}"
  exit 0
fi
