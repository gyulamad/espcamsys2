#!/usr/bin/env bash
# test_source_checks.sh — the helpers of the tests that read the sources (tests/shell/lib/source_checks.sh).
#
# test_security_patches.sh is worth something only if its helpers FAIL when they should, so this proves it on
# a throwaway folder: a pattern that is there and one that is not, for sc_has and for sc_lacks; a file that
# does not exist and a pattern grep cannot use (both must FAIL, sc_lacks included: an error must never look
# like "nothing found"); extended-regex syntax; a pattern that starts with "-"; the group name in front of
# the check names; the counts, the summary line and the exit status; and that sc_init starts over.
# Usage: tests/shell/test_source_checks.sh      Exit code: 0 if all pass.

set -uo pipefail
# shellcheck source-path=SCRIPTDIR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/tests/shell/lib/source_checks.sh"
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}

FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
printf '%s\n' 'alpha (beta)' 'gamma' '--dash' > "$FIXTURE/sample.txt"

# run_helpers COMMAND...: the commands run in a fresh shell on the fixture, then sc_summary; prints what they
# print and returns the exit status of sc_summary
run_helpers() {
    (
        # shellcheck source=lib/source_checks.sh
        source "$LIB"
        sc_init "$FIXTURE"
        "$@"
        sc_summary
    )
}

# verdict NAME LINE EXIT HELPER ARGS...: one check of a helper must print a line containing LINE and end the
# run with exit status EXIT
verdict() {
    local name="$1" line="$2" want="$3" out status
    shift 3
    out="$(run_helpers "$@")"
    status=$?
    check "$name" "$(printf '%s\n' "$out" | grep -qF -- "$line" && [ "$status" -eq "$want" ] && echo 0 || echo 1)"
}

# ── sc_has ───────────────────────────────────────────────────────────────
verdict "sc_has passes when a line matches" \
    "[PASS] it is there" 0 sc_has sample.txt 'gamma' "it is there"
verdict "sc_has fails when no line matches, and says where it looked for what" \
    "[FAIL] it is not there (not found in sample.txt: omega)" 1 sc_has sample.txt 'omega' "it is not there"

# ── sc_lacks ─────────────────────────────────────────────────────────────
verdict "sc_lacks passes when no line matches" \
    "[PASS] it is gone" 0 sc_lacks sample.txt 'omega' "it is gone"
verdict "sc_lacks fails when a line matches, and says so" \
    "[FAIL] it is back (must not be in sample.txt: gamma)" 1 sc_lacks sample.txt 'gamma' "it is back"

# ── a check that cannot be made fails — both ways ────────────────────────
verdict "sc_has fails on a file that does not exist" \
    "[FAIL] t (file not found: nope.txt)" 1 sc_has nope.txt 'gamma' "t"
verdict "sc_lacks fails on a file that does not exist (it does not pass for 'nothing found')" \
    "[FAIL] t (file not found: nope.txt)" 1 sc_lacks nope.txt 'gamma' "t"
verdict "sc_has fails on a pattern grep cannot use" \
    "[FAIL] t (cannot search sample.txt for: (gamma)" 1 sc_has sample.txt '(gamma' "t"
verdict "sc_lacks fails on a pattern grep cannot use (it does not pass for 'nothing found')" \
    "[FAIL] t (cannot search sample.txt for: (gamma)" 1 sc_lacks sample.txt '(gamma' "t"
verdict "a directory is not a file to search" \
    "[FAIL] t (file not found: .)" 1 sc_lacks . 'gamma' "t"

# ── the pattern ──────────────────────────────────────────────────────────
verdict "the pattern is an extended regex: alternation" \
    "[PASS] t" 0 sc_has sample.txt 'omega|gamma' "t"
verdict "the pattern is an extended regex: escaped brackets match the brackets themselves" \
    "[PASS] t" 0 sc_has sample.txt 'alpha \(beta\)' "t"
verdict "the pattern is an extended regex: an unescaped group matches its content, not the brackets" \
    "[FAIL] t (not found in sample.txt: alpha (beta))" 1 sc_has sample.txt 'alpha (beta)' "t"
verdict "a pattern that starts with '-' is a pattern, not an option (sc_has)" \
    "[PASS] t" 0 sc_has sample.txt '--dash' "t"
verdict "a pattern that starts with '-' is a pattern, not an option (sc_lacks)" \
    "[FAIL] t (must not be in sample.txt: --dash)" 1 sc_lacks sample.txt '--dash' "t"

# ── group, counts, summary, exit status ──────────────────────────────────
out="$(run_helpers true)"
status=$?
check "no checks: '0 passed, 0 failed', exit status 0" \
    "$(printf '%s\n' "$out" | grep -qx '0 passed, 0 failed' && [ "$status" -eq 0 ] && echo 0 || echo 1)"

out="$(
    # shellcheck source=lib/source_checks.sh
    source "$LIB"
    sc_init "$FIXTURE"
    sc_group "patch 9"
    sc_has sample.txt gamma "named"
    sc_lacks sample.txt gamma "named too"
    sc_summary
)"
status=$?
check "the group name is in front of the check names (passed and failed)" \
    "$(printf '%s\n' "$out" | grep -qxF '[PASS] patch 9: named' && printf '%s\n' "$out" | grep -qF '[FAIL] patch 9: named too' && echo 0 || echo 1)"
check "a passed and a failed check: '1 passed, 1 failed', exit status 1" \
    "$(printf '%s\n' "$out" | grep -qx '1 passed, 1 failed' && [ "$status" -eq 1 ] && echo 0 || echo 1)"

out="$(
    # shellcheck source=lib/source_checks.sh
    source "$LIB"
    sc_init "$FIXTURE"
    sc_group "patch 9"
    sc_lacks sample.txt gamma "old"
    sc_init "$FIXTURE"
    sc_has sample.txt gamma "new"
    sc_summary
)"
status=$?
check "sc_init starts over: no earlier count and no group name" \
    "$(printf '%s\n' "$out" | grep -qx '1 passed, 0 failed' && printf '%s\n' "$out" | grep -qxF '[PASS] new' && [ "$status" -eq 0 ] && echo 0 || echo 1)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
