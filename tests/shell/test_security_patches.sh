#!/usr/bin/env bash
# test_security_patches.sh — the eight security patches (0001-0008) are in the sources and have not been undone.
#
# A static check: it reads the relay, the dashboard, the sketches, the Apache config and the tests, and
# fails if a line a patch added is gone or a line it removed is back. It runs nothing, so it cannot say that
# the patches WORK (the suites run_tests.sh runs besides this one do: unit, end-to-end, PHP), and it cannot
# check what needs the real hardware or the Pi: the cameras connecting and streaming, the detectors' HTTP
# Upgrade, the dashboard over Tor, the over-the-air update with real boards.
#
# Usage: tests/shell/test_security_patches.sh      Exit code: 0 if all pass.
# run_tests.sh runs it; on its own it is the quick check (a second), the old "--code-only".

set -uo pipefail
# shellcheck source-path=SCRIPTDIR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib/source_checks.sh
source "$ROOT/tests/shell/lib/source_checks.sh"
sc_init "$ROOT"

RELAY="nodejs/camera-relay/server.js"
RECORDER="Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino"
PERSON="Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino"
DASHBOARD="php/cameras"

# ── Patch 0001 — require the camera key on POST /alarm/:id and /alarm/all (NODE-H1) ──
sc_group "patch 0001 (NODE-H1)"

sc_has "$RELAY" 'requireCameraKeyForAlarm' \
    "relay: requireCameraKeyForAlarm middleware exists"
sc_has "$RELAY" 'ALLOW_KEYLESS_ALARM' \
    "relay: ALLOW_KEYLESS_ALARM env var exists (opt-in for old firmware)"
sc_has "$RELAY" 'MAX_ALARM_RECORDINGS' \
    "relay: MAX_ALARM_RECORDINGS hard cap exists"
sc_has "$RELAY" "app\.post\('/alarm/all', requireCameraKeyForAlarm" \
    "relay: /alarm/all uses requireCameraKeyForAlarm"
sc_has "$RELAY" "app\.post\('/alarm/:id', requireCameraKeyForAlarm" \
    "relay: /alarm/:id uses requireCameraKeyForAlarm"
sc_has "$RECORDER" 'http\.addHeader\("X-Api-Key", g_cfg\.apiKey\.c_str\(\)\)' \
    "recorder sketch: sendAlarmRequest sends X-Api-Key"

# ── Patch 0002 — bind the relay's HTTP to 127.0.0.1 (SUPERSEDED by 0007: it broke the detectors) ──
sc_group "patch 0002 (superseded by 0007)"

sc_has "$RELAY" "RELAY_BIND = process\.env\.RELAY_BIND \|\| '0\.0\.0\.0'" \
    "relay: RELAY_BIND defaults to 0.0.0.0 (patch 0002 reverted by 0007)"
sc_lacks "$RELAY" "RELAY_BIND = process\.env\.RELAY_BIND \|\| '127\.0\.0\.1'" \
    "relay: RELAY_BIND does NOT default to 127.0.0.1 (would break detectors)"

# ── Patch 0003 — cap the php://input reads (PHP-H1) ──
sc_group "patch 0003 (PHP-H1)"

sc_has "$DASHBOARD/relay.php" 'function camdash_read_json_input' \
    "relay.php: camdash_read_json_input() exists"
sc_has "apache/camdash-protect.conf" 'LimitRequestBody' \
    "Apache config: LimitRequestBody directive exists"
for page in system-settings camera-admin camera-settings; do
    sc_has "$DASHBOARD/$page.php" 'camdash_read_json_input' \
        "$page.php: uses camdash_read_json_input"
    sc_lacks "$DASHBOARD/$page.php" "file_get_contents\('php://input'\)" \
        "$page.php: no longer uses raw file_get_contents('php://input')"
done

# ── Patch 0004 — only honour X-Actor from the loopback (NODE-M1) ──
sc_group "patch 0004 (NODE-M1)"

sc_has "$RELAY" 'function isLoopback' \
    "relay: isLoopback() helper exists"
sc_has "$RELAY" "isLoopback\(req\.socket\.remoteAddress\)" \
    "relay: actorOf() checks isLoopback before honouring X-Actor"

# ── Patch 0005 — mask the SSID in the remote log lines (ARD-M1) ──
# maskedSsid() works on c_str() and strlen only: the desktop fake of String has no length()/substring().
sc_group "patch 0005 (ARD-M1)"

for sketch in "recorder:$RECORDER" "person:$PERSON"; do
    name="${sketch%%:*}"
    ino="${sketch#*:}"
    sc_has "$ino" 'String maskedSsid\(\)' \
        "$name sketch: maskedSsid() exists"
    sc_has "$ino" 'WiFi\.SSID\(\)\.c_str\(\)' \
        "$name sketch: maskedSsid uses c_str() (not length/substring)"
    sc_has "$ino" 'strlen' \
        "$name sketch: maskedSsid uses strlen (C-string ops)"
    sc_has "$ino" 'maskedSsid\(\)\.c_str\(\)' \
        "$name sketch: log lines call maskedSsid()"
done
sc_lacks "$RECORDER" "heartbeat: WiFi.*WiFi\.SSID\(\)\.c_str\(\)" \
    "recorder sketch: heartbeat no longer logs the raw WiFi.SSID()"

# ── Patch 0006 — the login throttle file is out of /tmp (PHP-L4) ──
sc_group "patch 0006 (PHP-L4)"

sc_has "$DASHBOARD/auth.php" 'function camdash_throttle_file' \
    "auth.php: camdash_throttle_file() helper exists"
sc_has "$DASHBOARD/auth.php" "data/login-throttle\.json" \
    "auth.php: throttle file path is data/login-throttle.json"

# ── Patch 0007 — requireReadKey fails closed (NODE-H2) ──
sc_group "patch 0007 (NODE-H2)"

sc_has "$RELAY" 'READ_KEY_REQUIRED' \
    "relay: READ_KEY_REQUIRED env var exists"
sc_has "$RELAY" "this relay is not configured: set controlKey" \
    "relay: requireReadKey fails closed with the 503 message"
sc_lacks "$RELAY" "if \(!CONTROL_KEY\) return next\(\);" \
    "relay: requireReadKey does NOT fail open (the bare return-next is gone)"
sc_has "$RELAY" 'REFUSED \(503\)' \
    "relay: the startup log says reads are REFUSED"
sc_lacks "$RELAY" "can be read by anyone who can reach" \
    "relay: the old fail-open log message is gone"

# ── Patch 0008 — test fixes (no production code) ──
sc_group "patch 0008 (tests)"

sc_has tests/cpp/test_person_uplink_glue.cpp 'ex\*\*\*-1' \
    "C++ test: expects the masked SSID 'ex***-1' (not the full 'extender-1')"

# The end-to-end tests that read from the relay send the control key ...
for test in tests/e2e/test_detector_e2e.js tests/e2e/test_detector_firmware_e2e.js \
            tests/e2e/test_relay_mux_e2e.js tests/e2e/test_logging_e2e.js \
            tests/e2e/test_push_connection_e2e.js; do
    sc_has "$test" 'X-Control-Key' \
        "$(basename "$test"): sends X-Control-Key on reads"
done

# ... and the ones that raise alarms send the camera key, through a postCamKey() helper or a header of their own.
for test in tests/e2e/test_alarm_settings_e2e.js tests/e2e/test_preroll_e2e.js \
            tests/e2e/test_recording_switch_e2e.js tests/e2e/test_relay_camera_id_e2e.js \
            tests/e2e/test_relay_dashboard_auth_e2e.js tests/e2e/test_relay_read_auth_e2e.js; do
    sc_has "$test" 'postCamKey|X-Api-Key.*CAM_KEY' \
        "$(basename "$test"): alarm POSTs use the camera key (postCamKey or X-Api-Key)"
done

sc_summary
