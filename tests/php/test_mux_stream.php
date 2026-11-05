<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/MuxStream.php';

// Messages exactly as the relay's encoder (nodejs/camera-relay/lib/muxcodec.js) writes them: these hex strings were
// made by it, so what is checked here is that PHP reads and writes the same bytes as the relay does.
const MUX_HEARTBEAT = '00000003010200';
const MUX_FRAME_CAM = '0000001101010863616d3a63616d31ffd80102ffd9';        // frame, "cam:cam1", ff d8 01 02 ff d9
const MUX_FRAME_DET = '000000100101086465743a64657431ffd809ffd9';          // frame, "det:det1", ff d8 09 ff d9
const MUX_STATE = '0000001901030f73746174653a6465746563746f72737b2261223a317d';   // state, "state:detectors", {"a":1}

function mux_bytes(string $hex): string
{
    return (string) hex2bin($hex);
}

$cams = [
    ['id' => 'cam1', 'name' => 'Front', 'url' => 'http://x', 'detector' => 'det1'],
    ['id' => 'cam2', 'name' => 'Back', 'url' => 'http://x'],
];

// What a browser would read of $bytes: [[type, source, payload], ...]
function mux_read(string $bytes): array
{
    $buffer = $bytes;
    $messages = CamMuxStream::takeMessages($buffer);
    return array_map(function ($m) { return [$m['type'], $m['source'], $m['payload']]; }, $messages ?? []);
}

camtest_test('takeMessages reads what the relay writes: heartbeat, picture, readings', function () {
    $buffer = mux_bytes(MUX_HEARTBEAT . MUX_FRAME_CAM . MUX_STATE);
    $got = CamMuxStream::takeMessages($buffer);
    camtest_assert_equal($buffer, '');
    camtest_assert_equal($got, [
        ['type' => CamMuxStream::TYPE_HEARTBEAT, 'source' => '', 'payload' => ''],
        ['type' => CamMuxStream::TYPE_FRAME, 'source' => 'cam:cam1', 'payload' => mux_bytes('ffd80102ffd9')],
        ['type' => CamMuxStream::TYPE_STATE, 'source' => 'state:detectors', 'payload' => '{"a":1}'],
    ]);
});

camtest_test('encode writes the same bytes as the relay', function () {
    camtest_assert_equal(bin2hex(CamMuxStream::encode(CamMuxStream::TYPE_HEARTBEAT, '', '')), MUX_HEARTBEAT);
    camtest_assert_equal(bin2hex(CamMuxStream::encode(CamMuxStream::TYPE_FRAME, 'cam:cam1', mux_bytes('ffd80102ffd9'))), MUX_FRAME_CAM);
    camtest_assert_equal(bin2hex(CamMuxStream::encode(CamMuxStream::TYPE_STATE, 'state:detectors', '{"a":1}')), MUX_STATE);
});

camtest_test('takeMessages keeps the incomplete tail and finishes it when the rest arrives', function () {
    $all = mux_bytes(MUX_FRAME_CAM . MUX_FRAME_DET);
    $buffer = substr($all, 0, strlen($all) - 3);
    $first = CamMuxStream::takeMessages($buffer);
    camtest_assert_equal(count($first), 1);
    camtest_assert_equal($first[0]['source'], 'cam:cam1');
    camtest_assert_equal(strlen($buffer), strlen($all) - 3 - strlen(mux_bytes(MUX_FRAME_CAM)));
    $buffer .= substr($all, -3);
    $second = CamMuxStream::takeMessages($buffer);
    camtest_assert_equal(count($second), 1);
    camtest_assert_equal($second[0]['source'], 'det:det1');
    camtest_assert_equal($buffer, '');
});

camtest_test('takeMessages is split-proof: bytes arriving one at a time give the same messages', function () {
    $all = mux_bytes(MUX_HEARTBEAT . MUX_FRAME_CAM . MUX_STATE . MUX_FRAME_DET);
    $buffer = '';
    $got = [];
    foreach (str_split($all) as $byte) {
        $buffer .= $byte;
        $got = array_merge($got, CamMuxStream::takeMessages($buffer));
    }
    camtest_assert_equal(array_map(function ($m) { return $m['source']; }, $got), ['', 'cam:cam1', 'state:detectors', 'det:det1']);
    camtest_assert_equal($buffer, '');
});

camtest_test('takeMessages with nothing, or less than a length field, returns nothing and keeps what it has', function () {
    $empty = '';
    camtest_assert_equal(CamMuxStream::takeMessages($empty), []);
    $short = "\x00\x00";
    camtest_assert_equal(CamMuxStream::takeMessages($short), []);
    camtest_assert_equal($short, "\x00\x00");
});

camtest_test('takeMessages returns a message of a type it does not know (the caller drops it) and reads on', function () {
    $unknown = CamMuxStream::encode(99, 'x:y', 'zz');
    $buffer = $unknown . mux_bytes(MUX_HEARTBEAT);
    $got = CamMuxStream::takeMessages($buffer);
    camtest_assert_equal([$got[0]['type'], $got[1]['type']], [99, CamMuxStream::TYPE_HEARTBEAT]);
});

camtest_test('takeMessages refuses bytes that are not this format (null: the caller stops)', function () {
    $wrongVersion = mux_bytes('00000003020200');
    camtest_assert_equal(CamMuxStream::takeMessages($wrongVersion), null, 'version 2');
    $tooShort = mux_bytes('0000000201020000');
    camtest_assert_equal(CamMuxStream::takeMessages($tooShort), null, 'a length that cannot hold the fixed part');
    $huge = mux_bytes('ffffffff0101');
    camtest_assert_equal(CamMuxStream::takeMessages($huge), null, 'a length no message has, refused before waiting for it');
    $sourceTooLong = mux_bytes('00000004' . '010109' . '00');
    camtest_assert_equal(CamMuxStream::takeMessages($sourceTooLong), null, 'a source longer than its message');
    $sourceOverLimit = mux_bytes('00000054' . '0101' . '51' . str_repeat('61', 0x51));
    camtest_assert_equal(CamMuxStream::takeMessages($sourceOverLimit), null, 'a source longer than any source');
    $html = '<html><body>nope</body></html>';
    camtest_assert_equal(CamMuxStream::takeMessages($html), null, 'text from something that is not the relay');
});

camtest_test('allowedSources: cameras keep their names, a detector\'s picture is renamed to its camera', function () {
    camtest_assert_equal(
        CamMuxStream::allowedSources(['cam1', 'cam2'], ['cam1' => 'det1']),
        ['cam:cam1' => 'cam:cam1', 'cam:cam2' => 'cam:cam2', 'det:det1' => 'det:cam1']
    );
    camtest_assert_equal(CamMuxStream::allowedSources(['5'], []), ['cam:5' => 'cam:5'], 'numeric ids are fine');
});

$allowed = CamMuxStream::allowedSources(['cam1', 'cam2'], ['cam1' => 'det1']);

camtest_test('forward: heartbeats and the pictures that were asked for go through, a detector\'s renamed to its camera', function () use ($allowed, $cams) {
    $buffer = mux_bytes(MUX_HEARTBEAT . MUX_FRAME_CAM . MUX_FRAME_DET);
    $out = CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [], $cams);
    camtest_assert_equal(mux_read($out), [
        [CamMuxStream::TYPE_HEARTBEAT, '', ''],
        [CamMuxStream::TYPE_FRAME, 'cam:cam1', mux_bytes('ffd80102ffd9')],
        [CamMuxStream::TYPE_FRAME, 'det:cam1', mux_bytes('ffd809ffd9')],
    ]);
});

camtest_test('forward: a picture nobody asked for, a type nobody asked for and readings nobody asked for are dropped', function () use ($cams) {
    $only = CamMuxStream::allowedSources(['cam2'], []);
    $buffer = mux_bytes(MUX_FRAME_CAM . MUX_FRAME_DET . MUX_STATE) . CamMuxStream::encode(99, 'cam:cam2', 'x');
    $out = CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $only, [], $cams);
    camtest_assert_equal($out, '');
});

camtest_test('forward: readings are shaped like detector-status.php answers, under the same source', function () use ($allowed, $cams) {
    $relayReadings = json_encode(['det1' => ['online' => true, 'state' => 'online', 'hasPicture' => true, 'connected' => true, 'ageMs' => 40, 'message' => '', 'report' => ['fw' => 'x']]]);
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, $relayReadings);
    $out = CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams);
    $read = mux_read($out);
    camtest_assert_equal(count($read), 1);
    camtest_assert_equal([$read[0][0], $read[0][1]], [CamMuxStream::TYPE_STATE, 'state:detectors']);
    camtest_assert_equal(json_decode($read[0][2], true), json_decode(json_encode((object) CamLogic::buildDetectorStatus($cams, json_decode($relayReadings, true))), true));
    $status = json_decode($read[0][2], true);
    camtest_assert_equal([array_keys($status), $status['cam1']['detector'], $status['cam1']['state']], [['cam1'], 'det1', 'online'], 'by camera id, only paired cameras');
});

camtest_test('forward: of several readings in one read only the newest is passed on', function () use ($allowed, $cams) {
    $one = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, json_encode(['det1' => ['online' => true, 'state' => 'online']]));
    $two = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, json_encode(['det1' => ['online' => false, 'state' => 'offline']]));
    $buffer = $one . $two;
    $read = mux_read(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams));
    camtest_assert_equal(count($read), 1);
    camtest_assert_equal(json_decode($read[0][2], true)['cam1']['state'], 'offline');
});

camtest_test('forward: readings that are not a JSON object are skipped, the rest of the read still goes through', function () use ($allowed, $cams) {
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, 'not json {') . mux_bytes(MUX_HEARTBEAT);
    $read = mux_read(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams));
    camtest_assert_equal(array_map(function ($m) { return $m[0]; }, $read), [CamMuxStream::TYPE_HEARTBEAT]);
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, '5');
    camtest_assert_equal(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams), '');
});

camtest_test('forward: readings under another source are not the detectors\' readings', function () use ($allowed, $cams) {
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, 'state:other', '{"det1":{}}');
    camtest_assert_equal(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams), '');
});

camtest_test('wantedStates: the detectors\' readings and the cameras\' recording state, as asked for', function () {
    camtest_assert_equal(CamMuxStream::wantedStates(false, false), []);
    camtest_assert_equal(CamMuxStream::wantedStates(true, false), ['state:detectors']);
    camtest_assert_equal(CamMuxStream::wantedStates(false, true), ['state:cameras']);
    camtest_assert_equal(CamMuxStream::wantedStates(true, true), ['state:detectors', 'state:cameras']);
});

camtest_test('cameraStatusJson: a JSON object (or list) passes as it is, anything else is null', function () {
    camtest_assert_equal(CamMuxStream::cameraStatusJson('{"cam1":{"recording":true}}'), '{"cam1":{"recording":true}}');
    camtest_assert_equal(CamMuxStream::cameraStatusJson('{}'), '{}');
    foreach (['not json', '5', 'null', '"x"', ''] as $bad) {
        camtest_assert_equal(CamMuxStream::cameraStatusJson($bad), null, var_export($bad, true));
    }
});

camtest_test('forward: the cameras\' recording state goes through untouched when asked for, and only then', function () use ($allowed, $cams) {
    $json = '{"cam1":{"recording":true,"recordingEndAt":123,"recordingCount":4}}';
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, $json);
    $read = mux_read(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_CAMERAS], $cams));
    camtest_assert_equal($read, [[CamMuxStream::TYPE_STATE, 'state:cameras', $json]]);
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, $json);
    camtest_assert_equal(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS], $cams), '', 'only the detectors\' readings were asked for');
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, $json);
    camtest_assert_equal(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [], $cams), '');
});

camtest_test('forward: both kinds of readings, each its newest only, each under its own source', function () use ($allowed, $cams) {
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, '{"cam1":{"recording":false}}')
        . CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_DETECTORS, json_encode(['det1' => ['online' => true, 'state' => 'online']]))
        . CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, '{"cam1":{"recording":true}}');
    $read = mux_read(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_DETECTORS, CamMuxStream::STATE_CAMERAS], $cams));
    camtest_assert_equal(array_map(function ($m) { return $m[1]; }, $read), ['state:cameras', 'state:detectors']);
    camtest_assert_equal($read[0][2], '{"cam1":{"recording":true}}');
});

camtest_test('forward: recording state that is not a JSON object is skipped, the rest of the read still goes through', function () use ($allowed, $cams) {
    $buffer = CamMuxStream::encode(CamMuxStream::TYPE_STATE, CamMuxStream::STATE_CAMERAS, 'not json {') . mux_bytes(MUX_HEARTBEAT);
    $read = mux_read(CamMuxStream::forward(CamMuxStream::takeMessages($buffer), $allowed, [CamMuxStream::STATE_CAMERAS], $cams));
    camtest_assert_equal(array_map(function ($m) { return $m[0]; }, $read), [CamMuxStream::TYPE_HEARTBEAT]);
});

exit(camtest_summarize());
