<?php
// EventStream.php — the pure part of detector-events.php: reading Server-Sent Events from the relay and
// writing them to the browser. No I/O here, so it is tested without a web server or a relay.

require_once __DIR__ . '/Logic.php';

final class CamEventStream
{
    // The relay sends one small message (a few KB); more than this without a message end is not the relay.
    public const MAX_BUFFER_BYTES = 1048576;
    public const EVENT_NAME = 'detectors';
    // The relay pushes at least once a second; this long without a byte means the stream is dead.
    public const RELAY_SILENCE_SECONDS = 10;

    // Takes the bytes read so far ($buffer, which keeps any incomplete tail) and returns the `data` of every
    // COMPLETE message in it (messages end with a blank line; comments and other fields are ignored).
    // Returns null when the buffer outgrew MAX_BUFFER_BYTES without a message end: the peer is not an SSE
    // relay and the caller must stop.
    public static function takeMessages(string &$buffer): ?array
    {
        $out = [];
        $buffer = str_replace("\r\n", "\n", $buffer);
        while (($end = strpos($buffer, "\n\n")) !== false) {
            $block = substr($buffer, 0, $end);
            $buffer = substr($buffer, $end + 2);
            $data = self::dataOf($block);
            if ($data !== null) {
                $out[] = $data;
            }
        }
        return strlen($buffer) > self::MAX_BUFFER_BYTES ? null : $out;
    }

    // The `data:` lines of one message block joined with newlines (null if it has none).
    private static function dataOf(string $block): ?string
    {
        $lines = [];
        foreach (explode("\n", $block) as $line) {
            if (strncmp($line, 'data:', 5) !== 0) {
                continue;
            }
            $lines[] = ltrim(substr($line, 5), ' ');
        }
        return $lines ? implode("\n", $lines) : null;
    }

    // The readings the browser gets for one relay message: the same { camId: status } map that detector-status.php
    // answers (CamLogic::buildDetectorStatus), as JSON. Null when the relay's data is not a JSON object (it is then
    // skipped, not forwarded). Shared by the SSE stream below and mux.php.
    public static function statusJson(string $relayData, array $cameras): ?string
    {
        $relayDetectors = json_decode($relayData, true);
        if (!is_array($relayDetectors)) {
            return null;
        }
        $json = json_encode((object) CamLogic::buildDetectorStatus($cameras, $relayDetectors));
        return $json === false ? null : $json;
    }

    // The message the browser gets for one relay message, as one SSE message. Null when there is nothing to forward.
    public static function forward(string $relayData, array $cameras): ?string
    {
        $json = self::statusJson($relayData, $cameras);
        return $json === null ? null : 'event: ' . self::EVENT_NAME . "\ndata: " . $json . "\n\n";
    }

    // First bytes of every stream: how long the browser waits before it reconnects by itself.
    public static function preamble(int $retryMs = 1000): string
    {
        return 'retry: ' . $retryMs . "\n\n";
    }
}
