<?php
// sounds-admin.php — changes the alarm sounds: add, remove and try one. The relay keeps the files and decides what
// a sound may be (lib/sounds.js there); this page checks the request and passes it on with the control key, which the
// browser never sees.
//
//   POST sounds-admin.php?action=upload&name=siren.wav    body: the raw sound file (WAV, MP3 or OGG, up to 1 MiB)
//        -> { ok, replaced }  (a sound of that name is replaced)
//   POST sounds-admin.php?action=delete&name=siren.wav    -> { ok }   refused (409) while an alarm still uses the sound
//   POST sounds-admin.php?action=play&name=siren.wav      -> { ok }   plays it on the relay machine (to try the speaker);
//        502 with the reason when the player could not start, 409 while a sound is already playing
//
// Protected like the other changes: the dashboard login, the X-Requested-With header only the dashboard's script sends
// (CamLogic::isDashboardMutationAllowed), and the relay's control key. The relay's answer is rebuilt (an ok or an
// error text), never passed on as it came.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Sounds.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    json_fail(405, 'POST only');
}
require_dashboard_mutation();

$request = CamSounds::adminRequest($_GET);
if (isset($request['error'])) {
    json_fail(400, $request['error']);
}
if ((string) ($config['relay_control_key'] ?? '') === '') {
    json_fail(503, 'Changing sounds needs the control key: add relay_control_key to config.php (and the same value as controlKey in the relay config.js) once, by hand — see "Switching recording ON / OFF" in MANUAL.md');
}
$relayBase = (string) ($config['relay_url'] ?? '');
['action' => $action, 'name' => $name] = $request;

if ($action === 'upload') {
    // Refuse a body that says it is too large before reading it, and check what was really sent after.
    $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
    if ($declared > CamSounds::MAX_BYTES) {
        json_fail(413, 'the file is too large (at most ' . CamSounds::MAX_BYTES . ' bytes)');
    }
    $sound = file_get_contents('php://input');
    if ($sound === false || $sound === '') {
        json_fail(400, 'send the sound file as the request body');
    }
    if (strlen($sound) > CamSounds::MAX_BYTES) {
        json_fail(413, 'the file is too large (at most ' . CamSounds::MAX_BYTES . ' bytes)');
    }
    $call = ['PUT', 10, relay_actor_headers($config, false) . "Content-Type: application/octet-stream\r\n", $sound];
    $failed = 'The relay did not accept the sound';
} elseif ($action === 'delete') {
    $call = ['DELETE', 5, relay_actor_headers($config), null];
    $failed = 'The relay could not delete the sound';
} else {
    // The relay answers "play" after at most about 1.5 s (long enough to learn that the player cannot start).
    $call = ['POST', 8, relay_actor_headers($config), null];
    $failed = 'The relay could not play the sound';
}

[$method, $timeout, $headers, $payload] = $call;
$url = CamSounds::relayUrl($relayBase, $name, $action === 'play' ? 'play' : '');
[$body, $resp] = relay_fetch((string) $url, $method, $timeout, $headers, $payload);
if ($body === false) {
    json_fail(502, 'Could not reach the relay');
}
$status = CamLogic::passableStatus(CamLogic::extractStatusCode($resp));
if ($status === null) {
    json_fail(502, 'The relay answered with a status the dashboard does not pass on');
}
if ($status < 300 && $action !== 'play') {
    audit_log($action . ' sound ' . $name);   // who changed the library
}
http_response_code($status);
echo CamSounds::shapeAnswer($body, $status, $failed);
