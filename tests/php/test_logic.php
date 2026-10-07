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

exit(camtest_summarize());
