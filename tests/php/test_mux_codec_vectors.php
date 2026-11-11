<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/MuxStream.php';

// The wire format of GET /mux against the SAME golden bytes the Node side is checked against
// (tests/fixtures/mux_codec_vectors.json, tests/node/test_muxcodec_vectors.js), plus a seeded fuzz:
//   - CamMuxStream::encode writes exactly those bytes, takeMessages reads them back however they are cut;
//   - bytes that are not this format give null (the caller stops), never an exception or a warning;
//   - the buffer never holds more than one message, so a hostile peer cannot make PHP grow.

const MUX_FUZZ_ROUNDS = 300;
$vectors = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/mux_codec_vectors.json'), true);

// Feeds $bytes in chunks of the given sizes (cycled), as mux.php reads from the relay. Returns the messages in the
// shape of the fixture, or null once takeMessages refuses. $maxBuffer is the largest the leftover buffer ever got.
function mux_vectors_read(string $bytes, array $sizes, ?int &$maxBuffer = null): ?array
{
    $buffer = '';
    $out = [];
    $maxBuffer = 0;
    for ($at = 0, $i = 0; $at < strlen($bytes); $i++) {
        $size = $sizes[$i % count($sizes)];
        $buffer .= substr($bytes, $at, $size);
        $at += $size;
        $messages = CamMuxStream::takeMessages($buffer);
        if ($messages === null) {
            return null;
        }
        $maxBuffer = max($maxBuffer, strlen($buffer));
        foreach ($messages as $m) {
            $out[] = ['type' => $m['type'], 'source' => $m['source'], 'payloadHex' => bin2hex($m['payload'])];
        }
    }
    return $out;
}

function mux_vectors_chunkings(): array
{
    return [[1], [2], [3], [7], [64], [1 << 20], [1, 5, 2, 9]];
}

camtest_test('the fixture has every kind of vector', function () use ($vectors) {
    camtest_assert_true(count($vectors['valid']) >= 10 && count($vectors['invalid']) >= 10 && count($vectors['incomplete']) >= 4);
});

camtest_test('valid vectors: encode writes exactly these bytes', function () use ($vectors) {
    foreach ($vectors['valid'] as $v) {
        $written = '';
        foreach ($v['messages'] as $m) {
            $written .= CamMuxStream::encode($m['type'], $m['source'], (string) hex2bin($m['payloadHex']));
        }
        camtest_assert_equal(bin2hex($written), $v['hex'], $v['name']);
    }
});

camtest_test('valid vectors: takeMessages reads these messages, whatever the chunking', function () use ($vectors) {
    foreach ($vectors['valid'] as $v) {
        foreach (mux_vectors_chunkings() as $sizes) {
            camtest_assert_equal(mux_vectors_read((string) hex2bin($v['hex']), $sizes), $v['messages'], $v['name'] . ', chunks ' . implode(',', $sizes));
        }
    }
});

camtest_test('invalid vectors: takeMessages refuses them (null), whatever the chunking', function () use ($vectors) {
    foreach ($vectors['invalid'] as $v) {
        foreach (mux_vectors_chunkings() as $sizes) {
            camtest_assert_equal(mux_vectors_read((string) hex2bin($v['hex']), $sizes), null, $v['name'] . ', chunks ' . implode(',', $sizes));
        }
    }
});

camtest_test('incomplete vectors: nothing comes out and nothing is refused', function () use ($vectors) {
    foreach ($vectors['incomplete'] as $v) {
        foreach (mux_vectors_chunkings() as $sizes) {
            camtest_assert_equal(mux_vectors_read((string) hex2bin($v['hex']), $sizes), [], $v['name'] . ', chunks ' . implode(',', $sizes));
        }
    }
});

camtest_test('fuzz: random messages cut at random places come out whole, in order, byte for byte', function () {
    for ($seed = 1; $seed <= MUX_FUZZ_ROUNDS; $seed++) {
        mt_srand($seed);
        $expected = [];
        $stream = '';
        for ($n = mt_rand(0, 5); $n >= 0; $n--) {
            $type = [CamMuxStream::TYPE_FRAME, CamMuxStream::TYPE_STATE, CamMuxStream::TYPE_HEARTBEAT, mt_rand(4, 253)][mt_rand(0, 3)];
            $heartbeat = $type === CamMuxStream::TYPE_HEARTBEAT;
            $source = $heartbeat ? '' : 'cam:' . bin2hex(random_bytes_seeded(mt_rand(0, 19)));
            $payload = $heartbeat ? '' : random_bytes_seeded(mt_rand(0, 2999));
            $stream .= CamMuxStream::encode($type, $source, $payload);
            $expected[] = ['type' => $type, 'source' => $source, 'payloadHex' => bin2hex($payload)];
        }
        $sizes = [];
        for ($i = 0; $i < 7; $i++) {
            $sizes[] = mt_rand(1, 40);
        }
        camtest_assert_equal(mux_vectors_read($stream, $sizes), $expected, "seed $seed");
    }
});

// random_bytes() is not seedable; the fuzz must be replayable.
function random_bytes_seeded(int $n): string
{
    $out = '';
    for ($i = 0; $i < $n; $i++) {
        $out .= chr(mt_rand(0, 255));
    }
    return $out;
}

camtest_test('fuzz: random garbage gives messages or null, never an exception or a warning, and the buffer stays small', function () {
    $limit = 4 + 3 + CamMuxStream::MAX_SOURCE_BYTES + CamMuxStream::MAX_PAYLOAD_BYTES;
    $refused = 0;
    set_error_handler(function ($no, $str) { throw new ErrorException($str, 0, $no); });
    try {
        for ($seed = 1; $seed <= MUX_FUZZ_ROUNDS * 4; $seed++) {
            mt_srand($seed);
            // half of the cases start like a real message so the parser gets past the length check into the body
            $head = mt_rand(0, 1) === 0 ? pack('C*', 0, 0, 0, 3 + mt_rand(0, 59), mt_rand(0, 3), mt_rand(0, 3), mt_rand(0, 99)) : '';
            $bytes = $head . random_bytes_seeded(mt_rand(0, 399));
            $sizes = [mt_rand(1, 40), mt_rand(1, 40), mt_rand(1, 40)];
            $max = 0;
            if (mux_vectors_read($bytes, $sizes, $max) === null) {
                $refused++;
            }
            camtest_assert_true($max <= $limit, "seed $seed: the buffer grew to $max");
        }
    } finally {
        restore_error_handler();
    }
    camtest_assert_true($refused > 100, 'the garbage must actually reach the refusals, or this test proves nothing: ' . $refused);
});

exit(camtest_summarize());
