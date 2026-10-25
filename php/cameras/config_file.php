<?php
// config_file.php — the one place that rewrites config.php (the settings pages use it: login,
// relay address, control key, the camera list). Writes in place under a lock (the web server's
// user only needs write access to the FILE, not the folder), and tells PHP's opcache the file
// changed. The text itself is built by CamLogic::buildConfigPhp().
//
// SECURITY: config.php holds the dashboard password and the relay control key, so a copy of it
// must NEVER sit in the web folder (Apache would serve config.php.bak as a plain file). An
// optional backup is kept only if CAMDASH_BACKUP_DIR names an absolute folder OUTSIDE the web
// folder; it is written with mode 0600 and the folder is created with mode 0700. Any stale
// config.php.bak left in the web folder by an older version is deleted on every save.

require_once __DIR__ . '/lib/Logic.php';

// The folder for backups, or null when none is configured or the setting is unsafe
// (relative, or inside the folder that holds config.php — i.e. inside the web root).
function camdash_backup_dir(string $file): ?string
{
    $dir = getenv('CAMDASH_BACKUP_DIR');
    if (!is_string($dir) || $dir === '' || $dir[0] !== '/') {
        return null;
    }
    $webDir = realpath(dirname($file));
    if ($webDir === false) {
        return null;
    }
    $dir = rtrim($dir, '/');
    // Resolve the deepest existing ancestor so '..' and symlinks cannot hide a path inside the web folder.
    $probe = $dir;
    $tail = '';
    while ($probe !== '' && !file_exists($probe)) {
        $tail = '/' . basename($probe) . $tail;
        $probe = dirname($probe);
    }
    $real = realpath($probe === '' ? '/' : $probe);
    if ($real === false || strpos($tail, '..') !== false) {
        return null;
    }
    $resolved = rtrim($real, '/') . $tail;
    if ($resolved === $webDir || strpos($resolved . '/', $webDir . '/') === 0) {
        return null;
    }
    return $resolved;
}

// null when saved, else what went wrong.
function camdash_write_config(string $file, array $config): ?string
{
    if (!is_file($file) || !is_writable($file)) {
        return 'config.php is not writable by the web server — run once on the Pi: sudo chown www-data ' . $file . ' (deploy.sh does this)';
    }
    // An old version left config.php.bak next to config.php, where the web server hands it out. Remove it.
    $legacy = $file . '.bak';
    if (is_file($legacy)) {
        @unlink($legacy);
    }
    $backupDir = camdash_backup_dir($file);
    if ($backupDir !== null) {
        if (!is_dir($backupDir)) {
            @mkdir($backupDir, 0700, true);
        }
        if (is_dir($backupDir) && is_writable($backupDir)) {
            $target = $backupDir . '/config.php.bak';
            $old = @file_get_contents($file);
            if ($old !== false) {
                $oldUmask = umask(0077);
                @file_put_contents($target, $old, LOCK_EX);
                umask($oldUmask);
                @chmod($target, 0600);
            }
        }
    }
    if (@file_put_contents($file, CamLogic::buildConfigPhp($config), LOCK_EX) === false) {
        return 'config.php could not be written — check its permissions';
    }
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate($file, true);
    }
    return null;
}
