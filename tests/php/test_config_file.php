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

exit(camtest_summarize());
