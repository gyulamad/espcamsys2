#!/bin/bash
# camdash-power — the two privileged things the dashboard's reset menu may ask of the Pi:
#
#   camdash-power restart-php    restart the web server (Apache, which runs the dashboard's PHP)
#   camdash-power reboot         reboot the Raspberry Pi
#
# Installed by deploy.sh as /usr/local/sbin/camdash-power (root:root, mode 755); the web server's user may run
# exactly these two commands, through the sudo rule in apache/camdash-power.sudoers, and nothing else.
# That is why this script takes ONE argument from a fixed list, uses no environment and no other input,
# and refuses everything else.
#
# The action runs a few seconds LATER, from its own systemd timer, so the answer to the page that asked
# can still be sent (a web server that restarts itself in the middle of a request would never answer it).
#
#   camdash-power --print <action>   shows what it would run, runs nothing (for the tests)

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DELAY=3

usage() {
    echo "usage: camdash-power restart-php|reboot" >&2
    exit 2
}

PRINT=0
if [ "${1:-}" = "--print" ]; then
    PRINT=1
    shift
fi
[ "$#" -eq 1 ] || usage

case "$1" in
    restart-php) UNIT=camdash-power-restart-php; CMD=(/bin/systemctl restart apache2) ;;
    reboot)      UNIT=camdash-power-reboot;      CMD=(/bin/systemctl reboot) ;;
    *)           usage ;;
esac
SCHEDULE=(systemd-run --quiet --on-active="$DELAY" --unit="$UNIT" "${CMD[@]}")

if [ "$PRINT" -eq 1 ]; then
    echo "${SCHEDULE[*]}"
    exit 0
fi

# Already scheduled (the button was pressed twice): that is fine, it will happen.
if systemctl is-active --quiet "$UNIT.timer" 2>/dev/null; then
    echo "already scheduled"
    exit 0
fi
"${SCHEDULE[@]}" || { echo "could not schedule it (is systemd-run available, and is this run as root?)" >&2; exit 1; }
echo "scheduled in ${DELAY}s"
