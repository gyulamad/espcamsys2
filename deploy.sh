#!/bin/bash
# deploy.sh — copy the PHP dashboard into the web folder on the Pi (run from the repo root, as root:
#   sudo ./deploy.sh).
#
# The folder is /var/www/html/camdash, as it always was. If yours is elsewhere, run it as
#   sudo CAMDASH_DIR=/your/folder ./deploy.sh
# and change the one "Define CAMDASH_DIR" line in apache/camdash-protect.conf to match.

DEST="${CAMDASH_DIR:-/var/www/html/camdash}"
STRAY="${CAMDASH_STRAY_DIR:-/var/www/camdash}"

mkdir -p "$DEST/lib"
cp ./php/cameras/*.php "$DEST"
cp ./php/cameras/lib/*.php "$DEST/lib"
# .htaccess denies config.php.bak and similar copies of the config if the server allows overrides
# (cp *.php does not pick it up); apache/camdash-protect.conf denies them on its own too.
cp ./php/cameras/.htaccess "$DEST/.htaccess"
# an older version left config.php.bak (password + control key) in the web folder: remove it
rm -f "$DEST/config.php.bak"
# control.php (camera power on/off) was retired — cp never deletes, so remove the stale copy
rm -f "$DEST/control.php"

# The settings page rewrites config.php, so the web server's user must be able to write that FILE
# (not the folder). config.php is gitignored and never copied: it is created by hand, once. Only
# touches the file if it exists.
if [ -f "$DEST/config.php" ]; then
    chown www-data "$DEST/config.php"
    chmod 640 "$DEST/config.php"    # the web server's user and root only; no other user on the Pi can read the login
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
