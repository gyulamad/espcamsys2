<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/EventStream.php';

$cams = [['id' => 'cam1', 'name' => 'Front', 'url' => 'http://x', 'detector' => 'det1']];

camtest_test('takeMessages returns each complete message and keeps the incomplete tail', function () {
    $b = "event: detectors\ndata: {\"a\":1}\n\nevent: detectors\ndata: {\"b\"";
    $m = CamEventStream::takeMessages($b);
    camtest_assert_equal($m, ['{"a":1}']);
    camtest_assert_equal($b, "event: detectors\ndata: {\"b\"");
    $b .= ":2}\n\n";
    camtest_assert_equal(CamEventStream::takeMessages($b), ['{"b":2}']);
    camtest_assert_equal($b, '');
});

camtest_test('takeMessages copes with CRLF, comments, no-space data and multi-line data', function () {
    $b = ": hello\r\n\r\ndata:{\"a\":1}\r\n\r\ndata: x\ndata: y\n\n";
    camtest_assert_equal(CamEventStream::takeMessages($b), ['{"a":1}', "x\ny"]);
});

camtest_test('takeMessages is split-proof: bytes arriving one at a time give the same messages', function () {
    $all = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
    $b = ''; $got = [];
    foreach (str_split($all) as $ch) {
        $b .= $ch;
        $got = array_merge($got, CamEventStream::takeMessages($b));
    }
    camtest_assert_equal($got, ['{"a":1}', '{"b":2}']);
});

camtest_test('takeMessages gives up on a peer that never ends a message', function () {
    $b = str_repeat('x', CamEventStream::MAX_BUFFER_BYTES + 1);
    camtest_assert_true(CamEventStream::takeMessages($b) === null);
});

camtest_test('forward maps the relay detectors to the per-camera status, as one SSE message', function () use ($cams) {
    $relay = json_encode(['det1' => ['state' => 'online', 'online' => true, 'hasPicture' => true, 'connected' => true,
        'ageMs' => 10, 'pictureAgeMs' => 10, 'ip' => '1.2.3.4', 'message' => '', 'report' => null]]);
    $out = CamEventStream::forward($relay, $cams);
    camtest_assert_true(strpos($out, "event: detectors\ndata: ") === 0 && substr($out, -2) === "\n\n");
    $json = json_decode(trim(substr($out, strlen("event: detectors\ndata: "))), true);
    camtest_assert_equal($json['cam1']['state'], 'online');
    camtest_assert_equal($json['cam1']['detector'], 'det1');
});

camtest_test('forward: a detector the relay does not know is "never"; an empty map still forwards', function () use ($cams) {
    $out = CamEventStream::forward('{}', $cams);
    camtest_assert_true(strpos($out, '"state":"never"') !== false);
    camtest_assert_true(strpos(CamEventStream::forward('[]', $cams), 'cam1') !== false);
});

camtest_test('forward skips data that is not a JSON object', function () use ($cams) {
    camtest_assert_true(CamEventStream::forward('not json', $cams) === null);
    camtest_assert_true(CamEventStream::forward('42', $cams) === null);
});

camtest_test('forward never passes the relay text through: only the shaped status leaves', function () use ($cams) {
    $out = CamEventStream::forward('{"evil":{"state":"online"},"det1":{"state":"online"}}', $cams);
    camtest_assert_true(strpos($out, 'evil') === false, 'unpaired detector ids are not forwarded');
});

camtest_test('preamble sets the browser retry delay', function () {
    camtest_assert_equal(CamEventStream::preamble(1500), "retry: 1500\n\n");
});

exit(camtest_summarize());
