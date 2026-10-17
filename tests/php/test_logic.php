<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';

// ── checkCredentials ─────────────────────────────────────────────────

camtest_test('checkCredentials accepts matching user and password', function () {
    camtest_assert_true(CamLogic::checkCredentials('admin', 'secret', 'admin', 'secret'));
});

camtest_test('checkCredentials rejects a wrong password', function () {
    camtest_assert_true(!CamLogic::checkCredentials('admin', 'secret', 'admin', 'nope'));
});

camtest_test('checkCredentials rejects a wrong username', function () {
    camtest_assert_true(!CamLogic::checkCredentials('admin', 'secret', 'nope', 'secret'));
});

// ── attachRelayUrl ───────────────────────────────────────────────────

camtest_test('attachRelayUrl adds url to every camera and trims a trailing slash', function () {
    $cams = CamLogic::attachRelayUrl(
        [['id' => 'cam1', 'name' => 'Front'], ['id' => 'cam2', 'name' => 'Back']],
        'http://host:8080/'
    );
    camtest_assert_equal($cams[0]['url'], 'http://host:8080');
    camtest_assert_equal($cams[1]['url'], 'http://host:8080');
});

// ── findCameraById ───────────────────────────────────────────────────

camtest_test('findCameraById finds a matching camera', function () {
    $cams = [['id' => 'cam1'], ['id' => 'cam2']];
    $found = CamLogic::findCameraById($cams, 'cam2');
    camtest_assert_equal($found['id'], 'cam2');
});

camtest_test('findCameraById returns null when there is no match', function () {
    camtest_assert_equal(CamLogic::findCameraById([['id' => 'cam1']], 'camX'), null);
});

// ── computeGridColumns ───────────────────────────────────────────────

camtest_test('computeGridColumns: a single camera gets one column', function () {
    camtest_assert_equal(CamLogic::computeGridColumns(1), 1);
});

camtest_test('computeGridColumns: two to four cameras get two columns', function () {
    camtest_assert_equal(CamLogic::computeGridColumns(2), 2);
    camtest_assert_equal(CamLogic::computeGridColumns(4), 2);
});

camtest_test('computeGridColumns: more than four cameras get three columns', function () {
    camtest_assert_equal(CamLogic::computeGridColumns(5), 3);
    camtest_assert_equal(CamLogic::computeGridColumns(12), 3);
});

// ── validatePositiveIntParam ─────────────────────────────────────────

camtest_test('validatePositiveIntParam accepts plain digits', function () {
    camtest_assert_equal(CamLogic::validatePositiveIntParam('60'), 60);
});

camtest_test('validatePositiveIntParam rejects zero, negative and non-numeric input', function () {
    camtest_assert_equal(CamLogic::validatePositiveIntParam('0'), null);
    camtest_assert_equal(CamLogic::validatePositiveIntParam('-5'), null);
    camtest_assert_equal(CamLogic::validatePositiveIntParam('abc'), null);
    camtest_assert_equal(CamLogic::validatePositiveIntParam(''), null);
    camtest_assert_equal(CamLogic::validatePositiveIntParam(null), null);
});

// ── extractStatusCode ────────────────────────────────────────────────

camtest_test('extractStatusCode finds the status line', function () {
    $headers = ['HTTP/1.1 404 Not Found', 'Content-Type: application/json'];
    camtest_assert_equal(CamLogic::extractStatusCode($headers), 404);
});

camtest_test('extractStatusCode returns null with no status line present', function () {
    camtest_assert_equal(CamLogic::extractStatusCode(['Content-Type: application/json']), null);
});

// ── extractPassThroughHeaders ────────────────────────────────────────

camtest_test('extractPassThroughHeaders keeps only Range-related headers', function () {
    $headers = [
        'HTTP/1.1 206 Partial Content',
        'Content-Type: video/mp4',
        'Content-Range: bytes 0-99/200',
        'Content-Length: 100',
        'Accept-Ranges: bytes',
    ];
    camtest_assert_equal(
        CamLogic::extractPassThroughHeaders($headers),
        ['Content-Range: bytes 0-99/200', 'Content-Length: 100', 'Accept-Ranges: bytes']
    );
});

// ── isSafeFilename ───────────────────────────────────────────────────

camtest_test('isSafeFilename accepts a relay-generated recording name', function () {
    camtest_assert_true(CamLogic::isSafeFilename('cam1_2024-01-01T00-00-00-000Z.mp4'));
});

camtest_test('isSafeFilename rejects path traversal attempts', function () {
    camtest_assert_true(!CamLogic::isSafeFilename('../../etc/passwd'));
    camtest_assert_true(!CamLogic::isSafeFilename('sub/dir.mp4'));
});

camtest_test('isSafeFilename rejects the wrong extension', function () {
    camtest_assert_true(!CamLogic::isSafeFilename('video.mov'));
});

// ── buildSettingsQuery ───────────────────────────────────────────────

camtest_test('buildSettingsQuery builds the alarmRecordSeconds query', function () {
    camtest_assert_equal(CamLogic::buildSettingsQuery(10), 'alarmRecordSeconds=10');
});

camtest_test('buildSettingsQuery returns an empty string when nothing is provided', function () {
    camtest_assert_equal(CamLogic::buildSettingsQuery(null), '');
});

// ── buildContentDispositionHeader ────────────────────────────────────

camtest_test('buildContentDispositionHeader', function () {
    camtest_assert_equal(
        CamLogic::buildContentDispositionHeader('attachment', 'cam1_x.mp4'),
        'attachment; filename="cam1_x.mp4"'
    );
});

// ── extractContentType ───────────────────────────────────────────────

camtest_test('extractContentType uses the relay-provided header when present', function () {
    $wrapperData = ['HTTP/1.1 200 OK', 'Content-Type: multipart/x-mixed-replace; boundary=frame'];
    camtest_assert_equal(
        CamLogic::extractContentType($wrapperData, 'fallback'),
        'multipart/x-mixed-replace; boundary=frame'
    );
});

camtest_test('extractContentType falls back when the header is absent', function () {
    camtest_assert_equal(CamLogic::extractContentType(['HTTP/1.1 200 OK'], 'fallback'), 'fallback');
});

// ── FILES (N) button: formatFilesButtonLabel / parseStatusCounts / parseRecordingCount ──

camtest_test('formatFilesButtonLabel shows the number, 0 included', function () {
    camtest_assert_equal(CamLogic::formatFilesButtonLabel(3), '📼 FILES (3)');
    camtest_assert_equal(CamLogic::formatFilesButtonLabel(0), '📼 FILES (0)');
});

camtest_test('formatFilesButtonLabel shows no number when the count is unknown (not a wrong one)', function () {
    camtest_assert_equal(CamLogic::formatFilesButtonLabel(null), '📼 FILES');
});

camtest_test('parseStatusCounts reads recordingCount for every camera that has one', function () {
    $json = '{"cam1":{"recording":false,"recordingCount":3},"cam2":{"recordingCount":0}}';
    camtest_assert_equal(CamLogic::parseStatusCounts($json), ['cam1' => 3, 'cam2' => 0]);
});

camtest_test('parseStatusCounts skips cameras without a whole-number count (old relay, unreadable folder)', function () {
    $json = '{"old":{"recording":false},"bad":{"recordingCount":null},"str":{"recordingCount":"4"},"neg":{"recordingCount":-1},"ok":{"recordingCount":2}}';
    camtest_assert_equal(CamLogic::parseStatusCounts($json), ['ok' => 2]);
});

camtest_test('parseStatusCounts yields nothing for an error body or garbage', function () {
    camtest_assert_equal(CamLogic::parseStatusCounts('{"error":"Could not reach relay"}'), []);
    camtest_assert_equal(CamLogic::parseStatusCounts('Internal Server Error'), []);
    camtest_assert_equal(CamLogic::parseStatusCounts(''), []);
    camtest_assert_equal(CamLogic::parseStatusCounts('[]'), []);
});

camtest_test('parseRecordingCount counts the entries of the relay file list', function () {
    camtest_assert_equal(CamLogic::parseRecordingCount('[{"filename":"a.mp4"},{"filename":"b.mp4"}]'), 2);
    camtest_assert_equal(CamLogic::parseRecordingCount('[]'), 0);
});

camtest_test('parseRecordingCount is null for anything that is not a list', function () {
    camtest_assert_equal(CamLogic::parseRecordingCount('{"error":"nope"}'), null);
    camtest_assert_equal(CamLogic::parseRecordingCount('Internal Server Error'), null);
    camtest_assert_equal(CamLogic::parseRecordingCount('42'), null);
});

// ── collectRecordingCounts ───────────────────────────────────────────

// A fake relay: $routes maps URL => body (null = unreachable). Records every URL asked.
function camtest_fake_relay(array $routes, array &$asked): callable
{
    return function (string $url) use ($routes, &$asked): ?string {
        $asked[] = $url;
        return array_key_exists($url, $routes) ? $routes[$url] : null;
    };
}
function camtest_cams(): array
{
    return CamLogic::attachRelayUrl([['id' => 'cam1'], ['id' => 'cam2'], ['id' => 'cam3']], 'http://relay:8080');
}

camtest_test('collectRecordingCounts: a current relay answers everything with ONE request', function () {
    $asked = [];
    $fetch = camtest_fake_relay([
        'http://relay:8080/status' => '{"cam1":{"recordingCount":3},"cam2":{"recordingCount":0},"cam3":{"recordingCount":12}}',
    ], $asked);
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), ['cam1' => 3, 'cam2' => 0, 'cam3' => 12]);
    camtest_assert_equal($asked, ['http://relay:8080/status']);
});

camtest_test('collectRecordingCounts: an OLDER relay (no counts in /status) falls back to each camera\'s file list', function () {
    $asked = [];
    $fetch = camtest_fake_relay([
        'http://relay:8080/status' => '{"cam1":{"recording":false},"cam2":{"recording":false},"cam3":{"recording":false}}',
        'http://relay:8080/recordings/cam1' => '[{"filename":"a.mp4"},{"filename":"b.mp4"},{"filename":"c.mp4"}]',
        'http://relay:8080/recordings/cam2' => '[]',
        'http://relay:8080/recordings/cam3' => '[{"filename":"x.mp4"}]',
    ], $asked);
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), ['cam1' => 3, 'cam2' => 0, 'cam3' => 1]);
});

camtest_test('collectRecordingCounts: only cameras still missing a count get a list request', function () {
    $asked = [];
    $fetch = camtest_fake_relay([
        'http://relay:8080/status' => '{"cam1":{"recordingCount":5},"cam3":{"recordingCount":null}}',
        'http://relay:8080/recordings/cam2' => '[{"filename":"a.mp4"}]',
        'http://relay:8080/recordings/cam3' => '[{"filename":"a.mp4"},{"filename":"b.mp4"}]',
    ], $asked);
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), ['cam1' => 5, 'cam2' => 1, 'cam3' => 2]);
    camtest_assert_equal($asked, [
        'http://relay:8080/status',
        'http://relay:8080/recordings/cam2',
        'http://relay:8080/recordings/cam3',
    ]);
});

camtest_test('collectRecordingCounts: relay unreachable -> nothing, after exactly ONE attempt (no timeout per camera)', function () {
    $asked = [];
    $fetch = camtest_fake_relay([], $asked); // every URL unreachable
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), []);
    camtest_assert_equal(count($asked), 1);
});

camtest_test('collectRecordingCounts: relay dies midway -> keeps what it has and stops asking', function () {
    $asked = [];
    $fetch = camtest_fake_relay([
        'http://relay:8080/status' => '{"cam1":{"recordingCount":4}}',
        'http://relay:8080/recordings/cam2' => null, // unreachable now
    ], $asked);
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), ['cam1' => 4]);
    camtest_assert_equal(count($asked), 2, 'status + the one failed list request, then it gives up');
});

camtest_test('collectRecordingCounts: an error-shaped list answer leaves that camera without a number', function () {
    $asked = [];
    $fetch = camtest_fake_relay([
        'http://relay:8080/status' => '{}',
        'http://relay:8080/recordings/cam1' => '{"error":"x"}',
        'http://relay:8080/recordings/cam2' => '[{"filename":"a.mp4"}]',
        'http://relay:8080/recordings/cam3' => 'Internal Server Error',
    ], $asked);
    camtest_assert_equal(CamLogic::collectRecordingCounts(camtest_cams(), $fetch), ['cam2' => 1]);
});

camtest_test('collectRecordingCounts: no cameras -> no requests at all', function () {
    $asked = [];
    camtest_assert_equal(CamLogic::collectRecordingCounts([], camtest_fake_relay([], $asked)), []);
    camtest_assert_equal($asked, []);
});

// ── Recording ON/OFF switch: buildSwitchRequest / buildActor / buildSwitchHeaders ──

function camtest_switch_cams(): array
{
    return CamLogic::attachRelayUrl([['id' => 'cam1', 'name' => 'A'], ['id' => 'cam2', 'name' => 'B']], 'http://relay:8080/');
}

camtest_test('isDashboardAjaxRequest accepts only the dashboard\'s own header', function () {
    camtest_assert_true(CamLogic::isDashboardAjaxRequest(['HTTP_X_REQUESTED_WITH' => 'camdash']));
    camtest_assert_true(!CamLogic::isDashboardAjaxRequest([]));
    camtest_assert_true(!CamLogic::isDashboardAjaxRequest(['HTTP_X_REQUESTED_WITH' => 'XMLHttpRequest']));
    camtest_assert_true(!CamLogic::isDashboardAjaxRequest(['HTTP_X_REQUESTED_WITH' => '']));
});

camtest_test('buildSwitchRequest: one camera OFF for N minutes', function () {
    $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'cam' => 'cam2', 'action' => 'off', 'minutes' => '30'], camtest_switch_cams());
    camtest_assert_equal($r, ['ok' => true, 'url' => 'http://relay:8080/recording/camera/cam2/off?minutes=30']);
});

camtest_test('buildSwitchRequest: no minutes means the relay\'s default; ON never carries minutes', function () {
    $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off'], camtest_switch_cams());
    camtest_assert_equal($r['url'], 'http://relay:8080/recording/camera/cam1/off');
    $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off', 'minutes' => ''], camtest_switch_cams());
    camtest_assert_equal($r['url'], 'http://relay:8080/recording/camera/cam1/off');
    $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'cam' => 'cam1', 'action' => 'on', 'minutes' => '30'], camtest_switch_cams());
    camtest_assert_equal($r['url'], 'http://relay:8080/recording/camera/cam1/on');
});

camtest_test('buildSwitchRequest: 0 and negative minutes pass through (they mean "until switched ON")', function () {
    foreach (['0', '-1', '-60', ' 15 '] as $m) {
        $r = CamLogic::buildSwitchRequest(['scope' => 'all', 'action' => 'off', 'minutes' => $m], camtest_switch_cams());
        camtest_assert_true($r['ok'], "minutes=$m");
        camtest_assert_equal($r['url'], 'http://relay:8080/recording/all/off?minutes=' . urlencode(trim($m)));
    }
});

camtest_test('buildSwitchRequest: all cameras, ON and OFF', function () {
    camtest_assert_equal(CamLogic::buildSwitchRequest(['scope' => 'all', 'action' => 'on'], camtest_switch_cams())['url'], 'http://relay:8080/recording/all/on');
    camtest_assert_equal(CamLogic::buildSwitchRequest(['scope' => 'all', 'action' => 'off', 'minutes' => '5'], camtest_switch_cams())['url'], 'http://relay:8080/recording/all/off?minutes=5');
});

camtest_test('buildSwitchRequest: junk is rejected with 400 before anything is sent', function () {
    $bad = [
        ['scope' => 'camera', 'cam' => 'cam1', 'action' => 'toggle'],
        ['scope' => 'camera', 'cam' => 'cam1'],
        ['scope' => 'everything', 'action' => 'off'],
        ['action' => 'off'],
        ['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off', 'minutes' => 'abc'],
        ['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off', 'minutes' => '1.5'],
        ['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off', 'minutes' => '1e3'],
        ['scope' => 'camera', 'cam' => 'cam1', 'action' => 'off', 'minutes' => ['1']],
        ['scope' => 'all', 'action' => ['off']],
    ];
    foreach ($bad as $q) {
        $r = CamLogic::buildSwitchRequest($q, camtest_switch_cams());
        camtest_assert_true(!$r['ok'] && $r['status'] === 400, json_encode($q));
    }
});

camtest_test('buildSwitchRequest: a camera that is not configured is a 404, and cannot smuggle a path', function () {
    foreach (['nope', '', '../cam1', 'cam1/../x', 'cam1?x=1'] as $cam) {
        $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'cam' => $cam, 'action' => 'off'], camtest_switch_cams());
        camtest_assert_true(!$r['ok'] && $r['status'] === 404, json_encode($cam));
    }
    $r = CamLogic::buildSwitchRequest(['scope' => 'camera', 'action' => 'off'], camtest_switch_cams());
    camtest_assert_equal($r['status'], 404, 'no cam given');
    $r = CamLogic::buildSwitchRequest(['scope' => 'all', 'action' => 'on'], []);
    camtest_assert_equal($r['status'], 404, 'no cameras configured');
});

camtest_test('buildActor: user@address, reduced to harmless characters and capped', function () {
    camtest_assert_equal(CamLogic::buildActor('alice', '127.0.0.1'), 'alice@127.0.0.1');
    $evil = CamLogic::buildActor("al\r\nX-Evil: 1 ice", '::1');
    camtest_assert_equal($evil, 'al__X-Evil:_1_ice@::1', 'line breaks and spaces become underscores (":" is kept for IPv6 and is harmless inside a value)');
    camtest_assert_true(!preg_match('/[\r\n]/', $evil), 'no line break survives, so no header can be injected');
    camtest_assert_equal(strlen(CamLogic::buildActor(str_repeat('a', 200), '1.2.3.4')), 80);
});

camtest_test('buildSwitchHeaders: carries the control key and the actor', function () {
    camtest_assert_equal(CamLogic::buildSwitchHeaders('s3cret', 'alice@1.2.3.4'),
        "Content-Length: 0\r\nX-Control-Key: s3cret\r\nX-Actor: alice@1.2.3.4\r\n");
});

camtest_test('buildSwitchHeaders: refuses an empty key or one that could inject headers', function () {
    camtest_assert_equal(CamLogic::buildSwitchHeaders('', 'a'), null);
    camtest_assert_equal(CamLogic::buildSwitchHeaders("key\r\nX-Evil: 1", 'a'), null);
    camtest_assert_equal(CamLogic::buildSwitchHeaders("key\nmore", 'a'), null);
});

// ── Settings page ────────────────────────────────────────────────────

camtest_test('splitSettingsValues: separates the dashboard\'s own settings from the relay\'s', function () {
    $r = CamLogic::splitSettingsValues(['auth_user' => 'bob', 'preRollSeconds' => 9, 'relay_url' => 'http://x:1', 'camKey' => 'abc']);
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['dashboard'], ['auth_user' => 'bob', 'relay_url' => 'http://x:1']);
    camtest_assert_equal($r['relay'], ['preRollSeconds' => 9, 'camKey' => 'abc']);
});

camtest_test('splitSettingsValues: refuses anything that is not an object of plain values', function () {
    foreach ([null, 'text', [1, 2], ['a' => ['nested']], ['a' => null], ['a' => true]] as $bad) {
        camtest_assert_equal(CamLogic::splitSettingsValues($bad)['ok'], false, var_export($bad, true));
    }
});

camtest_test('normalizeRelayUrl: accepts http(s) addresses and drops the trailing slash', function () {
    camtest_assert_equal(CamLogic::normalizeRelayUrl(' http://192.168.4.9:8080/ '), 'http://192.168.4.9:8080');
    camtest_assert_equal(CamLogic::normalizeRelayUrl('https://relay.local'), 'https://relay.local');
    camtest_assert_equal(CamLogic::normalizeRelayUrl('http://[::1]:8080'), 'http://[::1]:8080');
});

camtest_test('normalizeRelayUrl: refuses anything else (no scheme, other schemes, logins, queries, junk)', function () {
    foreach (['', 'relay:8080', 'ftp://x', 'file:///etc/passwd', 'http://u:p@x', 'http://x?a=1', 'http://x#f', 'http://', 'http://x:99999', "http://x\r\nHost: y", 'http://a b'] as $bad) {
        camtest_assert_equal(CamLogic::normalizeRelayUrl($bad), null, $bad);
    }
});

camtest_test('replaceUrlPort: moves the port and keeps scheme, host and path', function () {
    camtest_assert_equal(CamLogic::replaceUrlPort('http://192.168.4.9:8080', 9000), 'http://192.168.4.9:9000');
    camtest_assert_equal(CamLogic::replaceUrlPort('http://relay.local', 9000), 'http://relay.local:9000');
    camtest_assert_equal(CamLogic::replaceUrlPort('https://h:1/sub/', 2), 'https://h:2/sub');
    camtest_assert_equal(CamLogic::replaceUrlPort('http://h:1', 0), null);
    camtest_assert_equal(CamLogic::replaceUrlPort('nonsense', 80), null);
});

camtest_test('validateDashboardUpdate: only real changes are returned', function () {
    $cur = ['auth_user' => 'bob', 'auth_pass' => 'longenough1', 'relay_url' => 'http://x:8080'];
    $r = CamLogic::validateDashboardUpdate(['auth_user' => 'bob', 'auth_pass' => '', 'relay_url' => 'http://x:8080/'], $cur);
    camtest_assert_equal($r, ['ok' => true, 'changes' => []]);
    $r = CamLogic::validateDashboardUpdate(['auth_user' => ' alice ', 'auth_pass' => 'a-new-password', 'relay_url' => 'http://y:9'], $cur);
    camtest_assert_equal($r['changes'], ['auth_user' => 'alice', 'auth_pass' => 'a-new-password', 'relay_url' => 'http://y:9']);
});

camtest_test('validateDashboardUpdate: refuses bad logins and addresses, and unknown settings', function () {
    $cur = ['auth_user' => 'bob', 'auth_pass' => 'longenough1', 'relay_url' => 'http://x:8080'];
    foreach ([['auth_user' => ''], ['auth_user' => 'a:b'], ['auth_user' => str_repeat('x', 65)], ['auth_user' => "a\nb"],
              ['auth_pass' => 'short'], ['auth_pass' => "line\nbreak-pass"], ['relay_url' => 'nope'], ['bogus' => 'x']] as $bad) {
        camtest_assert_equal(CamLogic::validateDashboardUpdate($bad, $cur)['ok'], false, var_export($bad, true));
    }
});

camtest_test('isValidSecret: 8-200 characters without spaces or control characters', function () {
    camtest_assert_true(CamLogic::isValidSecret('abcdefgh'));
    foreach (['short', 'has space123', "tab\tkey12345", "nl\nkey12345", str_repeat('x', 201), ''] as $bad) {
        camtest_assert_true(!CamLogic::isValidSecret($bad), $bad);
    }
});

camtest_test('buildConfigPhp: round-trips the whole config, cameras and awkward characters included', function () {
    $cfg = [
        'auth_user' => "o'brien", 'auth_pass' => 'p"a$s\\s{$x}', 'relay_url' => 'http://127.0.0.1:8080',
        'relay_control_key' => 'k', 'cameras' => [['id' => 'cam1', 'name' => "Bob's door", 'icon' => '🚪']],
    ];
    $file = tempnam(sys_get_temp_dir(), 'cfg') . '.php';
    file_put_contents($file, CamLogic::buildConfigPhp($cfg));
    $loaded = require $file;
    unlink($file);
    camtest_assert_equal($loaded, $cfg);
});

camtest_test('buildControlHeaders: key and actor, with a JSON body or an empty one; refuses header injection', function () {
    camtest_assert_equal(CamLogic::buildControlHeaders('k1', 'a@b'), "X-Control-Key: k1\r\nX-Actor: a@b\r\nContent-Length: 0\r\n");
    camtest_assert_equal(CamLogic::buildControlHeaders('k1', 'a@b', true), "X-Control-Key: k1\r\nX-Actor: a@b\r\nContent-Type: application/json\r\n");
    camtest_assert_equal(CamLogic::buildControlHeaders('', 'a'), null);
    camtest_assert_equal(CamLogic::buildControlHeaders("k\r\nX-Evil: 1", 'a'), null);
});

camtest_test('dashboardFields: described like the relay\'s fields, and isDashboardKey agrees', function () {
    foreach (CamLogic::dashboardFields() as $f) {
        camtest_assert_true(isset($f['key'], $f['type'], $f['label'], $f['help'], $f['group']), $f['key'] ?? '?');
        camtest_assert_true(CamLogic::isDashboardKey($f['key']));
    }
    camtest_assert_true(!CamLogic::isDashboardKey('preRollSeconds'));
    camtest_assert_true(!CamLogic::isDashboardKey('controlKey'));
});

// ── Cameras on the dashboard (add / rename / remove) ──────────────────

camtest_test('addCamera: appends the camera and keeps the others', function () {
    $r = CamLogic::addCamera([['id' => 'cam1', 'name' => 'A', 'icon' => '🎥']], 'cam2', ' Yard ', '🌿');
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['cameras'][1], ['id' => 'cam2', 'name' => 'Yard', 'icon' => '🌿']);
    camtest_assert_equal(count($r['cameras']), 2);
});

camtest_test('addCamera: refuses a bad id, a duplicate (any letter case) and bad details', function () {
    $have = [['id' => 'Cam1', 'name' => 'A', 'icon' => 'x']];
    foreach (['', '-x', 'a b', 'a/b', '../etc', str_repeat('x', 65), 'ä'] as $bad) {
        camtest_assert_equal(CamLogic::addCamera($have, $bad, 'n', 'i')['ok'], false, 'id ' . $bad);
    }
    camtest_assert_equal(CamLogic::addCamera($have, 'cam1', 'n', 'i')['ok'], false, 'duplicate in another case');
    camtest_assert_equal(CamLogic::addCamera($have, 'cam2', '', 'i')['ok'], false, 'empty name');
    camtest_assert_equal(CamLogic::addCamera($have, 'cam2', 'n', '')['ok'], false, 'empty icon');
});

camtest_test('validateCameraDetails: length, line breaks and markup characters in the icon', function () {
    camtest_assert_equal(CamLogic::validateCameraDetails('Front door', '🚪'), null);
    foreach ([['', 'x'], [str_repeat('n', 61), 'x'], ["a\nb", 'x'], ['n', '123456789'], ['n', '<b>'], ['n', 'a"b'], ['n', "a'b"], ['n', "a\nb"]] as $bad) {
        camtest_assert_true(CamLogic::validateCameraDetails($bad[0], $bad[1]) !== null, json_encode($bad));
    }
});

camtest_test('updateCamera: changes name and icon only; other keys and the id stay', function () {
    $r = CamLogic::updateCamera([['id' => 'cam1', 'name' => 'A', 'icon' => 'x', 'extra' => 7]], 'cam1', 'B', 'y');
    camtest_assert_equal($r['cameras'][0], ['id' => 'cam1', 'name' => 'B', 'icon' => 'y', 'extra' => 7]);
    camtest_assert_equal(CamLogic::updateCamera([['id' => 'cam1', 'name' => 'A', 'icon' => 'x']], 'nope', 'B', 'y')['ok'], false);
});

camtest_test('removeCamera: removes one, keeps the order of the rest, refuses an unknown id', function () {
    $cams = [['id' => 'a', 'name' => 'A', 'icon' => 'x'], ['id' => 'b', 'name' => 'B', 'icon' => 'x'], ['id' => 'c', 'name' => 'C', 'icon' => 'x']];
    $r = CamLogic::removeCamera($cams, 'b');
    camtest_assert_equal(array_column($r['cameras'], 'id'), ['a', 'c']);
    camtest_assert_equal(CamLogic::removeCamera($cams, 'zzz')['ok'], false);
});

camtest_test('findCamera: exact id or null', function () {
    $cams = [['id' => 'a', 'name' => 'A', 'icon' => 'x']];
    camtest_assert_equal(CamLogic::findCamera($cams, 'a')['name'], 'A');
    camtest_assert_equal(CamLogic::findCamera($cams, 'A'), null);
});

// ── A camera's own settings ───────────────────────────────────────────

function camtest_schema(): array { return require __DIR__ . '/../../php/cameras/lib/device_schema.php'; }
function camtest_reported(): array {
    return ['WIFI' => 'net:********', 'SERVER_HOST' => '192.168.4.9', 'PUSH_PORT' => '8081', 'HTTP_PORT' => '8080', 'CAMERA_ID' => 'cam2',
            'API_KEY' => '********', 'PUSH_GAP_MUL' => '1.5', 'ALARM_GPIO_PIN' => '13', 'ALARM_ACTIVE' => 'LOW', 'ALARM_ALL_CAMS' => '0',
            'LOG_ENABLED' => '1', 'LOG_MIN_LEVEL' => '1', 'LOG_ECHO' => '1', 'LOG_RETRY_MAX' => '3', 'LOG_RETRY_SEC' => '300',
            'LOG_FLUSH_SEC' => '10', 'LOG_REPEAT_SEC' => '30', 'LOG_HEARTBEAT' => '600', 'LOG_LOW_HEAP' => '30000'];
}
function camtest_change(array $reported, array $values): array {
    $sc = camtest_schema();
    return CamLogic::buildDeviceChange($sc['recorder']['keys'], $sc['recorder']['gpios'], $reported, $values);
}

camtest_test('the generated schema is complete and the connection settings are the locked ones', function () {
    $sc = camtest_schema()['recorder'];
    camtest_assert_true(count($sc['keys']) >= 15 && count($sc['gpios']) >= 3);
    $locked = [];
    foreach ($sc['keys'] as $k) {
        camtest_assert_true(isset($k['name'], $k['kind'], $k['cond'], $k['help']) && array_key_exists('condKey', $k), $k['name'] ?? '?');
        if ($k['locked']) { $locked[] = $k['name']; }
    }
    sort($locked);
    camtest_assert_equal($locked, ['API_KEY', 'CAMERA_ID', 'HTTP_PORT', 'PUSH_PORT', 'SERVER_HOST', 'WIFI']);
});

camtest_test('buildDeviceChange: a valid change becomes a line naming only what changed', function () {
    $r = camtest_change(camtest_reported(), ['LOG_HEARTBEAT' => '900', 'PUSH_GAP_MUL' => '1.5', 'LOG_ECHO' => 'off']);
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['changed'], ['LOG_HEARTBEAT', 'LOG_ECHO']);
    camtest_assert_equal($r['line'], 'LOG_HEARTBEAT=900;LOG_ECHO=0');
});

camtest_test('buildDeviceChange: nothing different means an empty line, not an error', function () {
    $r = camtest_change(camtest_reported(), ['LOG_HEARTBEAT' => '600', 'ALARM_ACTIVE' => 'low']);
    camtest_assert_equal([$r['ok'], $r['line'], $r['changed']], [true, '', []]);
});

camtest_test('buildDeviceChange: the settings that reach the relay are refused, even with their current value', function () {
    foreach (['WIFI', 'SERVER_HOST', 'PUSH_PORT', 'HTTP_PORT', 'CAMERA_ID', 'API_KEY'] as $k) {
        $r = camtest_change(camtest_reported(), [$k => 'anything1']);
        camtest_assert_equal($r['ok'], false, $k);
        camtest_assert_true(strpos($r['error'], 'serial port') !== false, $k);
    }
});

camtest_test('buildDeviceChange: unknown settings and bad values are refused, and the error never echoes the value', function () {
    foreach ([['NOPE' => '1'], ['LOG_HEARTBEAT' => '0'], ['LOG_HEARTBEAT' => 'abc'], ['LOG_HEARTBEAT' => '1.5'], ['LOG_ECHO' => 'maybe'],
              ['ALARM_ACTIVE' => 'SIDEWAYS'], ['ALARM_GPIO_PIN' => '7'], ['PUSH_GAP_MUL' => '99'], ['LOG_LOW_HEAP' => "5\n6"]] as $bad) {
        $r = camtest_change(camtest_reported(), $bad);
        camtest_assert_equal($r['ok'], false, json_encode($bad));
    }
    $r = camtest_change(camtest_reported(), ['LOG_HEARTBEAT' => 'hunter2-not-a-number']);
    camtest_assert_true(strpos($r['error'], 'hunter2') === false);
});

camtest_test('buildDeviceChange: values are normalised like the board does (bool words, level case, ints)', function () {
    $r = camtest_change(camtest_reported(), ['LOG_ECHO' => 'No', 'ALARM_ACTIVE' => 'high', 'LOG_RETRY_MAX' => '007', 'ALARM_GPIO_PIN' => '14']);
    camtest_assert_equal($r['line'], 'LOG_ECHO=0;ALARM_ACTIVE=HIGH;LOG_RETRY_MAX=7;ALARM_GPIO_PIN=14');
});

camtest_test('buildDeviceChange: switching a feature on needs the settings it requires', function () {
    $rep = camtest_reported();
    $rep['ALARM_GPIO_PIN'] = '-1';
    unset($rep['ALARM_ACTIVE'], $rep['ALARM_ALL_CAMS']);
    $r = camtest_change($rep, ['ALARM_GPIO_PIN' => '14']);
    camtest_assert_equal($r['ok'], false);
    camtest_assert_true(strpos($r['error'], 'ALARM_ACTIVE') !== false);
    $r = camtest_change($rep, ['ALARM_GPIO_PIN' => '14', 'ALARM_ACTIVE' => 'HIGH', 'ALARM_ALL_CAMS' => '1']);
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['changed'], ['ALARM_GPIO_PIN', 'ALARM_ACTIVE', 'ALARM_ALL_CAMS']);
});

camtest_test('buildDeviceChange: switching a feature OFF does not demand its settings', function () {
    $r = camtest_change(camtest_reported(), ['LOG_ENABLED' => '0']);
    camtest_assert_equal([$r['ok'], $r['line']], [true, 'LOG_ENABLED=0']);
    $r = camtest_change(camtest_reported(), ['ALARM_GPIO_PIN' => '-1']);
    camtest_assert_equal($r['ok'], true);
});

camtest_test('escapeSettingValue: ; and \\ are escaped so a value can not become a second setting', function () {
    camtest_assert_equal(CamLogic::escapeSettingValue('a;b\\c'), 'a\\;b\\\\c');
    camtest_assert_equal(CamLogic::escapeSettingValue('plain'), 'plain');
});

camtest_test('isDeviceSettingRequired: always / equals / not_equals, and "needed" when the controlling value is missing', function () {
    $eq = ['cond' => 'equals', 'condKey' => 'A', 'condValue' => '1'];
    $ne = ['cond' => 'not_equals', 'condKey' => 'A', 'condValue' => '-1'];
    camtest_assert_true(CamLogic::isDeviceSettingRequired(['cond' => 'always', 'condKey' => null], []));
    camtest_assert_true(CamLogic::isDeviceSettingRequired($eq, ['A' => '1']));
    camtest_assert_true(!CamLogic::isDeviceSettingRequired($eq, ['A' => '0']));
    camtest_assert_true(CamLogic::isDeviceSettingRequired($ne, ['A' => '5']));
    camtest_assert_true(!CamLogic::isDeviceSettingRequired($ne, ['A' => '-1']));
    camtest_assert_true(CamLogic::isDeviceSettingRequired($eq, []));
});

exit(camtest_summarize());
