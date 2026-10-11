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
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    json_fail(405, 'POST only');
}
if (!CamLogic::isDashboardAjaxRequest($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$controlKey = (string) ($config['relay_control_key'] ?? '');
if ($controlKey === '') {
    json_fail(503, 'Recording on/off is not set up: add relay_control_key to config.php (and the same value as controlKey in the relay config)');
}

$request = CamLogic::buildSwitchRequest($_GET, $cameras);
if (!$request['ok']) {
    json_fail($request['status'], $request['error']);
}

$actor = CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
$headers = CamLogic::buildSwitchHeaders($controlKey, $actor);
if ($headers === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

// Forward the relay's actual answer — 401 (wrong key), 400, 503 ... — so the
// dashboard can tell the user what really happened.
relay_proxy_json($request['url'], 'POST', 5, $headers, 'Could not reach the relay');
