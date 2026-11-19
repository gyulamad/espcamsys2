<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';
require_once __DIR__ . '/../../php/cameras/lib/SearchIndex.php';

// test_search_index.php — the "Jump to any setting" search index builder (php/cameras/lib/SearchIndex.php,
// F-29 T7b): one entry per CONCRETE setting — a camera's key, a detector's key (opened through the camera
// it is paired with), a relay or dashboard field — with the value it shows, the url it opens and, above
// all, NO secret value anywhere in it.

// A slice of the device schema shaped like device_schema.php's rows (name, kind, locked, default, label,
// category, tier, apply), so the tests are about the BUILDER, not about a snapshot of the whole schema.
function si_schema(): array
{
    return [
        'recorder' => ['keys' => [
            ['name' => 'WIFI', 'kind' => 'wifi', 'locked' => true, 'help' => 'the networks to join', 'default' => null, 'label' => null, 'category' => null, 'tier' => null, 'apply' => null],
            ['name' => 'JPEG_Q_MIN', 'kind' => 'int', 'locked' => false, 'help' => 'the best quality', 'default' => '12', 'label' => 'Best JPEG quality', 'category' => 'Picture & link', 'tier' => 'basic', 'apply' => 'live'],
            ['name' => 'JPEG_Q_DROP', 'kind' => 'bool', 'locked' => false, 'help' => 'shrink on a slow link', 'default' => '1', 'label' => 'Lower quality on a slow link', 'category' => 'Picture & link', 'tier' => 'basic', 'apply' => 'live'],
            ['name' => 'LOG_HEARTBEAT', 'kind' => 'int', 'locked' => false, 'help' => 'seconds between status lines', 'default' => '600', 'label' => 'Seconds between status lines', 'category' => 'Logging', 'tier' => 'advanced', 'apply' => 'live'],
            ['name' => 'SER_BAUD', 'kind' => 'int', 'locked' => false, 'help' => 'serial console speed', 'default' => '115200', 'label' => 'Serial speed (baud)', 'category' => 'Hardware & internals', 'tier' => 'expert', 'apply' => 'reboot'],
        ]],
        'detector' => ['keys' => [
            ['name' => 'DETECTOR_ID', 'kind' => 'id', 'locked' => true, 'help' => "this detector's name", 'default' => null, 'label' => null, 'category' => null, 'tier' => null, 'apply' => null],
            ['name' => 'STREAM_JPEG_Q', 'kind' => 'int', 'locked' => false, 'help' => 'JPEG quality of the picture', 'default' => '80', 'label' => 'Live view JPEG quality', 'category' => 'Picture & live view', 'tier' => 'basic', 'apply' => 'reboot'],
            ['name' => 'DARK_THRESH', 'kind' => 'int', 'locked' => false, 'help' => 'darkness threshold', 'default' => '40', 'label' => 'Darkness threshold (0 = off)', 'category' => 'Detection', 'tier' => 'basic', 'apply' => 'live'],
        ]],
    ];
}

function si_camera(array $over = []): array
{
    return array_merge(['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪'], $over);
}

camtest_test('a camera key becomes one entry with everything the hit shows', function () {
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(), null, 'recorder');
    camtest_assert_equal(5, count($e));
    $min = $e[1];
    camtest_assert_equal('cameras', $min['scope']);
    camtest_assert_equal('JPEG_Q_MIN', $min['key']);
    camtest_assert_equal('Best JPEG quality', $min['label']);
    camtest_assert_equal('Picture & link', $min['category']);
    camtest_assert_equal('basic', $min['tier']);
    camtest_assert_equal('live', $min['apply']);
    camtest_assert_equal(false, $min['locked']);
    camtest_assert_equal('12', $min['value']);          // not reported: the default, like the settings page shows
    camtest_assert_equal('cam-a', $min['deviceId']);
    camtest_assert_equal('Front door', $min['deviceName']);
    camtest_assert_equal('🚪', $min['deviceIcon']);
    camtest_assert_equal('camera-settings-page.php?cam=cam-a&find=JPEG_Q_MIN', $min['url']);
});

camtest_test('the reported value wins over the default, and a boolean reads on/off', function () {
    $state = ['reported' => ['settings' => ['JPEG_Q_MIN' => '10', 'JPEG_Q_DROP' => '0', 'WIFI' => 'net:********']]];
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(), $state, 'recorder');
    camtest_assert_equal('10', $e[1]['value']);
    camtest_assert_equal('off', $e[2]['value']);
    camtest_assert_equal('net:********', $e[0]['value']);   // masked upstream, shown as the settings page shows it
});

camtest_test('a key the board never stored and that has no default shows no value', function () {
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(), null, 'recorder');
    camtest_assert_equal(null, $e[0]['value']);   // WIFI: locked, no default
    $state = ['reported' => ['settings' => []]];
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(), $state, 'recorder');
    camtest_assert_equal(null, $e[0]['value']);
});

camtest_test('a state document that is missing or broken falls back to the defaults', function () {
    foreach ([null, [], ['reported' => null], ['reported' => ['settings' => 'junk']], 'junk'] as $bad) {
        $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(), $bad, 'recorder');
        camtest_assert_equal(5, count($e), var_export($bad, true));
        camtest_assert_equal('12', $e[1]['value'], var_export($bad, true));
        camtest_assert_equal('600', $e[3]['value'], var_export($bad, true));
    }
});

camtest_test('a detector key opens the paired camera’s CALIBRATE page, with the camera as the device', function () {
    $e = CamSearchIndex::deviceEntries('detectors', si_schema()['detector']['keys'], si_camera(), null, 'detector');
    $q = $e[1];
    camtest_assert_equal('detectors', $q['scope']);
    camtest_assert_equal('STREAM_JPEG_Q', $q['key']);
    camtest_assert_equal('Picture & live view', $q['category']);
    camtest_assert_equal('camera-settings-page.php?cam=cam-a&type=detector&find=STREAM_JPEG_Q', $q['url']);
    camtest_assert_equal('Front door', $q['deviceName']);
});

camtest_test('urls are percent-encoded, so an id with special characters cannot break the link', function () {
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(['id' => 'cam a&b']), null, 'recorder');
    camtest_assert_equal('camera-settings-page.php?cam=cam%20a%26b&find=JPEG_Q_MIN', $e[1]['url']);
    camtest_assert_equal('settings-page.php?find=alarmRecordSeconds', CamSearchIndex::relayUrl('alarmRecordSeconds'));
    camtest_assert_equal('settings-page.php?find=a%26b', CamSearchIndex::relayUrl('a&b'));
});

camtest_test('a camera without a name is named by its id, so the device chip is never empty', function () {
    $e = CamSearchIndex::deviceEntries('cameras', si_schema()['recorder']['keys'], si_camera(['name' => '', 'id' => 'cam-x']), null, 'recorder');
    camtest_assert_equal('cam-x', $e[1]['deviceName']);
});

camtest_test('a relay field becomes an entry: its group is the category, restart says reboot', function () {
    $fields = [
        ['key' => 'alarmRecordSeconds', 'type' => 'int', 'group' => 'Recording', 'tier' => 'basic', 'restart' => false, 'value' => 10, 'label' => 'Alarm recording length', 'help' => 'how long an alarm records'],
        ['key' => 'pushPort', 'type' => 'int', 'group' => 'Network', 'tier' => 'advanced', 'restart' => true, 'value' => 8081, 'label' => 'Push port', 'help' => 'raw push port'],
        ['key' => 'personScanPython', 'type' => 'string', 'group' => 'Detectors', 'restart' => false, 'locked' => true, 'value' => '/usr/bin/python3', 'label' => 'Python program', 'help' => 'what runs the person check'],
        ['key' => 'loopWatch', 'type' => 'bool', 'group' => 'Diagnostics', 'tier' => 'expert', 'restart' => false, 'value' => true, 'label' => 'Loop watchdog', 'help' => 'watch the main loop'],
    ];
    $e = CamSearchIndex::relayEntries($fields);
    camtest_assert_equal(4, count($e));
    camtest_assert_equal('relay', $e[0]['scope']);
    camtest_assert_equal('Recording', $e[0]['category']);
    camtest_assert_equal('10', $e[0]['value']);
    camtest_assert_equal('live', $e[0]['apply']);
    camtest_assert_equal('reboot', $e[1]['apply']);           // restarts relay → the device pages' word for it
    camtest_assert_equal(true, $e[2]['locked']);
    camtest_assert_equal('settings-page.php?find=pushPort', $e[1]['url']);
    camtest_assert_equal('true', $e[3]['value']);             // the text the relay stores and the switch sends
    camtest_assert_equal('Relay', $e[0]['deviceName']);
});

camtest_test('a relay secret says whether it is set, and nothing more', function () {
    $fields = [
        ['key' => 'controlKey', 'type' => 'secret', 'group' => 'Keys', 'restart' => false, 'isSet' => true, 'label' => 'Control key', 'help' => 'the dashboard’s key'],
        ['key' => 'telegramBotToken', 'type' => 'secret', 'group' => 'Notifications', 'restart' => false, 'isSet' => false, 'label' => 'Telegram bot token', 'help' => 'bot token'],
    ];
    $e = CamSearchIndex::relayEntries($fields);
    camtest_assert_equal('(set)', $e[0]['value']);
    camtest_assert_equal('(not set)', $e[1]['value']);
});

camtest_test('relayEntries skips a row that is not a field', function () {
    camtest_assert_equal([], CamSearchIndex::relayEntries([]));
    camtest_assert_equal([], CamSearchIndex::relayEntries([null, 'junk', ['nokey' => true], []]));
    $e = CamSearchIndex::relayEntries([null, 'junk', ['nokey' => true], ['key' => 'port', 'type' => 'int', 'group' => 'Network', 'value' => 8080]]);
    camtest_assert_equal(1, count($e));
    camtest_assert_equal('8080', $e[0]['value']);
});

camtest_test('the dashboard’s own settings become entries, values read from the config', function () {
    $config = ['auth_user' => 'owner', 'auth_pass' => 'a-long-pass', 'relay_url' => 'http://127.0.0.1:8080'];
    $e = CamSearchIndex::dashboardEntries($config);
    $byKey = [];
    foreach ($e as $x) {
        $byKey[$x['key']] = $x;
    }
    camtest_assert_equal('Dashboard username', $byKey['auth_user']['label']);
    camtest_assert_equal('owner', $byKey['auth_user']['value']);
    camtest_assert_equal('Dashboard', $byKey['auth_user']['category']);
    camtest_assert_equal('(set)', $byKey['auth_pass']['value']);        // the password itself never leaves the server
    camtest_assert_equal('http://127.0.0.1:8080', $byKey['relay_url']['value']);
    camtest_assert_equal('settings-page.php?find=auth_user', $byKey['auth_user']['url']);
    camtest_assert_equal('60', $byKey['record_seconds']['value']);      // CamLogic::intSetting's default
    camtest_assert_equal('Recording', $byKey['record_seconds']['category']);
    camtest_assert_equal('10', $byKey['slideshow_seconds']['value']);
});

camtest_test('build: cameras first, then the detectors of the cameras that have one, then the relay', function () {
    $config = ['auth_user' => 'owner', 'auth_pass' => 'x'];
    $out = CamSearchIndex::build(si_schema(), [si_camera(), si_camera(['id' => 'cam-b', 'name' => 'Back gate', 'icon' => '🌳', 'detector' => 'det-1'])],
        ['cam-a' => ['reported' => ['settings' => ['LOG_HEARTBEAT' => '900']]]],
        ['det-1' => ['reported' => ['settings' => ['DARK_THRESH' => '35']]]],
        [['key' => 'port', 'type' => 'int', 'group' => 'Network', 'value' => 8080]],
        null, $config);
    camtest_assert_equal(['cameras', 'detectors', 'relay'], $out['scopes']);
    camtest_assert_equal(null, $out['relayError']);
    $scopes = array_map(function ($e) {
        return $e['scope'];
    }, $out['entries']);
    // the order inside a scope stays the schema's; the scopes come in blocks
    camtest_assert_equal(true, array_search('cameras', $scopes) < array_search('detectors', $scopes)
        && array_search('detectors', $scopes) < array_search('relay', $scopes), json_encode($scopes));
    $det = array_values(array_filter($out['entries'], function ($e) {
        return $e['scope'] === 'detectors';
    }));
    camtest_assert_equal(3, count($det));   // only cam-b has a detector paired
    camtest_assert_equal('35', $det[2]['value']);   // DARK_THRESH reported by det-1
    $cams = array_values(array_filter($out['entries'], function ($e) {
        return $e['scope'] === 'cameras';
    }));
    camtest_assert_equal(10, count($cams));   // two cameras × five keys
    $hb = array_values(array_filter($out['entries'], function ($e) {
        return $e['scope'] === 'cameras' && $e['key'] === 'LOG_HEARTBEAT' && $e['deviceId'] === 'cam-a';
    }));
    camtest_assert_equal('900', $hb[0]['value']);   // cam-a reported it
    $hb2 = array_values(array_filter($out['entries'], function ($e) {
        return $e['scope'] === 'cameras' && $e['key'] === 'LOG_HEARTBEAT' && $e['deviceId'] === 'cam-b';
    }));
    camtest_assert_equal('600', $hb2[0]['value']);  // cam-b did not: its default
});

camtest_test('build: without the relay the devices are still indexed, and relayError says what is missing', function () {
    $out = CamSearchIndex::build(si_schema(), [si_camera()], [], [], null, 'The relay could not be reached', ['auth_user' => 'o']);
    camtest_assert_equal('The relay could not be reached', $out['relayError']);
    $scopes = array_map(function ($e) {
        return $e['scope'];
    }, $out['entries']);
    camtest_assert_equal(['cameras'], array_values(array_unique($scopes)));
    camtest_assert_equal(5, count($out['entries']));
});

camtest_test('build: a camera row that is not a camera row is skipped', function () {
    $out = CamSearchIndex::build(si_schema(), [null, 'junk', ['id' => ''], ['id' => 'cam-ok']], [], [], null, null, []);
    $scopes = array_map(function ($e) {
        return $e['scope'];
    }, $out['entries']);
    camtest_assert_equal(['cameras'], array_values(array_unique($scopes)));
    camtest_assert_equal(5, count($out['entries']));
});

camtest_test('the search index agrees with the schema the pages draw from: every recorder key is an entry', function () {
    $schema = require __DIR__ . '/../../php/cameras/lib/device_schema.php';
    $cam = si_camera(['id' => 'cam-zz']);
    $e = CamSearchIndex::deviceEntries('cameras', $schema['recorder']['keys'], $cam, null, 'recorder');
    camtest_assert_equal(count($schema['recorder']['keys']), count($e));
    $byName = [];
    foreach ($e as $x) {
        $byName[$x['key']] = $x;
    }
    foreach ($schema['recorder']['keys'] as $k) {
        camtest_assert_true(isset($byName[$k['name']]), $k['name']);
        // the url must land on the page that really edits this key: every name is a rawurlencode-safe ASCII key
        camtest_assert_equal('camera-settings-page.php?cam=cam-zz&find=' . $k['name'], $byName[$k['name']]['url'], $k['name']);
    }
});

exit(camtest_summarize());
