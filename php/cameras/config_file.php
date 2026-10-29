<?php
// config_file.php — loading and saving the dashboard's settings (login, relay address, control key,
// the camera list, the two recording lengths). Every page that needs the settings gets them from
// camdash_load_config(); every save goes through camdash_update_config().
//
// TWO FILES, ONE SET OF SETTINGS (review F-18, F-10)
//   config.php          what the owner wrote and deploy.sh copies. After deploy.sh has run as root it is
//                       READ-ONLY for the web server (owner root, group www-data, mode 640): the web
//                       process can no longer rewrite code it executes.
//   data/settings.json  what the settings pages saved, laid over config.php when the config is loaded
//                       (only the keys listed in CamLogic::CONFIG_OVERRIDE_KEYS, only values of the right
//                       type). JSON, not PHP, so it can never run as code; in a folder the web server
//                       may write and Apache never serves. Written to a temporary file in that folder and
//                       renamed into place — a power cut leaves the old file or the new one, never half a
//                       file — under ONE lock held from reading the current settings to writing the new
//                       ones, so two saves at the same moment cannot undo each other. A damaged file is
//                       ignored (and logged): the dashboard keeps running on config.php.
// Until deploy.sh has created data/ the old way still works: config.php is rewritten in place, now also
// under one lock from read to write, and the new text is checked before the file is touched.
//
// SECURITY: the settings hold the dashboard password and the relay control key, so a copy of them must
// NEVER sit in the web folder (Apache would serve config.php.bak as a plain file). An optional backup is
// kept only if CAMDASH_BACKUP_DIR names an absolute folder OUTSIDE the web folder; it is written with
// mode 0600 and the folder is created with mode 0700. Any stale config.php.bak left in the web folder
// by an older version is deleted on every save.

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

// What the browser is told when settings cannot be saved: no path and no command, only what to do
// (review F-20). The details go to the web server's error log.
function camdash_unwritable_message(string $file): string
{
    error_log('camdash: settings cannot be saved: neither ' . dirname($file) . '/data nor ' . $file . ' is writable by the web server (running as '
        . (function_exists('posix_geteuid') && function_exists('posix_getpwuid') ? (posix_getpwuid(posix_geteuid())['name'] ?? 'an unknown user') : 'an unknown user')
        . '). Run deploy.sh as root once: it creates the data folder for the web server and makes config.php read-only for it.');
    return 'The dashboard cannot save settings: the web server may not write its settings — run deploy.sh as root on the Pi once (it sets that up; details are in the web server error log)';
}

function camdash_data_dir(string $baseDir): string
{
    return $baseDir . '/data';
}

function camdash_settings_file(string $baseDir): string
{
    return camdash_data_dir($baseDir) . '/settings.json';
}

// True once deploy.sh has made data/ for the web server: then saves go to settings.json.
function camdash_override_mode(string $baseDir): bool
{
    $d = camdash_data_dir($baseDir);
    return is_dir($d) && is_writable($d);
}

// Whether a save can work at all (the settings pages show a banner when it cannot).
function camdash_config_writable(string $baseDir = __DIR__): bool
{
    $file = $baseDir . '/config.php';
    return camdash_override_mode($baseDir) || (is_file($file) && is_writable($file));
}

// error_log() at most once per 5 minutes per $key: a damaged file would otherwise be logged by every
// request (the page polls every few seconds).
function camdash_log_once(string $key, string $message): void
{
    $marker = sys_get_temp_dir() . '/camdash-log-' . sha1($key);
    $last = @filemtime($marker);
    if (!CamLogic::logDue($last === false ? null : $last, time(), 300)) {
        return;
    }
    @touch($marker);
    error_log('camdash: ' . $message);
}

// config.php as the owner wrote it. A broken config.php is a fatal error, as it always was: the
// dashboard fails closed rather than running with settings nobody chose.
// $lock: wait while a save is rewriting the file in place (the old way, before data/ exists) instead of
// reading half of it — the writer holds the exclusive lock, readers take the shared one. (A save that
// goes to data/settings.json never touches config.php, and a rename is whole at every instant, so there
// is nothing to wait for then.) The save itself reads with $lock = false: it already holds the lock.
function camdash_read_base(string $baseDir, bool $lock = true): array
{
    $file = $baseDir . '/config.php';
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate($file, true);
    }
    $h = $lock ? @fopen($file, 'r') : false;
    $locked = false;
    if ($h) {
        $deadline = microtime(true) + 3;
        do {
            $locked = flock($h, LOCK_SH | LOCK_NB);
        } while (!$locked && microtime(true) < $deadline && usleep(5000) === null);
    }
    try {
        $base = (function () use ($file) {
            return require $file;
        })();
    } finally {
        if ($h) {
            if ($locked) {
                flock($h, LOCK_UN);
            }
            fclose($h);
        }
    }
    return is_array($base) ? $base : [];
}

// What the settings pages saved. Missing or empty file: nothing saved yet. A file that is not valid JSON
// (a power cut in the middle of an old-style write, a hand edit gone wrong) is ignored and logged.
function camdash_read_overrides(string $baseDir): array
{
    $file = camdash_settings_file($baseDir);
    if (!is_file($file)) {
        return [];
    }
    $raw = @file_get_contents($file);
    if ($raw === false) {
        camdash_log_once('settings-unreadable:' . $file, $file . ' cannot be read by the web server — settings saved on the dashboard are NOT in effect (check its owner and mode: deploy.sh sets them)');
        return [];
    }
    if (trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        camdash_log_once('settings-invalid:' . $file, $file . ' is not valid JSON, so the settings saved on the dashboard are ignored and config.php is used. The next save on the dashboard repairs it; or delete the file.');
        return [];
    }
    return CamLogic::sanitizeOverrides($decoded);
}

// The settings in effect: config.php with what the dashboard saved on top.
function camdash_load_config(string $baseDir = __DIR__): array
{
    return CamLogic::mergeConfig(camdash_read_base($baseDir), camdash_read_overrides($baseDir));
}

// Takes an exclusive lock on an open file, waiting up to $waitMs. False if it stayed busy.
function camdash_flock($handle, int $waitMs = 5000): bool
{
    $deadline = microtime(true) + $waitMs / 1000;
    do {
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            return true;
        }
        usleep(20000);
    } while (microtime(true) < $deadline);
    return false;
}

// Copies $src into CAMDASH_BACKUP_DIR (outside the web folder) as $name, mode 0600. Does nothing if no
// safe backup folder is configured. $webFile is any file of the web folder, to check the folder against.
function camdash_backup_copy(string $src, string $name, string $webFile): void
{
    $backupDir = camdash_backup_dir($webFile);
    if ($backupDir === null || !is_file($src)) {
        return;
    }
    if (!is_dir($backupDir)) {
        @mkdir($backupDir, 0700, true);
    }
    if (!is_dir($backupDir) || !is_writable($backupDir)) {
        return;
    }
    $old = @file_get_contents($src);
    if ($old === false) {
        return;
    }
    $target = $backupDir . '/' . $name;
    $oldUmask = umask(0077);
    @file_put_contents($target, $old, LOCK_EX);
    umask($oldUmask);
    @chmod($target, 0600);
}

// Writes $content to $file so that it is either the old file or the whole new one, whenever the power
// goes: a temporary file in the same folder, flushed to disk, then renamed over the target.
function camdash_atomic_write(string $file, string $content): bool
{
    $dir = dirname($file);
    foreach (glob($file . '.tmp*') ?: [] as $stale) {   // left behind by a write that was cut short
        if (@filemtime($stale) < time() - 3600) {
            @unlink($stale);
        }
    }
    $tmp = $file . '.tmp' . bin2hex(random_bytes(6));
    $oldUmask = umask(0077);
    $h = @fopen($tmp, 'xb');
    umask($oldUmask);
    if (!$h) {
        return false;
    }
    $ok = fwrite($h, $content) === strlen($content) && fflush($h);
    if ($ok && function_exists('fsync')) {
        $ok = fsync($h);
    }
    fclose($h);
    if (!$ok || !@rename($tmp, $file)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

function camdash_save_result(bool $ok, ?string $error, array $config, bool $changed): array
{
    return ['ok' => $ok, 'error' => $error, 'config' => $config, 'changed' => $changed];
}

// THE way to save settings. $mutate receives the settings in effect, read fresh while the lock is held,
// and returns the new settings (an array), or a string (why this change cannot be made: nothing is
// written), or null / the same array (nothing to change). Returns
// ['ok' => bool, 'error' => ?string, 'config' => array (the settings in effect after), 'changed' => bool].
function camdash_update_config(callable $mutate, string $baseDir = __DIR__): array
{
    if (camdash_override_mode($baseDir)) {
        return camdash_update_overrides($mutate, $baseDir);
    }
    return camdash_update_legacy($mutate, $baseDir);
}

// The normal way, once deploy.sh has made data/: save into data/settings.json.
function camdash_update_overrides(callable $mutate, string $baseDir): array
{
    $dir = camdash_data_dir($baseDir);
    $lockFile = $dir . '/settings.lock';
    $oldUmask = umask(0077);
    $lock = @fopen($lockFile, 'c');
    umask($oldUmask);
    if (!$lock || !camdash_flock($lock)) {
        if ($lock) {
            fclose($lock);
        }
        return camdash_save_result(false, 'The settings are being saved by someone else right now — try again in a moment', [], false);
    }
    try {
        $base = camdash_read_base($baseDir, false);   // config.php is never rewritten in this mode
        $current = CamLogic::mergeConfig($base, camdash_read_overrides($baseDir));
        $new = $mutate($current);
        if (is_string($new)) {
            return camdash_save_result(false, $new, $current, false);
        }
        if (!is_array($new) || $new === $current) {
            return camdash_save_result(true, null, $current, false);
        }
        $overrides = CamLogic::configOverrides($base, $new);
        $stored = CamLogic::mergeConfig($base, $overrides);
        foreach (CamLogic::CONFIG_OVERRIDE_KEYS as $k) {   // everything that was meant to be saved can be stored
            if (array_key_exists($k, $new) && (!array_key_exists($k, $stored) || $stored[$k] !== $new[$k])) {
                return camdash_save_result(false, 'These settings cannot be stored (' . $k . ' has a value of the wrong type) — nothing was saved', $current, false);
            }
        }
        $json = json_encode($overrides === [] ? new stdClass() : $overrides, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return camdash_save_result(false, 'These settings cannot be stored (not valid text) — nothing was saved', $current, false);
        }
        $file = camdash_settings_file($baseDir);
        camdash_backup_copy($file, 'settings.json.bak', $baseDir . '/config.php');
        if (!camdash_atomic_write($file, $json . "\n")) {
            return camdash_save_result(false, camdash_unwritable_message($baseDir . '/config.php'), $current, false);
        }
        return camdash_save_result(true, null, $new, true);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

// The old way, until deploy.sh has made data/: rewrite config.php in place. The folder is not writable
// by the web server (only the file), so there is no temporary file and rename here: instead the lock is
// held from reading to writing, and the new text is checked to be valid PHP BEFORE the file is touched.
function camdash_update_legacy(callable $mutate, string $baseDir): array
{
    $file = $baseDir . '/config.php';
    if (!is_file($file) || !is_writable($file)) {
        return camdash_save_result(false, camdash_unwritable_message($file), [], false);
    }
    // Settings were saved in data/settings.json before, but the web server cannot write that folder now
    // (its owner or mode was changed): a save into config.php would be overruled by those old settings
    // and look as if it worked. Refuse, and say what to fix.
    if (is_dir(camdash_data_dir($baseDir)) && camdash_read_overrides($baseDir) !== []) {
        return camdash_save_result(false, camdash_unwritable_message($file), [], false);
    }
    // An old version left config.php.bak next to config.php, where the web server hands it out. Remove it.
    if (is_file($file . '.bak')) {
        @unlink($file . '.bak');
    }
    $h = @fopen($file, 'c+');
    if (!$h || !camdash_flock($h)) {
        if ($h) {
            fclose($h);
        }
        return camdash_save_result(false, 'The settings are being saved by someone else right now — try again in a moment', [], false);
    }
    try {
        $current = CamLogic::mergeConfig(camdash_read_base($baseDir, false), camdash_read_overrides($baseDir));   // we hold the lock ourselves
        $new = $mutate($current);
        if (is_string($new)) {
            return camdash_save_result(false, $new, $current, false);
        }
        if (!is_array($new) || $new === $current) {
            return camdash_save_result(true, null, $current, false);
        }
        $php = CamLogic::buildConfigPhp($new);
        try {
            token_get_all($php, TOKEN_PARSE);   // never replace a working file with text PHP cannot read
        } catch (ParseError $e) {
            return camdash_save_result(false, 'The new settings could not be written as a valid config.php — nothing was saved', $current, false);
        }
        camdash_backup_copy($file, 'config.php.bak', $file);
        $ok = ftruncate($h, 0) && rewind($h) && fwrite($h, $php) === strlen($php) && fflush($h);
        if ($ok && function_exists('fsync')) {
            fsync($h);
        }
        if (!$ok) {
            return camdash_save_result(false, 'config.php could not be written — check its permissions', $current, false);
        }
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($file, true);
        }
        return camdash_save_result(true, null, $new, true);
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

// null when saved, else what went wrong. Sets the WHOLE config (the older interface, kept for callers
// that have a complete config in hand): the saved settings become exactly $config.
function camdash_write_config(string $file, array $config): ?string
{
    $r = camdash_update_config(function () use ($config) {
        return $config;
    }, dirname($file));
    return $r['error'];
}
