#!/usr/bin/env bash
# deploy_plan_lib.sh — the decisions of deploy_all.sh that need no network, no root and no hardware:
# what a list of changed files means for a deploy, and which part of a settings template may be
# staged on the relay. Sourced by deploy_all.sh and its test, never run on its own.
#
# Needs bash 4.2+ (associative arrays) and tools/sketch_build_lib.sh sourced first (SKETCH_TYPES,
# SKETCH_ROOT, sketch_dir).

# The settings a board needs to REACH the relay, and the ones that belong to one board alone, are
# never staged: the relay does not take them from a fleet line anyway (only missing or invalid
# settings are filled, and a board that cannot reach the relay cannot ask), and a staged line is
# plain text that every board of the type can fetch, so the Wi-Fi password, the camera key and the
# master password of the setup Wi-Fi (SETUP_PASSWORD) must not be in it. SETUP_MODE=1 arms a board's
# own setup Wi-Fi at boot: staged for a whole type it would arm every board of it.
STAGING_EXCLUDED_KEYS="CAMERA_ID,DETECTOR_ID,WIFI,SERVER_HOST,HTTP_PORT,PUSH_PORT,API_KEY,SETUP_PASSWORD,SETUP_MODE"

# What one sketch's settings are called in Arduino/templates/ (the real ones are gitignored).
settings_template_name() {
    case "$1" in
        recorder) echo "recorder.txt" ;;
        detector) echo "person.txt" ;;
        *)        return 1 ;;
    esac
}

# sketch_rel_dir TYPE — the folder of that sketch, relative to the repository root.
sketch_rel_dir() {
    local dir
    dir="$(sketch_dir "$1")" || return 1
    echo "${dir#"$SKETCH_ROOT"/}"
}

# ── the plan ────────────────────────────────────────────────────────────

PLAN_PHP=0; PLAN_RELAY=0; PLAN_RELAY_DEPS=0
declare -gA PLAN_SKETCH=() PLAN_SETTINGS=()

# plan_reset — nothing to deploy.
plan_reset() {
    PLAN_PHP=0; PLAN_RELAY=0; PLAN_RELAY_DEPS=0
    PLAN_SKETCH=(); PLAN_SETTINGS=()
}

# plan_everything — deploy every part (the first deploy, or --all).
plan_everything() {
    local t
    PLAN_PHP=1; PLAN_RELAY=1; PLAN_RELAY_DEPS=1
    for t in $SKETCH_TYPES; do PLAN_SKETCH[$t]=1; PLAN_SETTINGS[$t]=1; done
}

# plan_add_path PATH — one changed file (a path relative to the repository root).
#   php/                           the dashboard
#   nodejs/                        the relay (package.json / package-lock.json: its packages too)
#   a sketch's folder              that sketch's firmware
#   a sketch's settings_schema.h   ... and its settings: the board may need a value it does not have
plan_add_path() {
    local path="$1" t rel
    case "$path" in
        php/*) PLAN_PHP=1; return 0 ;;
        nodejs/camera-relay/package.json|nodejs/camera-relay/package-lock.json)
            PLAN_RELAY=1; PLAN_RELAY_DEPS=1; return 0 ;;
        nodejs/*) PLAN_RELAY=1; return 0 ;;
    esac
    for t in $SKETCH_TYPES; do
        rel="$(sketch_rel_dir "$t")" || continue
        case "$path" in
            "$rel"/settings_schema.h) PLAN_SKETCH[$t]=1; PLAN_SETTINGS[$t]=1; return 0 ;;
            "$rel"/*)                 PLAN_SKETCH[$t]=1; return 0 ;;
        esac
    done
    return 0
}

# plan_from_paths — reads one path per line on stdin (git diff --name-only) into the plan. Run it
# in the current shell (`plan_from_paths <<< "$paths"`), not at the end of a pipe: a pipe's right
# side is a subshell and the plan would be lost.
plan_from_paths() {
    local path
    while IFS= read -r path; do
        if [ -n "$path" ]; then plan_add_path "$path"; fi
    done
    return 0
}

# plan_ota_targets — what to hand to ota-deploy.sh, one argument per line: "all" when every sketch
# changed (one call compiles and watches both), otherwise the changed type(s). Empty: no firmware.
plan_ota_targets() {
    local t planned=() total=0
    for t in $SKETCH_TYPES; do
        total=$((total + 1))
        [ "${PLAN_SKETCH[$t]:-0}" = 1 ] && planned+=("$t")
    done
    [ "${#planned[@]}" -gt 0 ] || return 0
    if [ "${#planned[@]}" -eq "$total" ]; then echo "all"; return 0; fi
    printf '%s\n' "${planned[@]}"
}

# plan_has_firmware — succeeds if any sketch changed.
plan_has_firmware() { [ -n "$(plan_ota_targets)" ]; }

# plan_is_empty — succeeds if nothing that is deployed changed.
plan_is_empty() {
    local t
    [ "$PLAN_PHP" = 0 ] && [ "$PLAN_RELAY" = 0 ] || return 1
    for t in $SKETCH_TYPES; do [ "${PLAN_SKETCH[$t]:-0}" = 0 ] || return 1; done
    return 0
}

# plan_summary — one line: what changed.
plan_summary() {
    local parts=() t
    [ "$PLAN_PHP" = 1 ] && parts+=("php")
    for t in $SKETCH_TYPES; do
        [ "${PLAN_SKETCH[$t]:-0}" = 1 ] || continue
        if [ "${PLAN_SETTINGS[$t]:-0}" = 1 ]; then parts+=("$t firmware + settings"); else parts+=("$t firmware"); fi
    done
    if [ "$PLAN_RELAY_DEPS" = 1 ]; then parts+=("relay + packages")
    elif [ "$PLAN_RELAY" = 1 ]; then parts+=("relay"); fi
    [ "${#parts[@]}" -gt 0 ] || { echo "nothing"; return 0; }
    local IFS=','; echo "${parts[*]}" | sed 's/,/, /g'
}

# ── the settings that may be staged ─────────────────────────────────────

# staged_line_from_template — reads a settings template (one line, KEY=value;KEY=value, `\;` `\:`
# and `\\` are a literal ; : and \) on stdin and prints it without STAGING_EXCLUDED_KEYS. Prints
# nothing when nothing is left.
staged_line_from_template() {
    local line part key
    local -a kept=() parts=()
    IFS= read -r line || true
    # protect the escaped characters, so only a bare ; separates two settings
    line="${line//\\\\/$'\001'}"
    line="${line//\\;/$'\002'}"
    local IFS=';'
    read -ra parts <<< "$line"
    for part in "${parts[@]}"; do
        [ -n "$part" ] || continue
        key="${part%%=*}"
        case ",$STAGING_EXCLUDED_KEYS," in *",$key,"*) continue ;; esac
        kept+=("$part")
    done
    [ "${#kept[@]}" -gt 0 ] || return 0
    local joined="${kept[*]}"
    joined="${joined//$'\001'/\\\\}"
    joined="${joined//$'\002'/\\;}"
    printf '%s\n' "$joined"
}
