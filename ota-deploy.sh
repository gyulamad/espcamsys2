#!/usr/bin/env bash
# ota-deploy.sh — compile the sketches of the git revision that is checked out and hand the
# binaries to the relay, which gives them to every camera (they poll, download, flash and
# reboot by themselves). See "Over-the-air updates" in INSTALL.md.
#
# Usage:
#   ./ota-deploy.sh [recorder|detector|all] [--wait SECS]
#
#   recorder|detector|all   which sketch(es) to deploy (default: all)
#   --wait SECS             after publishing, watch the relay until every device of the deployed
#                           type(s) runs the new version, or SECS seconds have passed; prints a
#                           table and exits non-zero if any device is not updated
#
# The version is `git describe --always --dirty`; with uncommitted changes ".t<epoch>" is added,
# so a dev build always re-flashes. A different version — not a newer one — updates the cameras,
# so checking out an older commit and deploying it downgrades them.
#
# Needs: arduino-cli (with the esp32 core 3.x), curl, awk, git. Settings: ota.conf (see
# ota.example.conf). Exit code: 0 all good, 1 failed (build, upload, or a device not updated),
# 2 wrong usage / missing setup.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${OTA_CONF:-$ROOT_DIR/ota.conf}"

die()  { echo "ota-deploy: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ── arguments ────────────────────────────────────────────────────────────
WHAT="all"
WAIT_ARG=""
while [ $# -gt 0 ]; do
    case "$1" in
        recorder|detector|all) WHAT="$1"; shift ;;
        --wait)
            [ $# -ge 2 ] || { echo "--wait needs a number of seconds" >&2; exit 2; }
            WAIT_ARG="$2"; shift 2 ;;
        --wait=*) WAIT_ARG="${1#--wait=}"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
    esac
done

# ── settings ─────────────────────────────────────────────────────────────
RELAY_URL=""; CONTROL_KEY=""
FQBN="esp32:esp32:esp32cam:PartitionScheme=min_spiffs"
EXTRA_COMPILE_ARGS=""
SLOT_BYTES=1966080
WAIT_SECONDS=0
if [ -f "$CONF" ]; then
    # shellcheck disable=SC1090
    . "$CONF"
else
    echo "ota-deploy: no $CONF - copy ota.example.conf to ota.conf and fill it in" >&2; exit 2
fi
[ -n "$WAIT_ARG" ] && WAIT_SECONDS="$WAIT_ARG"
[ -n "$RELAY_URL" ]   || { echo "ota-deploy: RELAY_URL is not set in $CONF" >&2; exit 2; }
[ -n "$CONTROL_KEY" ] || { echo "ota-deploy: CONTROL_KEY is not set in $CONF" >&2; exit 2; }
RELAY_URL="${RELAY_URL%/}"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || { echo "ota-deploy: --wait must be a whole number of seconds (got: $WAIT_SECONDS)" >&2; exit 2; }
[[ "$SLOT_BYTES" =~ ^[0-9]+$ ]]   || { echo "ota-deploy: SLOT_BYTES must be a number" >&2; exit 2; }
for tool in arduino-cli curl awk git; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ota-deploy: $tool not found on PATH" >&2; exit 2; }
done

case "$WHAT" in
    all)      TYPES="recorder detector" ;;
    *)        TYPES="$WHAT" ;;
esac
sketch_dir()  { case "$1" in recorder) echo "$ROOT_DIR/Arduino/ESP32_CAM_Recorder" ;; detector) echo "$ROOT_DIR/Arduino/ESP32_CAM_TFLite_Person" ;; esac; }
sketch_name() { basename "$(sketch_dir "$1")"; }

# ── version ──────────────────────────────────────────────────────────────
VERSION="$(git -C "$ROOT_DIR" describe --always --dirty 2>/dev/null)" || die "git describe failed - is this a git checkout?"
case "$VERSION" in
    *-dirty)
        VERSION="$VERSION.t$(date +%s)"
        echo "WARNING: uncommitted changes - deploying a dev build ($VERSION). It will re-flash every time." >&2 ;;
esac
# The relay accepts 1-64 characters from A-Z a-z 0-9 . _ - (no '+': it would need URL-encoding).
if ! [[ "$VERSION" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    die "the version '$VERSION' has characters or a length the relay does not accept (1-64 of A-Z a-z 0-9 . _ -)"
fi
echo "Version: $VERSION"

# ── build ────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
cleanup() {
    for t in recorder detector; do rm -f "$(sketch_dir "$t")/fw_version.h"; done
    rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The key goes into a header file (mode 600), not onto curl's command line where `ps` shows it.
umask 077
printf 'X-Control-Key: %s\n' "$CONTROL_KEY" > "$TMP/control-header"

for t in $TYPES; do
    dir="$(sketch_dir "$t")"
    name="$(sketch_name "$t")"
    printf '#define FW_GIT "%s"\n' "$VERSION" > "$dir/fw_version.h"
    echo
    echo "== Compiling $t ($name) for $FQBN"
    # shellcheck disable=SC2086
    arduino-cli compile --fqbn "$FQBN" $EXTRA_COMPILE_ARGS --output-dir "$TMP/$t" "$dir" || die "compiling the $t sketch failed"
    bin="$TMP/$t/$name.ino.bin"
    [ -f "$bin" ] || die "the build did not produce $name.ino.bin (looked in $TMP/$t)"
    size="$(wc -c < "$bin" | tr -d ' ')"
    pct=$(( size * 100 / SLOT_BYTES ))
    echo "   $t: $size bytes of $SLOT_BYTES ($pct% of one app slot)"
    [ "$size" -le "$SLOT_BYTES" ] || die "the $t firmware ($size bytes) does not fit an app slot ($SLOT_BYTES): it could not be flashed over the air"
    rm -f "$dir/fw_version.h"
done

# ── publish (only once everything compiled: no half deployments) ─────────
for t in $TYPES; do
    echo
    echo "== Publishing $t $VERSION to $RELAY_URL"
    code="$(curl -sS -o "$TMP/reply-$t" -w '%{http_code}' -X PUT -H "@$TMP/control-header" \
            -H 'Content-Type: application/octet-stream' --data-binary "@$TMP/$t/$(sketch_name "$t").ino.bin" \
            "$RELAY_URL/ota/$t?version=$VERSION")" || die "could not reach the relay at $RELAY_URL"
    if [ "$code" != "200" ]; then
        echo "   the relay answered HTTP $code: $(cat "$TMP/reply-$t")" >&2
        die "publishing the $t firmware failed"
    fi
    echo "   published: $(cat "$TMP/reply-$t")"
done

if [ "$WAIT_SECONDS" -eq 0 ]; then
    echo
    echo "Published. The cameras check about once a minute; watch the relay log, or run:"
    echo "  curl -s -H 'X-Control-Key: ...' $RELAY_URL/ota/status"
    exit 0
fi

# ── wait and report ──────────────────────────────────────────────────────
# /ota/status: id type target running state lastSeenAgo lastError (tab separated), for every
# device that polled since the relay started. We look at the types we deployed.
echo
echo "== Waiting up to ${WAIT_SECONDS}s for the cameras to update (they check about once a minute)"
deadline=$(( $(date +%s) + WAIT_SECONDS ))
all_updated=0
while :; do
    if curl -sS -f -H "@$TMP/control-header" "$RELAY_URL/ota/status" -o "$TMP/status" 2>"$TMP/status.err"; then
        # rows of the deployed types; the verdict is: at least one, and every one `updated` to THIS version
        verdict="$(awk -F'\t' -v types=" $TYPES " -v ver="$VERSION" '
            index(types, " " $2 " ") { rows++; if ($5 != "updated" || $3 != ver) pending++ }
            END { if (rows > 0 && pending == 0) print "done"; else print "waiting" }' "$TMP/status")"
        if [ "$verdict" = "done" ]; then all_updated=1; break; fi
    fi
    remaining=$(( deadline - $(date +%s) ))
    [ "$remaining" -gt 0 ] || break
    # OTA_POLL_SECONDS is only for the tests; 10 s is right for real cameras
    poll="${OTA_POLL_SECONDS:-10}"
    sleep $(( remaining < poll ? remaining : poll ))
done

echo
printf 'id\ttype\ttarget\trunning\tstate\tlast seen\tlast error\n' > "$TMP/table"
if [ -s "$TMP/status" ]; then
    awk -F'\t' -v types=" $TYPES " 'index(types, " " $2 " ")' "$TMP/status" >> "$TMP/table"
fi
if [ "$(wc -l < "$TMP/table")" -le 1 ]; then
    echo "No device of type ($TYPES) has asked the relay for firmware since it started."
    [ -s "$TMP/status.err" ] && cat "$TMP/status.err" >&2
else
    column -t -s "$(printf '\t')" "$TMP/table" 2>/dev/null || cat "$TMP/table"
fi
echo
if [ "$all_updated" = 1 ]; then
    echo "All devices run $VERSION."
    exit 0
fi
bad="$(awk -F'\t' -v types=" $TYPES " -v ver="$VERSION" 'index(types, " " $2 " ") && ($5 != "updated" || $3 != ver) { n++ } END { print n + 0 }' "$TMP/status" 2>/dev/null)"
echo "NOT every device runs $VERSION yet (${bad:-0} not updated). pending = still on the old version; offline = not seen for 10 minutes (WiFi / power?);"
echo "the last error column says why an attempt failed. They keep retrying every 5 minutes; run again with --wait to check later."
exit 1
