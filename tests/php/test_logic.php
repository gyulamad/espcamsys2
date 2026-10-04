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

exit(camtest_summarize());
