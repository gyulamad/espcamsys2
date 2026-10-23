#!/usr/bin/env bash
# capture-env.sh — write down every tool/library version this project depends on.
#
# Run it ON EACH MACHINE that matters and save the output next to the repo:
#   - the Pi (runtime: node, php, apache, tor, ffmpeg)
#   - the laptop/PC you compile and flash from (arduino-cli, esp32 core, libraries, g++ ...)
#
#   ./capture-env.sh > env-snapshots/$(hostname)-$(date +%F).md
#
# Read-only: it changes nothing. Missing tools are reported, not fatal.
# Optional: ESPCAM_REPO=/path/to/espcamsys2 (default: directory of this script)

REPO="${ESPCAM_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LIBDIR="${ARDUINO_LIBS:-$HOME/Arduino/libraries}"

section() { printf '\n## %s\n\n' "$1"; }
run() {  # run "label" cmd args...   -> prints "label: first line of output" or MISSING
  local label="$1"; shift
  if command -v "$1" >/dev/null 2>&1; then
    printf -- '- %s: `%s`\n' "$label" "$("$@" 2>&1 | head -n 1)"
  else
    printf -- '- %s: **not installed / not on PATH**\n' "$label"
  fi
}

echo "# Environment snapshot — $(hostname) — $(date -u +%FT%TZ)"

section "Repo"
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "- commit: \`$(git -C "$REPO" rev-parse HEAD)\`"
  echo "- describe: \`$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null)\`"
else
  echo "- $REPO is not a git checkout"
fi

section "Operating system / hardware"
[ -r /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_CODENAME|VERSION_ID)=' /etc/os-release | sed 's/^/- /'
echo "- kernel: \`$(uname -srmo)\`"
[ -r /proc/device-tree/model ] && echo "- board: \`$(tr -d '\0' < /proc/device-tree/model)\`"
[ -r /etc/rpi-issue ] && echo "- rpi image: \`$(head -n 1 /etc/rpi-issue)\`"
echo "- libc: \`$(ldd --version 2>&1 | head -n 1)\`"

section "Relay runtime (Pi)"
run "node" node --version
run "npm" npm --version
run "ffmpeg" ffmpeg -version
if [ -f "$REPO/nodejs/camera-relay/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
  echo "- installed npm tree (top level) in nodejs/camera-relay:"
  echo '```'
  (cd "$REPO/nodejs/camera-relay" && npm ls --depth=0 2>&1 | head -n 20)
  echo '```'
fi
echo "- NodeSource / node apt origin: \`$(apt-cache policy nodejs 2>/dev/null | sed -n '2,3p' | tr '\n' ' ')\`"

section "Dashboard runtime (Pi)"
run "php" php --version
run "apache" apache2 -v
run "tor" tor --version
if command -v php >/dev/null 2>&1; then
  echo "- php modules: \`$(php -m 2>/dev/null | grep -vE '^\[|^$' | tr '\n' ' ')\`"
fi
if command -v apache2ctl >/dev/null 2>&1; then
  echo "- apache modules (headers/php/rewrite): \`$(apache2ctl -M 2>/dev/null | grep -E 'headers|php|rewrite' | tr -s ' ' | tr '\n' ' ')\`"
fi
run "systemd" systemctl --version

section "Exact Debian/Ubuntu package versions (Pi)"
if command -v dpkg-query >/dev/null 2>&1; then
  echo '```'
  dpkg-query -W -f='${Package}=${Version}\n' 2>/dev/null \
    | grep -E '^(nodejs|npm|ffmpeg|php[0-9.]*(-[a-z]+)?|libapache2-mod-php[0-9.]*|apache2|tor|curl|openssl)=' | sort
  echo '```'
fi

section "Firmware toolchain (laptop)"
run "arduino-cli" arduino-cli version
if command -v arduino-cli >/dev/null 2>&1; then
  echo "- installed cores (esp32 core version is the important one):"
  echo '```'; arduino-cli core list 2>&1; echo '```'
  echo "- installed libraries (Library Manager):"
  echo '```'; arduino-cli lib list 2>&1; echo '```'
  echo "- config (where cores/libs live):"
  echo '```'; arduino-cli config dump 2>&1 | grep -E 'data:|user:|downloads:|additional_urls' ; echo '```'
  echo "- bundled toolchain / tools of the esp32 core:"
  echo '```'
  ls "$(arduino-cli config get directories.data 2>/dev/null)/packages/esp32/tools" 2>/dev/null
  for t in "$(arduino-cli config get directories.data 2>/dev/null)"/packages/esp32/tools/*/; do
    [ -d "$t" ] && echo "$(basename "$t") $(ls "$t" | tr '\n' ' ')"
  done 2>/dev/null
  echo '```'
fi
echo "- Arduino IDE (if used instead of the CLI): record Help > About manually."

section "Git-cloned Arduino libraries (outside the repo — NOT covered by arduino-cli lib list)"
if [ -d "$LIBDIR" ]; then
  for d in "$LIBDIR"/*/; do
    [ -d "$d/.git" ] || continue
    echo "- \`$(basename "$d")\`"
    echo "  - remote: \`$(git -C "$d" remote get-url origin 2>/dev/null)\`"
    echo "  - commit: \`$(git -C "$d" rev-parse HEAD 2>/dev/null)\`"
    echo "  - describe: \`$(git -C "$d" describe --tags --always --dirty 2>/dev/null)\`"
    echo "  - submodules: \`$(git -C "$d" submodule status 2>/dev/null | tr '\n' ' ')\`"
  done
  echo "- all libraries present in $LIBDIR:"
  echo '```'; ls -1 "$LIBDIR"; echo '```'
else
  echo "- $LIBDIR not found (set ARDUINO_LIBS=/path to override)"
fi

section "Test / build tooling (laptop or Pi)"
run "g++" g++ --version
run "gcov" gcov --version
run "gdb" gdb --version
run "make" make --version
run "git" git --version
run "curl" curl --version
run "openssl" openssl version
if command -v php >/dev/null 2>&1; then
  echo "- php coverage driver: \`$(php -m 2>/dev/null | grep -iE '^(pcov|xdebug)$' | tr '\n' ' ')\`"
fi

section "3D / hardware design (optional)"
run "FreeCAD" freecadcmd --version
echo "- AI-Thinker ESP32-CAM board revision / camera sensor: note by hand (not detectable from software here)."

section "Firmware currently running (ask the relay)"
echo "- run: \`curl -s -H \"X-Control-Key: <controlKey>\" http://<pi>:8080/ota/status\` and paste the table here."
echo "- boot banner of any board shows: \`Arduino-ESP32 core 3.x.x\`"
