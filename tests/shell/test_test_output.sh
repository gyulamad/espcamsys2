#!/bin/bash
# test_test_output.sh — tools/test_output.sh, which decides how much of a test run's output is shown
# (run_tests.sh --verbose 0|1|2), and the checking of that option in run_tests.sh. Proven with a fake
# test run that prints every kind of line:
#   - level 2 is the command as it is: every line, nothing in between
#   - level 1 turns each passed test case ("[PASS] ...", and the "ok" of run_tests.sh's own checks) into a dot
#     and shows all the rest, the failed test cases in full
#   - level 0 does the same and leaves the summaries of suites with no failure out as well (the titles of the
#     groups are the command's own lines: run_tests.sh prints them at level 1 and 2 only)
#   - at every level a failure, a crash, a SKIP or any other line that is not a pass is shown, in the order it
#     was written (stdout and stderr together), and the command's exit code is the tool's
#   - a long run of dots is wrapped; a wrong level or no command runs nothing and exits 2
#   - run_tests.sh refuses a wrong --verbose level (exit 2) and its --help explains the option
# Usage: tests/shell/test_test_output.sh      Exit code: 0 if all pass.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOL="$ROOT/tools/test_output.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}
same() {   # same "name" "expected" "actual"
    if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1; echo "  expected: $(printf '%q' "$2")"; echo "  actual:   $(printf '%q' "$3")"; fi
}

# ── the fake test run ────────────────────────────────────────────────────
cat > "$TMP/run.sh" <<'EOF'
#!/bin/bash
echo "------------------------------------------------------------"
echo "Node.js tests"
echo "-- test_a.js"
echo "[PASS] adds numbers"
echo "[PASS] ...and subtracts"
echo "[FAIL] multiplies -- expected 6 got 5" >&2
echo "[PASS] divides"
echo
echo "3 passed, 1 failed"
echo "-- test_b.js"
echo "[PASS] clean one"
echo
echo "1 passed, 0 failed"
echo "--- a check of the script"
echo "ok (2 copies)"
echo "SKIP: jsdom is not installed"
echo "Error: boom" >&2
echo "    at crash (file.js:1:1)" >&2
echo "a line with [PASS] in the middle"
exit "${FAKE_EXIT:-0}"
EOF
chmod +x "$TMP/run.sh"

run() { "$TOOL" "$@" 2>&1; }   # what a person sees: both streams

full="$("$TMP/run.sh" 2>&1)"

# ── level 2: as it is ────────────────────────────────────────────────────
same "level 2 shows everything exactly as the command prints it" "$full" "$(run 2 "$TMP/run.sh")"

# ── level 1 ──────────────────────────────────────────────────────────────
expected1='------------------------------------------------------------
Node.js tests
-- test_a.js
..
[FAIL] multiplies -- expected 6 got 5
.

3 passed, 1 failed
-- test_b.js
.

1 passed, 0 failed
--- a check of the script
.
SKIP: jsdom is not installed
Error: boom
    at crash (file.js:1:1)
a line with [PASS] in the middle'
same "level 1: a dot for each pass, the group text, the failure, and every other line in full" "$expected1" "$(run 1 "$TMP/run.sh")"

# ── level 0 ──────────────────────────────────────────────────────────────
expected0='------------------------------------------------------------
Node.js tests
-- test_a.js
..
[FAIL] multiplies -- expected 6 got 5
.

3 passed, 1 failed
-- test_b.js
.
--- a check of the script
.
SKIP: jsdom is not installed
Error: boom
    at crash (file.js:1:1)
a line with [PASS] in the middle'
same "level 0: as level 1, but the summary of a suite with no failure (and its empty line) is left out" "$expected0" "$(run 0 "$TMP/run.sh")"

# ── the same, from a command that only prints what level 0 shows ─────────
cat > "$TMP/quiet.sh" <<'EOF'
#!/bin/bash
echo "[PASS] a"; echo "[PASS] b"; echo; echo "2 passed, 0 failed"; echo "[PASS] c"
EOF
chmod +x "$TMP/quiet.sh"
same "level 0 of a run with no failure is only dots" "$(printf '...')" "$(run 0 "$TMP/quiet.sh")"

# ── exit codes ───────────────────────────────────────────────────────────
for level in 0 1 2; do
    FAKE_EXIT=0 "$TOOL" "$level" "$TMP/run.sh" >/dev/null 2>&1; code0=$?
    FAKE_EXIT=3 "$TOOL" "$level" "$TMP/run.sh" >/dev/null 2>&1; code3=$?
    same "level $level: the exit code is the command's (0 and 3)" "0 3" "$code0 $code3"
done

# ── stdout and stderr keep their order ───────────────────────────────────
cat > "$TMP/order.sh" <<'EOF'
#!/bin/bash
for i in 1 2 3 4 5 6; do echo "out $i"; echo "err $i" >&2; done
EOF
chmod +x "$TMP/order.sh"
same "the two streams come out in the order they were written" "out 1
err 1
out 2
err 2
out 3
err 3
out 4
err 4
out 5
err 5
out 6
err 6" "$(run 0 "$TMP/order.sh")"

# ── a failure is never hidden: no newline at the end, the last line is kept ─
same "a last line without a newline is not lost" "x" "$(run 0 printf x)"

# ── wrapping ─────────────────────────────────────────────────────────────
cat > "$TMP/many.sh" <<'EOF'
#!/bin/bash
for i in $(seq 1 200); do echo "[PASS] t$i"; done
EOF
chmod +x "$TMP/many.sh"
widths="$(run 0 "$TMP/many.sh" | awk '{ printf "%d ", length($0) }')"
same "200 dots are wrapped at 80 to a line" "80 80 40 " "$widths"

# ── usage ────────────────────────────────────────────────────────────────
rm -f "$TMP/ran"
for bad in 3 -1 x "" 01; do
    "$TOOL" "$bad" touch "$TMP/ran" >/dev/null 2>&1; code=$?
    same "level '$bad' is refused (exit 2) and the command does not run" "2 no" "$code $([ -e "$TMP/ran" ] && echo yes || echo no)"
done
"$TOOL" 0 >/dev/null 2>&1; code=$?
same "no command is refused (exit 2)" "2" "$code"
"$TOOL" >/dev/null 2>&1; code=$?
same "no arguments is refused (exit 2)" "2" "$code"
"$TOOL" 0 "$TMP/does-not-exist" >/dev/null 2>&1; code=$?
same "a command that cannot be run fails the way bash says (127)" "127" "$code"

# ── run_tests.sh --verbose ───────────────────────────────────────────────
for bad in "--verbose=3" "--verbose=" "--verbose=x" "--verbose 3" "--verbose=-1"; do
    # shellcheck disable=SC2086
    out="$("$ROOT/run_tests.sh" $bad 2>&1)"; code=$?
    same "run_tests.sh $bad is refused (exit 2) before anything runs" "2 --verbose level must be 0, 1 or 2" "$code ${out%% (got*}"
done
out="$("$ROOT/run_tests.sh" --verbose abc 2>&1)"; code=$?
same "run_tests.sh --verbose abc: the word is an unknown argument (exit 2)" "2 unknown argument: abc (try --help)" "$code $out"
help="$("$ROOT/run_tests.sh" --help)"
for word in "--verbose" "--verbose=N" "a dot for every passed test case"; do
    case "$help" in *"$word"*) check "--help explains: $word" 0 ;; *) check "--help explains: $word" 1 ;; esac
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
