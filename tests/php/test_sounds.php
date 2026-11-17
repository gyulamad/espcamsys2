<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Sounds.php';

// test_sounds.php — the dashboard's alarm sound rules (php/cameras/lib/Sounds.php). They must agree with the relay's
// (nodejs/camera-relay/lib/sounds.js): the same names are accepted here and there — checked against that file's
// own pattern below, so the two cannot drift apart unnoticed.

camtest_test('isName: plain names with a known extension', function () {
    foreach (['siren.wav', 'Alarm_1.mp3', 'a.ogg', 'x-y.z.wav', 'SIREN.WAV', '1.mp3', str_repeat('a', 60) . '.wav'] as $ok) {
        camtest_assert_true(CamSounds::isName($ok), $ok);
    }
});

camtest_test('isName: nothing that could leave the folder, hide, or be another kind of file', function () {
    foreach (['', '.wav', '.hidden.wav', '../x.wav', 'a/b.wav', 'a\\b.wav', '/etc/passwd', 'a..wav', 'a b.wav', "a.wav\n", 'siren', 'siren.txt',
              'siren.php', 'siren.wav.php', 'a.mp4', str_repeat('a', 61) . '.wav', "a\0.wav", '-rf.wav'] as $bad) {
        camtest_assert_true(!CamSounds::isName($bad), json_encode($bad));
    }
    foreach ([null, 5, 1.5, true, [], ['a.wav']] as $notText) {
        camtest_assert_true(!CamSounds::isName($notText), var_export($notText, true));
    }
});

camtest_test('isName agrees with the relay: the same pattern, the same limits', function () {
    $src = file_get_contents(__DIR__ . '/../../nodejs/camera-relay/lib/sounds.js');
    camtest_assert_true(preg_match('#const NAME_PATTERN = /\^(.*)\$/;#', $src, $m) === 1, 'the relay\'s pattern was found');
    camtest_assert_equal('/^' . $m[1] . '$/D', CamSounds::NAME_PATTERN);
    camtest_assert_true(preg_match('/const MAX_SOUND_BYTES = 1024 \* 1024;/', $src) === 1 && CamSounds::MAX_BYTES === 1024 * 1024);
    camtest_assert_true(preg_match('/const MAX_SOUNDS = (\d+);/', $src, $n) === 1 && (int) $n[1] === CamSounds::MAX_SOUNDS);
    foreach (['wav', 'mp3', 'ogg'] as $ext) {
        camtest_assert_true(strpos($src, "'." . $ext . "': { contentType: '" . CamSounds::CONTENT_TYPES[$ext] . "'") !== false, $ext);
    }
    camtest_assert_equal(count(CamSounds::CONTENT_TYPES), 3);
    camtest_assert_true(CamSounds::MAX_BYTES < 2097152, 'fits through the web server\'s 2 MiB request limit');
});

camtest_test('the event kinds agree with the relay\'s', function () {
    $src = file_get_contents(__DIR__ . '/../../nodejs/camera-relay/lib/alarmsound.js');
    preg_match_all('/^  (\w+): Object\.freeze\(\{$/m', $src, $m);
    camtest_assert_equal($m[1], CamSounds::EVENT_KINDS);
});

camtest_test('contentType: from the extension, never from anything else', function () {
    camtest_assert_equal(CamSounds::contentType('a.wav'), 'audio/wav');
    camtest_assert_equal(CamSounds::contentType('a.MP3'), 'audio/mpeg');
    camtest_assert_equal(CamSounds::contentType('a.ogg'), 'audio/ogg');
    camtest_assert_equal(CamSounds::contentType('a.html'), null);
    camtest_assert_equal(CamSounds::contentType('../a.wav'), null);
    camtest_assert_equal(CamSounds::contentType(null), null);
});

camtest_test('relayUrl: the library, one sound, the play action — and nothing for a name that is not a sound\'s', function () {
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080/'), 'http://r:8080/sounds');
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080', 'a.wav'), 'http://r:8080/sounds/a.wav');
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080', 'a.wav', 'play'), 'http://r:8080/sounds/a.wav/play');
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080', '../etc/passwd'), null);
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080', 'a.wav', 'delete'), null);
    camtest_assert_equal(CamSounds::relayUrl('http://r:8080', 'a.wav', '../x'), null);
});

camtest_test('requestedName: absent is the library; present must be a sound\'s name', function () {
    camtest_assert_equal(CamSounds::requestedName([]), ['name' => null]);
    camtest_assert_equal(CamSounds::requestedName(['name' => 'a.wav']), ['name' => 'a.wav']);
    foreach ([['name' => '../a.wav'], ['name' => ''], ['name' => ['a.wav']], ['name' => 'a.txt']] as $bad) {
        camtest_assert_true(isset(CamSounds::requestedName($bad)['error']), json_encode($bad));
    }
});

camtest_test('adminRequest: an action and a sound\'s name, both required', function () {
    camtest_assert_equal(CamSounds::adminRequest(['action' => 'upload', 'name' => 'a.wav']), ['action' => 'upload', 'name' => 'a.wav']);
    camtest_assert_equal(CamSounds::adminRequest(['action' => 'play', 'name' => 'a.mp3'])['action'], 'play');
    foreach ([[], ['name' => 'a.wav'], ['action' => 'upload'], ['action' => 'rm', 'name' => 'a.wav'], ['action' => ['upload'], 'name' => 'a.wav'],
              ['action' => 'delete', 'name' => '../a.wav'], ['action' => 'delete', 'name' => ['a.wav']]] as $bad) {
        camtest_assert_true(isset(CamSounds::adminRequest($bad)['error']), json_encode($bad));
    }
});

camtest_test('shapeList: the relay\'s list is rebuilt: good entries kept, odd ones dropped, limits are this server\'s own', function () {
    $relay = json_encode(['sounds' => [
        ['name' => 'a.wav', 'bytes' => 10, 'extra' => 'x'], ['name' => '../b.wav', 'bytes' => 1], ['name' => 'c.mp3', 'bytes' => -1],
        ['name' => 'd.ogg', 'bytes' => '5'], 'junk', null, ['name' => 'e.ogg', 'bytes' => 7],
    ], 'maxBytes' => 99999999, 'maxSounds' => 5000, '<script>' => 1]);
    camtest_assert_equal(json_decode(CamSounds::shapeList($relay), true), [
        'sounds' => [['name' => 'a.wav', 'bytes' => 10], ['name' => 'e.ogg', 'bytes' => 7]],
        'maxBytes' => CamSounds::MAX_BYTES, 'maxSounds' => CamSounds::MAX_SOUNDS,
    ]);
    camtest_assert_equal(json_decode(CamSounds::shapeList('{"sounds":[]}'), true)['sounds'], []);
    camtest_assert_true(strpos((string) CamSounds::shapeList('{"sounds":[]}'), '"sounds":[]') !== false, 'an empty list stays a list');
});

camtest_test('shapeList: what is not a list is null', function () {
    foreach (['', 'nonsense', '[]', '{}', '{"sounds":"x"}', '5', 'null'] as $bad) {
        camtest_assert_equal(CamSounds::shapeList($bad), null, $bad);
    }
});

$event = ['seq' => 1, 'at' => 1500, 'kind' => 'recordStart', 'camId' => 'cam1', 'sound' => 'siren.wav'];

camtest_test('shapeAlarmState: a good list comes out the same, with nothing added', function () use ($event) {
    $in = ['epoch' => 1000, 'now' => 2000, 'events' => [$event, ['seq' => 2, 'at' => 1600, 'kind' => 'personDetected', 'camId' => 'cam2', 'sound' => 'b.mp3']]];
    camtest_assert_equal(json_decode(CamSounds::shapeAlarmState(json_encode($in)), true), $in);
    camtest_assert_true(strpos(CamSounds::shapeAlarmState('{"epoch":1,"now":2,"events":[]}'), '"events":[]') !== false);
});

camtest_test('shapeAlarmState: extra fields are dropped; events of an unknown kind or with odd names or numbers are dropped', function () use ($event) {
    $bad = [
        array_merge($event, ['kind' => 'selfDestruct']), array_merge($event, ['camId' => '../x']), array_merge($event, ['camId' => '<b>']),
        array_merge($event, ['sound' => '../a.wav']), array_merge($event, ['sound' => 'a.html']), array_merge($event, ['seq' => 0]),
        array_merge($event, ['seq' => '1']), array_merge($event, ['at' => 'now']), array_merge($event, ['kind' => ['recordStart']]), 'junk', null,
    ];
    $in = ['epoch' => 1, 'now' => 2, 'events' => array_merge($bad, [array_merge($event, ['seq' => 7, 'evil' => '<script>'])]), 'x' => 'y'];
    $out = json_decode(CamSounds::shapeAlarmState(json_encode($in)), true);
    camtest_assert_equal(array_keys($out), ['epoch', 'now', 'events']);
    camtest_assert_equal($out['events'], [array_merge($event, ['seq' => 7])]);
});

camtest_test('shapeAlarmState: at most the latest events are kept, in order', function () use ($event) {
    $events = [];
    for ($i = 1; $i <= CamSounds::MAX_EVENTS + 5; $i++) {
        $events[] = array_merge($event, ['seq' => $i]);
    }
    $out = json_decode(CamSounds::shapeAlarmState(json_encode(['epoch' => 1, 'now' => 2, 'events' => $events])), true);
    camtest_assert_equal(count($out['events']), CamSounds::MAX_EVENTS);
    camtest_assert_equal($out['events'][0]['seq'], 6);
    camtest_assert_equal($out['events'][CamSounds::MAX_EVENTS - 1]['seq'], CamSounds::MAX_EVENTS + 5);
});

camtest_test('shapeAlarmState: anything that is not an alarm list is null (the message is skipped)', function () {
    foreach (['', 'nonsense', '[]', '{}', '{"epoch":1,"now":2}', '{"epoch":"1","now":2,"events":[]}', '{"epoch":1,"now":2.5,"events":[]}', '{"epoch":1,"now":2,"events":"x"}', 'null'] as $bad) {
        camtest_assert_equal(CamSounds::shapeAlarmState($bad), null, $bad);
    }
});

camtest_test('shapeAnswer: a success is just ok (and whether a sound was replaced, when the relay said so)', function () {
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer('{"ok":true,"name":"a.wav","bytes":5,"replaced":true,"secret":"x"}', 200, 'f'), true), ['ok' => true, 'replaced' => true]);
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer('{"ok":true}', 200, 'f'), true), ['ok' => true]);
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer('not json', 200, 'f'), true), ['ok' => true]);
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer('{"replaced":"yes"}', 204, 'f'), true), ['ok' => true]);
});

camtest_test('shapeAnswer: an error carries the relay\'s short plain reason, else the fallback — never anything else the relay sent', function () {
    $reason = 'the sound a.wav is chosen for when a recording starts — choose another';
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer(json_encode(['error' => $reason, 'trace' => 'x']), 409, 'fallback'), true), ['error' => $reason]);
    foreach (['', 'not json', '{}', '{"error":5}', '{"error":["x"]}', json_encode(['error' => str_repeat('x', 301)]), json_encode(['error' => "a\nb"]), json_encode(['error' => "a\x1bb"])] as $bad) {
        camtest_assert_equal(json_decode(CamSounds::shapeAnswer($bad, 502, 'fallback'), true), ['error' => 'fallback'], $bad);
    }
    camtest_assert_equal(json_decode(CamSounds::shapeAnswer('{"error":"x"}', 199, 'f'), true), ['error' => 'x']);
});

camtest_test('cleanSoundFields: a sound field keeps only valid names as options and as its value; other fields are left alone', function () {
    $fields = [
        ['key' => 'alarmSoundRecordStart', 'type' => 'sound', 'value' => 'a.wav', 'options' => ['a.wav', '../b.wav', 'c.txt', 5, 'd.ogg', ['x']], 'label' => 'L'],
        ['key' => 'alarmSoundPersonDetected', 'type' => 'sound', 'value' => '<script>', 'options' => 'nonsense'],
        ['key' => 'alarmSoundX', 'type' => 'sound', 'value' => ''],
        ['key' => 'port', 'type' => 'int', 'value' => 8080, 'options' => ['x']],
        'junk', null,
    ];
    $out = CamSounds::cleanSoundFields($fields);
    camtest_assert_equal($out[0], ['key' => 'alarmSoundRecordStart', 'type' => 'sound', 'value' => 'a.wav', 'options' => ['a.wav', 'd.ogg'], 'label' => 'L']);
    camtest_assert_equal([$out[1]['value'], $out[1]['options']], ['', []]);
    camtest_assert_equal([$out[2]['value'], $out[2]['options']], ['', []]);
    camtest_assert_equal($out[3], $fields[3]);
    camtest_assert_equal([$out[4], $out[5]], ['junk', null]);
    camtest_assert_equal(CamSounds::cleanSoundFields([]), []);
});

exit(camtest_summarize());
