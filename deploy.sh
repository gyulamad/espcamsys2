#!/bin/bash
# deploy.sh — copy the PHP dashboard into the web folder on the Pi (run from the repo root, as root:
#   sudo ./deploy.sh).
#
# The web folder is the one INSTALL.md §4 and apache/camdash.conf use: /var/www/camdash.
# (Older versions of this script copied into /var/www/html/camdash, which Apache's DEFAULT site
# serves on every interface — the dashboard was then reachable on the LAN over plain HTTP, where
# the Basic-auth password can be sniffed. Override with CAMDASH_DIR=... only if you changed the
# vhost's DocumentRoot too.)

DEST="${CAMDASH_DIR:-/var/www/camdash}"
LEGACY="${CAMDASH_LEGACY_DIR:-/var/www/html/camdash}"

mkdir -p "$DEST/lib"
cp ./php/cameras/*.php "$DEST"
cp ./php/cameras/lib/*.php "$DEST/lib"
# .htaccess denies config.php.bak and similar copies of the config if the vhost allows overrides
# (cp *.php does not pick it up); the vhost in apache/camdash.conf denies them on its own too.
cp ./php/cameras/.htaccess "$DEST/.htaccess"
# an older version left config.php.bak (password + control key) in the web folder: remove it
rm -f "$DEST/config.php.bak"
# control.php (camera power on/off) was retired — cp never deletes, so remove the stale copy
rm -f "$DEST/control.php"

# config.php is gitignored and never copied. If the old location has one and the new location does not,
# carry it over (copy, so nothing is lost); otherwise tell the owner to create it.
if [ ! -f "$DEST/config.php" ] && [ -f "$LEGACY/config.php" ]; then
    cp -p "$LEGACY/config.php" "$DEST/config.php"
    echo "deploy: copied your config.php from $LEGACY to $DEST"
fi
if [ ! -f "$DEST/config.php" ]; then
    echo "deploy: NOTE there is no $DEST/config.php yet — copy example.config.php to config.php and fill it in."
fi

# The settings page rewrites config.php, so the web server's user must be able to write that FILE
# (not the folder). Only touches the file if it exists.
if [ -f "$DEST/config.php" ]; then
    chown www-data "$DEST/config.php"
    chmod 640 "$DEST/config.php"
fi

# ── warnings: things that leave the dashboard reachable from the LAN ──
if [ -d "$LEGACY" ] && [ "$DEST" != "$LEGACY" ]; then
    echo
    echo "deploy: WARNING the old copy $LEGACY still exists. Apache's default site serves it on"
    echo "        every interface, with the old code and your password. After checking the new one"
    echo "        works, remove it:   sudo rm -rf $LEGACY"
fi
if command -v ss >/dev/null 2>&1; then
    # any listener on port 80 that is not 127.0.0.1 / ::1
    OPEN=$(ss -ltnH 'sport = :80' 2>/dev/null | awk '{print $4}' | grep -v -E '^(127\.0\.0\.1|\[::1\]):80$' | head -3)
    if [ -n "$OPEN" ]; then
        echo
        echo "deploy: WARNING something listens on port 80 beyond localhost: $(echo $OPEN | tr '\n' ' ')"
        echo "        The dashboard may be reachable on the LAN over plain HTTP. Set"
        echo "        'Listen 127.0.0.1:80' in /etc/apache2/ports.conf, run 'sudo a2dissite 000-default',"
        echo "        and use apache/camdash.conf (INSTALL.md §4), then 'sudo systemctl restart apache2'."
    fi
fi
true
