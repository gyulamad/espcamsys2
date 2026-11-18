#!/usr/bin/env bash
# test_gen_settings_reference.sh — F-29 T9: tools/gen_settings_reference.sh and the committed docs/SETTINGS_REFERENCE.md.
#
# The reference is worth something only if CI goes red when it is stale, so this proves both ways:
#   - the committed file is current, and a fresh generation gives the same bytes (and is stable: twice, same result);
#   - --check FAILS on a file that was edited by hand, on one that is missing, and (the real case) when a default in a
#     firmware settings_schema.h or in the relay's table changes and the file was not regenerated; running the
#     generator then makes --check pass again;
#   - a bad argument is refused and writes nothing; --check never writes.
# The changes are made in a throwaway copy of the sources, never in the repository.
# Usage: tests/shell/test_gen_settings_reference.sh      Exit code: 0 if all pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="tools/gen_settings_reference.sh"
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── the repository itself ────────────────────────────────────────────────
out="$("$ROOT/$GEN" --check 2>&1)"; status=$?
check "the committed docs/SETTINGS_REFERENCE.md is up to date" "$status"
check "--check says so" "$(printf '%s' "$out" | grep -qF "up to date" && echo 0 || echo 1)"

SETTINGS_REFERENCE_FILE="$WORK/fresh.md" "$ROOT/$GEN" >/dev/null 2>&1
check "a fresh generation is the committed file, byte for byte" "$(cmp -s "$WORK/fresh.md" "$ROOT/docs/SETTINGS_REFERENCE.md" && echo 0 || echo 1)"
SETTINGS_REFERENCE_FILE="$WORK/again.md" "$ROOT/$GEN" >/dev/null 2>&1
check "generating twice gives the same bytes" "$(cmp -s "$WORK/fresh.md" "$WORK/again.md" && echo 0 || echo 1)"

# ── what the file must contain ───────────────────────────────────────────
ref="$ROOT/docs/SETTINGS_REFERENCE.md"
check "it has the camera, detector and relay sections" \
    "$(grep -q '^## Camera' "$ref" && grep -q '^## Detector' "$ref" && grep -q '^## Relay' "$ref" && echo 0 || echo 1)"
check "a camera key shows its default, tier, apply and category" \
    "$(grep -qF '| `JPEG_Q_MIN` | Best JPEG quality | `12` | basic | live | Picture & link |' "$ref" && echo 0 || echo 1)"
check "a relay key shows its default and apply" \
    "$(grep -qF '| `port` | HTTP port | `8080` | — | reboot | Network |' "$ref" && echo 0 || echo 1)"
check "a locked identity key is listed with no default" \
    "$(grep -qF '| `API_KEY` | — | — | — | — | — |' "$ref" && echo 0 || echo 1)"

# ── --check fails when the file is stale ─────────────────────────────────
cp "$ref" "$WORK/hand_edited.md"; printf '| `FAKE` | x | `1` | basic | live | x |\n' >> "$WORK/hand_edited.md"
out="$(SETTINGS_REFERENCE_FILE="$WORK/hand_edited.md" "$ROOT/$GEN" --check 2>&1)"; status=$?
check "--check fails on a file that was edited by hand" "$([ "$status" -eq 1 ] && echo 0 || echo 1)"
check "...and tells you to run the generator" "$(printf '%s' "$out" | grep -qF "out of date — run tools/gen_settings_reference.sh" && echo 0 || echo 1)"

out="$(SETTINGS_REFERENCE_FILE="$WORK/missing.md" "$ROOT/$GEN" --check 2>&1)"; status=$?
check "--check fails on a file that does not exist" "$([ "$status" -eq 1 ] && echo 0 || echo 1)"
check "...and does not create it" "$([ ! -e "$WORK/missing.md" ] && echo 0 || echo 1)"

cp "$ref" "$WORK/untouched.md"; touch -d '2020-01-01' "$WORK/untouched.md"
SETTINGS_REFERENCE_FILE="$WORK/untouched.md" "$ROOT/$GEN" --check >/dev/null 2>&1
check "--check never writes (an up-to-date file keeps its timestamp)" "$([ "$(stat -c %Y "$WORK/untouched.md")" = "$(date -d '2020-01-01' +%s)" ] && echo 0 || echo 1)"

# ── a source table changes, the file is not regenerated ──────────────────
# A throwaway copy of what the generator reads (the firmware headers without the model data, the relay's lib, tools).
TREE="$WORK/tree"
mkdir -p "$TREE/docs" "$TREE/nodejs/camera-relay"
cp -r "$ROOT/tools" "$TREE/tools"
cp -r "$ROOT/nodejs/camera-relay/lib" "$TREE/nodejs/camera-relay/lib"
for sketch in ESP32_CAM_Recorder ESP32_CAM_TFLite_Person; do
    mkdir -p "$TREE/Arduino/$sketch"
    cp "$ROOT/Arduino/$sketch/"*.h "$TREE/Arduino/$sketch/"
done
rm -f "$TREE/Arduino/ESP32_CAM_TFLite_Person/person_detect_model_data.h"
cp "$ref" "$TREE/docs/SETTINGS_REFERENCE.md"
check "the throwaway copy starts up to date" "$("$TREE/$GEN" --check >/dev/null 2>&1 && echo 0 || echo 1)"

# (a) a firmware default changes
sed -i 's|{ "PUSH_WR_TMO_MS", "8000",|{ "PUSH_WR_TMO_MS", "9000",|' "$TREE/Arduino/ESP32_CAM_Recorder/settings_schema.h"
check "the test really changed the firmware table" "$(grep -qF '"PUSH_WR_TMO_MS", "9000"' "$TREE/Arduino/ESP32_CAM_Recorder/settings_schema.h" && echo 0 || echo 1)"
"$TREE/$GEN" --check >/dev/null 2>&1; status=$?
check "--check FAILS after a firmware default changed" "$([ "$status" -eq 1 ] && echo 0 || echo 1)"
"$TREE/$GEN" >/dev/null 2>&1
check "regenerating writes the new default" "$(grep -qF '| `PUSH_WR_TMO_MS` | Push write timeout (ms) | `9000` |' "$TREE/docs/SETTINGS_REFERENCE.md" && echo 0 || echo 1)"
check "--check passes again after regenerating" "$("$TREE/$GEN" --check >/dev/null 2>&1 && echo 0 || echo 1)"

# (b) a relay default changes
# T6a moved the rows from sysconfig.js (which now only re-exports FIELDS) to lib/sysfields.js,
# and the row carries its tier between the key and the type: match the table where it lives.
sed -i "s|key: 'pushPort', tier: 'advanced', type: 'int', min: 1, max: 65535, default: 8081,|key: 'pushPort', tier: 'advanced', type: 'int', min: 1, max: 65535, default: 8082,|" "$TREE/nodejs/camera-relay/lib/sysfields.js"
check "the test really changed the relay table" "$(grep -qF 'default: 8082' "$TREE/nodejs/camera-relay/lib/sysfields.js" && echo 0 || echo 1)"
"$TREE/$GEN" --check >/dev/null 2>&1; status=$?
check "--check FAILS after a relay default changed" "$([ "$status" -eq 1 ] && echo 0 || echo 1)"
"$TREE/$GEN" >/dev/null 2>&1
check "regenerating writes the new relay default" "$(grep -qF '| `pushPort` | Camera push port | `8082` |' "$TREE/docs/SETTINGS_REFERENCE.md" && echo 0 || echo 1)"

# (c) a table that no longer compiles stops the generator (it must not write a half file)
cp "$TREE/docs/SETTINGS_REFERENCE.md" "$WORK/before_broken.md"
printf '\nthis is not C++\n' >> "$TREE/Arduino/ESP32_CAM_Recorder/settings_schema.h"
"$TREE/$GEN" >/dev/null 2>&1; status=$?
check "a firmware table that does not compile makes the generator fail" "$([ "$status" -ne 0 ] && echo 0 || echo 1)"
check "...and leaves the committed file as it was" "$(cmp -s "$WORK/before_broken.md" "$TREE/docs/SETTINGS_REFERENCE.md" && echo 0 || echo 1)"

# ── usage ────────────────────────────────────────────────────────────────
out="$(SETTINGS_REFERENCE_FILE="$WORK/never.md" "$ROOT/$GEN" --bogus 2>&1)"; status=$?
check "an unknown argument is refused (exit 2)" "$([ "$status" -eq 2 ] && echo 0 || echo 1)"
check "...with a usage line, and nothing written" "$(printf '%s' "$out" | grep -qF "usage:" && [ ! -e "$WORK/never.md" ] && echo 0 || echo 1)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
