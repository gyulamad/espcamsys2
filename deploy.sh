cp ./php/cameras/*.php /var/www/html/camdash
cp ./php/cameras/lib/*.php /var/www/html/camdash/lib
# control.php (camera power on/off) was retired — cp never deletes, so remove the stale copy
rm -f /var/www/html/camdash/control.php
