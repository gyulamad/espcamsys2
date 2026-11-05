#!/usr/bin/env bash
# test_output.sh — runs a command and shows its test output at the chosen verbosity (run_tests.sh --verbose).
#
# Usage:
#   tools/test_output.sh LEVEL COMMAND [ARGS...]
#
# LEVEL (0, 1 or 2):
#   2  everything, exactly as the command prints it (the command is simply run, nothing in between)
#   1  a "." for every passed test case instead of its "[PASS] ..." line; everything else in full
#   0  as 1, and the summaries of the suites with no failure are left out too
# The titles of the groups (a suite, a test file) are the command's own lines: run_tests.sh prints them
# at level 1 and 2 only, so at level 0 there are the dots and the failures.
#
# The command's stdout and stderr are shown in the order they were written, and the exit code is the
# command's own. Every line that is not a passed test case or the summary of a suite with no failure is
# shown at every level, so a crash, a stack trace, a SKIP or an "ok: coverage ..." gate result is never
# hidden. What counts as what (the test frameworks of this repo all print the same):
#   "[PASS] text"                  a passed test case
#   "ok", "ok (text)"              a passed check of run_tests.sh itself
#   "N passed, 0 failed"           the summary of a suite with no failure (hidden at level 0 with the empty
#                                  line before it; with a failure it is shown, it is a failing suite's tally)
#   "[FAIL] text"                  a failed test case: shown at every level
#
# Exit code: the command's; 2 for wrong usage.

set -uo pipefail

DOTS_PER_LINE=80    # a long run is wrapped, so no line of a log file grows to thousands of characters

LEVEL=""
dots_on_line=0       # dots printed on the current output line
blank_held=0         # an empty line waits to see whether the line after it is shown (level 0)

# ── Output ───────────────────────────────────────────────────────────────

# Ends the line of dots, if there is one, so that the next text starts on a line of its own.
end_dots() {
    [ "$dots_on_line" -eq 0 ] && return 0
    printf '\n'
    dots_on_line=0
}

show_line() {
    end_dots
    if [ "$blank_held" -eq 1 ]; then
        printf '\n'
        blank_held=0
    fi
    printf '%s\n' "$1"
}

show_dot() {
    blank_held=0
    printf '.'
    dots_on_line=$((dots_on_line + 1))
    [ "$dots_on_line" -lt "$DOTS_PER_LINE" ] && return 0
    printf '\n'
    dots_on_line=0
}

# ── What a line is ───────────────────────────────────────────────────────

is_pass_line() {
    [[ "$1" == '[PASS]'* ]] && return 0
    [[ "$1" == 'ok' || "$1" == 'ok ('*')' ]] && return 0
    return 1
}

is_clean_summary() {
    [[ "$1" =~ ^[0-9]+\ passed,\ 0\ failed$ ]]
}

handle_line() {
    local line="$1"
    if is_pass_line "$line"; then
        [ "$LEVEL" -eq 2 ] && { show_line "$line"; return 0; }
        show_dot
        return 0
    fi
    if [ "$LEVEL" -eq 0 ] && is_clean_summary "$line"; then
        blank_held=0
        return 0
    fi
    if [ "$LEVEL" -eq 0 ] && [ -z "$line" ]; then
        blank_held=1
        return 0
    fi
    show_line "$line"
}

filter_stream() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
        handle_line "$line"
    done
    end_dots
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
    if [ $# -lt 2 ] || ! [[ "$1" =~ ^[012]$ ]]; then
        echo "usage: $0 LEVEL COMMAND [ARGS...]   (LEVEL is 0, 1 or 2)" >&2
        return 2
    fi
    LEVEL="$1"
    shift

    # Level 2 is the command as it is: no pipe, no tool in between.
    [ "$LEVEL" -eq 2 ] && exec "$@"

    "$@" 2>&1 | filter_stream
    return "${PIPESTATUS[0]}"
}

main "$@"
exit $?
