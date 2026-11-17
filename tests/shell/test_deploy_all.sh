#!/bin/bash
# test_deploy_all.sh — deploy_all.sh and tools/deploy_plan_lib.sh. Everything the script would touch is
# a fake (deploy.sh, ota-deploy.sh, run_tests.sh, curl, npm, sudo) that only logs what it was asked, so
# what is proven is what the SCRIPT decides:
#   - only what changed since the deployed version is deployed, in the order dashboard -> settings ->
#     firmware -> relay, and the relay is never restarted after a failed firmware update
#   - the settings are staged BEFORE the firmware, without the Wi-Fi/key/id lines, and never as an empty
#     body (which would remove what is staged)
#   - a missing input is found before the first step runs; a failed step stops the deploy
#   - the control key never appears on a command line, and its file is private (600) — without the strict
#     umask used for it leaking into the steps: deploy.sh, ota-deploy.sh and run_tests.sh run with the
#     umask the caller has (077 made every NEW file of the web folder 600, unreadable by Apache)
#   - --dry-run changes nothing; the deployed revision is recorded only after a clean, complete run
# Usage: tests/shell/test_deploy_all.sh      Exit code: 0 if all pass.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}
ok_if() { if "$@"; then echo 0; else echo 1; fi; }
has()   { grep -qF -- "$2" "$1"; }                  # has FILE TEXT: the file contains the text
hasnt() { ! grep -qF -- "$2" "$1"; }
called() { grep -q -- "^$2" "$1"; }                 # called LOG NAME: a fake script/tool of that name ran
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }   # line_of FILE TEXT
before() { local a b; a="$(line_of "$1" "$2")"; b="$(line_of "$1" "$3")"; [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }

# ── the pure part: tools/deploy_plan_lib.sh ──────────────────────────────
# shellcheck disable=SC1091
. "$ROOT/tools/sketch_build_lib.sh"
# shellcheck disable=SC1091
. "$ROOT/tools/deploy_plan_lib.sh"

plan_of() {   # plan_of PATH... — the plan after those changed files, as one line
    plan_reset
    for p in "$@"; do plan_add_path "$p"; done
    echo "php=$PLAN_PHP relay=$PLAN_RELAY deps=$PLAN_RELAY_DEPS rec=${PLAN_SKETCH[recorder]:-0}/${PLAN_SETTINGS[recorder]:-0} det=${PLAN_SKETCH[detector]:-0}/${PLAN_SETTINGS[detector]:-0}"
}
REC=Arduino/ESP32_CAM_Recorder; DET=Arduino/ESP32_CAM_TFLite_Person

[ "$(plan_of README.md MANUAL.md tests/x.sh Arduino/templates/example.recorder.template.txt tools/sketch_build_lib.sh)" = "php=0 relay=0 deps=0 rec=0/0 det=0/0" ]
check "plan: docs, tests, tools and the example templates deploy nothing" $?
[ "$(plan_of php/cameras/index.php)" = "php=1 relay=0 deps=0 rec=0/0 det=0/0" ]
check "plan: php/ is the dashboard" $?
[ "$(plan_of nodejs/camera-relay/server.js)" = "php=0 relay=1 deps=0 rec=0/0 det=0/0" ]
check "plan: nodejs/ is the relay" $?
[ "$(plan_of nodejs/camera-relay/package-lock.json)" = "php=0 relay=1 deps=1 rec=0/0 det=0/0" ]
check "plan: the lockfile means the relay's packages too" $?
[ "$(plan_of $REC/ESP32_CAM_Recorder.ino)" = "php=0 relay=0 deps=0 rec=1/0 det=0/0" ]
check "plan: a recorder file is the recorder firmware, not its settings" $?
[ "$(plan_of $DET/settings_schema.h)" = "php=0 relay=0 deps=0 rec=0/0 det=1/1" ]
check "plan: a sketch's settings_schema.h is its firmware AND its settings" $?
[ "$(plan_of $REC/settings_schema.h $DET/a.h | tr -d '\n')" = "php=0 relay=0 deps=0 rec=1/1 det=1/0" ]
check "plan: both sketches can change at once" $?

plan_reset; plan_add_path "$REC/a.h"
[ "$(plan_ota_targets)" = "recorder" ]; check "ota targets: one changed sketch is deployed alone" $?
plan_add_path "$DET/a.h"
[ "$(plan_ota_targets)" = "all" ]; check "ota targets: both changed is 'all'" $?
plan_reset; [ -z "$(plan_ota_targets)" ] && ! plan_has_firmware; check "ota targets: none when no sketch changed" $?
plan_reset; plan_is_empty; check "plan_is_empty: a fresh plan" $?
plan_add_path php/x.php; ! plan_is_empty; check "plan_is_empty: not after a change" $?

staged() { printf '%s\n' "$1" | staged_line_from_template; }
[ "$(staged 'CAMERA_ID=cam1;SERVER_HOST=h;PUSH_PORT=1;HTTP_PORT=2;API_KEY=k;WIFI=a:b;LOG_X=3;JPEG_Q=4')" = "LOG_X=3;JPEG_Q=4" ]
check "staged line: the Wi-Fi, server, ports, key and id are left out" $?
[ "$(staged 'DETECTOR_ID=d1;DETECT_THRESH=0.6')" = "DETECT_THRESH=0.6" ]; check "staged line: the detector's id is left out" $?
[ "$(staged 'SETUP_PASSWORD=Master-9;SETUP_MODE=1;LOG_X=3')" = "LOG_X=3" ]
check "staged line: the setup Wi-Fi's master password and SETUP_MODE (which would arm every board) are left out" $?
[ -z "$(staged 'WIFI=a:b;API_KEY=k')" ]; check "staged line: nothing is left when only those are there" $?
[ "$(staged 'A=x\;y;WIFI=s:p;B=back\\slash;C=a=b')" = 'A=x\;y;B=back\\slash;C=a=b' ]
check "staged line: escaped ; and \\ and a = in a value survive" $?
[ "$(staged 'WIFI_X=1;MY_API_KEY=2')" = "WIFI_X=1;MY_API_KEY=2" ]; check "staged line: only exact key names are left out" $?

# ── the sandbox: a repository with the real scripts and fake tools ────────
SB="$TMP/repo"; BIN="$TMP/bin"; LOG="$TMP/calls.log"; OUT="$TMP/out.txt"
mkdir -p "$SB/tools" "$SB/php/cameras" "$SB/nodejs/camera-relay" "$SB/$REC" "$SB/$DET" "$SB/Arduino/templates" "$BIN"
cp "$ROOT/deploy_all.sh" "$SB/"
cp "$ROOT/tools/sketch_build_lib.sh" "$ROOT/tools/deploy_plan_lib.sh" "$SB/tools/"

# the fake scripts of the repository: log the call, fail when FAKE_FAIL names them
for s in deploy.sh ota-deploy.sh run_tests.sh; do
    cat > "$SB/$s" <<EOF
#!/usr/bin/env bash
echo "$s \$*" >> "\$FAKE_LOG"
echo "$s umask=\$(umask)" >> "\${FAKE_UMASK_LOG:-/dev/null}"
case " \${FAKE_FAIL:-} " in *" $s "*) exit 1 ;; esac
exit 0
EOF
    chmod +x "$SB/$s"
done
printf 'RELAY_URL=http://relay.test:8080/\nCONTROL_KEY=sekrit-control-key\n' > "$SB/ota.conf"
printf 'CAMERA_ID=cam1;API_KEY=sekrit-cam-key;WIFI=ssid:wifipass;SETUP_PASSWORD=sekrit-setup;SETUP_MODE=1;LOG_NEW=30\n' > "$SB/Arduino/templates/recorder.txt"
printf 'DETECTOR_ID=d1;API_KEY=sekrit-cam-key;DETECT_THRESH=0.6\n' > "$SB/Arduino/templates/person.txt"

# the fake curl: logs method, url and the body; answers by FAKE_CODE_<METHOD> (default 200; POST /restart 202);
# the relay "comes back" once FAKE_RELAY_DOWN is not 1
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
method=GET; url=""; out=""; body=""; wfmt=""; args="$*"
while [ $# -gt 0 ]; do
    case "$1" in
        -X) method="$2"; shift 2 ;;
        -o) out="$2"; shift 2 ;;
        -w) wfmt="$2"; shift 2 ;;
        --data-binary) body="$2"; shift 2 ;;
        -H) case "$2" in @*) stat -c %a "${2#@}" >> "${FAKE_HDRMODE:-/dev/null}" ;; esac; shift 2 ;;
        --max-time) shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
echo "curl $method $url body=[$body]" >> "$FAKE_LOG"
echo "ARGV: $args" >> "$FAKE_ARGV"
path="${url#http://relay.test:8080}"
if [ "$path" = /ota/status ] && [ "${FAKE_RELAY_DOWN:-0}" = 1 ]; then exit 7; fi
code=200
[ "$method" = POST ] && [ "$path" = /restart ] && code=202
[ "$method" = PUT ] && [ -n "${FAKE_CODE_PUT:-}" ] && code="$FAKE_CODE_PUT"
[ "$method" = POST ] && [ -n "${FAKE_CODE_POST:-}" ] && code="$FAKE_CODE_POST"
[ -n "$out" ] && [ "$out" != /dev/null ] && echo '{"error":"the relay says no"}' > "$out"
[ -n "$wfmt" ] && printf '%s' "$code"
case "$code" in 2*) exit 0 ;; *) exit 0 ;; esac
EOF
printf '#!/usr/bin/env bash\necho "npm $*" >> "$FAKE_LOG"\n[ "${FAKE_FAIL:-}" = npm ] && exit 1\nexit 0\n' > "$BIN/npm"
printf '#!/usr/bin/env bash\necho "sudo $*" >> "$FAKE_LOG"\nexec "$@"\n' > "$BIN/sudo"
chmod +x "$BIN"/*

git -C "$SB" init -q . && git -C "$SB" config user.email t@example.com && git -C "$SB" config user.name t
printf '.deployed-rev\n.deploy_all.lock\nota.conf\nArduino/templates/*.txt\n' > "$SB/.gitignore"
touch "$SB/php/cameras/index.php" "$SB/nodejs/camera-relay/server.js" "$SB/nodejs/camera-relay/package.json" \
      "$SB/$REC/ESP32_CAM_Recorder.ino" "$SB/$REC/settings_schema.h" "$SB/$DET/ESP32_CAM_TFLite_Person.ino" "$SB/$DET/settings_schema.h"
git -C "$SB" add -A && git -C "$SB" commit -qm base && BASE_REV="$(git -C "$SB" rev-parse HEAD)"

commit_change() {   # commit_change FILE... — change each file and commit
    for f in "$@"; do echo "change $RANDOM" >> "$SB/$f"; done
    git -C "$SB" add -A && git -C "$SB" commit -qm "change $*"
}
reset_to_base() { git -C "$SB" reset -q --hard "$BASE_REV"; rm -f "$SB/.deployed-rev"; git -C "$SB" update-ref -d ORIG_HEAD 2>/dev/null; }

run_deploy() {   # run_deploy ARGS... — sets rc; the log of the fakes is $LOG, the script's words are $OUT
    : > "$LOG"; : > "$TMP/argv.log"; : > "$TMP/umask.log"; : > "$TMP/hdrmode.log"
    (cd "$SB" && umask "${CASE_UMASK:-0022}" && PATH="$BIN:$PATH" FAKE_LOG="$LOG" FAKE_ARGV="$TMP/argv.log" \
        FAKE_UMASK_LOG="$TMP/umask.log" FAKE_HDRMODE="$TMP/hdrmode.log" \
        DEPLOY_RESTART_PAUSE=0 DEPLOY_POLL_SECONDS=1 DEPLOY_RELAY_WAIT="${CASE_RELAY_WAIT:-3}" \
        bash ./deploy_all.sh "$@") > "$OUT" 2>&1
    rc=$?
}
FAILRUN() { FAKE_FAIL="$1" run_deploy "${@:2}"; }   # FAILRUN NAME ARGS... — NAME (a fake script, or npm) fails
fresh_with() {   # fresh_with FILE... — the base revision is deployed, then these files change (committed)
    reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change "$@"
}
deployed_rev() { [ -f "$SB/.deployed-rev" ] && cat "$SB/.deployed-rev"; }

# ── 1. nothing changed ───────────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"
commit_change README-not-deployed.txt
run_deploy --run-tests
[ $rc -eq 0 ] && [ ! -s "$LOG" ] && has "$OUT" "nothing to do"
check "nothing deployed changed: exit 0, no step ran (not even the tests)" $?
[ "$(deployed_rev)" = "$(git -C "$SB" rev-parse HEAD)" ]; check "nothing deployed changed: the new revision is recorded as deployed" $?

# ── 2. dashboard only ────────────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php
run_deploy
[ $rc -eq 0 ] && called "$LOG" deploy.sh && ! called "$LOG" ota-deploy.sh && ! called "$LOG" curl && ! called "$LOG" npm
check "php only: only deploy.sh ran (with root rights)" $?
if [ "$(id -u)" -ne 0 ]; then has "$LOG" "sudo ./deploy.sh"; else true; fi; check "php only: deploy.sh is run through sudo when not root" $?
[ "$(deployed_rev)" = "$(git -C "$SB" rev-parse HEAD)" ]; check "php only: the revision is recorded after a good run" $?

# ── 3. a sketch, no settings change ──────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change $REC/ESP32_CAM_Recorder.ino
run_deploy --wait 120
[ $rc -eq 0 ] && has "$LOG" "ota-deploy.sh recorder --wait 120" && hasnt "$LOG" "PUT" && hasnt "$LOG" "/restart" && ! called "$LOG" deploy.sh
check "recorder sketch only: ota-deploy.sh recorder --wait 120; nothing staged, no restart" $?

# ── 4. a sketch and its settings ─────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change $REC/ESP32_CAM_Recorder.ino $REC/settings_schema.h
run_deploy
[ $rc -eq 0 ] && has "$LOG" "curl PUT http://relay.test:8080/device-settings/recorder body=[LOG_NEW=30]"
check "settings changed: staged for the recorder, without the id, key and Wi-Fi" $?
before "$LOG" "curl PUT" "ota-deploy.sh recorder"; check "settings changed: staged BEFORE the firmware" $?
hasnt "$TMP/argv.log" "sekrit-control-key"; check "the control key is never on a command line" $?
hasnt "$LOG" "sekrit-cam-key" && hasnt "$LOG" "wifipass" && hasnt "$LOG" "sekrit-setup" && hasnt "$LOG" "SETUP_MODE"; check "the camera key, the Wi-Fi password and the setup password are never sent, nor SETUP_MODE" $?

# ── 5. both sketches ─────────────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change $REC/ESP32_CAM_Recorder.ino $DET/settings_schema.h
run_deploy
[ $rc -eq 0 ] && has "$LOG" "ota-deploy.sh all --wait 600" && has "$LOG" "device-settings/detector body=[DETECT_THRESH=0.6]" && hasnt "$LOG" "device-settings/recorder"
check "both sketches: ota-deploy.sh all, settings staged only for the detector (default wait 600)" $?

# ── 6. relay only ────────────────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change nodejs/camera-relay/server.js
run_deploy
[ $rc -eq 0 ] && has "$LOG" "curl POST http://relay.test:8080/restart" && has "$LOG" "curl GET http://relay.test:8080/ota/status" && hasnt "$LOG" "npm" && hasnt "$LOG" "ota-deploy.sh"
check "relay only: restarted through POST /restart, then asked until it answers; no npm, no firmware" $?
commit_change nodejs/camera-relay/package.json
run_deploy
[ $rc -eq 0 ] && before "$LOG" "npm ci" "curl POST"; check "relay packages changed: npm ci before the restart" $?

# ── 7. everything, in order ──────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"
commit_change php/cameras/index.php $REC/settings_schema.h nodejs/camera-relay/server.js
run_deploy --run-tests
[ $rc -eq 0 ] && before "$LOG" "run_tests.sh" "deploy.sh" && before "$LOG" "deploy.sh" "curl PUT" \
    && before "$LOG" "curl PUT" "ota-deploy.sh recorder" && before "$LOG" "ota-deploy.sh recorder" "curl POST"
check "everything: tests -> dashboard -> settings -> firmware -> relay restart" $?
has "$LOG" "run_tests.sh" && ! has "$LOG" "run_tests.sh --no-sketch-compile"; check "--run-tests: the sketches are compiled when a sketch changed" $?

# ── 7b. the umask of the caller reaches every step; only the key file is private ──
for um in 0022 0002; do
    reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"
    commit_change php/cameras/index.php $REC/settings_schema.h nodejs/camera-relay/server.js
    CASE_UMASK=$um run_deploy --run-tests
    [ $rc -eq 0 ] && [ "$(grep -c . "$TMP/umask.log")" -eq 3 ] && ! grep -qv "umask=$um\$" "$TMP/umask.log"
    check "umask $um: run_tests.sh, deploy.sh and ota-deploy.sh all run with the caller's umask (the key file's 077 must not leak)" $?
    [ "$(cat "$TMP/hdrmode.log" | sort -u)" = 600 ]; check "umask $um: the file holding the control key is mode 600" $?
done
CASE_UMASK=0077 run_deploy --run-tests   # a caller who really has a strict umask keeps it: it is theirs to choose
[ $rc -eq 0 ] && ! grep -qv "umask=0077\$" "$TMP/umask.log"; check "umask 0077 of the caller is passed on as it is (no more, no less)" $?

# ── 8. --run-tests without a sketch change ───────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php
run_deploy --run-tests
[ $rc -eq 0 ] && has "$LOG" "run_tests.sh --no-sketch-compile"; check "--run-tests: --no-sketch-compile when no sketch changed" $?
fresh_with php/cameras/index.php
FAILRUN run_tests.sh --run-tests
[ $rc -eq 1 ] && ! called "$LOG" deploy.sh && has "$OUT" "nothing was deployed" && [ "$(deployed_rev)" = "$BASE_REV" ]
check "failing tests stop the deploy before anything is touched, and nothing is recorded" $?

# ── 9. a failed firmware update ──────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"
commit_change $REC/ESP32_CAM_Recorder.ino nodejs/camera-relay/server.js
FAILRUN ota-deploy.sh
[ $rc -eq 1 ] && hasnt "$LOG" "/restart" && has "$OUT" "was not restarted" && has "$OUT" "git checkout ${BASE_REV:0:12}" \
    && [ "$(deployed_rev)" = "$BASE_REV" ]
check "firmware not updated: exit 1, the relay is NOT restarted, a rollback hint with the old revision, not recorded" $?

# ── 10. failures of the other steps ──────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php $REC/settings_schema.h
FAILRUN deploy.sh
[ $rc -eq 1 ] && ! called "$LOG" curl && ! called "$LOG" ota-deploy.sh; check "deploy.sh fails: no staging, no firmware" $?
FAKE_CODE_PUT=400 run_deploy
[ $rc -eq 1 ] && hasnt "$LOG" "ota-deploy.sh" && has "$OUT" "HTTP 400" && has "$OUT" "the relay says no"; check "the relay refuses the settings: exit 1, no firmware, the reason is shown" $?
FAKE_CODE_PUT=401 run_deploy
[ $rc -eq 1 ] && has "$OUT" "HTTP 401"; check "wrong control key: exit 1" $?

reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change nodejs/camera-relay/server.js
FAKE_CODE_POST=409 run_deploy
[ $rc -eq 1 ] && has "$OUT" "did not accept the restart (HTTP 409)" && [ "$(deployed_rev)" = "$BASE_REV" ]; check "the relay refuses to restart (not supervised): exit 1, not recorded" $?
FAKE_RELAY_DOWN=1 CASE_RELAY_WAIT=2 run_deploy
[ $rc -eq 1 ] && has "$OUT" "did not answer within 2s"; check "the relay does not come back: exit 1" $?
commit_change nodejs/camera-relay/package.json
FAILRUN npm
[ $rc -eq 1 ] && hasnt "$LOG" "curl POST"; check "npm ci fails: the relay is not restarted" $?

# ── 11. inputs are checked before the first step ─────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php $REC/settings_schema.h
mv "$SB/Arduino/templates/recorder.txt" "$TMP/recorder.txt.away"
run_deploy
[ $rc -eq 2 ] && [ ! -s "$LOG" ] && has "$OUT" "recorder.txt"; check "settings template missing: exit 2 before anything ran (not even deploy.sh)" $?
printf 'A=1\nB=2\n' > "$SB/Arduino/templates/recorder.txt"
run_deploy
[ $rc -eq 2 ] && [ ! -s "$LOG" ] && has "$OUT" "ONE line"; check "settings template of two lines: exit 2 before anything ran" $?
printf 'WIFI=a:b;API_KEY=k\n' > "$SB/Arduino/templates/recorder.txt"
run_deploy
[ $rc -eq 0 ] && hasnt "$LOG" "curl PUT" && has "$OUT" "nothing to stage"; check "nothing but per-board settings: nothing is staged (an empty body would delete the staged line)" $?
mv "$TMP/recorder.txt.away" "$SB/Arduino/templates/recorder.txt"
fresh_with php/cameras/index.php $REC/settings_schema.h
mv "$SB/ota.conf" "$TMP/ota.conf.away"
run_deploy
[ $rc -eq 2 ] && [ ! -s "$LOG" ] && has "$OUT" "ota.conf"; check "no ota.conf: exit 2 before anything ran" $?
printf 'RELAY_URL=http://relay.test:8080\n' > "$SB/ota.conf"
run_deploy
[ $rc -eq 2 ] && has "$OUT" "CONTROL_KEY"; check "no CONTROL_KEY: exit 2" $?
mv "$TMP/ota.conf.away" "$SB/ota.conf"
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php
rm "$SB/ota.conf"; run_deploy
[ $rc -eq 0 ] && called "$LOG" deploy.sh; check "a dashboard-only deploy does not need ota.conf" $?
printf 'RELAY_URL=http://relay.test:8080/\nCONTROL_KEY=sekrit-control-key\n' > "$SB/ota.conf"

# ── 12. --dry-run ────────────────────────────────────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"
commit_change php/cameras/index.php $REC/settings_schema.h nodejs/camera-relay/package.json
run_deploy --dry-run --run-tests
[ $rc -eq 0 ] && [ ! -s "$LOG" ] && [ "$(deployed_rev)" = "$BASE_REV" ] && has "$OUT" "DRY RUN" && has "$OUT" "recorder firmware + settings"
check "--dry-run: prints the plan, runs nothing, records nothing" $?

# ── 13. the version to compare with ──────────────────────────────────────
reset_to_base; commit_change php/cameras/index.php
run_deploy
[ $rc -eq 2 ] && [ ! -s "$LOG" ] && has "$OUT" "--since"; check "no state file and no ORIG_HEAD: exit 2 and says what to do" $?
git -C "$SB" update-ref ORIG_HEAD "$BASE_REV"
run_deploy
[ $rc -eq 0 ] && called "$LOG" deploy.sh && has "$OUT" "ORIG_HEAD"; check "no state file: the version before the pull (ORIG_HEAD) is used" $?
reset_to_base; commit_change php/cameras/index.php $REC/ESP32_CAM_Recorder.ino
run_deploy --since "$BASE_REV"
[ $rc -eq 0 ] && called "$LOG" deploy.sh && has "$LOG" "ota-deploy.sh recorder"; check "--since REV: compares with that revision" $?
run_deploy --since HEAD
[ $rc -eq 0 ] && [ ! -s "$LOG" ]; check "--since HEAD: nothing to deploy" $?
run_deploy --since no-such-revision
[ $rc -eq 2 ] && [ ! -s "$LOG" ]; check "--since an unknown revision: exit 2" $?
run_deploy --since --all
[ $rc -eq 2 ]; check "--since cannot be an option" $?
run_deploy --all --since HEAD
[ $rc -eq 2 ]; check "--all with --since: exit 2" $?
reset_to_base
run_deploy --all
[ $rc -eq 0 ] && called "$LOG" deploy.sh && has "$LOG" "ota-deploy.sh all" && has "$LOG" "device-settings/recorder" \
    && has "$LOG" "device-settings/detector" && has "$LOG" "npm ci" && has "$LOG" "/restart"; check "--all: every part, whatever changed" $?

# ── 14. a tree with uncommitted changes, usage ───────────────────────────
reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; echo "wip" >> "$SB/php/cameras/index.php"
run_deploy
[ $rc -eq 0 ] && called "$LOG" deploy.sh && [ "$(deployed_rev)" = "$BASE_REV" ] && has "$OUT" "not recorded"
check "uncommitted changes: they are deployed, but not recorded as a revision" $?
git -C "$SB" checkout -q -- .
run_deploy --bogus;           [ $rc -eq 2 ]; check "an unknown argument: exit 2" $?
run_deploy --wait abc;        [ $rc -eq 2 ]; check "--wait needs a number: exit 2" $?
run_deploy --wait;            [ $rc -eq 2 ]; check "--wait without a value: exit 2" $?
run_deploy --since;           [ $rc -eq 2 ]; check "--since without a value: exit 2" $?
run_deploy --help;            [ $rc -eq 0 ] && has "$OUT" "deploy_all.sh"; check "--help: usage, exit 0" $?

# ── 15. one deploy at a time ─────────────────────────────────────────────
if command -v flock >/dev/null 2>&1; then
    reset_to_base; echo "$BASE_REV" > "$SB/.deployed-rev"; commit_change php/cameras/index.php
    ( exec 8> "$SB/.deploy_all.lock"; flock -n 8 && sleep 3 ) &
    sleep 0.5
    run_deploy
    [ $rc -eq 1 ] && [ ! -s "$LOG" ] && has "$OUT" "another deploy_all.sh is running"; check "a second deploy at the same time: exit 1, nothing ran" $?
    wait
fi

# ── 16. --branch: the pull is part of the deploy ─────────────────────────
REMOTE_GIT="$TMP/remote.git"; OTHER="$TMP/other"
MAIN="$(git -C "$SB" branch --show-current)"
git init -q --bare "$REMOTE_GIT"
git -C "$SB" remote add origin "$REMOTE_GIT"
git -C "$SB" push -q origin "$MAIN:$MAIN" 2>/dev/null
git clone -q "$REMOTE_GIT" "$OTHER" 2>/dev/null
git -C "$OTHER" config user.email t@example.com; git -C "$OTHER" config user.name t

publish_branch() {   # publish_branch NAME FILE... — origin's branch NAME is the base plus a commit changing the files
    local name="$1"; shift
    git -C "$OTHER" fetch -q origin
    git -C "$OTHER" checkout -q -B "$name" "origin/$MAIN"
    for f in "$@"; do mkdir -p "$(dirname "$OTHER/$f")"; echo "remote change $RANDOM" >> "$OTHER/$f"; done
    git -C "$OTHER" add -A && git -C "$OTHER" commit -qm "remote $name" && git -C "$OTHER" push -q -f origin "$name" 2>/dev/null
    REMOTE_TIP="$(git -C "$OTHER" rev-parse HEAD)"
}
branch_fresh() {   # the Pi is on the main branch at the base revision, with no local "release" branch
    git -C "$SB" checkout -q -f "$MAIN" && git -C "$SB" reset -q --hard "$BASE_REV"
    git -C "$SB" branch -q -D release 2>/dev/null
    git -C "$SB" update-ref -d ORIG_HEAD 2>/dev/null
    rm -f "$SB/.deployed-rev"
}
current_branch() { git -C "$SB" branch --show-current; }
sb_head() { git -C "$SB" rev-parse HEAD; }

branch_fresh; echo "$BASE_REV" > "$SB/.deployed-rev"; publish_branch release php/cameras/index.php
run_deploy --branch=release
[ $rc -eq 0 ] && [ "$(current_branch)" = release ] && [ "$(sb_head)" = "$REMOTE_TIP" ] && called "$LOG" deploy.sh && ! called "$LOG" ota-deploy.sh \
    && [ "$(deployed_rev)" = "$REMOTE_TIP" ] && has "$OUT" "${BASE_REV:0:12} -> ${REMOTE_TIP:0:12}"
check "--branch: the branch is made from origin's, checked out, and what the pull brought is deployed and recorded" $?

run_deploy --branch=release
[ $rc -eq 0 ] && [ ! -s "$LOG" ] && has "$OUT" "up to date" && has "$OUT" "nothing to do"
check "--branch: already up to date and deployed: nothing to do" $?

branch_fresh; publish_branch release $REC/ESP32_CAM_Recorder.ino
run_deploy --branch release
[ $rc -eq 0 ] && has "$OUT" "the version before the pull" && has "$LOG" "ota-deploy.sh recorder" && [ "$(sb_head)" = "$REMOTE_TIP" ]
check "--branch NAME (two words), no deploy recorded: compared with the version before the pull" $?

branch_fresh; echo "$BASE_REV" > "$SB/.deployed-rev"; publish_branch release php/cameras/index.php
git -C "$SB" branch -q release "$BASE_REV"
run_deploy --branch=release
[ $rc -eq 0 ] && [ "$(current_branch)" = release ] && [ "$(sb_head)" = "$REMOTE_TIP" ] && called "$LOG" deploy.sh
check "--branch: an existing local branch that is behind is fast-forwarded" $?

branch_fresh; echo "$BASE_REV" > "$SB/.deployed-rev"; publish_branch release php/cameras/index.php
git -C "$SB" checkout -q -b release && commit_change README-local-work.txt && git -C "$SB" checkout -q "$MAIN"
run_deploy --branch=release
[ $rc -eq 1 ] && [ ! -s "$LOG" ] && has "$OUT" "cannot be fast-forwarded" && [ "$(current_branch)" = "$MAIN" ]
check "--branch: a local branch with commits of its own is refused, nothing ran, the Pi stays on its branch" $?

branch_fresh; echo "$BASE_REV" > "$SB/.deployed-rev"; publish_branch release php/cameras/index.php
echo wip >> "$SB/php/cameras/index.php"
run_deploy --branch=release
[ $rc -eq 1 ] && [ ! -s "$LOG" ] && has "$OUT" "uncommitted changes" && [ "$(sb_head)" = "$BASE_REV" ] && [ "$(current_branch)" = "$MAIN" ]
check "--branch: uncommitted changes refuse the pull, nothing ran" $?
git -C "$SB" checkout -q -- .

branch_fresh; echo "$BASE_REV" > "$SB/.deployed-rev"
run_deploy --branch=no-such-branch
[ $rc -eq 1 ] && [ ! -s "$LOG" ] && has "$OUT" "could not fetch no-such-branch" && [ "$(current_branch)" = "$MAIN" ]
check "--branch: a branch that origin does not have: exit 1, nothing ran" $?

publish_branch release php/cameras/index.php $REC/ESP32_CAM_Recorder.ino
run_deploy --branch=release --dry-run
[ $rc -eq 0 ] && [ ! -s "$LOG" ] && [ "$(sb_head)" = "$BASE_REV" ] && [ "$(current_branch)" = "$MAIN" ] && [ "$(deployed_rev)" = "$BASE_REV" ] \
    && has "$OUT" "dry run: not pulled" && has "$OUT" "php, recorder firmware" && ! git -C "$SB" show-ref -q --verify refs/heads/release
check "--branch --dry-run: plans against origin's branch, pulls nothing, runs nothing, records nothing" $?

run_deploy --branch=release --since no-such-revision
[ $rc -eq 2 ] && [ "$(sb_head)" = "$BASE_REV" ] && ! git -C "$SB" show-ref -q --verify refs/heads/release
check "--branch with a bad --since: found before anything is pulled" $?

for bad in "--branch=" "--branch=-x" "--branch=a..b" "--branch=has space" "--branch=@{-1}"; do
    run_deploy "$bad"
    [ $rc -eq 2 ] && [ ! -s "$LOG" ]; check "$bad: not a branch name, exit 2" $?
done
run_deploy --branch;  [ $rc -eq 2 ]; check "--branch without a name: exit 2" $?
git -C "$SB" checkout -q -f "$MAIN"

# ── the repository itself ────────────────────────────────────────────────
[ -x "$ROOT/deploy_all.sh" ]; check "deploy_all.sh is executable" $?
git -C "$ROOT" check-ignore -q .deployed-rev 2>/dev/null || grep -q '^\.deployed-rev$' "$ROOT/.gitignore"
check ".deployed-rev is gitignored" $?
grep -q '^\.deploy_all\.lock$' "$ROOT/.gitignore"; check ".deploy_all.lock is gitignored" $?

echo
echo "deploy_all tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
