<?php
// Tests for php/cameras/config_file.php — F-01: no copy of config.php may sit in the web folder.
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/config_file.php';

function cf_tmp(): string
{
    $d = sys_get_temp_dir() . '/camdash_cf_' . bin2hex(random_bytes(4));
    mkdir($d, 0700, true);
    return $d;
}
function cf_rm(string $d): void
{
    foreach (glob($d . '/{,.}*', GLOB_BRACE) ?: [] as $f) {
        if (basename($f) === '.' || basename($f) === '..') continue;
        is_dir($f) ? cf_rm($f) : @unlink($f);
    }
    @rmdir($d);
}
function cf_config(): array
{
    return ['auth_user' => 'u', 'auth_pass' => 'long-enough-pass', 'relay_url' => 'http://127.0.0.1:8080', 'cameras' => []];
}

camtest_test('saving config.php leaves no config.php.bak in the web folder', function () {
    putenv('CAMDASH_BACKUP_DIR');
    $d = cf_tmp();
    file_put_contents($d . '/config.php', "<?php return [];\n");
    camtest_assert_equal(camdash_write_config($d . '/config.php', cf_config()), null);
    camtest_assert_true(!file_exists($d . '/config.php.bak'), 'config.php.bak must not exist');
    camtest_assert_equal(glob($d . '/*'), [$d . '/config.php']);
    cf_rm($d);
});

camtest_test('a stale config.php.bak from an older version is deleted on save', function () {
    putenv('CAMDASH_BACKUP_DIR');
    $d = cf_tmp();
    file_put_contents($d . '/config.php', "<?php return [];\n");
    file_put_contents($d . '/config.php.bak', "SECRET\n");
    camtest_assert_equal(camdash_write_config($d . '/config.php', cf_config()), null);
    camtest_assert_true(!file_exists($d . '/config.php.bak'));
    cf_rm($d);
});

camtest_test('a backup goes to CAMDASH_BACKUP_DIR outside the web folder, mode 0600', function () {
    $d = cf_tmp();
    $b = cf_tmp();
    file_put_contents($d . '/config.php', "<?php return ['old'=>1];\n");
    putenv('CAMDASH_BACKUP_DIR=' . $b . '/sub');
    camtest_assert_equal(camdash_write_config($d . '/config.php', cf_config()), null);
    camtest_assert_equal(file_get_contents($b . '/sub/config.php.bak'), "<?php return ['old'=>1];\n");
    camtest_assert_equal(substr(sprintf('%o', fileperms($b . '/sub/config.php.bak')), -4), '0600');
    camtest_assert_equal(substr(sprintf('%o', fileperms($b . '/sub')), -4), '0700');
    camtest_assert_true(!file_exists($d . '/config.php.bak'));
    putenv('CAMDASH_BACKUP_DIR');
    cf_rm($d);
    cf_rm($b);
});

camtest_test('CAMDASH_BACKUP_DIR inside the web folder, relative, or via .. is refused', function () {
    $d = cf_tmp();
    file_put_contents($d . '/config.php', "<?php return [];\n");
    foreach ([$d, $d . '/backups', $d . '/x/../backups', 'relative/dir', ''] as $bad) {
        putenv('CAMDASH_BACKUP_DIR=' . $bad);
        camtest_assert_equal(camdash_backup_dir($d . '/config.php'), null, "dir '$bad'");
    }
    putenv('CAMDASH_BACKUP_DIR');
    camdash_write_config($d . '/config.php', cf_config());
    camtest_assert_equal(glob($d . '/*'), [$d . '/config.php']);
    cf_rm($d);
});

camtest_test('F-20: the unwritable-config message tells the browser what to do, without a path or a command', function () {
    ini_set('error_log', '/dev/null');   // the details are meant for the error log; keep the test output clean
    $file = sys_get_temp_dir() . '/camdash_secret_dir_' . bin2hex(random_bytes(3)) . '/config.php';   // does not exist
    $msg = camdash_write_config($file, cf_config());
    camtest_assert_true(is_string($msg) && $msg !== '', 'an error is returned');
    camtest_assert_true(strpos($msg, $file) === false && strpos($msg, dirname($file)) === false && strpos($msg, sys_get_temp_dir()) === false, 'no path: ' . $msg);
    camtest_assert_true(!preg_match('/sudo|chown|chmod|\/var\/|\/tmp\//', $msg), 'no command or folder: ' . $msg);
    camtest_assert_true(strpos($msg, 'deploy.sh') !== false && strpos($msg, 'error log') !== false, 'but says what to do and where the details are: ' . $msg);
    camtest_assert_equal(camdash_unwritable_message($file), $msg, 'the settings page gets the very same text');
});

// ── F-18 / F-10: data/settings.json over a read-only config.php ──────

// A throwaway web folder: config.php (the base) and, with $withData, the data/ folder deploy.sh makes.
function cf_site(bool $withData): string
{
    $d = cf_tmp();
    file_put_contents($d . '/config.php', "<?php\nreturn " . var_export([
        'auth_user' => 'owner', 'auth_pass' => 'base-password-1', 'relay_url' => 'http://127.0.0.1:8080', 'relay_control_key' => 'base-control-key-0123456789',
        'cameras' => [['id' => 'base-cam', 'name' => 'Base', 'icon' => '📷']],
    ], true) . ";\n");
    if ($withData) mkdir($d . '/data', 0700);
    return $d;
}
function cf_json_files(string $d): array
{
    return array_map('basename', glob($d . '/data/*') ?: []);
}
function cf_worker_script(): string
{
    $f = sys_get_temp_dir() . '/camdash_cf_worker_' . bin2hex(random_bytes(3)) . '.php';
    file_put_contents($f, <<<'PHP'
<?php
require $argv[1] . '/config_file.php';
[$dir, $w, $n] = [$argv[2], $argv[3], (int) $argv[4]];
for ($i = 0; $i < $n; $i++) {
    $r = camdash_update_config(function (array $c) use ($w, $i) {
        $c['cameras'][] = ['id' => "w{$w}-i{$i}", 'name' => 'x'];
        return $c;
    }, $dir);
    if (!$r['ok']) { fwrite(STDERR, $r['error'] . "\n"); exit(3); }
}
PHP);
    return $f;
}
// Runs $workers PHP processes at once, each adding $each cameras, and returns [exit codes].
function cf_run_workers(string $site, int $workers, int $each): array
{
    $script = cf_worker_script();
    $procs = [];
    for ($w = 0; $w < $workers; $w++) {
        $procs[] = proc_open([PHP_BINARY, $script, dirname(__DIR__, 2) . '/php/cameras', $site, (string) $w, (string) $each], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$w]);
    }
    $codes = [];
    foreach ($procs as $w => $p) {
        stream_get_contents($pipes[$w][1]);
        $err = stream_get_contents($pipes[$w][2]);
        $codes[] = proc_close($p);
        if ($err !== '') fwrite(STDERR, $err);
    }
    @unlink($script);
    return $codes;
}

camtest_test('F-18: with data/, a save goes to settings.json; config.php is not touched', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    $before = file_get_contents($d . '/config.php');
    $r = camdash_update_config(function (array $c) { $c['auth_pass'] = 'new-password-2'; $c['record_seconds'] = 90; return $c; }, $d);
    camtest_assert_true($r['ok'] === true && $r['changed'] === true && $r['error'] === null, json_encode($r));
    camtest_assert_equal(file_get_contents($d . '/config.php'), $before, 'config.php byte for byte');
    camtest_assert_equal(json_decode(file_get_contents($d . '/data/settings.json'), true), ['auth_pass' => 'new-password-2', 'record_seconds' => 90]);
    camtest_assert_equal(substr(sprintf('%o', fileperms($d . '/data/settings.json')), -4), '0600');
    camtest_assert_equal(cf_json_files($d), ['settings.json', 'settings.lock'], 'no temporary file is left behind');
    $c = camdash_load_config($d);
    camtest_assert_true($c['auth_pass'] === 'new-password-2' && $c['auth_user'] === 'owner' && $c['record_seconds'] === 90, 'load = config.php + overrides');
    camtest_assert_equal($r['config'], $c);
    cf_rm($d);
});

camtest_test('F-18: nothing to change writes nothing; a refusal writes nothing; a value changed back drops its override', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    $r = camdash_update_config(function (array $c) { return $c; }, $d);
    camtest_assert_true($r['ok'] === true && $r['changed'] === false);
    $r = camdash_update_config(function () { return null; }, $d);
    camtest_assert_true($r['ok'] === true && $r['changed'] === false);
    camtest_assert_true(!file_exists($d . '/data/settings.json'), 'no file for no change');
    $r = camdash_update_config(function () { return 'that is not allowed'; }, $d);
    camtest_assert_true($r['ok'] === false && $r['error'] === 'that is not allowed' && !file_exists($d . '/data/settings.json'));
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'other-password-3'; return $c; }, $d);
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'base-password-1'; return $c; }, $d);
    camtest_assert_equal(json_decode(file_get_contents($d . '/data/settings.json'), true), [], 'back to the config.php value: no override left');
    camtest_assert_true(trim(file_get_contents($d . '/data/settings.json')) === '{}', 'an empty file is {}, not []');
    cf_rm($d);
});

camtest_test('F-18: a damaged settings.json (power cut) never takes the dashboard down; the next save repairs it', function () {
    $log = tempnam(sys_get_temp_dir(), 'cflog');
    ini_set('error_log', $log);
    $d = cf_site(true);
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'saved-password-4'; $c['cameras'][] = ['id' => 'cam2', 'name' => 'Two']; return $c; }, $d);
    $good = file_get_contents($d . '/data/settings.json');
    foreach (['', '   ', substr($good, 0, 20), substr($good, 0, (int) (strlen($good) / 2)), "\0\0\0\0", 'not json at all', '[1,2', '"just a string"', '12'] as $i => $damaged) {
        file_put_contents($d . '/data/settings.json', $damaged);
        @unlink(sys_get_temp_dir() . '/camdash-log-' . sha1('settings-invalid:' . $d . '/data/settings.json'));
        $c = camdash_load_config($d);   // must not throw, must not stop
        camtest_assert_true($c['auth_user'] === 'owner' && $c['auth_pass'] === 'base-password-1' && count($c['cameras']) === 1, 'load falls back to config.php for: ' . var_export(substr($damaged, 0, 20), true));
    }
    file_put_contents($d . '/data/settings.json', substr($good, 0, 25));
    @unlink(sys_get_temp_dir() . '/camdash-log-' . sha1('settings-invalid:' . $d . '/data/settings.json'));
    camdash_load_config($d);
    camtest_assert_true(strpos(file_get_contents($log), 'is not valid JSON') !== false && strpos(file_get_contents($log), $d) !== false, 'the damage is logged for the owner');
    $r = camdash_update_config(function (array $c) { $c['record_seconds'] = 45; return $c; }, $d);
    camtest_assert_true($r['ok'] === true && is_array(json_decode(file_get_contents($d . '/data/settings.json'), true)), 'the next save writes a valid file again');
    camtest_assert_equal(camdash_load_config($d)['record_seconds'], 45);
    @unlink($log);
    cf_rm($d);
});

camtest_test('F-18: a damaged file is logged once, not on every request', function () {
    $log = tempnam(sys_get_temp_dir(), 'cflog');
    ini_set('error_log', $log);
    $d = cf_site(true);
    file_put_contents($d . '/data/settings.json', '{broken');
    @unlink(sys_get_temp_dir() . '/camdash-log-' . sha1('settings-invalid:' . $d . '/data/settings.json'));
    for ($i = 0; $i < 20; $i++) camdash_load_config($d);
    camtest_assert_equal(substr_count(file_get_contents($log), 'is not valid JSON'), 1);
    @unlink($log);
    cf_rm($d);
});

camtest_test('F-18: a hand-made or tampered settings.json cannot add settings or put in values of the wrong type', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    file_put_contents($d . '/data/settings.json', json_encode([
        'evil_setting' => 'x', 'port' => 1, 'auth_user' => 5, 'auth_pass' => ['a'], 'record_seconds' => '60',
        'relay_url' => 'http://10.0.0.9:8080', 'cameras' => [['id' => "a');x('", 'name' => 'bad'], ['id' => 'fine', 'name' => 'Fine']],
    ]));
    $c = camdash_load_config($d);
    camtest_assert_true(!isset($c['evil_setting']) && !isset($c['port']) && !isset($c['record_seconds']), 'unknown keys and wrong types are not taken');
    camtest_assert_equal([$c['auth_user'], $c['auth_pass'], $c['relay_url']], ['owner', 'base-password-1', 'http://10.0.0.9:8080']);
    camtest_assert_equal(array_column($c['cameras'], 'id'), ['fine']);
    cf_rm($d);
});

camtest_test('F-18: a half-written temporary file from a cut-short save is cleaned up later, never read', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    file_put_contents($d . '/data/settings.json.tmpdeadbeef0000', '{"auth_pass": "half');
    touch($d . '/data/settings.json.tmpdeadbeef0000', time() - 7200);
    file_put_contents($d . '/data/settings.json.tmpfresh0000', 'being written right now');
    camtest_assert_equal(camdash_load_config($d)['auth_pass'], 'base-password-1', 'a temp file is never read as settings');
    camdash_update_config(function (array $c) { $c['record_seconds'] = 30; return $c; }, $d);
    camtest_assert_true(!file_exists($d . '/data/settings.json.tmpdeadbeef0000'), 'the old leftover is removed');
    camtest_assert_true(file_exists($d . '/data/settings.json.tmpfresh0000'), 'a fresh one (another save in progress) is left alone');
    cf_rm($d);
});

camtest_test('F-18: 8 processes saving at the same moment lose nothing (data/ mode)', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    $codes = cf_run_workers($d, 8, 12);
    camtest_assert_equal($codes, array_fill(0, 8, 0), 'every worker finished its saves');
    $ids = array_column(camdash_load_config($d)['cameras'], 'id');
    camtest_assert_equal(count($ids), 97, 'the camera from config.php and all 96 added ones');
    camtest_assert_equal(count(array_unique($ids)), count($ids), 'no duplicates');
    foreach ([0, 7] as $w) foreach ([0, 11] as $i) camtest_assert_true(in_array("w$w-i$i", $ids, true), "w$w-i$i present");
    camtest_assert_true(in_array('base-cam', $ids, true), 'the camera from config.php is still there');
    camtest_assert_true(is_array(json_decode(file_get_contents($d . '/data/settings.json'), true)), 'the file is whole');
    camtest_assert_equal(cf_json_files($d), ['settings.json', 'settings.lock']);
    cf_rm($d);
});

camtest_test('F-18: 8 processes saving at the same moment lose nothing (old way: config.php in place)', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(false);
    $codes = cf_run_workers($d, 8, 12);
    camtest_assert_equal($codes, array_fill(0, 8, 0));
    $c = require $d . '/config.php';
    $ids = array_column($c['cameras'], 'id');
    camtest_assert_equal(count($ids), 97, 'the base camera and all 96 added ones');
    camtest_assert_equal(count(array_unique($ids)), 97);
    cf_rm($d);
});

camtest_test('F-18: camdash_config_writable and the mode switch', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(false);
    camtest_assert_true(!camdash_override_mode($d) && camdash_config_writable($d), 'before deploy.sh: the old way, config.php writable');
    mkdir($d . '/data', 0700);
    camtest_assert_true(camdash_override_mode($d) && camdash_config_writable($d), 'with data/: the new way');
    cf_rm($d);
    $e = cf_tmp();
    camtest_assert_true(!camdash_config_writable($e), 'nothing to write to');
    cf_rm($e);
});

camtest_test('F-18: a backup of settings.json goes outside the web folder when CAMDASH_BACKUP_DIR is set', function () {
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    $b = cf_tmp();
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'first-password-5'; return $c; }, $d);
    putenv('CAMDASH_BACKUP_DIR=' . $b . '/bk');
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'second-password-6'; return $c; }, $d);
    putenv('CAMDASH_BACKUP_DIR');
    camtest_assert_equal(json_decode(file_get_contents($b . '/bk/settings.json.bak'), true), ['auth_pass' => 'first-password-5'], 'the previous settings');
    camtest_assert_equal(substr(sprintf('%o', fileperms($b . '/bk/settings.json.bak')), -4), '0600');
    camtest_assert_true(!file_exists($d . '/data/settings.json.bak') && !file_exists($d . '/config.php.bak'), 'no copy inside the web folder');
    cf_rm($d);
    cf_rm($b);
});

camtest_test('F-18: the old way refuses to save while old settings in data/ would overrule it (data/ not writable)', function () {
    if (function_exists('posix_geteuid') && posix_geteuid() === 0) return;   // root can always write: nothing to show
    ini_set('error_log', '/dev/null');
    $d = cf_site(true);
    camdash_update_config(function (array $c) { $c['auth_pass'] = 'saved-password-7'; return $c; }, $d);
    chmod($d . '/data', 0500);
    $r = camdash_update_config(function (array $c) { $c['auth_pass'] = 'lost-password-8'; return $c; }, $d);
    chmod($d . '/data', 0700);
    camtest_assert_true($r['ok'] === false && strpos($r['error'], 'deploy.sh') !== false, json_encode($r));
    camtest_assert_equal(camdash_load_config($d)['auth_pass'], 'saved-password-7', 'nothing changed');
    cf_rm($d);
});

exit(camtest_summarize());
