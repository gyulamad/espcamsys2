#!/bin/bash
# test_camdash_power.sh — the privileged helper the dashboard's reset menu uses (tools/camdash-power.sh)
# and its sudo rule (apache/camdash-power.sudoers). Runs nothing privileged: the helper's --print mode
# only shows the command it would schedule.
#
# Checks: exactly two actions work; everything else (nothing, unknown, two words, odd characters,
# --print without an action) is refused with exit 2; the environment cannot change what it runs; the sudo
# rule allows the same two commands as the helper and the dashboard's PHP know, with no wildcard and no
# other command, and (when visudo is installed) is valid.
# Usage: tests/shell/test_camdash_power.sh      Exit code: 0 if all pass.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$ROOT/tools/camdash-power.sh"
SUDOERS="$ROOT/apache/camdash-power.sudoers"
pass=0; fail=0
check() {   # check "name" <condition exit code>
    if [ "$2" -eq 0 ]; then pass=$((pass + 1)); echo "[PASS] $1"; else fail=$((fail + 1)); echo "[FAIL] $1"; fi
}

out=$("$HELPER" --print restart-php); rc=$?
check "restart-php schedules a delayed apache2 restart" $([ $rc -eq 0 ] && [ "$out" = "systemd-run --quiet --on-active=3 --unit=camdash-power-restart-php /bin/systemctl restart apache2" ] && echo 0 || echo 1)
out=$("$HELPER" --print reboot); rc=$?
check "reboot schedules a delayed reboot" $([ $rc -eq 0 ] && [ "$out" = "systemd-run --quiet --on-active=3 --unit=camdash-power-reboot /bin/systemctl reboot" ] && echo 0 || echo 1)

for bad in "" "bogus" "REBOOT" "reboot now" "reboot;id" '$(id)' "restart-php reboot" "--print" "-h" "../reboot"; do
    # shellcheck disable=SC2086
    if [ -z "$bad" ]; then "$HELPER" >/dev/null 2>&1; else "$HELPER" $bad >/dev/null 2>&1; fi
    rc=$?
    # "reboot now" etc. arrive as two words, "--print" alone has no action: all exit 2 and run nothing
    check "refused (exit 2): '$bad'" $([ $rc -eq 2 ] && echo 0 || echo 1)
done
"$HELPER" "reboot now" >/dev/null 2>&1; rc=$?
check "one argument containing a space is refused (exit 2)" $([ $rc -eq 2 ] && echo 0 || echo 1)
"$HELPER" --print >/dev/null 2>&1; rc=$?
check "--print without an action is refused (exit 2)" $([ $rc -eq 2 ] && echo 0 || echo 1)
"$HELPER" --print reboot extra >/dev/null 2>&1; rc=$?
check "an extra argument is refused (exit 2)" $([ $rc -eq 2 ] && echo 0 || echo 1)

out=$(PATH=/nonexistent SYSTEMD_RUN=/bin/false DELAY=999 "$HELPER" --print reboot)
check "the environment (PATH, DELAY, ...) does not change what it runs" $([ "$out" = "systemd-run --quiet --on-active=3 --unit=camdash-power-reboot /bin/systemctl reboot" ] && echo 0 || echo 1)

rules=$(grep -v '^[[:space:]]*#' "$SUDOERS" | grep -v '^[[:space:]]*$')
check "the sudo rule is one line" $([ "$(echo "$rules" | wc -l)" -eq 1 ] && echo 0 || echo 1)
check "...for the web server's user, as root, with no password prompt available (NOPASSWD only for these)" $(echo "$rules" | grep -q '^www-data ALL=(root) NOPASSWD: ' && echo 0 || echo 1)
cmds=$(echo "$rules" | sed 's/^[^:]*: //' | tr ',' '\n' | sed 's/^ *//')
check "...allowing exactly the two helper commands" $([ "$cmds" = "$(printf '/usr/local/sbin/camdash-power restart-php\n/usr/local/sbin/camdash-power reboot')" ] && echo 0 || echo 1)
check "...with no wildcard and no ALL command" $(echo "$rules" | grep -qE '\*|NOPASSWD: *ALL' && echo 1 || echo 0)
if command -v visudo >/dev/null 2>&1; then
    visudo -cf "$SUDOERS" >/dev/null 2>&1; check "...and visudo accepts it" $?
fi
if command -v php >/dev/null 2>&1; then
    php_actions=$(php -r 'require "'"$ROOT"'/php/cameras/lib/Reboot.php"; echo implode(" ", CamReboot::HOST_ACTIONS);')
    check "the actions the dashboard may send are the ones the rule and helper know" $([ "$php_actions" = "restart-php reboot" ] && echo 0 || echo 1)
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
