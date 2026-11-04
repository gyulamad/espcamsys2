#!/bin/bash
# test_compile_sketches.sh — tools/compile_sketches.sh, the check that both sketches really compile with
# the Arduino toolchain. A test machine has no ESP32 toolchain, so a fake `arduino-cli` stands in for it
# (like in test_ota_deploy_e2e.js); what is proven is what the SCRIPT does with the toolchain's answers:
#   - it compiles the real sketch folders (the fake insists on what the real tool insists on: the folder
#     holds a .ino of the same name), for the board of ota-deploy.sh, with the extra arguments of ota.conf
#   - one broken sketch fails the run (exit 1), shows the compiler's words and does not stop the other one
#   - a missing toolchain or board is a different failure (exit 2: nothing was compiled), not a broken sketch
#   - the build files go to a throwaway folder (or the one asked for), never into the repository
# Usage: tests/shell/test_compile_sketches.sh      Exit code: 0 if all pass.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/tools/compile_sketches.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}
has() { grep -qF -- "$2" "$1"; }   # has FILE TEXT: the file contains the text
ok_if() { if "$@"; then echo 0; else echo 1; fi; }

# ── the fake toolchain ───────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/arduino-cli" <<'EOF'
#!/usr/bin/env bash
# fake arduino-cli: logs what it was asked, fails like the real one where the real one would
case "$1 $2" in
    "board details")
        [ "${FAKE_NO_BOARD:-}" = 1 ] && { echo "Error: platform not installed" >&2; exit 1; }
        echo "board details $*" >> "$FAKE_LOG"; exit 0 ;;
esac
[ "$1" = compile ] || { echo "fake arduino-cli: unexpected command $*" >&2; exit 99; }
shift
fqbn=""; build=""; sketch=""; extra=""
while [ $# -gt 0 ]; do
    case "$1" in
        --fqbn) fqbn="$2"; shift 2 ;;
        --build-path) build="$2"; shift 2 ;;
        --build-property) extra="$extra $1 $2"; shift 2 ;;
        *) sketch="$1"; shift ;;
    esac
done
name="$(basename "$sketch")"
echo "compile $name fqbn=$fqbn extra=[${extra# }] build=$build" >> "$FAKE_LOG"
# the real tool: "main file missing from sketch" unless <folder>/<folder>.ino exists
[ -f "$sketch/$name.ino" ] || { echo "Error: main file missing from sketch: $sketch/$name.ino" >&2; exit 1; }
mkdir -p "$build" && : > "$build/$name.ino.elf"
case "$name" in
    *Recorder*) kind=recorder ;;
    *)          kind=detector ;;
esac
case " ${FAKE_FAIL:-} " in
    *" $kind "*) echo "$name.ino:42:7: error: 'g_relayOkAt' was not declared in this scope" >&2; exit 1 ;;
esac
echo "Sketch uses 123 bytes"
EOF
chmod +x "$TMP/bin/arduino-cli"

# run_script ARGS... — runs the script with the fake toolchain first on PATH; sets rc and out.
# FAKE_LOG is reset each time; OTA_CONF points at a config that does not exist unless the case sets it.
run_script() {
    : > "$TMP/fake.log"
    out="$TMP/out.txt"
    PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/fake.log" OTA_CONF="${CASE_CONF:-$TMP/no-such.conf}" \
        bash "$SCRIPT" "$@" > "$out" 2>&1
    rc=$?
}
compiled() { grep -c '^compile ' "$TMP/fake.log"; }

# ── a clean run ──────────────────────────────────────────────────────────
run_script
check "all sketches compile: exit 0" $([ $rc -eq 0 ] && echo 0 || echo 1)
check "...both real sketch folders were compiled, once each" $([ "$(compiled)" = 2 ] && has "$TMP/fake.log" "compile ESP32_CAM_Recorder " && has "$TMP/fake.log" "compile ESP32_CAM_TFLite_Person " && echo 0 || echo 1)
check "...for the board ota-deploy.sh builds for" $(has "$TMP/fake.log" "fqbn=esp32:esp32:esp32cam:PartitionScheme=min_spiffs" && echo 0 || echo 1)
check "...says so, and prints no compiler output for sketches that compiled" $(has "$out" "ok: every sketch compiles" && ! has "$out" "Sketch uses" && echo 0 || echo 1)
check "...the board was checked before compiling" $(has "$TMP/fake.log" "board details --fqbn esp32:esp32:esp32cam:PartitionScheme=min_spiffs" && echo 0 || echo 1)

# ── choosing the sketch ──────────────────────────────────────────────────
run_script recorder
check "'recorder' compiles only the recorder" $([ $rc -eq 0 ] && [ "$(compiled)" = 1 ] && has "$TMP/fake.log" "compile ESP32_CAM_Recorder " && echo 0 || echo 1)
run_script detector
check "'detector' compiles only the detector" $([ $rc -eq 0 ] && [ "$(compiled)" = 1 ] && has "$TMP/fake.log" "compile ESP32_CAM_TFLite_Person " && echo 0 || echo 1)
run_script all
check "'all' compiles both" $([ $rc -eq 0 ] && [ "$(compiled)" = 2 ] && echo 0 || echo 1)

# ── a broken sketch ──────────────────────────────────────────────────────
FAKE_FAIL=detector run_script
check "a sketch that does not compile fails the run (exit 1)" $([ $rc -eq 1 ] && echo 0 || echo 1)
check "...the compiler's own words are shown" $(has "$out" "'g_relayOkAt' was not declared in this scope" && echo 0 || echo 1)
check "...and the failed sketch is named" $(has "$out" "FAIL: did not compile: ESP32_CAM_TFLite_Person" && echo 0 || echo 1)
check "...the other sketch was still compiled (and is not blamed)" $([ "$(compiled)" = 2 ] && ! has "$out" "did not compile: ESP32_CAM_Recorder" && echo 0 || echo 1)
FAKE_FAIL=recorder run_script
check "the recorder failing is reported the same way (the detector still compiled)" $([ $rc -eq 1 ] && [ "$(compiled)" = 2 ] && has "$out" "FAIL: did not compile: ESP32_CAM_Recorder" && echo 0 || echo 1)
FAKE_FAIL="recorder detector" run_script
check "both failing: both named" $([ $rc -eq 1 ] && has "$out" "ESP32_CAM_Recorder" && has "$out" "ESP32_CAM_TFLite_Person" && has "$out" "FAIL: did not compile:" && echo 0 || echo 1)

# ── the same settings as ota-deploy.sh ───────────────────────────────────
printf 'RELAY_URL="http://x"\nCONTROL_KEY="k"\nFQBN="esp32:esp32:esp32cam"\nEXTRA_COMPILE_ARGS="--build-property build.partitions=min_spiffs --build-property upload.maximum_size=1966080"\n' > "$TMP/ota.conf"
CASE_CONF="$TMP/ota.conf" run_script recorder
check "FQBN from ota.conf is used" $(has "$TMP/fake.log" "fqbn=esp32:esp32:esp32cam extra=" && echo 0 || echo 1)
check "EXTRA_COMPILE_ARGS from ota.conf are passed to the compiler" $(has "$TMP/fake.log" "extra=[--build-property build.partitions=min_spiffs --build-property upload.maximum_size=1966080]" && echo 0 || echo 1)
check "ota.conf's secrets never reach the output" $(! has "$out" "CONTROL_KEY" && ! has "$TMP/fake.log" '"k"' && echo 0 || echo 1)

# ── where the build files go ─────────────────────────────────────────────
run_script
builds="$(sed -n 's/.* build=//p' "$TMP/fake.log")"
check "the build files go to a throwaway folder outside the repository" $([ -n "$builds" ] && ! echo "$builds" | grep -q "^$ROOT" && echo 0 || echo 1)
check "...which is gone after the run" $(ok_if test ! -e "$(echo "$builds" | head -1)")
check "...and each sketch has its own" $([ "$(echo "$builds" | sort -u | wc -l)" = 2 ] && echo 0 || echo 1)
SKETCH_BUILD_DIR="$TMP/keep" run_script
check "SKETCH_BUILD_DIR keeps the build files in that folder, one per sketch" $([ -e "$TMP/keep/recorder/ESP32_CAM_Recorder.ino.elf" ] && [ -e "$TMP/keep/detector/ESP32_CAM_TFLite_Person.ino.elf" ] && echo 0 || echo 1)
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    before="$(git -C "$ROOT" status --porcelain --ignored -- Arduino | sort)"
    run_script
    after="$(git -C "$ROOT" status --porcelain --ignored -- Arduino | sort)"
    check "nothing is written into the sketch folders" $([ "$before" = "$after" ] && echo 0 || echo 1)
fi

# ── the toolchain is not there: not the sketches' fault (exit 2) ─────────
mkdir -p "$TMP/bare"
for tool in bash dirname basename sed mktemp rm cat; do ln -sf "$(command -v $tool)" "$TMP/bare/$tool"; done
PATH="$TMP/bare" OTA_CONF="$TMP/no-such.conf" "$(command -v bash)" "$SCRIPT" > "$TMP/out.txt" 2>&1; rc=$?
check "no arduino-cli: exit 2, not a broken-sketch failure" $([ $rc -eq 2 ] && echo 0 || echo 1)
check "...it says what to install" $(has "$TMP/out.txt" "arduino-cli not found on PATH" && echo 0 || echo 1)
FAKE_NO_BOARD=1 run_script
check "the board (esp32 core) is not installed: exit 2, nothing compiled" $([ $rc -eq 2 ] && [ "$(compiled)" = 0 ] && echo 0 || echo 1)
check "...it says which board and how to get it" $(has "$out" "does not know the board esp32:esp32:esp32cam:PartitionScheme=min_spiffs" && has "$out" "arduino-cli core install esp32:esp32" && echo 0 || echo 1)

# ── usage ────────────────────────────────────────────────────────────────
for bad in "bogus" "--bogus" "recorder detector" "recorder all"; do
    # shellcheck disable=SC2086
    run_script $bad
    check "refused (exit 2), nothing compiled: '$bad'" $([ $rc -eq 2 ] && [ "$(compiled)" = 0 ] && echo 0 || echo 1)
done
run_script --help
check "--help prints the usage and succeeds without compiling" $([ $rc -eq 0 ] && has "$out" "Usage:" && has "$out" "recorder|detector|all" && [ "$(compiled)" = 0 ] && echo 0 || echo 1)

# ── the sketches this guards are the ones that exist ─────────────────────
for dir in ESP32_CAM_Recorder ESP32_CAM_TFLite_Person; do
    check "$dir has a .ino of its own name (the Arduino toolchain demands it)" $([ -f "$ROOT/Arduino/$dir/$dir.ino" ] && echo 0 || echo 1)
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
