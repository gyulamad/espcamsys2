#!/bin/bash
# deploy.sh — copy the PHP dashboard into the web folder on the Pi (run from the repo root, as root:
#   sudo ./deploy.sh).
#
# The folder is /var/www/html/camdash, as it always was. If yours is elsewhere, run it as
#   sudo CAMDASH_DIR=/your/folder ./deploy.sh
# and change the one "Define CAMDASH_DIR" line in apache/camdash-protect.conf to match.

DEST="${CAMDASH_DIR:-/var/www/html/camdash}"
STRAY="${CAMDASH_STRAY_DIR:-/var/www/camdash}"

# config.php is gitignored. If you keep yours in php/cameras/ it is copied along with the other
# *.php files, exactly as this script always did — and that REPLACES the one in the web folder. Until the
# data folder exists (see below) the settings page rewrites the web folder's config.php, so anything
# saved there since the last deploy would be lost: say so before it happens. (With the data folder, what
# the dashboard saved lives in data/settings.json, which a deploy never touches.)
if [ -f ./php/cameras/config.php ] && [ -f "$DEST/config.php" ] && [ ! -d "$DEST/data" ] && ! cmp -s ./php/cameras/config.php "$DEST/config.php"; then
    echo "deploy: NOTE php/cameras/config.php differs from $DEST/config.php and replaces it now."
    echo "        Settings saved on the dashboard since the last deploy (login, relay address, cameras)"
    echo "        live only in the web folder's copy — they are gone after this deploy unless you had"
    echo "        copied them back into php/cameras/config.php."
fi

mkdir -p "$DEST/lib"
cp ./php/cameras/*.php "$DEST"
cp ./php/cameras/lib/*.php "$DEST/lib"
# the two typefaces (Share Tech Mono, Barlow) are served from here, not from Google Fonts (review F-19)
mkdir -p "$DEST/fonts"
cp ./php/cameras/fonts/* "$DEST/fonts"
# .htaccess denies config.php.bak and similar copies of the config if the server allows overrides
# (cp *.php does not pick it up); apache/camdash-protect.conf denies them on its own too.
cp ./php/cameras/.htaccess "$DEST/.htaccess"
# an older version left config.php.bak (password + control key) in the web folder: remove it
rm -f "$DEST/config.php.bak"
# control.php (camera power on/off) was retired — cp never deletes, so remove the stale copy
rm -f "$DEST/control.php"

# Settings changed on the dashboard's pages (login, relay address, control key, cameras, recording lengths)
# are saved in $DEST/data/settings.json: JSON, so never code; in a folder only the web server may use
# (mode 700) that Apache never serves. config.php itself becomes READ-ONLY for the web server (owner
# root, group www-data, mode 640): it can no longer rewrite code it executes, and a deploy no longer
# overwrites what was saved on the dashboard. Needs root and the www-data user: without them nothing is
# changed and the dashboard keeps saving into config.php as before.
if [ "$(id -u)" -eq 0 ] && id www-data >/dev/null 2>&1; then
    mkdir -p "$DEST/data"
    chown www-data "$DEST/data"
    chmod 700 "$DEST/data"
    printf 'Require all denied\n' > "$DEST/data/.htaccess"    # a second lock, next to apache/camdash-protect.conf
    if [ -f "$DEST/config.php" ]; then
        chown root:www-data "$DEST/config.php"
        chmod 640 "$DEST/config.php"    # readable by the web server, writable only by root
        echo "deploy: $DEST/config.php is now read-only for the web server; settings you change on the"
        echo "        dashboard are saved in $DEST/data/settings.json and take precedence over config.php."
    else
        echo "deploy: NOTE there is no $DEST/config.php yet — copy example.config.php to config.php and fill it in."
    fi
    if [ -s "$DEST/data/settings.json" ]; then
        KEYS=$(grep -oE '^    "[a-z_]+"' "$DEST/data/settings.json" | tr -d ' "' | tr '\n' ' ')
        if [ -n "$KEYS" ]; then
            echo "deploy: NOTE settings saved on the dashboard win over config.php for: $KEYS"
            echo "        (to change one of those by hand, change it on the dashboard, or delete it from data/settings.json)"
        fi
    fi
elif [ -f "$DEST/config.php" ]; then
    echo "deploy: NOTE not run as root (or no www-data user), so no data folder was made and $DEST/config.php"
    echo "        was left as it is — run it with sudo so the web server can save settings without being able"
    echo "        to rewrite config.php, and so no other user can read the login (config.php mode 640)."
else
    echo "deploy: NOTE there is no $DEST/config.php yet — copy example.config.php to config.php and fill it in."
fi

# A previous version of this script copied into /var/www/camdash instead — a second, unused copy.
if [ -d "$STRAY" ] && [ "$STRAY" != "$DEST" ]; then
    echo
    echo "deploy: NOTE $STRAY exists. That is the stray copy an earlier version of this script made;"
    echo "        this script does not use it. Before you delete it, check which folder Apache serves:"
    echo "          grep -rn DocumentRoot /etc/apache2/sites-enabled/    and    ls /etc/apache2/sites-enabled/"
    echo "        and that $DEST/config.php is the newer config (ls -l both). Then:   sudo rm -rf $STRAY"
fi
true
