<?php
// Sounds.php — the dashboard's side of the alarm sounds, as pure functions (tests/php/test_sounds.php): which names a
// sound may have, which type it is served with, and the shaping of what the relay sends before a browser gets it.
//
// The naming rules are the relay's (nodejs/camera-relay/lib/sounds.js) and must agree with them: a name is ONE plain
// path segment (letters, digits . _ -, not starting with a dot, no "..") ending in .wav, .mp3 or .ogg. They are
// applied here as well, before a name goes into a URL to the relay, so a browser can never make this server ask the
// relay for anything but a sound. What the relay answers is rebuilt field by field, never passed on as it came: the
// browser only gets names, numbers and the two kinds of alarm it knows.

require_once __DIR__ . '/Logic.php';

final class CamSounds
{
    const NAME_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/D';
    // What a sound is served as — decided here from the extension, never taken from the relay's answer.
    const CONTENT_TYPES = ['wav' => 'audio/wav', 'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg'];
    // The relay takes up to 1 MiB; the web server's own request limit (apache/camdash-protect.conf) is 2 MiB.
    const MAX_BYTES = 1048576;
    const MAX_SOUNDS = 20;
    const EVENT_KINDS = ['recordStart', 'personDetected'];
    const MAX_EVENTS = 16;
    const ACTIONS = ['upload', 'delete', 'play'];

    public static function isName($name): bool
    {
        if (!is_string($name) || preg_match(self::NAME_PATTERN, $name) !== 1 || strpos($name, '..') !== false) {
            return false;
        }
        return isset(self::CONTENT_TYPES[strtolower((string) pathinfo($name, PATHINFO_EXTENSION))]);
    }

    // The Content-Type of a sound's name, or null when the name is not a sound's.
    public static function contentType($name): ?string
    {
        return self::isName($name) ? self::CONTENT_TYPES[strtolower((string) pathinfo($name, PATHINFO_EXTENSION))] : null;
    }

    // The relay's address for the library ($name null) or one sound, with an optional action after it ('play').
    // Null for a name that is not a sound's, so a caller cannot build a URL for anything else.
    public static function relayUrl(string $relayBase, ?string $name = null, string $action = ''): ?string
    {
        $base = rtrim($relayBase, '/') . '/sounds';
        if ($name === null) {
            return $base;
        }
        if (!self::isName($name) || !in_array($action, ['', 'play'], true)) {
            return null;
        }
        return $base . '/' . rawurlencode($name) . ($action === '' ? '' : '/' . $action);
    }

    // What the sounds.php / sounds-admin.php request asks for: ['name' => ?string] or ['error' => text].
    // A name that is present must be a sound's; absent is allowed (the library).
    public static function requestedName(array $query): array
    {
        if (!array_key_exists('name', $query)) {
            return ['name' => null];
        }
        return self::isName($query['name']) ? ['name' => $query['name']] : ['error' => 'name must be the name of a sound (letters, digits . _ - and ending in .wav, .mp3 or .ogg)'];
    }

    // ['action' => 'upload'|'delete'|'play', 'name' => string] or ['error' => text] for sounds-admin.php.
    public static function adminRequest(array $query): array
    {
        $action = $query['action'] ?? null;
        if (!is_string($action) || !in_array($action, self::ACTIONS, true)) {
            return ['error' => 'action must be one of ' . implode(', ', self::ACTIONS)];
        }
        $named = self::requestedName($query);
        if (isset($named['error']) || $named['name'] === null) {
            return ['error' => $named['error'] ?? 'name is required'];
        }
        return ['action' => $action, 'name' => $named['name']];
    }

    // The library as the relay lists it -> what the browser gets: { sounds: [{name, bytes}], maxBytes, maxSounds }.
    // Entries that are not a sound's name with a size are dropped. Null when the relay's answer is not that object.
    public static function shapeList(string $relayJson): ?string
    {
        $data = json_decode($relayJson, true);
        if (!is_array($data) || !isset($data['sounds']) || !is_array($data['sounds'])) {
            return null;
        }
        $sounds = [];
        foreach ($data['sounds'] as $entry) {
            if (is_array($entry) && self::isName($entry['name'] ?? null) && is_int($entry['bytes'] ?? null) && $entry['bytes'] >= 0) {
                $sounds[] = ['name' => $entry['name'], 'bytes' => $entry['bytes']];
            }
            if (count($sounds) >= self::MAX_SOUNDS * 5) {
                break;
            }
        }
        $json = json_encode([
            'sounds' => $sounds,
            'maxBytes' => self::MAX_BYTES,       // this server's own limits: what the page must hold an upload to
            'maxSounds' => self::MAX_SOUNDS,
        ]);
        return $json === false ? null : $json;
    }

    // The alarm events as the relay sends them (lib/alarmfeed.js) -> the same, rebuilt from checked fields only:
    // { epoch, now, events: [{ seq, at, kind, camId, sound }] }. Events that are malformed, of a kind this page does not
    // know, or for a camera or sound with an odd name are dropped; at most the latest MAX_EVENTS stay. Null when the
    // relay's data is not that object (the message is then skipped, not forwarded).
    public static function shapeAlarmState(string $relayJson): ?string
    {
        $data = json_decode($relayJson, true);
        if (!is_array($data) || !is_int($data['epoch'] ?? null) || !is_int($data['now'] ?? null) || !is_array($data['events'] ?? null)) {
            return null;
        }
        $events = [];
        foreach ($data['events'] as $e) {
            if (!is_array($e)
                || !is_int($e['seq'] ?? null) || $e['seq'] < 1
                || !is_int($e['at'] ?? null)
                || !in_array($e['kind'] ?? null, self::EVENT_KINDS, true)
                || !is_string($e['camId'] ?? null) || preg_match(CamLogic::CAMERA_ID_PATTERN, $e['camId']) !== 1
                || !self::isName($e['sound'] ?? null)) {
                continue;
            }
            $events[] = ['seq' => $e['seq'], 'at' => $e['at'], 'kind' => $e['kind'], 'camId' => $e['camId'], 'sound' => $e['sound']];
        }
        $json = json_encode(['epoch' => $data['epoch'], 'now' => $data['now'], 'events' => array_slice($events, -self::MAX_EVENTS)]);
        return $json === false ? null : $json;
    }

    // The relay's answer to a change (upload, delete, play) -> what the browser gets, for the HTTP status $status the relay
    // answered with: { ok: true } for a success, else { error: text } with the relay's own reason when it gave a short,
    // plain one (it says things like "the sound x is chosen for when a recording starts") and $fallback when not.
    public static function shapeAnswer(string $relayJson, int $status, string $fallback): string
    {
        if ($status >= 200 && $status < 300) {
            $data = json_decode($relayJson, true);
            $answer = ['ok' => true];
            if (is_array($data) && is_bool($data['replaced'] ?? null)) {
                $answer['replaced'] = $data['replaced'];
            }
            return (string) json_encode($answer);
        }
        $data = json_decode($relayJson, true);
        $text = is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : '';
        $plain = $text !== '' && strlen($text) <= 300 && preg_match('/[\x00-\x1f\x7f]/', $text) !== 1;
        return (string) json_encode(['error' => $plain ? $text : $fallback]);
    }

    // The settings fields the relay lists -> the same, where a `sound` field (a choice among the sound files) has only
    // valid sound names as its options and as its value ('' = none): the page builds a <select> from them.
    public static function cleanSoundFields(array $fields): array
    {
        foreach ($fields as $i => $f) {
            if (!is_array($f) || ($f['type'] ?? null) !== 'sound') {
                continue;
            }
            $options = is_array($f['options'] ?? null) ? array_values(array_filter($f['options'], [self::class, 'isName'])) : [];
            $fields[$i]['options'] = $options;
            $value = $f['value'] ?? '';
            $fields[$i]['value'] = $value === '' || self::isName($value) ? $value : '';
        }
        return $fields;
    }
}
