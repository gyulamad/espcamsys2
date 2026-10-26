#!/bin/bash
# make-selfsigned-cert.sh — makes the self-signed certificate for the OPTIONAL HTTPS virtual host
# (apache/camdash-ssl.conf). Run it as root on the Pi:
#
#   sudo ./apache/make-selfsigned-cert.sh raspberrypi raspberrypi.local 192.168.1.20
#
# Every argument is a name or an IP address the browser will use to reach the Pi; they all go into the
# certificate (a browser rejects a certificate whose names do not include the address you typed).
# Without arguments it uses this machine's host name. Files go to /etc/ssl/camdash/ (override with
# CAMDASH_CERT_DIR): camdash.key (0600, root only) and camdash.crt. It will not overwrite an existing
# certificate unless you add --force as the FIRST argument. Valid for 825 days; run it again with
# --force before then and reload Apache.

set -eu

DIR="${CAMDASH_CERT_DIR:-/etc/ssl/camdash}"
DAYS=825

FORCE=0
if [ "${1:-}" = "--force" ]; then
    FORCE=1
    shift
fi
if ! command -v openssl >/dev/null 2>&1; then
    echo "make-selfsigned-cert: openssl is not installed (sudo apt install openssl)" >&2
    exit 1
fi
if [ $# -eq 0 ]; then
    set -- "$(hostname)"
fi

# names and addresses only: they end up in a config line, so nothing else is accepted
SAN=""
CN=""
for h in "$@"; do
    if [[ "$h" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        SAN="${SAN:+$SAN,}IP:$h"
    elif [[ "$h" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]; then
        SAN="${SAN:+$SAN,}DNS:$h"
    else
        echo "make-selfsigned-cert: '$h' is not a host name or an IPv4 address" >&2
        exit 1
    fi
    [ -z "$CN" ] && CN="$h"
done

if [ -e "$DIR/camdash.crt" ] || [ -e "$DIR/camdash.key" ]; then
    if [ "$FORCE" -ne 1 ]; then
        echo "make-selfsigned-cert: $DIR/camdash.crt already exists — add --force as the first argument to replace it" >&2
        exit 1
    fi
fi

umask 077
mkdir -p "$DIR"
chmod 755 "$DIR"
# write next to the final files and move into place, so a failure never leaves half a pair
TMPKEY="$(mktemp "$DIR/key.XXXXXX")"
TMPCRT="$(mktemp "$DIR/crt.XXXXXX")"
trap 'rm -f "$TMPKEY" "$TMPCRT"' EXIT
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$TMPKEY" -out "$TMPCRT" -days "$DAYS" \
    -subj "/CN=$CN/O=camdash" -addext "subjectAltName=$SAN" \
    -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=serverAuth"
chmod 600 "$TMPKEY"
chmod 644 "$TMPCRT"
mv -f "$TMPKEY" "$DIR/camdash.key"
mv -f "$TMPCRT" "$DIR/camdash.crt"
trap - EXIT

echo "make-selfsigned-cert: wrote $DIR/camdash.crt and camdash.key"
echo "  names in the certificate: $SAN"
echo "  valid for $DAYS days"
echo "  SHA-256 fingerprint (compare it with what the browser shows before you accept):"
openssl x509 -in "$DIR/camdash.crt" -noout -fingerprint -sha256 | sed 's/^/  /'
