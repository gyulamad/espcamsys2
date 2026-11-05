<?php
// MuxStream.php — the pure part of mux.php: reading the relay's mux stream and writing what the browser may have
// of it. No I/O here, so it is tested without a web server or a relay (tests/php/test_mux_stream.php).
//
// The format is documented in nodejs/camera-relay/lib/muxcodec.js (and read in the browser by js/mux-codec.js):
//   [length u32][version u8][type u8][source length u8][source][payload]      (big-endian)
// The relay speaks in ITS names (a detector's own id); the browser gets the dashboard's: a detector's picture
// arrives as "det:<id of the camera it is paired with>", and the readings as the { camId: status } map that
// detector-status.php answers. So the browser never needs to know a detector's id, and the shaping of the
// readings (CamLogic::buildDetectorStatus) stays in PHP, as it is for detector-events.php. Only what the page
// asked for is passed on, whatever the relay sends.

require_once __DIR__ . '/Logic.php';
require_once __DIR__ . '/EventStream.php';

final class CamMuxStream
{
    public const VERSION = 1;
    public const TYPE_FRAME = 1;
    public const TYPE_HEARTBEAT = 2;
    public const TYPE_STATE = 3;
    public const STATE_DETECTORS = 'state:detectors';
    public const MAX_SOURCE_BYTES = 80;
    public const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;   // the largest picture the relay accepts from a camera

    private const LENGTH_BYTES = 4;
    private const FIXED_BODY_BYTES = 3;                 // version + type + source length

    // The complete messages in $buffer (the bytes read so far; what is left of it is the start of the next message):
    // [ ['type' => int, 'source' => string, 'payload' => string], ... ]. Null when the bytes are not this format
    // (the caller must stop: the peer is not the relay's mux stream). A length that promises more than the largest
    // possible message is refused at once, so the buffer never grows past one message.
    public static function takeMessages(string &$buffer): ?array
    {
        $messages = [];
        $offset = 0;
        $size = strlen($buffer);
        while ($size - $offset >= self::LENGTH_BYTES) {
            $bodyLength = unpack('N', $buffer, $offset)[1];
            if ($bodyLength < self::FIXED_BODY_BYTES || $bodyLength > self::FIXED_BODY_BYTES + self::MAX_SOURCE_BYTES + self::MAX_PAYLOAD_BYTES) {
                return null;
            }
            if ($size - $offset < self::LENGTH_BYTES + $bodyLength) {
                break;
            }
            $message = self::readBody((string) substr($buffer, $offset + self::LENGTH_BYTES, $bodyLength));
            if ($message === null) {
                return null;
            }
            $messages[] = $message;
            $offset += self::LENGTH_BYTES + $bodyLength;
        }
        $buffer = (string) substr($buffer, $offset);
        return $messages;
    }

    private static function readBody(string $body): ?array
    {
        if (ord($body[0]) !== self::VERSION) {
            return null;
        }
        $sourceLength = ord($body[2]);
        if ($sourceLength > self::MAX_SOURCE_BYTES || self::FIXED_BODY_BYTES + $sourceLength > strlen($body)) {
            return null;
        }
        return [
            'type' => ord($body[1]),
            'source' => (string) substr($body, self::FIXED_BODY_BYTES, $sourceLength),
            'payload' => (string) substr($body, self::FIXED_BODY_BYTES + $sourceLength),
        ];
    }

    public static function encode(int $type, string $source, string $payload): string
    {
        return pack('NCCC', self::FIXED_BODY_BYTES + strlen($source) + strlen($payload), self::VERSION, $type, strlen($source))
            . $source . $payload;
    }

    // The sources a request asks for, as the relay names them => as the browser gets them:
    // a camera's picture "cam:<id>" stays, a detector's picture "det:<detector id>" becomes "det:<camera id>".
    // $detectorByCamera: camera id => the id of its paired detector.
    public static function allowedSources(array $camIds, array $detectorByCamera): array
    {
        $allowed = [];
        foreach ($camIds as $id) {
            $allowed['cam:' . $id] = 'cam:' . $id;
        }
        foreach ($detectorByCamera as $camId => $detectorId) {
            $allowed['det:' . $detectorId] = 'det:' . $camId;
        }
        return $allowed;
    }

    // What the browser gets for the messages of one read: heartbeats, and pictures from the $allowed sources (renamed);
    // when $status, the newest readings (shaped like detector-status.php's answer; the older ones are out of date);
    // nothing else, so a type or source this page never asked for does not get through.
    public static function forward(array $messages, array $allowed, bool $status, array $cameras): string
    {
        $out = '';
        $newestReadings = null;
        foreach ($messages as $message) {
            if ($message['type'] === self::TYPE_HEARTBEAT) {
                $out .= self::encode(self::TYPE_HEARTBEAT, '', '');
            } elseif ($message['type'] === self::TYPE_FRAME && isset($allowed[$message['source']])) {
                $out .= self::encode(self::TYPE_FRAME, $allowed[$message['source']], $message['payload']);
            } elseif ($message['type'] === self::TYPE_STATE && $status && $message['source'] === self::STATE_DETECTORS) {
                $newestReadings = $message['payload'];
            }
        }
        if ($newestReadings === null) {
            return $out;
        }
        $json = CamEventStream::statusJson($newestReadings, $cameras);
        return $json === null ? $out : $out . self::encode(self::TYPE_STATE, self::STATE_DETECTORS, $json);
    }
}
