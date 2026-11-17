<?php
// sounds.php — the alarm sounds, read only (changing them is sounds-admin.php).
//
//   GET sounds.php            -> { sounds: [ {name, bytes} ], maxBytes, maxSounds }     the library
//   GET sounds.php?name=x.wav -> the sound itself (audio/wav, audio/mpeg or audio/ogg)  for the player of a browser
//
// Both only ask the relay (which keeps the files) and rebuild what it answers: the list from checked fields
// (lib/Sounds.php), the file with a Content-Type decided HERE from the name's extension and nosniff, so whatever the
// relay's folder holds can only ever reach the browser as audio. A name that is not a sound's is refused before any
// request to the relay is made.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Sounds.php';
require_once __DIR__ . '/relay.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Content-Type: application/json');
    header('Allow: GET');
    json_fail(405, 'GET only');
}

$named = CamSounds::requestedName($_GET);
if (isset($named['error'])) {
    header('Content-Type: application/json');
    json_fail(400, $named['error']);
}
$name = $named['name'];
$headers = relay_read_headers($config);

if ($name === null) {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    [$body, $resp] = relay_fetch((string) CamSounds::relayUrl((string) ($config['relay_url'] ?? '')), 'GET', 5, $headers);
    if ($body === false) {
        json_fail(502, 'Could not reach the relay');
    }
    $status = CamLogic::passableStatus(CamLogic::extractStatusCode($resp));
    if ($status === null) {
        json_fail(502, 'The relay answered with a status the dashboard does not pass on');
    }
    if ($status >= 400) {
        http_response_code($status);
        exit(CamSounds::shapeAnswer($body, $status, 'The relay could not list the sounds'));
    }
    $list = CamSounds::shapeList($body);
    if ($list === null) {
        json_fail(502, 'The relay did not answer with a list of sounds');
    }
    exit($list);
}

[$body, $resp] = relay_fetch((string) CamSounds::relayUrl((string) ($config['relay_url'] ?? ''), $name), 'GET', 10, $headers);
if ($body === false) {
    header('Content-Type: application/json');
    json_fail(502, 'Could not reach the relay');
}
$status = CamLogic::passableStatus(CamLogic::extractStatusCode($resp));
if ($status === null) {
    header('Content-Type: application/json');
    json_fail(502, 'The relay answered with a status the dashboard does not pass on');
}
if ($status !== 200) {
    header('Content-Type: application/json');
    http_response_code($status);
    exit(CamSounds::shapeAnswer($body, $status, 'The relay could not give the sound'));
}
if (strlen($body) > CamSounds::MAX_BYTES) {
    header('Content-Type: application/json');
    json_fail(502, 'The relay sent more than a sound can be');
}
header('Content-Type: ' . CamSounds::contentType($name));
header('X-Content-Type-Options: nosniff');
header('Cache-Control: private, no-cache');
header('Content-Disposition: inline; filename="' . $name . '"');   // $name is checked: letters, digits . _ - only
header('Content-Length: ' . strlen($body));
echo $body;
