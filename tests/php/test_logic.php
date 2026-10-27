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

camtest_test('recordSeconds / switchOffMinutes: configured value, or the default when missing or out of range', function () {
    camtest_assert_equal(CamLogic::recordSeconds([]), 60);
    camtest_assert_equal(CamLogic::recordSeconds(['record_seconds' => 120]), 120);
    camtest_assert_equal(CamLogic::recordSeconds(['record_seconds' => '90']), 90);
    camtest_assert_equal(CamLogic::recordSeconds(['record_seconds' => 0]), 60);
    camtest_assert_equal(CamLogic::recordSeconds(['record_seconds' => 99999]), 60);
    camtest_assert_equal(CamLogic::recordSeconds(['record_seconds' => 'abc']), 60);
    camtest_assert_equal(CamLogic::switchOffMinutes([]), 60);
    camtest_assert_equal(CamLogic::switchOffMinutes(['switch_off_minutes' => 30]), 30);
    camtest_assert_equal(CamLogic::switchOffMinutes(['switch_off_minutes' => 0]), 0);
    camtest_assert_equal(CamLogic::switchOffMinutes(['switch_off_minutes' => -1]), -1);
    camtest_assert_equal(CamLogic::switchOffMinutes(['switch_off_minutes' => 'x']), 60);
});

camtest_test('validateDashboardUpdate: recording length and OFF time are checked, and only real changes returned', function () {
    $cur = ['auth_user' => 'bob', 'auth_pass' => 'longenough1', 'relay_url' => 'http://x:8080', 'record_seconds' => 60];
    $r = CamLogic::validateDashboardUpdate(['record_seconds' => '60', 'switch_off_minutes' => '60'], $cur);
    camtest_assert_equal($r, ['ok' => true, 'changes' => []]);
    $r = CamLogic::validateDashboardUpdate(['record_seconds' => '120', 'switch_off_minutes' => '0'], $cur);
    camtest_assert_equal($r['changes'], ['record_seconds' => 120, 'switch_off_minutes' => 0]);
    foreach ([['record_seconds' => '0'], ['record_seconds' => '3601'], ['record_seconds' => 'abc'], ['record_seconds' => ''],
              ['switch_off_minutes' => '-2'], ['switch_off_minutes' => '10081'], ['switch_off_minutes' => '1.5']] as $bad) {
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

function camtest_detector_reported(): array {
    return ['PERSON_GPIO' => '13', 'DETECT_THRESH' => '0.6', 'CLEAR_THRESH' => '0.5', 'LOOP_DELAY_MS' => '10', 'DARK_THRESH' => '40',
            'MOTION_THRESH' => '300', 'MOTION_HOLD_S' => '10', 'STREAM_ENABLED' => '1', 'WIFI' => 'net:********', 'SERVER_HOST' => '192.168.1.117',
            'HTTP_PORT' => '8080', 'API_KEY' => '********', 'DETECTOR_ID' => 'detector-1', 'STREAM_MAX_FPS' => '10', 'STREAM_JPEG_Q' => '80',
            'STREAM_WR_TMO_S' => '3', 'ANN_HEARTBEAT' => '600', 'ANN_RETRY' => '30'];
}
function camtest_detector_change(array $values): array {
    $sc = camtest_schema()['detector'];
    return CamLogic::buildDeviceChange($sc['keys'], $sc['gpios'], camtest_detector_reported(), $values);
}

camtest_test('the generated schema has the person detector: the calibration settings are open, the connection and the alarm pin are locked', function () {
    $sc = camtest_schema()['detector'];
    $locked = [];
    $names = [];
    foreach ($sc['keys'] as $k) {
        $names[] = $k['name'];
        if ($k['locked']) { $locked[] = $k['name']; }
    }
    sort($locked);
    camtest_assert_equal($locked, ['API_KEY', 'DETECTOR_ID', 'HTTP_PORT', 'PERSON_GPIO', 'SERVER_HOST', 'STREAM_ENABLED', 'WIFI']);
    foreach (['DARK_THRESH', 'MOTION_THRESH', 'MOTION_HOLD_S', 'DETECT_THRESH', 'CLEAR_THRESH'] as $n) {
        camtest_assert_true(in_array($n, $names, true), $n);
    }
});

camtest_test('buildDeviceChange for a detector: a calibration change becomes a line naming only what changed', function () {
    $r = camtest_detector_change(['DARK_THRESH' => '55', 'MOTION_THRESH' => '300', 'MOTION_HOLD_S' => '20']);
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['changed'], ['DARK_THRESH', 'MOTION_HOLD_S']);
    camtest_assert_equal($r['line'], 'DARK_THRESH=55;MOTION_HOLD_S=20');
});

camtest_test('buildDeviceChange for a detector: the connection settings and the alarm pin cannot be changed, a value out of range is refused', function () {
    foreach (['SERVER_HOST' => '10.0.0.1', 'DETECTOR_ID' => 'x', 'PERSON_GPIO' => '4', 'STREAM_ENABLED' => '0', 'API_KEY' => 'k'] as $name => $value) {
        $r = camtest_detector_change([$name => $value]);
        camtest_assert_equal($r['ok'], false, $name);
    }
    camtest_assert_equal(camtest_detector_change(['DARK_THRESH' => '300'])['ok'], false);   // brightness is 0-255
    camtest_assert_equal(camtest_detector_change(['NOPE' => '1'])['ok'], false);
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

camtest_test('detectorIdOf: only a well-formed string counts', function () {
    camtest_assert_equal(CamLogic::detectorIdOf(['id' => 'cam1', 'detector' => 'detector-1']), 'detector-1');
    camtest_assert_equal(CamLogic::detectorIdOf(['id' => 'cam1']), null);
    camtest_assert_equal(CamLogic::detectorIdOf(['id' => 'cam1', 'detector' => '']), null);
    camtest_assert_equal(CamLogic::detectorIdOf(['id' => 'cam1', 'detector' => 5]), null);
    camtest_assert_equal(CamLogic::detectorIdOf(['id' => 'cam1', 'detector' => '../x']), null);
});

camtest_test('setCameraDetector: pairs, unpairs, keeps other keys', function () {
    $cams = [['id' => 'cam1', 'name' => 'A', 'icon' => 'x', 'extra' => 7], ['id' => 'cam2', 'name' => 'B', 'icon' => 'y']];
    $r = CamLogic::setCameraDetector($cams, 'cam1', ' detector-1 ');
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['cameras'][0], ['id' => 'cam1', 'name' => 'A', 'icon' => 'x', 'extra' => 7, 'detector' => 'detector-1']);
    camtest_assert_equal(isset($r['cameras'][1]['detector']), false);
    $u = CamLogic::setCameraDetector($r['cameras'], 'cam1', '');
    camtest_assert_equal($u['ok'], true);
    camtest_assert_equal(isset($u['cameras'][0]['detector']), false);
    camtest_assert_equal($u['cameras'][0]['extra'], 7);
    $again = CamLogic::setCameraDetector($r['cameras'], 'cam1', 'detector-1');   // re-saving the same pairing is fine
    camtest_assert_equal($again['ok'], true);
});

camtest_test('setCameraDetector: refuses a bad id, a taken detector, a camera id, an unknown camera', function () {
    $cams = [['id' => 'cam1', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-1'], ['id' => 'cam2', 'name' => 'B', 'icon' => 'y']];
    foreach (['bad id', '../x', str_repeat('a', 65), '-x'] as $bad) {
        camtest_assert_equal(CamLogic::setCameraDetector($cams, 'cam2', $bad)['ok'], false, $bad);
    }
    $taken = CamLogic::setCameraDetector($cams, 'cam2', 'det-1');
    camtest_assert_equal($taken['ok'], false);
    camtest_assert_true(strpos($taken['error'], 'cam1') !== false);
    camtest_assert_equal(CamLogic::setCameraDetector($cams, 'cam2', 'CAM1')['ok'], false);
    camtest_assert_equal(CamLogic::setCameraDetector($cams, 'nope', 'det-2')['ok'], false);
});

// A detector as the relay's GET /detectors describes it (detectorstate.buildView()).
function camtest_relay_view(array $over = []): array
{
    return array_merge([
        'state' => 'online', 'online' => true, 'hasPicture' => true, 'connected' => true,
        'ageMs' => 120, 'pictureAgeMs' => 130, 'connectedForMs' => 5000, 'ip' => '192.168.4.37',
        'lastDisconnect' => null, 'message' => '', 'report' => ['scene' => ['brightness' => 90]],
    ], $over);
}

camtest_test('buildDetectorStatus: only paired cameras; carries the relay\'s state, flags, ip and message', function () {
    $cams = [['id' => 'cam1', 'detector' => 'det-1'], ['id' => 'cam2'], ['id' => 'cam3', 'detector' => 'det-3']];
    $relay = ['det-1' => camtest_relay_view(), 'det-3' => camtest_relay_view([
        'state' => 'offline', 'online' => false, 'hasPicture' => false, 'connected' => false, 'ageMs' => 9000, 'pictureAgeMs' => 9000,
        'ip' => '192.168.4.38', 'message' => 'last heard 9 s ago; its connection ended (the board closed the connection)',
    ])];
    $s = CamLogic::buildDetectorStatus($cams, $relay);
    camtest_assert_equal(array_keys($s), ['cam1', 'cam3']);
    camtest_assert_equal($s['cam1'], [
        'detector' => 'det-1', 'state' => 'online', 'online' => true, 'hasPicture' => true, 'connected' => true,
        'ageMs' => 120, 'pictureAgeMs' => 130, 'ip' => '192.168.4.37', 'message' => '', 'report' => ['scene' => ['brightness' => 90]],
    ]);
    camtest_assert_equal($s['cam3']['state'], 'offline');
    camtest_assert_equal($s['cam3']['online'], false);
    camtest_assert_equal($s['cam3']['message'], 'last heard 9 s ago; its connection ended (the board closed the connection)');
    camtest_assert_equal(CamLogic::buildDetectorStatus([], $relay), []);
});

camtest_test('buildDetectorStatus: numbers without a picture stay "online" but are flagged no-picture', function () {
    $s = CamLogic::buildDetectorStatus(
        [['id' => 'cam1', 'detector' => 'det-1']],
        ['det-1' => camtest_relay_view(['state' => 'no-picture', 'hasPicture' => false, 'message' => 'the numbers arrive but there is no picture'])]
    );
    camtest_assert_equal([$s['cam1']['state'], $s['cam1']['online'], $s['cam1']['hasPicture']], ['no-picture', true, false]);
    camtest_assert_equal($s['cam1']['message'], 'the numbers arrive but there is no picture');
});

camtest_test('buildDetectorStatus: a detector the relay has never heard from is "never", with a reason', function () {
    $s = CamLogic::buildDetectorStatus([['id' => 'cam1', 'detector' => 'det-1']], []);
    camtest_assert_equal($s['cam1']['state'], 'never');
    camtest_assert_equal([$s['cam1']['online'], $s['cam1']['hasPicture'], $s['cam1']['connected']], [false, false, false]);
    camtest_assert_equal([$s['cam1']['ageMs'], $s['cam1']['ip'], $s['cam1']['report']], [null, null, null]);
    camtest_assert_true(strpos($s['cam1']['message'], "has not heard from a detector called 'det-1'") !== false, $s['cam1']['message']);
    camtest_assert_true(strpos($s['cam1']['message'], 'SERVER_HOST') !== false, 'with nothing else to go on it says what to check on the board');
});

camtest_test('buildDetectorStatus: a detector the relay hears but no camera is paired with points at a mistyped id', function () {
    $cams = [['id' => 'cam1', 'detector' => 'detector-1'], ['id' => 'cam2', 'detector' => 'det-2']];
    $relay = ['det-2' => camtest_relay_view(), 'detector1' => camtest_relay_view(), 'abc' => camtest_relay_view()];
    $s = CamLogic::buildDetectorStatus($cams, $relay);
    camtest_assert_true(strpos($s['cam1']['message'], "does hear 'abc', 'detector1', which no camera here is paired with") !== false, $s['cam1']['message']);
    camtest_assert_true(strpos($s['cam1']['message'], 'mistyped') !== false);
    camtest_assert_true(strpos($s['cam1']['message'], "'det-2'") === false, 'a detector that IS paired (with another camera) is not offered as the likely culprit');
    camtest_assert_equal($s['cam2']['state'], 'online');
});

camtest_test('buildDetectorStatus: copes with a relay that predates state / hasPicture / message', function () {
    $s = CamLogic::buildDetectorStatus(
        [['id' => 'cam1', 'detector' => 'det-1'], ['id' => 'cam2', 'detector' => 'det-2']],
        ['det-1' => ['online' => true, 'ageMs' => 5, 'report' => ['x' => 1]], 'det-2' => ['online' => false, 'ageMs' => 99999, 'report' => null]]
    );
    camtest_assert_equal([$s['cam1']['state'], $s['cam1']['hasPicture'], $s['cam1']['message']], ['online', true, '']);
    camtest_assert_equal([$s['cam2']['state'], $s['cam2']['hasPicture']], ['offline', false]);
});

camtest_test('buildDetectorStatus: odd values from the relay are not trusted', function () {
    $s = CamLogic::buildDetectorStatus(
        [['id' => 'cam1', 'detector' => 'det-1']],
        ['det-1' => camtest_relay_view(['message' => ['not', 'text'], 'ip' => 5, 'state' => 7])]
    );
    camtest_assert_equal([$s['cam1']['message'], $s['cam1']['ip'], $s['cam1']['state']], ['', null, 'online']);
});

camtest_test('detectorStreamFailure: relay unreachable is a 502 that carries PHP\'s reason', function () {
    $f = CamLogic::detectorStreamFailure(null, '', 'Front Door', 'Connection refused');
    camtest_assert_equal($f['status'], 502);
    camtest_assert_equal($f['message'], 'Could not reach the relay to get the picture of the person detector of Front Door (Connection refused)');
    camtest_assert_equal(CamLogic::detectorStreamFailure(null, '', 'Front Door')['message'], 'Could not reach the relay to get the picture of the person detector of Front Door');
});

camtest_test('detectorStreamFailure: the relay\'s own reason is passed on, with its 404 / 503', function () {
    $never = CamLogic::detectorStreamFailure(404, '{"error":"no detector called \'d1\' has connected to the relay since it started","state":"never"}', 'Front Door');
    camtest_assert_equal($never['status'], 404);
    camtest_assert_equal($never['message'], "The person detector of Front Door: no detector called 'd1' has connected to the relay since it started");
    $off = CamLogic::detectorStreamFailure(503, '{"error":"detector \'d1\' has no picture to show: last heard 9 s ago"}', 'Back');
    camtest_assert_equal([$off['status'], $off['message']], [503, "The person detector of Back: detector 'd1' has no picture to show: last heard 9 s ago"]);
});

camtest_test('detectorStreamFailure: an answer that is not the relay\'s own is a 502 that suspects an old relay', function () {
    $html = CamLogic::detectorStreamFailure(404, '<!DOCTYPE html><pre>Cannot GET /detector/d1/stream</pre>', 'Front Door');
    camtest_assert_equal($html['status'], 502);
    camtest_assert_true(strpos($html['message'], 'HTTP 404 without a reason') !== false && strpos($html['message'], 'older than this dashboard') !== false, $html['message']);
    camtest_assert_equal(CamLogic::detectorStreamFailure(500, '', 'X')['status'], 502);
    camtest_assert_equal(CamLogic::detectorStreamFailure(400, '{"error":"invalid detector id"}', 'X')['status'], 502, 'only 404 and 503 are passed on as they are');
    camtest_assert_equal(CamLogic::detectorStreamFailure(503, '{"error":7}', 'X')['status'], 502, 'a reason that is not text is no reason');
});

camtest_test('logDue: at most once per period, and a clock that went backwards does not silence it', function () {
    camtest_assert_true(CamLogic::logDue(null, 1000, 300));
    camtest_assert_true(!CamLogic::logDue(1000, 1299, 300));
    camtest_assert_true(CamLogic::logDue(1000, 1300, 300));
    camtest_assert_true(CamLogic::logDue(5000, 1000, 300), 'now earlier than the last write');
});

// ── F-02: CSRF guard for state-changing requests ─────────────────────

camtest_test('isSameOriginRequest accepts no Origin / no Sec-Fetch-Site (curl, old browsers)', function () {
    camtest_assert_true(CamLogic::isSameOriginRequest(['HTTP_HOST' => 'a.onion']));
});

camtest_test('isSameOriginRequest accepts an Origin that matches Host (case and port aware)', function () {
    camtest_assert_true(CamLogic::isSameOriginRequest(['HTTP_HOST' => 'abc.onion', 'HTTP_ORIGIN' => 'http://ABC.onion']));
    camtest_assert_true(CamLogic::isSameOriginRequest(['HTTP_HOST' => '127.0.0.1:8081', 'HTTP_ORIGIN' => 'http://127.0.0.1:8081']));
});

camtest_test('isSameOriginRequest rejects another site, another port, "null" and junk Origins', function () {
    foreach (['http://evil.example', 'http://abc.onion:81', 'null', 'garbage', 'http://abc.onion.evil.example'] as $o) {
        camtest_assert_true(!CamLogic::isSameOriginRequest(['HTTP_HOST' => 'abc.onion', 'HTTP_ORIGIN' => $o]), $o);
    }
});

camtest_test('isSameOriginRequest follows Sec-Fetch-Site', function () {
    camtest_assert_true(CamLogic::isSameOriginRequest(['HTTP_HOST' => 'h', 'HTTP_SEC_FETCH_SITE' => 'same-origin']));
    camtest_assert_true(!CamLogic::isSameOriginRequest(['HTTP_HOST' => 'h', 'HTTP_SEC_FETCH_SITE' => 'cross-site']));
    camtest_assert_true(!CamLogic::isSameOriginRequest(['HTTP_HOST' => 'h', 'HTTP_SEC_FETCH_SITE' => 'same-site']));
});

camtest_test('isDashboardMutationAllowed needs the header AND same origin', function () {
    $ok = ['HTTP_HOST' => 'h', 'HTTP_X_REQUESTED_WITH' => 'camdash'];
    camtest_assert_true(CamLogic::isDashboardMutationAllowed($ok));
    camtest_assert_true(!CamLogic::isDashboardMutationAllowed(['HTTP_HOST' => 'h']));
    camtest_assert_true(!CamLogic::isDashboardMutationAllowed($ok + ['HTTP_ORIGIN' => 'http://evil.example']));
    camtest_assert_true(!CamLogic::isDashboardMutationAllowed($ok + ['HTTP_SEC_FETCH_SITE' => 'cross-site']));
});

camtest_test('validateRecordSeconds accepts 1..3600 and nothing else', function () {
    camtest_assert_equal(CamLogic::validateRecordSeconds('1'), 1);
    camtest_assert_equal(CamLogic::validateRecordSeconds('3600'), 3600);
    foreach (['3601', '999999999', '0', '-5', '', 'abc', null, ['5'], '1.5'] as $bad) {
        camtest_assert_equal(CamLogic::validateRecordSeconds($bad), null, var_export($bad, true));
    }
});

camtest_test('buildActorHeaders: actor always, control key when set, refuses a key with a line break', function () {
    camtest_assert_equal(CamLogic::buildActorHeaders('k', 'u@1', true), "Content-Length: 0\r\nX-Control-Key: k\r\nX-Actor: u@1\r\n");
    camtest_assert_equal(CamLogic::buildActorHeaders('', 'u@1', false), "X-Actor: u@1\r\n");
    camtest_assert_equal(CamLogic::buildActorHeaders("k\r\nX-Evil: 1", 'u@1'), null);
});

// ── F-03 / F-04: login policy and guess throttle ─────────────────────

camtest_test('checkCredentials never accepts an empty configured login (F-04)', function () {
    camtest_assert_true(!CamLogic::checkCredentials('', '', '', ''), 'empty config + empty request');
    camtest_assert_true(!CamLogic::checkCredentials('admin', '', 'admin', ''), 'empty password');
    camtest_assert_true(!CamLogic::checkCredentials('', 'secret', '', 'secret'), 'empty user');
    camtest_assert_true(CamLogic::checkCredentials('admin', 'secret', 'admin', 'secret'));
});

camtest_test('credentialProblem: empty, template and short logins are refused, a real one is fine', function () {
    camtest_assert_true(CamLogic::credentialProblem('', 'a-long-password') !== null);
    camtest_assert_true(CamLogic::credentialProblem('admin', '') !== null);
    camtest_assert_true(CamLogic::credentialProblem('change-me', 'change-me') !== null);
    camtest_assert_true(CamLogic::credentialProblem('admin', 'change-me') !== null);
    camtest_assert_true(CamLogic::credentialProblem('Change-Me', 'a-long-password') !== null);
    camtest_assert_true(CamLogic::credentialProblem('admin', 'short') !== null);
    camtest_assert_true(CamLogic::credentialProblem(null, 'a-long-password') !== null, 'missing key');
    camtest_assert_true(CamLogic::credentialProblem('admin', ['x']) !== null, 'wrong type');
    camtest_assert_equal(CamLogic::credentialProblem('admin', '12345678'), null);
});

camtest_test('validateDashboardUpdate refuses the template value, so the settings page cannot lock the owner out', function () {
    $r = CamLogic::validateDashboardUpdate(['auth_pass' => 'change-me'], []);
    camtest_assert_true($r['ok'] === false);
    $r = CamLogic::validateDashboardUpdate(['auth_user' => 'change-me'], []);
    camtest_assert_true($r['ok'] === false);
    $r = CamLogic::validateDashboardUpdate(['auth_user' => 'owner', 'auth_pass' => 'a-long-password'], []);
    camtest_assert_true($r['ok'] === true);
});

camtest_test('throttle: the first 9 failures are not locked, the 10th locks for 15 s', function () {
    $s = CamLogic::loginThrottleState(null, 1000);
    for ($i = 1; $i <= 9; $i++) {
        $s = CamLogic::loginAfterFailure($s, 1000);
        camtest_assert_equal(CamLogic::loginLockRemaining($s, 1000), 0, "failure $i");
    }
    $s = CamLogic::loginAfterFailure($s, 1000);
    camtest_assert_equal($s['fails'], 10);
    camtest_assert_equal(CamLogic::loginLockRemaining($s, 1000), 15);
    camtest_assert_equal(CamLogic::loginLockRemaining($s, 1015), 0);
});

camtest_test('throttle: the lock doubles with every further failure and stops at 15 minutes', function () {
    $s = ['fails' => 10, 'last' => 0, 'lockUntil' => 0];
    $expect = [30, 60, 120, 240, 480, 900, 900, 900];
    foreach ($expect as $i => $secs) {
        $s = CamLogic::loginAfterFailure($s, 5000);
        camtest_assert_equal(CamLogic::loginLockRemaining($s, 5000), $secs, 'failure ' . ($i + 11));
    }
    $s = CamLogic::loginAfterFailure(['fails' => 100000, 'last' => 0, 'lockUntil' => 0], 5000);
    camtest_assert_equal(CamLogic::loginLockRemaining($s, 5000), 900, 'huge count stays capped (no shift overflow)');
});

camtest_test('throttle: a success clears everything; old failures are forgotten', function () {
    camtest_assert_equal(CamLogic::loginAfterSuccess(['fails' => 12, 'last' => 5, 'lockUntil' => 99]), ['fails' => 0, 'last' => 0, 'lockUntil' => 0]);
    $old = ['fails' => 9, 'last' => 1000, 'lockUntil' => 0];
    camtest_assert_equal(CamLogic::loginThrottleState($old, 1000 + 3601)['fails'], 0);
    camtest_assert_equal(CamLogic::loginThrottleState($old, 1000 + 3000)['fails'], 9);
    // ...but never while a lock is still running
    $locked = ['fails' => 12, 'last' => 1000, 'lockUntil' => 1000 + 3700];
    camtest_assert_equal(CamLogic::loginThrottleState($locked, 1000 + 3601)['fails'], 12);
});

camtest_test('throttle: garbage in the state file is ignored, and a clock that jumped back cannot lock forever', function () {
    camtest_assert_equal(CamLogic::loginThrottleState('junk', 10), ['fails' => 0, 'last' => 0, 'lockUntil' => 0]);
    camtest_assert_equal(CamLogic::loginThrottleState(['fails' => 'x', 'last' => -5, 'lockUntil' => 1.5], 10), ['fails' => 0, 'last' => 0, 'lockUntil' => 0]);
    $s = CamLogic::loginThrottleState(['fails' => 12, 'last' => 10, 'lockUntil' => 10 + 999999], 10);
    camtest_assert_equal(CamLogic::loginLockRemaining($s, 10), 900);
});

// ── F-08: the control key must only ever go to the relay ─────────────

camtest_test('relayHttpOptions never follows redirects, whatever the call', function () {
    foreach ([CamLogic::relayHttpOptions(), CamLogic::relayHttpOptions('POST', 8, "X-Control-Key: k\r\n", '{}'), CamLogic::relayHttpOptions('DELETE', 30)] as $o) {
        camtest_assert_equal($o['follow_location'], 0);
        camtest_assert_equal($o['max_redirects'], 0);
        camtest_assert_true($o['ignore_errors'] === true);
    }
    $o = CamLogic::relayHttpOptions('POST', 8, "X-Actor: a\r\n", '{"x":1}');
    camtest_assert_equal([$o['method'], $o['timeout'], $o['header'], $o['content']], ['POST', 8, "X-Actor: a\r\n", '{"x":1}']);
    camtest_assert_true(!isset(CamLogic::relayHttpOptions()['header']) && !isset(CamLogic::relayHttpOptions()['content']));
});

camtest_test('isRedirectStatus: only 3xx', function () {
    foreach ([301, 302, 307, 308, 300, 399] as $s) camtest_assert_true(CamLogic::isRedirectStatus($s), (string) $s);
    foreach ([null, 0, 200, 202, 299, 400, 404, 502] as $s) camtest_assert_true(!CamLogic::isRedirectStatus($s), var_export($s, true));
});

camtest_test('isAllowedRelayHost accepts this machine and the local network', function () {
    foreach (['127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20', '100.64.0.1', '100.127.255.1',
              '[::1]', '::1', '[fd12:3456:789a::1]', 'fc00::1', 'localhost', 'LOCALHOST', 'raspberrypi', 'pi', 'relay.local', 'pi.lan', 'cam-relay.home.arpa', 'nas.localdomain'] as $h) {
        camtest_assert_true(CamLogic::isAllowedRelayHost($h), $h);
    }
});

camtest_test('isAllowedRelayHost refuses public, link-local, metadata and disguised addresses', function () {
    foreach (['8.8.8.8', '1.1.1.1', '169.254.169.254', '169.254.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '0.0.0.0', '255.255.255.255',
              '[fe80::1]', 'fe80::1', '2001:4860:4860::8888', '[::ffff:8.8.8.8]', '::ffff:127.0.0.1', '::',
              'example.com', 'evil.example.com', 'localhost.evil.com', 'relay.local.evil.com', 'metadata.google.internal', 'relay.internal',
              '2130706433', '0x7f000001', '017700000001', '127.1', '10.1', '1e3', '0relay', '', 'pi.', '.local', 'bad host', "a\nb", str_repeat('a', 64)] as $h) {
        camtest_assert_true(!CamLogic::isAllowedRelayHost($h), var_export($h, true));
    }
});

camtest_test('relayUrlHostAllowed reads the host out of a URL', function () {
    camtest_assert_true(CamLogic::relayUrlHostAllowed('http://127.0.0.1:8080'));
    camtest_assert_true(CamLogic::relayUrlHostAllowed('https://192.168.1.5'));
    camtest_assert_true(CamLogic::relayUrlHostAllowed('http://[::1]:8080'));
    camtest_assert_true(CamLogic::relayUrlHostAllowed('http://pi.local:8080/'));
    camtest_assert_true(!CamLogic::relayUrlHostAllowed('http://169.254.169.254/latest'));
    camtest_assert_true(!CamLogic::relayUrlHostAllowed('http://8.8.8.8:80'));
    camtest_assert_true(!CamLogic::relayUrlHostAllowed('http://127.0.0.1.evil.com:80'));
    camtest_assert_true(!CamLogic::relayUrlHostAllowed('not a url'));
});

camtest_test('validateDashboardUpdate refuses a NEW relay_url outside the local network', function () {
    $cur = ['auth_user' => 'bob', 'auth_pass' => 'longenough1', 'relay_url' => 'http://127.0.0.1:8080'];
    foreach (['http://8.8.8.8:80', 'http://169.254.169.254', 'http://evil.example.com:8080', 'https://relay.example.org', 'http://2130706433:80'] as $bad) {
        $r = CamLogic::validateDashboardUpdate(['relay_url' => $bad], $cur);
        camtest_assert_true($r['ok'] === false && strpos($r['error'], 'local network') !== false, $bad);
    }
    foreach (['http://192.168.1.9:8080', 'http://pi.local:8080', 'http://[::1]:8080', 'http://10.0.0.2'] as $good) {
        $r = CamLogic::validateDashboardUpdate(['relay_url' => $good], $cur);
        camtest_assert_true($r['ok'] === true && $r['changes']['relay_url'] === $good, $good);
    }
});

camtest_test('an UNCHANGED relay_url is never refused (a hand-set remote relay must not block other saves)', function () {
    $cur = ['auth_user' => 'bob', 'auth_pass' => 'longenough1', 'relay_url' => 'https://relay.example.com'];
    $r = CamLogic::validateDashboardUpdate(['relay_url' => 'https://relay.example.com/', 'auth_user' => 'alice'], $cur);
    camtest_assert_true($r['ok'] === true);
    camtest_assert_equal($r['changes'], ['auth_user' => 'alice']);
});

camtest_test('isRelayStatusAnswer wants 200 and a JSON object/list, nothing else', function () {
    camtest_assert_true(CamLogic::isRelayStatusAnswer('{"cam1":{"online":true}}', 200));
    camtest_assert_true(CamLogic::isRelayStatusAnswer('{}', 200), 'an empty relay');
    camtest_assert_true(CamLogic::isRelayStatusAnswer('[]', 200));
    foreach ([['<html>router login</html>', 200], ['{"a":1}', 404], ['{"a":1}', null], ['{"a":1}', 302], [false, 200], [null, 200], ['', 200], ['12', 200], ['"str"', 200], ['null', 200]] as [$b, $s]) {
        camtest_assert_true(!CamLogic::isRelayStatusAnswer($b, $s), var_export($b, true) . ' ' . var_export($s, true));
    }
});

// ── F-05: nothing from the relay or config.php may become markup ─────

camtest_test('sanitizeRecordingList keeps clean names and drops everything else', function () {
    $list = [
        ['filename' => 'cam1-20260101-000000.mp4', 'sizeBytes' => 1234, 'seen' => false],
        ['filename' => "x');alert(1);('.mp4", 'sizeBytes' => 1],
        ['filename' => '"><img src=x onerror=alert(1)>.mp4'],
        ['filename' => '../../etc/passwd'],
        ['filename' => 'a/b.mp4'],
        ['filename' => 'notvideo.html'],
        ['filename' => ['a.mp4']],
        ['filename' => 5],
        ['nofilename' => 'a.mp4'],
        'a-string', null, 7,
        ['filename' => 'ok-2.mp4', 'sizeBytes' => '<b>big</b>', 'seen' => 'false', 'extra' => '<script>'],
    ];
    camtest_assert_equal(CamLogic::sanitizeRecordingList($list), [
        ['filename' => 'cam1-20260101-000000.mp4', 'sizeBytes' => 1234, 'seen' => false],
        ['filename' => 'ok-2.mp4', 'sizeBytes' => 0],
    ]);
});

camtest_test('sanitizeRecordingList: an empty list is a list; anything that is not a list is refused', function () {
    camtest_assert_equal(CamLogic::sanitizeRecordingList([]), []);
    foreach ([null, 'text', 5, true, ['error' => 'boom'], ['a.mp4' => ['filename' => 'a.mp4']], [1 => ['filename' => 'a.mp4']]] as $bad) {
        camtest_assert_equal(CamLogic::sanitizeRecordingList($bad), null, var_export($bad, true));
    }
});

camtest_test('sanitizeRecordingList: negative, float and huge sizes become 0 or stay whole numbers', function () {
    $r = CamLogic::sanitizeRecordingList([
        ['filename' => 'a.mp4', 'sizeBytes' => -5], ['filename' => 'b.mp4', 'sizeBytes' => 1.5], ['filename' => 'c.mp4', 'sizeBytes' => PHP_INT_MAX],
    ]);
    camtest_assert_equal(array_column($r, 'sizeBytes'), [0, 0, PHP_INT_MAX]);
});

camtest_test('onlyValidCameras drops ids that are not plain ids and reports them', function () {
    $cams = [
        ['id' => 'cam1', 'name' => 'A'], ['id' => 'front.door-2_x', 'name' => 'B'],
        ['id' => "a');alert(1);('", 'name' => 'evil'], ['id' => '<img src=x>', 'name' => 'evil2'], ['id' => 'has space'], ['id' => '-startsbad'],
        ['id' => str_repeat('a', 65)], ['id' => 5], ['name' => 'no id'], 'junk', null,
    ];
    $skipped = null;
    $valid = CamLogic::onlyValidCameras($cams, $skipped);
    camtest_assert_equal(array_column($valid, 'id'), ['cam1', 'front.door-2_x']);
    camtest_assert_equal(count($skipped), 9);
    foreach ($skipped as $s) camtest_assert_true(preg_match('/^[\x20-\x7e]*$/', $s) === 1 && strlen($s) <= 40, $s);
    camtest_assert_equal(CamLogic::onlyValidCameras('not an array'), []);
});

// ── F-09: the dashboard must not set file or folder paths on the relay ─

camtest_test('splitSettingsValues passes every allowed relay setting on, and the dashboard\'s own to the dashboard', function () {
    $values = ['alarmRecordSeconds' => 60, 'preRollSeconds' => '10', 'preRollMaxBytes' => 8388608, 'port' => 8080, 'pushPort' => 8081,
               'camKey' => 'a-camera-key', 'controlKey' => 'a-control-key', 'logMaxBytes' => 5242880, 'logKeepFiles' => 2, 'auth_user' => 'bob'];
    $r = CamLogic::splitSettingsValues($values);
    camtest_assert_true($r['ok'] === true);
    camtest_assert_equal(array_keys($r['relay']), CamLogic::RELAY_SETTING_KEYS);
    camtest_assert_equal(array_keys($r['dashboard']), ['auth_user']);
});

camtest_test('splitSettingsValues refuses every file and folder path, saving nothing', function () {
    foreach (CamLogic::RELAY_PATH_SETTING_KEYS as $key) {
        foreach (['/etc/passwd', '../../etc', '/home/pi/.ssh', 'logs/camera.log', ''] as $path) {
            $r = CamLogic::splitSettingsValues(['preRollSeconds' => 5, $key => $path]);
            camtest_assert_true($r['ok'] === false, "$key = $path");
            camtest_assert_true(strpos($r['error'], $key) !== false && strpos($r['error'], 'nothing was saved') !== false && !isset($r['relay']), $r['error'] ?? '');
        }
    }
    camtest_assert_equal(CamLogic::RELAY_PATH_SETTING_KEYS, ['logFile', 'deviceSettingsDir', 'firmwareDir', 'switchFile']);
});

camtest_test('splitSettingsValues refuses a setting it does not know (allow-list, not deny-list)', function () {
    foreach (['somethingNew', 'PORT', 'port ', 'preRollSeconds2', '__proto__', 'constructor', 'LOG_FILE', "port\n"] as $key) {
        $r = CamLogic::splitSettingsValues([$key => 1]);
        camtest_assert_true($r['ok'] === false && strpos($r['error'], 'unknown setting') !== false, var_export($key, true));
    }
    $r = CamLogic::splitSettingsValues([str_repeat("x\x00\n", 100) => 1]);
    camtest_assert_true($r['ok'] === false && preg_match('/unknown setting "([^"]*)"/', $r['error'], $m) === 1, 'message names the key');
    camtest_assert_true(strlen($m[1]) <= 40 && preg_match('/^[\x20-\x7e]*$/', $m[1]) === 1, 'a hostile key is cut short and printable in the message: ' . var_export($m[1], true));
});

camtest_test('the allow-list and the path list do not overlap, and the dashboard keys are not in either', function () {
    camtest_assert_equal(array_intersect(CamLogic::RELAY_SETTING_KEYS, CamLogic::RELAY_PATH_SETTING_KEYS), []);
    foreach (CamLogic::dashboardFields() as $f) {
        camtest_assert_true(!in_array($f['key'], CamLogic::RELAY_SETTING_KEYS, true) && !in_array($f['key'], CamLogic::RELAY_PATH_SETTING_KEYS, true), $f['key']);
    }
});

camtest_test('visibleRelayFields keeps the allowed fields in order and drops paths, unknowns and junk', function () {
    $fields = [
        ['key' => 'alarmRecordSeconds', 'group' => 'Recording'], ['key' => 'logFile', 'group' => 'Log'], ['key' => 'port', 'group' => 'Network'],
        ['key' => 'firmwareDir', 'group' => 'Folders'], ['key' => 'switchFile', 'group' => 'Folders'], ['key' => 'deviceSettingsDir', 'group' => 'Folders'],
        ['key' => 'newThing'], ['nokey' => 1], 'junk', null, ['key' => ['port']], ['key' => 'controlKey', 'group' => 'Keys'],
    ];
    camtest_assert_equal(array_column(CamLogic::visibleRelayFields($fields), 'key'), ['alarmRecordSeconds', 'port', 'controlKey']);
    camtest_assert_equal(CamLogic::visibleRelayFields('nonsense'), []);
    camtest_assert_equal(CamLogic::visibleRelayFields(null), []);
});

camtest_test('the allow-list matches the relay\'s real settings schema: every relay field is either allowed or a path, nothing else', function () {
    // The relay (nodejs/camera-relay/lib/sysconfig.js) is where the keys are defined. If it gains a setting,
    // this fails until someone decides on purpose whether the dashboard may change it.
    $src = @file_get_contents(__DIR__ . '/../../nodejs/camera-relay/lib/sysconfig.js');
    if ($src === false) {
        camtest_assert_true(true, 'relay source not found (skipped)');
        return;
    }
    $relayKeys = [];
    if (preg_match('/const FIELDS = \[(.*?)\n\];/s', $src, $m)) {
        preg_match_all("/\{ key: '([A-Za-z]+)'/", $m[1], $mm);
        $relayKeys = $mm[1];
    }
    camtest_assert_true(count($relayKeys) >= 10, 'found ' . count($relayKeys) . ' fields in sysconfig.js');
    $known = array_merge(CamLogic::RELAY_SETTING_KEYS, CamLogic::RELAY_PATH_SETTING_KEYS);
    sort($relayKeys);
    sort($known);
    camtest_assert_equal($relayKeys, $known);
});

// ── F-12 / F-14 / F-15 / F-16: small input and output checks ─────────

camtest_test('F-15: a trailing newline no longer slips past the validators', function () {
    foreach (["a.mp4\n", "cam1-20260101-000000.mp4\n", "a.mp4\r\n"] as $name) camtest_assert_true(!CamLogic::isSafeFilename($name), var_export($name, true));
    camtest_assert_true(CamLogic::isSafeFilename('a.mp4'));
    camtest_assert_equal(preg_match(CamLogic::CAMERA_ID_PATTERN, "cam1\n"), 0);
    camtest_assert_equal(preg_match(CamLogic::CAMERA_ID_PATTERN, 'cam1'), 1);
    camtest_assert_true(!CamLogic::isAllowedRelayHost("pi\n") && !CamLogic::isAllowedRelayHost("localhost\n") && !CamLogic::isAllowedRelayHost("relay.local\n"), 'relay host with a trailing newline');
    camtest_assert_equal(CamLogic::onlyValidCameras([['id' => "cam1\n"], ['id' => 'cam2']])[0]['id'], 'cam2');
});

camtest_test('F-15: the filename pattern the PAGE gets is the bare regex (JavaScript has no /D flag)', function () {
    camtest_assert_equal(CamLogic::SAFE_FILENAME_REGEX, '^[A-Za-z0-9_.-]+\.mp4$');
    camtest_assert_equal(CamLogic::SAFE_FILENAME_PATTERN, '/^[A-Za-z0-9_.-]+\.mp4$/D');
    camtest_assert_true(strpos(CamLogic::SAFE_FILENAME_REGEX, '/') === false);
});

camtest_test('F-12: validateSwitchMinutes caps the top, keeps negatives, rejects junk', function () {
    foreach ([['60', 60], ['0', 0], ['-1', -1], ['-15', -15], ['10080', 10080], [' 7 ', 7], ['007', 7], ["5\n", 5], ['-0', 0]] as [$in, $out]) {
        camtest_assert_equal(CamLogic::validateSwitchMinutes($in), $out, $in);
    }
    foreach (['10081', '99999999', '999999999', '1000000000', '+5', '1.5', '1e3', '', 'abc', '5 6', '0x10', '--5', "5\n6"] as $bad) {
        camtest_assert_equal(CamLogic::validateSwitchMinutes($bad), null, var_export($bad, true));
    }
    foreach ([null, 60, ['5'], true] as $notText) camtest_assert_equal(CamLogic::validateSwitchMinutes($notText), null, var_export($notText, true));
});

camtest_test('F-12: a switch-off request forwards the checked number, written fresh', function () {
    $q = fn($minutes) => ['scope' => 'camera', 'cam' => 'cam2', 'action' => 'off', 'minutes' => $minutes];
    $r = CamLogic::buildSwitchRequest($q(' 007 '), camtest_switch_cams());
    camtest_assert_true($r['ok'] === true && substr($r['url'], -10) === '?minutes=7', json_encode($r));
    $r = CamLogic::buildSwitchRequest($q('-15'), camtest_switch_cams());
    camtest_assert_true($r['ok'] === true && substr($r['url'], -12) === '?minutes=-15', json_encode($r));
    $r = CamLogic::buildSwitchRequest($q(''), camtest_switch_cams());
    camtest_assert_true($r['ok'] === true && strpos($r['url'], 'minutes') === false, 'an empty value counts as not given (the relay uses its default)');
    foreach (['10081', '99999999', '1e3', 'abc'] as $bad) {
        $r = CamLogic::buildSwitchRequest($q($bad), camtest_switch_cams());
        camtest_assert_true($r['ok'] === false && $r['status'] === 400 && strpos($r['error'], '10080') !== false, $bad . ' ' . json_encode($r));
    }
    $r = CamLogic::buildSwitchRequest($q(['5']), camtest_switch_cams());
    camtest_assert_true($r['ok'] === false && $r['status'] === 400, 'an array is refused, not a crash');
});

camtest_test('F-16: firstNonStringParam names the first parameter that is not plain text', function () {
    camtest_assert_equal(CamLogic::firstNonStringParam(['cam' => 'a', 'play' => 'x.mp4'], ['cam', 'play', 'delete']), null);
    camtest_assert_equal(CamLogic::firstNonStringParam(['cam' => ['a']], ['cam']), 'cam');
    camtest_assert_equal(CamLogic::firstNonStringParam(['cam' => 'a', 'play' => ['x'], 'delete' => ['y']], ['cam', 'play', 'delete']), 'play');
    camtest_assert_equal(CamLogic::firstNonStringParam(['other' => ['x']], ['cam']), null, 'only the named ones are looked at');
    camtest_assert_equal(CamLogic::firstNonStringParam(['cam' => null], ['cam']), 'cam', 'a present non-string value');
    camtest_assert_equal(CamLogic::firstNonStringParam([], ['cam']), null);
});

camtest_test('F-14: safeStreamContentType serves picture streams only', function () {
    $mj = fn($v) => CamLogic::safeStreamContentType(['HTTP/1.1 200 OK', 'Content-Type: ' . $v]);
    camtest_assert_equal($mj('multipart/x-mixed-replace; boundary=frame'), 'multipart/x-mixed-replace; boundary=frame');
    camtest_assert_equal($mj('multipart/x-mixed-replace;boundary="myboundary-1"'), 'multipart/x-mixed-replace; boundary=myboundary-1');
    camtest_assert_equal($mj('MULTIPART/X-MIXED-REPLACE; boundary=abc'), 'multipart/x-mixed-replace; boundary=abc');
    camtest_assert_equal($mj('multipart/x-mixed-replace'), 'multipart/x-mixed-replace; boundary=frame', 'no boundary: the default one');
    camtest_assert_equal($mj('image/jpeg'), 'image/jpeg');
    camtest_assert_equal(CamLogic::safeStreamContentType(['HTTP/1.1 200 OK']), 'multipart/x-mixed-replace; boundary=frame', 'no Content-Type at all: the default');
    camtest_assert_equal($mj(''), 'multipart/x-mixed-replace; boundary=frame', 'an empty Content-Type counts as none');
    foreach (['text/html', 'text/html; charset=utf-8', 'application/javascript', 'image/svg+xml', 'application/xhtml+xml', 'text/plain', 'video/mp4',
              'multipart/x-mixed-replace; boundary=<script>', 'multipart/x-mixed-replace; boundary=a b', 'multipart/x-mixed-replace; charset=x', 'image/jpeg; boundary=x',
              'multipart/x-mixed-replace; boundary=' . str_repeat('a', 71), 'multipart/x-mixed-replace; boundary=frame; x=y', "text/html\nX: y"] as $bad) {
        camtest_assert_equal($mj($bad), null, var_export($bad, true));
    }
});

camtest_test('F-14: validRangeHeader passes ONE plain byte range and nothing else', function () {
    foreach (['bytes=0-99', 'bytes=500-', 'bytes=-500', 'bytes=0-0', 'bytes=123456789012345-123456789012345'] as $ok) camtest_assert_equal(CamLogic::validRangeHeader($ok), $ok, $ok);
    foreach (['bytes=0-1,5-9', 'bytes=-', 'bytes=', 'bytes=abc', 'bytes=5-2', 'items=0-5', 'bytes=0-5 ', " bytes=0-5", "bytes=0-5\n", "bytes=0-5\r\nX-Evil: 1", 'bytes=0-9999999999999999', 'bytes=1-2-3', '', 'bytes=+1-2'] as $bad) {
        camtest_assert_equal(CamLogic::validRangeHeader($bad), null, var_export($bad, true));
    }
    foreach ([null, ['bytes=0-1'], 5] as $notText) camtest_assert_equal(CamLogic::validRangeHeader($notText), null);
});

camtest_test('F-14: only well-formed Content-Range / Content-Length / Accept-Ranges are passed back', function () {
    $in = ['HTTP/1.1 206 Partial Content', 'Content-Type: text/html', 'Content-Range: bytes 0-99/1000', 'Content-Range: bytes */1000', 'Content-Length: 100', 'Accept-Ranges: bytes', 'Accept-Ranges: none',
           'Content-Range: <script>alert(1)</script>', 'Content-Range: bytes 0-99/abc', 'Content-Length: -5', 'Content-Length: 12abc', 'Accept-Ranges: everything',
           'Set-Cookie: a=b', 'Location: http://evil.example', 'content-length: 7'];
    camtest_assert_equal(CamLogic::extractPassThroughHeaders($in), ['Content-Range: bytes 0-99/1000', 'Content-Range: bytes */1000', 'Content-Length: 100', 'Accept-Ranges: bytes', 'Accept-Ranges: none', 'content-length: 7']);
    camtest_assert_equal(CamLogic::extractPassThroughHeaders(['Content-Length: 5' . "\r\n"]), ['Content-Length: 5' . "\r\n"], 'a CRLF at the very end is just the line end');
    camtest_assert_equal(CamLogic::extractPassThroughHeaders(["Content-Length: 5\r\nSet-Cookie: x=y"]), [], 'an injected second header is refused');
    camtest_assert_equal(CamLogic::extractPassThroughHeaders([null, 5, ['Content-Length: 5']]), []);
});

camtest_test('F-14: passableStatus repeats real final answers only', function () {
    foreach ([200, 206, 204, 400, 404, 416, 500, 502, 599] as $ok) camtest_assert_equal(CamLogic::passableStatus($ok), $ok, (string) $ok);
    foreach ([null, 0, 100, 101, 199, 300, 301, 302, 399, 600, 999, -1] as $bad) camtest_assert_equal(CamLogic::passableStatus($bad), null, var_export($bad, true));
});

camtest_test('F-20: transportReason keeps the reason in words and drops the address', function () {
    $cases = [
        ['fopen(http://127.0.0.1:8080/detector/det-A/stream): Failed to open stream: Connection refused', 'Connection refused'],
        ['fopen(http://192.168.1.9:8080/x): Failed to open stream: Connection timed out', 'Connection timed out'],
        ['fopen(http://10.0.0.5:8080/x): Failed to open stream: No route to host', 'No route to host'],
        ['fopen(http://pi.local:8080/x): Failed to open stream: php_network_getaddresses: getaddrinfo for pi.local failed: Name or service not known', "the relay's name could not be looked up"],
        ['file_get_contents(): Failed to open stream: HTTP request failed!', 'HTTP request failed!'],
        ['something else entirely', 'the connection failed'],
        ['', 'the connection failed'],
        ['fopen(x): Failed to open stream: ', 'the connection failed'],
    ];
    foreach ($cases as [$in, $out]) camtest_assert_equal(CamLogic::transportReason($in), $out, $in);
    $long = CamLogic::transportReason('fopen(x): Failed to open stream: ' . str_repeat('a', 500));
    camtest_assert_true(strlen($long) <= 80, 'cut short');
    $weird = CamLogic::transportReason("fopen(x): Failed to open stream: bad http://secret.example:99/path\x00\n stuff");
    camtest_assert_true(strpos($weird, 'secret') === false && preg_match('/^[\x20-\x7e]*$/', $weird) === 1, $weird);
    foreach ($cases as [$in]) camtest_assert_true(!preg_match('~://|127\.0\.0\.1|192\.168|fopen|pi\.local~', CamLogic::transportReason($in)), 'no address in the reason for: ' . $in);
});

exit(camtest_summarize());
