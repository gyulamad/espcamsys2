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

// ── validateEnabledParam ─────────────────────────────────────────────

camtest_test('validateEnabledParam parses "1" and "0"', function () {
    camtest_assert_equal(CamLogic::validateEnabledParam('1'), true);
    camtest_assert_equal(CamLogic::validateEnabledParam('0'), false);
});

camtest_test('validateEnabledParam rejects anything else', function () {
    camtest_assert_equal(CamLogic::validateEnabledParam('true'), null);
    camtest_assert_equal(CamLogic::validateEnabledParam(null), null);
    camtest_assert_equal(CamLogic::validateEnabledParam(''), null);
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

// ── buildControlQuery ────────────────────────────────────────────────

camtest_test('buildControlQuery: turning off ignores seconds', function () {
    camtest_assert_equal(CamLogic::buildControlQuery(false, 60), 'enabled=0');
});

camtest_test('buildControlQuery: turning on includes seconds', function () {
    camtest_assert_equal(CamLogic::buildControlQuery(true, 300), 'enabled=1&seconds=300');
});

camtest_test('buildControlQuery: turning on without an explicit duration', function () {
    camtest_assert_equal(CamLogic::buildControlQuery(true, null), 'enabled=1');
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

exit(camtest_summarize());
