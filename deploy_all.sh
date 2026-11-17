#!/usr/bin/env bash
# deploy_all.sh — put the version that was just pulled on the Pi into use: the dashboard, the
# settings the boards will need, the firmware of the cameras, and the relay. It only does what
# changed since the version that is running, and stops at the first thing that goes wrong.
#
# Run it on the Pi, in the repository, as the user who runs the relay (not as root: it asks for
# root by itself, for the dashboard copy only):
#
#   ./deploy_all.sh --branch=master [options]      pulls the branch itself, then deploys
#   git pull && ./deploy_all.sh [options]          or: you pull, it deploys
#
# The order is on purpose (the relay is the last): if a camera gets a bad firmware, the relay is
# still the old, working one, so you can still reach the camera and put the last good version back.
#
#   1. --run-tests    ./run_tests.sh (with --no-sketch-compile when no sketch changed); a failure
#                     stops everything before anything is touched
#   2. php/ changed   sudo ./deploy.sh
#   3. a sketch's settings_schema.h changed
#                     stage the settings on the relay (PUT /device-settings/<type>), from
#                     Arduino/templates/recorder.txt (recorder) or person.txt (detector) — the files
#                     you keep from your first flash; without the Wi-Fi, server, key and id lines.
#                     A board that lacks a new setting then fills it in by itself after the update
#   4. a sketch changed
#                     ./ota-deploy.sh <recorder|detector|all> --wait SECS: every camera of that
#                     type is updated and watched; one that does not come back stops the deploy
#   5. nodejs/ changed
#                     npm ci (if the packages changed), then POST /restart, then wait for the relay
#
# "Changed" is compared with the version that was last deployed (the revision in .deployed-rev,
# written at the end of a good run); the first time, with the version the Pi had before the pull:
# the one before --branch pulled, or else before your `git pull` (ORIG_HEAD). None of these: say
# which with --since REV, or deploy everything with --all.
#
# Usage:
#   ./deploy_all.sh [--branch=NAME] [--run-tests] [--dry-run] [--since REV | --all] [--wait SECS]
#
#   --branch=NAME   first bring this branch of origin in: fetch, check it out and fast-forward it
#                   (refused with uncommitted changes, or when the local branch has commits of its
#                   own); what changed between the version before and after is what is deployed.
#                   With --dry-run nothing is pulled: it compares with origin's copy of the branch
#   --run-tests     run ./run_tests.sh first (see 1.)
#   --dry-run       print what would be done; change nothing
#   --since REV     compare with this revision instead
#   --all           deploy every part, whatever changed
#   --wait SECS     how long ota-deploy.sh watches the cameras (default 600)
#
# Needs: git, curl, sudo (for the dashboard), npm (when the relay's packages changed) and what
# ota-deploy.sh needs. Settings: ota.conf (RELAY_URL, CONTROL_KEY; see ota.example.conf).
# Exit code: 0 deployed (or nothing to deploy), 1 a step failed, 2 wrong usage / missing setup.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/sketch_build_lib.sh
. "$ROOT_DIR/tools/sketch_build_lib.sh"
# shellcheck source=tools/deploy_plan_lib.sh
. "$ROOT_DIR/tools/deploy_plan_lib.sh"
cd "$ROOT_DIR" || exit 2

CONF="${OTA_CONF:-$ROOT_DIR/ota.conf}"
STATE_FILE="${DEPLOY_STATE_FILE:-$ROOT_DIR/.deployed-rev}"
SETTINGS_DIR="${DEPLOY_SETTINGS_DIR:-$ROOT_DIR/Arduino/templates}"
RELAY_WAIT_SECONDS="${DEPLOY_RELAY_WAIT:-90}"   # how long the relay may take to come back
RELAY_POLL_SECONDS="${DEPLOY_POLL_SECONDS:-2}"
REMOTE="${DEPLOY_REMOTE:-origin}"
RELAY_RESTART_PAUSE="${DEPLOY_RESTART_PAUSE:-5}" # lets the old process go before asking again
MAX_STAGED_BYTES=4000                            # the relay takes 4 kB

usage()       { sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die()         { echo "deploy_all: $*" >&2; exit 1; }
usage_error() { echo "deploy_all: $*" >&2; exit 2; }
heading()     { echo; echo "== $*"; }
dry_run_stop() { [ "$DRY_RUN" = 1 ] || return 1; echo "   (dry run: not done)"; }

# ── arguments ────────────────────────────────────────────────────────────
RUN_TESTS=0; DRY_RUN=0; ALL=0; SINCE=""; OTA_WAIT=600; BRANCH=""; BRANCH_GIVEN=0

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --run-tests) RUN_TESTS=1; shift ;;
            --dry-run)   DRY_RUN=1; shift ;;
            --all)       ALL=1; shift ;;
            --since)
                [ $# -ge 2 ] || usage_error "--since needs a revision"
                SINCE="$2"; shift 2 ;;
            --since=*)   SINCE="${1#--since=}"; shift ;;
            --branch)
                [ $# -ge 2 ] || usage_error "--branch needs a branch name"
                BRANCH="$2"; BRANCH_GIVEN=1; shift 2 ;;
            --branch=*)  BRANCH="${1#--branch=}"; BRANCH_GIVEN=1; shift ;;
            --wait)
                [ $# -ge 2 ] || usage_error "--wait needs a number of seconds"
                OTA_WAIT="$2"; shift 2 ;;
            --wait=*)    OTA_WAIT="${1#--wait=}"; shift ;;
            -h|--help)   usage; exit 0 ;;
            *) usage_error "unknown argument: $1 (try --help)" ;;
        esac
    done
    [[ "$OTA_WAIT" =~ ^[0-9]+$ ]] || usage_error "--wait must be a whole number of seconds (got: $OTA_WAIT)"
    [ "$ALL" = 1 ] && [ -n "$SINCE" ] && usage_error "--all and --since cannot be used together"
    if [ "$BRANCH_GIVEN" = 1 ]; then check_branch_name; fi
    return 0
}

# check_branch_name — BRANCH must be a plain branch name: it goes to git as an argument.
check_branch_name() {
    case "$BRANCH" in ""|-*) usage_error "--branch: not a branch name: '$BRANCH'" ;; esac
    git check-ref-format "refs/heads/$BRANCH" 2>/dev/null || usage_error "--branch: not a branch name: '$BRANCH'"
}

# ── what changed ─────────────────────────────────────────────────────────
BASE=""; BASE_SOURCE=""; PRE_PULL_HEAD=""; TARGET_REV=""

commit_of() { git rev-parse --verify --quiet "$1^{commit}"; }   # commit_of REF: the commit, or nothing

# check_since — a bad --since is found before anything is pulled.
check_since() {
    [ -n "$SINCE" ] || return 0
    case "$SINCE" in -*) usage_error "--since: not a revision: $SINCE" ;; esac
    commit_of "$SINCE" >/dev/null || usage_error "not a revision of this repository: $SINCE"
}

# checkout_branch — the local branch (made from origin's if it does not exist yet), moved forward to
# origin's. A local branch with commits of its own is NOT touched: that is somebody's work, and the
# check comes before the checkout, so a refusal leaves the Pi on the branch it was on.
checkout_branch() {
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        git merge-base --is-ancestor "refs/heads/$BRANCH" "refs/remotes/$REMOTE/$BRANCH" \
            || die "$BRANCH has commits that $REMOTE/$BRANCH has not: it cannot be fast-forwarded - sort that out by hand"
        git checkout --quiet "$BRANCH" || die "could not check out $BRANCH"
        git merge --ff-only --quiet "$REMOTE/$BRANCH" || die "could not fast-forward $BRANCH"
        return 0
    fi
    git checkout --quiet -b "$BRANCH" --track "$REMOTE/$BRANCH" || die "could not make the local branch $BRANCH"
}

# pull_branch — --branch: bring the branch in. Remembers the version before (PRE_PULL_HEAD), which is
# what "changed" is compared with when no deploy was recorded. In a dry run nothing but the remote
# copy is fetched, and the plan is made against that (TARGET_REV).
pull_branch() {
    local after
    [ -n "$BRANCH" ] || return 0
    heading "Pull $REMOTE/$BRANCH"
    PRE_PULL_HEAD="$(git rev-parse HEAD)" || die "this is not a git checkout"
    if [ "$DRY_RUN" != 1 ]; then
        tree_is_clean || die "uncommitted changes: commit or stash them before --branch pulls"
    fi
    git fetch --quiet "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" \
        || die "could not fetch $BRANCH from $REMOTE"
    if [ "$DRY_RUN" = 1 ]; then
        TARGET_REV="$(commit_of "refs/remotes/$REMOTE/$BRANCH")" || die "$REMOTE has no branch $BRANCH"
        echo "   (dry run: not pulled; comparing with $REMOTE/$BRANCH at ${TARGET_REV:0:12})"
        return 0
    fi
    checkout_branch
    after="$(git rev-parse HEAD)"
    if [ "$after" = "$PRE_PULL_HEAD" ]; then echo "   $BRANCH is up to date at ${after:0:12}"
    else echo "   $BRANCH: ${PRE_PULL_HEAD:0:12} -> ${after:0:12}"; fi
}

# resolve_baseline — sets BASE (a commit) and BASE_SOURCE: the version to compare with.
resolve_baseline() {
    local candidate=""
    if [ "$ALL" = 1 ]; then BASE_SOURCE="--all"; return 0; fi
    if [ -n "$SINCE" ]; then
        candidate="$SINCE"; BASE_SOURCE="--since"
    elif [ -s "$STATE_FILE" ]; then
        candidate="$(head -n 1 "$STATE_FILE")"; BASE_SOURCE="the last deploy ($(basename "$STATE_FILE"))"
    elif [ -n "$PRE_PULL_HEAD" ]; then
        candidate="$PRE_PULL_HEAD"; BASE_SOURCE="the version before the pull"
    elif git rev-parse --verify --quiet ORIG_HEAD >/dev/null; then
        candidate="ORIG_HEAD"; BASE_SOURCE="the version before the last git pull (ORIG_HEAD)"
    else
        usage_error "do not know what is deployed on this Pi: say with --since REV, or deploy everything with --all"
    fi
    BASE="$(commit_of "$candidate")" \
        || usage_error "not a revision of this repository: $candidate"
}

# load_plan — fills the plan (tools/deploy_plan_lib.sh) from the files that differ between BASE and
# what is checked out (or, in a --branch dry run, the remote's branch).
load_plan() {
    local paths
    plan_reset
    if [ "$ALL" = 1 ]; then plan_everything; return 0; fi
    # (no TARGET_REV: the working tree, committed or not: ota-deploy.sh builds the tree too)
    paths="$(git -c core.quotepath=off diff --name-only --relative "$BASE" ${TARGET_REV:+"$TARGET_REV"} --)" \
        || die "git diff against ${BASE:0:12} failed"
    plan_from_paths <<< "$paths"
}

print_plan() {
    heading "Deploy plan"
    if [ "$ALL" = 1 ]; then echo "   everything (--all)"; else echo "   compared with ${BASE:0:12}, ${BASE_SOURCE}"; fi
    echo "   to deploy: $(plan_summary)"
    [ "$DRY_RUN" = 1 ] && echo "   DRY RUN: nothing will be changed"
    return 0
}

tree_is_clean() { [ -z "$(git status --porcelain --untracked-files=no)" ]; }

# record_deployed — the next run compares with this revision. Not for a dirty tree: what is
# running is then not any revision.
record_deployed() {
    local head tmp
    dry_run_stop && return 0
    if ! tree_is_clean; then
        echo "   (uncommitted changes: this deploy is not recorded as a revision)"
        return 0
    fi
    head="$(git rev-parse HEAD)" || return 1
    tmp="$STATE_FILE.tmp"
    printf '%s\n' "$head" > "$tmp" && mv "$tmp" "$STATE_FILE" || die "could not write $STATE_FILE"
    echo "   recorded ${head:0:12} as deployed"
}

# ── before anything is touched ───────────────────────────────────────────
RELAY_URL=""; CONTROL_KEY=""
TMP=""

need_relay() { [ "$PLAN_RELAY" = 1 ] || plan_has_firmware; }

load_relay_conf() {
    [ -f "$CONF" ] || usage_error "no $CONF - copy ota.example.conf to ota.conf and fill it in"
    # shellcheck disable=SC1090
    . "$CONF"
    [ -n "$RELAY_URL" ]   || usage_error "RELAY_URL is not set in $CONF"
    [ -n "$CONTROL_KEY" ] || usage_error "CONTROL_KEY is not set in $CONF"
    RELAY_URL="${RELAY_URL%/}"
}

# settings_file_for TYPE — the template to stage for that type.
settings_file_for() {
    local name
    name="$(settings_template_name "$1")" || return 1
    echo "$SETTINGS_DIR/$name"
}

# staged_line_for TYPE — what is to be staged for that type (may be empty). Fails with a reason
# on stderr if the template is not usable.
staged_line_for() {
    local file lines line
    file="$(settings_file_for "$1")" || return 1
    [ -f "$file" ] || { echo "the settings of the $1 are not in $file" >&2; return 1; }
    lines="$(grep -c . "$file")"
    [ "$lines" -eq 1 ] || { echo "$file must hold ONE line of KEY=value;KEY=value (it has $lines)" >&2; return 1; }
    line="$(staged_line_from_template < "$file")"
    [ "${#line}" -le "$MAX_STAGED_BYTES" ] || { echo "the settings staged for the $1 are longer than $MAX_STAGED_BYTES bytes" >&2; return 1; }
    printf '%s' "$line"
}

# preflight — every input is checked before the first step runs, so a missing file does not
# leave a deploy half done.
preflight() {
    local t tool
    for tool in git curl; do
        command -v "$tool" >/dev/null 2>&1 || usage_error "$tool not found on PATH"
    done
    if [ "$PLAN_RELAY_DEPS" = 1 ] && ! command -v npm >/dev/null 2>&1; then usage_error "npm not found on PATH"; fi
    if [ "$PLAN_PHP" = 1 ] && [ ! -f "$ROOT_DIR/deploy.sh" ]; then usage_error "deploy.sh is missing"; fi
    if need_relay; then load_relay_conf; fi
    for t in $SKETCH_TYPES; do
        [ "${PLAN_SETTINGS[$t]:-0}" = 1 ] || continue
        staged_line_for "$t" > /dev/null || usage_error "cannot stage the settings (see above): put your $t settings in $(settings_file_for "$t")"
    done
    return 0
}

acquire_lock() {
    command -v flock >/dev/null 2>&1 || return 0
    exec 9> "$ROOT_DIR/.deploy_all.lock"
    flock -n 9 || die "another deploy_all.sh is running"
}

setup_relay_calls() {
    need_relay || return 0
    TMP="$(mktemp -d)" || die "could not make a temporary folder"
    trap 'rm -rf "$TMP"' EXIT
    trap 'exit 130' INT TERM
    # The key goes into a header file (mode 600), not onto curl's command line where `ps` shows it.
    # The strict umask is for that one file only (a subshell): set here for the whole script it was
    # inherited by `sudo ./deploy.sh`, which then made every NEW file of the web folder 600 and every
    # new folder 700 — unreadable by Apache — and by ota-deploy.sh and run_tests.sh.
    ( umask 077 && printf 'X-Control-Key: %s\n' "$CONTROL_KEY" > "$TMP/control-header" ) \
        || die "could not write the control key file in $TMP"
}

# relay_call METHOD PATH [curl args...] — prints the HTTP status (000: no answer); the body is in $TMP/reply.
relay_call() {
    local method="$1" path="$2"
    shift 2
    curl -sS --max-time 20 -o "$TMP/reply" -w '%{http_code}' -X "$method" \
        -H "@$TMP/control-header" "$@" "$RELAY_URL$path" 2>"$TMP/curl.err" || true
}

# reply_text — what the relay said, one short line.
reply_text() { { head -c 300 "$TMP/reply" 2>/dev/null; head -c 300 "$TMP/curl.err" 2>/dev/null; } | tr '\n' ' '; }

# ── the steps ────────────────────────────────────────────────────────────

step_tests() {
    local args=()
    [ "$RUN_TESTS" = 1 ] || return 0
    plan_has_firmware || args+=(--no-sketch-compile)
    heading "Running the tests (./run_tests.sh ${args[*]:-})"
    dry_run_stop && return 0
    ./run_tests.sh "${args[@]}" || { echo "deploy_all: the tests failed - nothing was deployed" >&2; return 1; }
}

step_php() {
    [ "$PLAN_PHP" = 1 ] || return 0
    heading "Dashboard (sudo ./deploy.sh)"
    dry_run_stop && return 0
    if [ "$(id -u)" -eq 0 ]; then ./deploy.sh; else sudo ./deploy.sh; fi \
        || { echo "deploy_all: deploy.sh failed" >&2; return 1; }
}

# stage_settings TYPE
stage_settings() {
    local t="$1" line code
    line="$(staged_line_for "$t")" || return 1
    # An empty body would REMOVE what is staged, so nothing is sent when nothing is left.
    if [ -z "$line" ]; then echo "   $t: nothing to stage (only settings that belong to one board)"; return 0; fi
    code="$(relay_call PUT "/device-settings/$t" -H 'Content-Type: text/plain' --data-binary "$line")"
    [ "$code" = 200 ] || { echo "deploy_all: staging the $t settings failed (HTTP $code): $(reply_text)" >&2; return 1; }
    echo "   $t: staged $(printf '%s' "$line" | tr ';' '\n' | wc -l | tr -d ' ') settings on the relay"
}

step_settings() {
    local t any=0
    for t in $SKETCH_TYPES; do [ "${PLAN_SETTINGS[$t]:-0}" = 1 ] && any=1; done
    [ "$any" = 1 ] || return 0
    heading "Settings for the boards (staged on the relay, before the firmware)"
    dry_run_stop && return 0
    for t in $SKETCH_TYPES; do
        [ "${PLAN_SETTINGS[$t]:-0}" = 1 ] || continue
        stage_settings "$t" || return 1
    done
}

print_rollback_hint() {
    echo >&2
    echo "deploy_all: the firmware is NOT in place everywhere. The relay was not restarted. To put the" >&2
    echo "            version that ran before back on the cameras:" >&2
    echo "              git checkout ${BASE:0:12} && ./ota-deploy.sh $1 --wait $OTA_WAIT" >&2
    echo "            (then git checkout back to your branch)" >&2
}

step_firmware() {
    local target
    plan_has_firmware || return 0
    heading "Firmware (./ota-deploy.sh, every camera of the type is updated and watched)"
    dry_run_stop && return 0
    while IFS= read -r target; do
        echo "   -> $target"
        ./ota-deploy.sh "$target" --wait "$OTA_WAIT" && continue
        print_rollback_hint "$target"
        return 1
    done < <(plan_ota_targets)
}

wait_for_relay() {
    local deadline=$((SECONDS + RELAY_WAIT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -sf --max-time 5 -H "@$TMP/control-header" -o /dev/null "$RELAY_URL/ota/status"; then return 0; fi
        sleep "$RELAY_POLL_SECONDS"
    done
    return 1
}

step_relay() {
    local code
    [ "$PLAN_RELAY" = 1 ] || return 0
    heading "Relay (restart to run the new nodejs code)"
    dry_run_stop && return 0
    if [ "$PLAN_RELAY_DEPS" = 1 ]; then
        echo "   the relay's packages changed: npm ci"
        (cd "$ROOT_DIR/nodejs/camera-relay" && npm ci) || { echo "deploy_all: npm ci failed - the relay was not restarted" >&2; return 1; }
    fi
    code="$(relay_call POST /restart)"
    [ "$code" = 202 ] || { echo "deploy_all: the relay did not accept the restart (HTTP $code): $(reply_text)" >&2; return 1; }
    sleep "$RELAY_RESTART_PAUSE"
    wait_for_relay || { echo "deploy_all: the relay did not answer within ${RELAY_WAIT_SECONDS}s after the restart - look at: journalctl -u camrelay" >&2; return 1; }
    echo "   the relay is back"
}

# ── main ─────────────────────────────────────────────────────────────────
main() {
    parse_args "$@"
    acquire_lock
    check_since
    pull_branch
    resolve_baseline
    load_plan
    print_plan
    if plan_is_empty; then
        echo "   nothing to do"
        record_deployed
        return 0
    fi
    preflight
    setup_relay_calls
    step_tests    || return 1
    step_php      || return 1
    step_settings || return 1
    step_firmware || return 1
    step_relay    || return 1
    heading "Done"
    record_deployed
}

main "$@"
