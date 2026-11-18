#!/usr/bin/env bash
# Rewrites docs/SETTINGS_REFERENCE.md: every setting of the camera, the detector and the relay with its label, default,
# tier, apply mode and category, taken from the same tables the firmware and the relay use (never typed by hand).
#   tools/gen_settings_reference.sh            rewrite the file (run it after changing a settings table)
#   tools/gen_settings_reference.sh --check    change nothing; fail if the file is out of date (run_tests.sh does this)
# SETTINGS_REFERENCE_FILE=PATH overrides where the file is written / checked (the tests use it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SETTINGS_REFERENCE_FILE:-$ROOT/docs/SETTINGS_REFERENCE.md}"
MODE="${1:-}"
if [ -n "$MODE" ] && [ "$MODE" != "--check" ]; then
    echo "usage: tools/gen_settings_reference.sh [--check]" >&2
    exit 2
fi
if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: node not found on PATH (needed to build the settings reference)" >&2
    exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=schema_dump_lib.sh
source "$ROOT/tools/schema_dump_lib.sh"
build_schema_dumps "$ROOT" "$TMP"
# One step per file, so a failing dump stops the script instead of leaving a half-written JSON behind.
"$TMP/dump_recorder" > "$TMP/recorder.json"
"$TMP/dump_detector" > "$TMP/detector.json"
node "$ROOT/tools/dump_relay_schema.js" > "$TMP/relay.json"
{
    echo '{'
    sed '$ s/}$/},/' "$TMP/recorder.json"
    sed '$ s/}$/},/' "$TMP/detector.json"
    echo '  "relay":'
    cat "$TMP/relay.json"
    echo '}'
} > "$TMP/schema.json"
node "$ROOT/tools/render_settings_reference.js" "$TMP/schema.json" > "$TMP/reference.md"

if [ "$MODE" = "--check" ]; then
    if [ ! -f "$OUT" ]; then
        echo "FAIL: $OUT does not exist — run tools/gen_settings_reference.sh" >&2
        exit 1
    fi
    if cmp -s "$TMP/reference.md" "$OUT"; then echo "SETTINGS_REFERENCE.md is up to date"; exit 0; fi
    echo "FAIL: ${OUT#"$ROOT"/} is out of date — run tools/gen_settings_reference.sh" >&2
    exit 1
fi
mkdir -p "$(dirname "$OUT")"
cp "$TMP/reference.md" "$OUT"
echo "wrote $OUT"
