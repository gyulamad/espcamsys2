<?php
// config_file.php — the one place that rewrites config.php (the settings pages use it: login,
// relay address, control key, the camera list). Keeps a config.php.bak of what was there, writes
// in place under a lock (the web server's user only needs write access to the FILE, not the folder),
// and tells PHP's opcache the file changed. The text itself is built by CamLogic::buildConfigPhp().

require_once __DIR__ . '/lib/Logic.php';

// null when saved, else what went wrong.
function camdash_write_config(string $file, array $config): ?string
{
    if (!is_file($file) || !is_writable($file)) {
        return 'config.php is not writable by the web server — run once on the Pi: sudo chown www-data ' . $file . ' (deploy.sh does this)';
    }
    @copy($file, $file . '.bak');
    if (@file_put_contents($file, CamLogic::buildConfigPhp($config), LOCK_EX) === false) {
        return 'config.php could not be written — check its permissions';
    }
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate($file, true);
    }
    return null;
}
