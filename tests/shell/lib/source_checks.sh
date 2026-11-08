#!/usr/bin/env bash
# source_checks.sh — helpers for tests that check what the source files do (or do not) contain.
# Sourced by the tests in tests/shell/, never run by itself. It is tested by tests/shell/test_source_checks.sh.
#
#   sc_init ROOT               start counting; the file names below are relative to ROOT
#   sc_group TEXT              put "TEXT: " in front of the names of the checks that follow
#   sc_has   FILE REGEX TEXT   passes if a line of FILE matches REGEX (grep -E)
#   sc_lacks FILE REGEX TEXT   passes if no line of FILE matches REGEX
#   sc_summary                 prints "N passed, M failed"; exit status 0 only if nothing failed
#
# They print "[PASS] ..." / "[FAIL] ..." lines like the other tests (tools/test_output.sh turns the passed
# ones into dots). A check that cannot be made FAILS — the file is missing, or grep cannot use REGEX or read
# the file — and that holds for sc_lacks too: an error must never look like "nothing found".

SC_ROOT=""
SC_GROUP=""
SC_PASSED=0
SC_FAILED=0

sc_init() {
    SC_ROOT="$1"
    SC_GROUP=""
    SC_PASSED=0
    SC_FAILED=0
}

sc_group() {
    SC_GROUP="$1: "
}

sc_pass() {
    SC_PASSED=$((SC_PASSED + 1))
    echo "[PASS] $SC_GROUP$1"
}

sc_fail() {
    SC_FAILED=$((SC_FAILED + 1))
    echo "[FAIL] $SC_GROUP$1"
}

# sc_search FILE REGEX — exit status: 0 a line matches, 1 no line matches,
#                        2 FILE does not exist, 3 grep itself failed (REGEX it cannot use, FILE it cannot read)
sc_search() {
    local path="$SC_ROOT/$1"
    [ -f "$path" ] || return 2
    grep -qE -- "$2" "$path" 2>/dev/null
    local status=$?
    [ "$status" -le 1 ] && return "$status"
    return 3
}

# Why a search could not be made, for the text of the failure: sc_why_not CODE FILE REGEX
sc_why_not() {
    [ "$1" -eq 2 ] && { echo "file not found: $2"; return 0; }
    echo "cannot search $2 for: $3"
}

sc_has() {
    local file="$1" regex="$2" text="$3" status
    sc_search "$file" "$regex"
    status=$?
    case "$status" in
        0) sc_pass "$text" ;;
        1) sc_fail "$text (not found in $file: $regex)" ;;
        *) sc_fail "$text ($(sc_why_not "$status" "$file" "$regex"))" ;;
    esac
}

sc_lacks() {
    local file="$1" regex="$2" text="$3" status
    sc_search "$file" "$regex"
    status=$?
    case "$status" in
        0) sc_fail "$text (must not be in $file: $regex)" ;;
        1) sc_pass "$text" ;;
        *) sc_fail "$text ($(sc_why_not "$status" "$file" "$regex"))" ;;
    esac
}

sc_summary() {
    echo
    echo "$SC_PASSED passed, $SC_FAILED failed"
    [ "$SC_FAILED" -eq 0 ]
}
