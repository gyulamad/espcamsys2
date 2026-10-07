<?php
// recording-switch.php — lets the dashboard switch recording ON or OFF, for one
// camera or for every camera at once. The state itself lives on the relay
// (server.js), which refuses recordings of a camera that is OFF and remembers
// the state across restarts.
//
//   POST recording-switch.php?scope=camera&cam=ID&action=off&minutes=N
//   POST recording-switch.php?scope=camera&cam=ID&action=on
//   POST recording-switch.php?scope=all&action=off&minutes=N
//   POST recording-switch.php?scope=all&action=on
//
//   minutes: how long to stay OFF (default 60); 0 or negative = until switched ON.
//   Answers with the relay's JSON and status code ({ ok, affected, off: {...} }).
//
// Switching recording off is exactly what someone who wants to go unrecorded
// would try, so this is protected in layers:
//   1. the dashboard login (auth.php) — as every page;
//   2. a custom request header (X-Requested-With) the dashboard's own script
//      sends and a page on another website cannot make a browser send, so a
//      malicious page can't use the login your browser has cached to click
//      "OFF" for you;
//   3. the relay's CONTROL key (relay_control_key in config.php, controlKey in
//      the relay's config.js), added here — the browser never sees it. It is
//      deliberately not the key flashed into every camera board.
// The relay also records WHO did it (the logged-in user) in its log.
//
// Request checking and header building live in lib/Logic.php (CamLogic) so they
// can be unit tested — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function fail($status, $message) {
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    fail(405, 'POST only');
}
if (!CamLogic::isDashboardAjaxRequest($_SERVER)) {
    fail(403, 'This request must come from the dashboard page itself');
}

$controlKey = (string) ($config['relay_control_key'] ?? '');
if ($controlKey === '') {
    fail(503, 'Recording on/off is not set up: add relay_control_key to config.php (and the same value as controlKey in the relay config)');
}

$request = CamLogic::buildSwitchRequest($_GET, $cameras);
if (!$request['ok']) {
    fail($request['status'], $request['error']);
}

$actor = CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
$headers = CamLogic::buildSwitchHeaders($controlKey, $actor);
if ($headers === null) {
    fail(500, 'relay_control_key in config.php contains a line break');
}

$ctx = stream_context_create([
    'http' => [
        'method'        => 'POST',
        'header'        => $headers,
        'timeout'       => 5,
        'ignore_errors' => true,
    ],
]);
$result = @file_get_contents($request['url'], false, $ctx);
$responseHeaders = $http_response_header ?? [];

if ($result === false) {
    fail(502, 'Could not reach the relay');
}

// Forward the relay's actual answer — 401 (wrong key), 400, 503 ... — so the
// dashboard can tell the user what really happened.
$statusCode = CamLogic::extractStatusCode($responseHeaders);
if ($statusCode !== null) {
    http_response_code($statusCode);
}
echo $result;
