<?php
// reboot.php — lets the dashboard hard-reset a part of the system.
//
//   POST reboot.php?target=detector&cam=ID    reset the person detector paired with camera ID
//   (camera, both, nodejs, php, relay, all: named by the menus, answered 501 until they are built)
//
// Answers { ok: true, target, message } or { error } with a matching status.
//
// The detector is reset through the relay: the relay queues a "reboot" command, the board picks it
// up on its next poll (about 30 s), answers "applied" and restarts. Protected like
// recording-switch.php: dashboard login, the X-Requested-With header (a page on another website
// cannot make a browser send it), and the relay's CONTROL key, added here and never sent to the browser.
//
// Request checking lives in lib/Logic.php (CamLogic::buildRebootRequest), unit tested.

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
if (!CamLogic::isDashboardMutationAllowed($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$controlKey = (string) ($config['relay_control_key'] ?? '');
if ($controlKey === '') {
    json_fail(503, 'Reset is not set up: add relay_control_key to config.php (and the same value as controlKey in the relay config)');
}

$request = CamLogic::buildRebootRequest($_GET, $cameras);
if (!$request['ok']) {
    json_fail($request['status'], $request['error']);
}

$headers = CamLogic::buildSwitchHeaders($controlKey, request_actor());
if ($headers === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

[$body, $responseHeaders] = relay_fetch($request['url'], 'POST', 6, $headers);
if ($body === false) {
    json_fail(502, 'Could not reach the relay - nothing was requested');
}
$status = CamLogic::extractStatusCode($responseHeaders) ?? 200;
$answer = json_decode($body, true);
if ($status !== 200 || !is_array($answer) || empty($answer['ok'])) {
    // The relay's own reason (409: the detector has never reported, 401: wrong key ...) is the useful one.
    $reason = is_array($answer) && isset($answer['error']) && is_string($answer['error']) ? $answer['error'] : 'The relay refused the request';
    json_fail(CamLogic::passableStatus($status) !== null && $status >= 400 ? $status : 502, $reason);
}

audit_log('requested a reset of the ' . $request['target'] . ' of camera ' . $request['cam']);
echo json_encode(['ok' => true, 'target' => $request['target'], 'message' => CamLogic::rebootQueuedMessage($request['target'])]);
