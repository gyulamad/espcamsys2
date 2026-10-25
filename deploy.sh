cp ./php/cameras/*.php /var/www/html/camdash
cp ./php/cameras/lib/*.php /var/www/html/camdash/lib
# .htaccess denies config.php.bak and similar copies of the config (cp *.php does not pick it up)
cp ./php/cameras/.htaccess /var/www/html/camdash/.htaccess
# an older version left config.php.bak (password + control key) in the web folder: remove it
rm -f /var/www/html/camdash/config.php.bak
# control.php (camera power on/off) was retired — cp never deletes, so remove the stale copy
rm -f /var/www/html/camdash/control.php
# The settings page rewrites config.php, so the web server's user must be able to write it
# (it was probably created by hand as root). Only touches the file if it exists.
[ -f /var/www/html/camdash/config.php ] && chown www-data /var/www/html/camdash/config.php
true
