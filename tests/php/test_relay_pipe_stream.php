<?php
// test_relay_pipe_stream.php — relay_pipe_stream() and relay_read_available() (php/cameras/relay.php): the loop that
// carries the relay's live stream to the browser in mux.php. Run against a stream double (a scripted stream wrapper),
// so no web server and no relay are needed:
//   - every chunk goes through the filter and only what the filter returns reaches the browser;
//   - a filter that says "stop" (null) ends the loop at once and nothing more is read or written;
//   - '' from the filter means "nothing to send yet" and the loop reads on;
//   - the end of the stream ends the loop; a pause in the stream (nothing read yet) does not.
// Not covered here: a browser that has gone (connection_aborted() is always 0 on the command line).

require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';
require_once __DIR__ . '/../../php/cameras/relay.php';

// A stream that returns scripted reads, one per fread(): a string is that chunk, '' is "nothing there yet". When the
// script is used up the stream is at its end. The reads the code under test made are counted.
final class ScriptedStream
{
    public const SCHEME = 'scripted';
    /** @var array<string, array{script: string[], reads: int}> */
    public static array $streams = [];
    public $context;
    private string $id = '';

    public static function open(array $script): array
    {
        if (!in_array(self::SCHEME, stream_get_wrappers(), true)) {
            stream_wrapper_register(self::SCHEME, self::class);
        }
        $id = bin2hex(random_bytes(4));
        self::$streams[$id] = ['script' => $script, 'reads' => 0];
        return [fopen(self::SCHEME . '://' . $id, 'rb'), $id];
    }

    public function stream_open(string $path): bool
    {
        $this->id = substr($path, strlen(self::SCHEME) + 3);
        return isset(self::$streams[$this->id]);
    }

    public function stream_read(int $count): string|false
    {
        $s = &self::$streams[$this->id];
        $s['reads']++;
        return $s['script'] === [] ? '' : array_shift($s['script']);
    }

    public function stream_eof(): bool
    {
        return self::$streams[$this->id]['script'] === [];
    }

    public function stream_set_option(int $option, int $arg1, ?int $arg2): bool
    {
        return false;   // blocking mode cannot be changed on this stream; the code under test does not depend on it
    }

    public function stream_stat(): array
    {
        return [];
    }

    public function stream_close(): void
    {
    }
}

// What relay_pipe_stream() sent to the browser for $script, and what the filter was given; also how many reads it took.
function pipe_run(array $script, callable $filter, ?array &$filterSaw = null, ?int &$reads = null): string
{
    [$stream, $id] = ScriptedStream::open($script);
    $filterSaw = [];
    ob_start();
    try {
        relay_pipe_stream($stream, function (string $chunk) use ($filter, &$filterSaw) {
            $filterSaw[] = $chunk;
            return $filter($chunk);
        });
    } finally {
        $out = (string) ob_get_clean();
        $reads = ScriptedStream::$streams[$id]['reads'];
        fclose($stream);
    }
    return $out;
}

camtest_test('relay_pipe_stream: what the filter returns is what the browser gets, chunk by chunk, in order', function () {
    $out = pipe_run(['aa', 'bb', 'cc'], function ($chunk) { return strtoupper($chunk); }, $saw);
    camtest_assert_equal($out, 'AABBCC');
    camtest_assert_equal($saw, ['aa', 'bb', 'cc']);
});

camtest_test('relay_pipe_stream: the filter is never given an empty read, and a pause does not end the stream', function () {
    $out = pipe_run(['aa', '', '', 'bb'], function ($chunk) { return $chunk; }, $saw);
    camtest_assert_equal($saw, ['aa', 'bb']);
    camtest_assert_equal($out, 'aabb');
});

camtest_test('relay_pipe_stream: a filter that returns "" sends nothing for that chunk and the loop reads on', function () {
    $out = pipe_run(['aa', 'bb', 'cc'], function ($chunk) { return $chunk === 'bb' ? '' : $chunk; }, $saw);
    camtest_assert_equal($out, 'aacc');
    camtest_assert_equal($saw, ['aa', 'bb', 'cc']);
});

camtest_test('relay_pipe_stream: a filter that returns null stops the loop: nothing more is sent or read', function () {
    $out = pipe_run(['aa', 'bb', 'cc'], function ($chunk) { return $chunk === 'bb' ? null : $chunk; }, $saw, $reads);
    camtest_assert_equal($out, 'aa', 'the chunk before the stop went out, the stopping chunk and everything after did not');
    camtest_assert_equal($saw, ['aa', 'bb'], 'the chunk after the stop was never given to the filter');
    camtest_assert_equal($reads, 2, 'and never read');
});

camtest_test('relay_pipe_stream: a stream that is already at its end sends nothing and never calls the filter', function () {
    $out = pipe_run([], function ($chunk) { return $chunk; }, $saw);
    camtest_assert_equal([$out, $saw], ['', []]);
});

camtest_test('relay_pipe_stream: binary chunks pass through untouched', function () {
    $bytes = implode('', array_map('chr', range(0, 255)));
    camtest_assert_equal(pipe_run([$bytes], function ($chunk) { return $chunk; }), $bytes);
});

camtest_test('relay_pipe_stream: an exception of the filter is not swallowed', function () {
    $thrown = null;
    try {
        pipe_run(['aa'], function ($chunk) { throw new RuntimeException('boom'); });
    } catch (RuntimeException $e) {
        $thrown = $e->getMessage();
    }
    camtest_assert_equal($thrown, 'boom');
});

camtest_test('relay_read_available: bytes are returned as they are and the time of the last data is updated', function () {
    [$stream] = ScriptedStream::open(['abc', 'def']);
    $lastDataAt = 1.0;
    camtest_assert_equal(relay_read_available($stream, $lastDataAt), 'abc');
    camtest_assert_true($lastDataAt > 1.0, 'the silence clock restarts with every byte');
    fclose($stream);
});

camtest_test('relay_read_available: nothing there yet is "" (after a short nap), not the end', function () {
    [$stream] = ScriptedStream::open(['', 'x']);
    $lastDataAt = microtime(true);
    $started = microtime(true);
    camtest_assert_equal(relay_read_available($stream, $lastDataAt), '');
    camtest_assert_true(microtime(true) - $started >= RELAY_POLL_MICROSECONDS / 1e6 * 0.5, 'it naps instead of spinning');
    fclose($stream);
});

camtest_test('relay_read_available: the end of the stream is null', function () {
    [$stream] = ScriptedStream::open([]);
    $lastDataAt = microtime(true);
    camtest_assert_equal(relay_read_available($stream, $lastDataAt), null);
    fclose($stream);
});

camtest_test('relay_read_available: a relay silent for longer than the limit is given up on (null), a quieter one is not', function () {
    [$stream] = ScriptedStream::open(['', '', 'x']);
    $longAgo = microtime(true) - 100;
    $lastDataAt = $longAgo;
    camtest_assert_equal(relay_read_available($stream, $lastDataAt, 15), null, 'silent for 100 s with a limit of 15');
    camtest_assert_equal($lastDataAt, $longAgo, 'giving up does not touch the clock');
    $lastDataAt = microtime(true) - 5;
    camtest_assert_equal(relay_read_available($stream, $lastDataAt, 15), '', 'silent for 5 s with a limit of 15');
    fclose($stream);
});

exit(camtest_summarize());
