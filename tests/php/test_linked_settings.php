<?php
// test_linked_settings.php — the Linked settings rules (F-29 T8): values that must agree across
// devices, watched and offered together (CamLogic::linkedSettings / relayLinkedValues /
// linkedMaxJpegBytesProblem; the panel itself is camera-settings-page.php).
//
// Every rule gets a PASSING case (the values agree) and a FAILING case (they do not, and the
// problem names the two values). Around them: the relay-value extractor, the mirrored protocol
// constants re-read from their real sources, what happens when a value is unknown (a board that
// has not reported, a relay that did not answer its settings), and that no rule ever names a
// secret's value — the shared-key rule speaks about "set / not set" only.
//
// Run directly:  php tests/php/test_linked_settings.php

require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';

// The real generated schema (the same file the endpoint uses), so the defaults the rules lean
// on (RF_PORT 8082, PUSH_WR_TMO_MS 8000, ALARM_HOLD_MS 1000) are the firmware's own.
function camtest_schema_of(string $type): array
{
    $schema = require __DIR__ . '/../../php/cameras/lib/device_schema.php';
    return $schema[$type]['keys'];
}

// What a healthy recorder reports. RF_PORT / PUSH_WR_TMO_MS are left OUT on purpose: a board
// that predates those keys (or never stored them) must be judged from its defaults — the same
// view of a board as buildDeviceChange.
function camtest_rec_reported(): array
{
    return ['WIFI' => 'net:********', 'SERVER_HOST' => '192.168.4.9', 'PUSH_PORT' => '8081', 'HTTP_PORT' => '8080', 'CAMERA_ID' => 'cam2',
            'API_KEY' => '********', 'ALARM_GPIO_PIN' => '13', 'ALARM_ACTIVE' => 'LOW', 'ALARM_ALL_CAMS' => '0',
            'ALARM_HOLD_MS' => '1000'];
}

function camtest_det_reported(): array
{
    return ['WIFI' => 'net:********', 'SERVER_HOST' => '192.168.4.9', 'HTTP_PORT' => '8080', 'API_KEY' => '********', 'DETECTOR_ID' => 'detector-1',
            'PERSON_GPIO' => '13', 'DETECT_THRESH' => '0.6', 'CLEAR_THRESH' => '0.5'];
}

// The relay's values, healthy (the shape relayLinkedValues() produces).
function camtest_relay(array $over = []): array
{
    return array_merge(['pushPort' => 8081, 'camKeySet' => true, 'discoveryPort' => 8082, 'alarmRecordSeconds' => 60], $over);
}

function camtest_linked(?array $reported, ?array $relay, string $type = 'recorder'): array
{
    return CamLogic::linkedSettings(camtest_schema_of($type), $reported, $relay, $type);
}

function camtest_rule(array $rules, string $formula): ?array
{
    foreach ($rules as $r) {
        if ($r['formula'] === $formula) {
            return $r;
        }
    }
    return null;
}

// ── the rules a device is offered ─────────────────────────────────────

camtest_test('a recorder is offered its five links; a detector its three — and only those', function () {
    camtest_assert_equal(array_column(camtest_linked(camtest_rec_reported(), camtest_relay()), 'formula'), [
        'API_KEY = relay camKey',
        'RF_PORT = relay discoveryPort',
        'PUSH_PORT = relay pushPort',
        'PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS',
        'ALARM_HOLD_MS < relay alarmRecordSeconds',
    ]);
    camtest_assert_equal(array_column(camtest_linked(camtest_det_reported(), camtest_relay(), 'detector'), 'formula'), [
        'API_KEY = relay camKey',
        'RF_PORT = relay discoveryPort',
        'MAX_JPEG_BYTES = relay MAX_JPEG_BYTES',
    ]);
});

camtest_test('a healthy board against a healthy relay: every rule holds', function () {
    $rules = camtest_linked(camtest_rec_reported(), camtest_relay());
    foreach ($rules as $r) {
        camtest_assert_equal($r['status'], 'ok', $r['formula']);
        camtest_assert_equal($r['problem'], null, $r['formula']);
    }
});

camtest_test('an unknown device type is refused, like every other scope-taking rule in this file', function () {
    $threw = false;
    try {
        CamLogic::linkedSettings(camtest_schema_of('recorder'), camtest_rec_reported(), camtest_relay(), 'doorbell');
    } catch (InvalidArgumentException $e) {
        $threw = strpos($e->getMessage(), 'doorbell') !== false;
    }
    camtest_assert_true($threw);
});

// ── PUSH_PORT = relay pushPort ────────────────────────────────────────

camtest_test('PUSH_PORT = relay pushPort passes when they are equal', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay()), 'PUSH_PORT = relay pushPort');
    camtest_assert_equal($r['status'], 'ok');
});

camtest_test('PUSH_PORT = relay pushPort fails when they differ, naming both ports and where to change them', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay(['pushPort' => 8099])), 'PUSH_PORT = relay pushPort');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'PUSH_PORT (8081)') !== false, 'names the camera\'s port');
    camtest_assert_true(strpos($r['problem'], 'pushPort (8099)') !== false, 'names the relay\'s port');
    camtest_assert_true(strpos($r['problem'], 'cannot connect') !== false, 'says what breaks');
});

// ── API_KEY = relay camKey ────────────────────────────────────────────

camtest_test('API_KEY = relay camKey passes when both sides are set', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay()), 'API_KEY = relay camKey');
    camtest_assert_equal($r['status'], 'ok');
    camtest_assert_true(strpos($r['note'], 'never sent') !== false, 'says plainly that the values are never compared by text');
});

camtest_test('API_KEY = relay camKey fails when the relay has no camKey set', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay(['camKeySet' => false])), 'API_KEY = relay camKey');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'no camKey set') !== false);
});

camtest_test('API_KEY = relay camKey fails when the device has no API_KEY stored', function () {
    $reported = camtest_rec_reported();
    unset($reported['API_KEY']);
    $r = camtest_rule(camtest_linked($reported, camtest_relay()), 'API_KEY = relay camKey');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'no API_KEY stored') !== false);
});

// ── RELAY_FIND_PORT = relay discoveryPort ─────────────────────────────

camtest_test('RF_PORT = relay discoveryPort passes when they are equal (a default counts as the board\'s value)', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay()), 'RF_PORT = relay discoveryPort');
    camtest_assert_equal($r['status'], 'ok');   // RF_PORT was never reported: its default 8082 is judged
});

camtest_test('RF_PORT = relay discoveryPort fails when they differ, naming both ports', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay(['discoveryPort' => 8083])), 'RF_PORT = relay discoveryPort');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'RF_PORT (8082)') !== false);
    camtest_assert_true(strpos($r['problem'], 'discoveryPort (8083)') !== false);
});

camtest_test('RF_PORT = relay discoveryPort fails while the relay\'s discovery is switched off (0)', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay(['discoveryPort' => 0])), 'RF_PORT = relay discoveryPort');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'discovery is switched off') !== false);
});

camtest_test('RF_PORT = relay discoveryPort is not judged while the board never searches (RF_ENABLED 0)', function () {
    $reported = camtest_rec_reported();
    $reported['RF_ENABLED'] = '0';
    $reported['RF_PORT'] = '8083';   // would be a mismatch — but the feature is off, so no alarm
    $r = camtest_rule(camtest_linked($reported, camtest_relay()), 'RF_PORT = relay discoveryPort');
    camtest_assert_equal($r['status'], 'unknown');
    camtest_assert_true(strpos($r['note'], 'RF_ENABLED 0') !== false);
});

// ── PUSH_WRITE_TIMEOUT_MS > LIVE_WINDOW_MS ────────────────────────────

camtest_test('PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS passes above the window (a default counts as the board\'s value)', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay()), 'PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS');
    camtest_assert_equal($r['status'], 'ok');   // never reported: its default 8000 is judged
});

camtest_test('PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS fails at and below the window', function () {
    // PHP casts a numeric array key like '2000' to an int, but a board always reports text — so the
    // values are given as text lists, not as a '2000' => ... map.
    foreach ([['2000', 'at the window'], ['1000', 'below the window']] as [$value, $why]) {
        $reported = camtest_rec_reported();
        $reported['PUSH_WR_TMO_MS'] = $value;
        $r = camtest_rule(camtest_linked($reported, camtest_relay()), 'PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS');
        camtest_assert_equal($r['status'], 'problem', $why);
        camtest_assert_true(strpos($r['problem'], '(' . $value . ')') !== false, $why . ': names the camera\'s timeout');
        camtest_assert_true(strpos($r['problem'], 'LIVE_WINDOW_MS ' . CamLogic::RELAY_LIVE_WINDOW_MS) !== false, $why . ': names the relay\'s window');
    }
});

// ── ALARM_HOLD_MS < alarmRecordSeconds ───────────────────────────────

camtest_test('ALARM_HOLD_MS < relay alarmRecordSeconds passes while the repeat stays inside the recording', function () {
    $r = camtest_rule(camtest_linked(camtest_rec_reported(), camtest_relay()), 'ALARM_HOLD_MS < relay alarmRecordSeconds');
    camtest_assert_equal($r['status'], 'ok');   // 1000 ms < 60 s
});

camtest_test('ALARM_HOLD_MS < relay alarmRecordSeconds fails when the repeat outlives the recording, naming both', function () {
    $reported = camtest_rec_reported();
    $reported['ALARM_HOLD_MS'] = '5000';   // 5000 ms >= 2 s = 2000 ms: the repeat outlives the recording
    $r = camtest_rule(camtest_linked($reported, camtest_relay(['alarmRecordSeconds' => 2])), 'ALARM_HOLD_MS < relay alarmRecordSeconds');
    camtest_assert_equal($r['status'], 'problem');
    camtest_assert_true(strpos($r['problem'], 'ALARM_HOLD_MS (5000)') !== false);
    camtest_assert_true(strpos($r['problem'], 'alarmRecordSeconds (2 s = 2000 ms)') !== false);
});

camtest_test('ALARM_HOLD_MS is not offered while the alarm input is unused (ALARM_GPIO_PIN -1)', function () {
    $reported = camtest_rec_reported();
    $reported['ALARM_GPIO_PIN'] = '-1';
    $reported['ALARM_HOLD_MS'] = '60000';   // would fail against a 60 s recording — but no pin listens
    $r = camtest_rule(camtest_linked($reported, camtest_relay()), 'ALARM_HOLD_MS < relay alarmRecordSeconds');
    camtest_assert_equal($r, null, 'the rule is not offered at all');
});

// ── MAX_JPEG_BYTES ───────────────────────────────────────────────────

camtest_test('MAX_JPEG_BYTES passes while the two limits are the same', function () {
    camtest_assert_equal(CamLogic::linkedMaxJpegBytesProblem(16384, 16384), null);
    $r = camtest_rule(camtest_linked(camtest_det_reported(), camtest_relay(), 'detector'), 'MAX_JPEG_BYTES = relay MAX_JPEG_BYTES');
    camtest_assert_equal($r['status'], 'ok');
});

camtest_test('MAX_JPEG_BYTES fails when the two limits differ, naming both', function () {
    $p = CamLogic::linkedMaxJpegBytesProblem(16384, 8192);
    camtest_assert_true($p !== null);
    camtest_assert_true(strpos($p, 'MAX_JPEG_BYTES 16384') !== false);
    camtest_assert_true(strpos($p, '8192') !== false);
});

// ── the relay-side mirrors: the constants the dashboard copies ────────

camtest_test('the mirrored relay constants are the real ones — re-read from the sources they mirror', function () {
    $read = function (string $file, string $pattern): ?int {
        $text = file_get_contents(__DIR__ . '/../../' . $file);
        if ($text === false || !preg_match($pattern, $text, $m)) {
            return null;
        }
        return (int) $m[1] * (isset($m[2]) ? (int) $m[2] : 1);
    };
    $live = $read('nodejs/camera-relay/lib/connection.js', '/const LIVE_WINDOW_MS = (\d+);/D');
    camtest_assert_true($live !== null, 'connection.js still defines LIVE_WINDOW_MS');
    camtest_assert_equal($live, CamLogic::RELAY_LIVE_WINDOW_MS);

    $relayJpeg = $read('nodejs/camera-relay/lib/detectorlink.js', '/const MAX_JPEG_BYTES = (\d+) \* (\d+);/D');
    camtest_assert_true($relayJpeg !== null, 'detectorlink.js still defines MAX_JPEG_BYTES');
    camtest_assert_equal($relayJpeg, CamLogic::RELAY_MAX_JPEG_BYTES);

    $detJpeg = $read('Arduino/ESP32_CAM_TFLite_Person/report_logic.h', '/constexpr size_t MAX_JPEG_BYTES = (\d+) \* (\d+);/D');
    camtest_assert_true($detJpeg !== null, 'report_logic.h still defines MAX_JPEG_BYTES');
    camtest_assert_equal($detJpeg, CamLogic::DETECTOR_MAX_JPEG_BYTES);

    camtest_assert_equal($detJpeg, $relayJpeg, 'the detector\'s and the relay\'s picture limits really match');
});

// ── relayLinkedValues: the relay's /system-settings fields ────────────

camtest_test('relayLinkedValues reads the four watched values out of the relay\'s field list', function () {
    $fields = [
        ['key' => 'port', 'type' => 'int', 'value' => 8080, 'label' => 'HTTP port'],
        ['key' => 'pushPort', 'type' => 'int', 'value' => 8081, 'label' => 'Camera push port'],
        ['key' => 'discoveryPort', 'type' => 'int', 'value' => 8082, 'label' => 'Camera discovery port'],
        ['key' => 'alarmRecordSeconds', 'type' => 'int', 'value' => 60, 'label' => 'Alarm recording length'],
        ['key' => 'camKey', 'type' => 'secret', 'isSet' => true, 'label' => 'Camera key'],
    ];
    camtest_assert_equal(CamLogic::relayLinkedValues($fields),
        ['pushPort' => 8081, 'camKeySet' => true, 'discoveryPort' => 8082, 'alarmRecordSeconds' => 60]);
});

camtest_test('relayLinkedValues leaves unknown what it cannot read (missing fields, junk values, isSet false)', function () {
    camtest_assert_equal(CamLogic::relayLinkedValues([]), ['pushPort' => null, 'camKeySet' => null, 'discoveryPort' => null, 'alarmRecordSeconds' => null]);
    camtest_assert_equal(CamLogic::relayLinkedValues([
        ['key' => 'pushPort', 'value' => 'not a number'],
        ['key' => 'discoveryPort', 'value' => 0],
        ['key' => 'camKey'],
        ['key' => 'alarmRecordSeconds'],
    ]), ['pushPort' => null, 'camKeySet' => false, 'discoveryPort' => 0, 'alarmRecordSeconds' => null]);
    camtest_assert_equal(CamLogic::relayLinkedValues([['key' => 'port', 'value' => 8080]]),
        ['pushPort' => null, 'camKeySet' => null, 'discoveryPort' => null, 'alarmRecordSeconds' => null]);
});

// ── what the rules answer when values are unknown ────────────────────

camtest_test('a board that has not reported yet answers "unknown" for every rule', function () {
    foreach (camtest_linked(null, camtest_relay()) as $r) {
        camtest_assert_equal($r['status'], 'unknown', $r['formula']);
        camtest_assert_true(strpos($r['note'], 'has not reported') !== false, $r['formula']);
    }
});

camtest_test('a relay that did not tell its settings leaves the rules that need it unknown, and judges the rest', function () {
    $rules = camtest_linked(camtest_rec_reported(), []);
    foreach (['API_KEY = relay camKey', 'RF_PORT = relay discoveryPort', 'PUSH_PORT = relay pushPort'] as $formula) {
        $r = camtest_rule($rules, $formula);
        camtest_assert_equal($r['status'], 'unknown', $formula);
        camtest_assert_true(strpos($r['note'], 'the relay did not tell its settings') !== false, $formula);
    }
    // the timeout rule needs only the mirrored constant, so it still holds on the default
    camtest_assert_equal(camtest_rule($rules, 'PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS')['status'], 'ok');
});

// ── no secret is ever named ───────────────────────────────────────────

camtest_test('no rule ever names a secret\'s value — not even the masked form', function () {
    foreach (['recorder' => camtest_rec_reported(), 'detector' => camtest_det_reported()] as $type => $reported) {
        foreach (camtest_linked($reported, camtest_relay(), $type) as $r) {
            camtest_assert_true(strpos(json_encode($r), '********') === false, $r['formula']);
        }
    }
    $reported = camtest_rec_reported();
    $reported['API_KEY'] = 'a-real-secret-value-1';   // a broken board reporting in the clear
    foreach (camtest_linked($reported, camtest_relay()) as $r) {
        camtest_assert_true(strpos(json_encode($r), 'a-real-secret-value-1') === false, $r['formula']);
    }
});

exit(camtest_summarize());
