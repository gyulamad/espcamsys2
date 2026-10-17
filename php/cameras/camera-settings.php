<?php
// camera-settings.php — one camera's own settings (the ones stored in the board's flash): what the
// board reports it holds, and queueing a change for it. The page is camera-settings-page.php.
//
//   GET  camera-settings.php?cam=ID
//        -> { camera: {id, name, icon}, keys: [ {name, kind, min, max, cond, condKey, condValue, locked, help} ],
//             gpios: [...], state: { reported: {settings, at} | null, pending: {rev, keys, at, by} | null,
//                                    last: {rev, result, message, at} | null, now } }
//   POST camera-settings.php?cam=ID   body: { "values": { "LOG_HEARTBEAT": "900", ... } }   queue a change
//                                     or    { "cancel": true }                               withdraw the queued one
//        -> { ok, queued, changed: [names], message }
//
// How a change reaches the board: this checks it (CamLogic::buildDeviceChange) and queues it on the
// relay; within about half a minute the board asks the relay for it, checks it again (it refuses
// anything unsafe), stores it, restarts, and reports back — the page shows "applied" or the reason.
// Nothing here talks to the board directly, and the settings that connect it to the relay (Wi-Fi,
// server, ports, key, id) are never changeable this way.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    json_fail(405, 'GET or POST only');
}
if (!CamLogic::isDashboardAjaxRequest($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$camId = isset($_GET['cam']) && is_string($_GET['cam']) ? $_GET['cam'] : '';
$camera = CamLogic::findCamera($config['cameras'] ?? [], $camId);
if ($camera === null) {
    json_fail(404, 'No such camera on the dashboard');
}
$key = (string) ($config['relay_control_key'] ?? '');
if ($key === '') {
    json_fail(503, 'Camera settings need the control key: add relay_control_key to config.php (and the same value as controlKey in the relay config.js) — see "Switching recording ON / OFF" in INSTALL.md');
}
$actor   = CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
$headers = CamLogic::buildControlHeaders($key, $actor);
$textHeaders = CamLogic::buildControlHeaders($key, $actor, true);
if ($headers === null || $textHeaders === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}
$base = rtrim((string) ($config['relay_url'] ?? ''), '/') . '/device-settings/recorder/' . rawurlencode($camId);
$schema = require __DIR__ . '/lib/device_schema.php';
$keys = $schema['recorder']['keys'];
$gpios = $schema['recorder']['gpios'];

// The relay's state document for this camera, or an error response.
function camera_state(string $base, string $headers): array
{
    [$body, $resp] = relay_fetch($base . '/state', 'GET', 5, $headers);
    if ($body === false) {
        json_fail(502, 'Could not reach the relay');
    }
    $status = CamLogic::extractStatusCode($resp) ?? 200;
    $j = json_decode($body, true);
    if ($status === 404 && !is_array($j)) {
        json_fail(502, 'The relay does not know camera settings yet — copy the new nodejs/camera-relay/ to the Pi and restart it');
    }
    if ($status !== 200 || !is_array($j)) {
        json_fail($status === 200 ? 502 : $status, is_array($j) && isset($j['error']) ? $j['error'] : 'The relay did not answer with the camera\'s state');
    }
    return $j;
}

if ($method === 'GET') {
    echo json_encode([
        'camera' => ['id' => (string) $camera['id'], 'name' => (string) ($camera['name'] ?? ''), 'icon' => (string) ($camera['icon'] ?? '')],
        'keys' => $keys,
        'gpios' => $gpios,
        'state' => camera_state($base, $headers),
    ]);
    exit;
}

// ── POST ──
$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_fail(400, 'send { "values": { "SETTING": value } } or { "cancel": true }');
}

function queue_on_relay(string $base, string $headers, string $line): array
{
    [$body, $resp] = relay_fetch($base . '/change', 'PUT', 6, $headers, $line);
    if ($body === false) {
        json_fail(502, 'Could not reach the relay — nothing was queued');
    }
    $status = CamLogic::extractStatusCode($resp) ?? 200;
    $j = json_decode($body, true);
    if ($status !== 200 || !is_array($j) || empty($j['ok'])) {
        json_fail($status === 200 ? 502 : $status, is_array($j) && isset($j['error']) ? $j['error'] : 'The relay refused the change');
    }
    return $j;
}

if (!empty($input['cancel'])) {
    queue_on_relay($base, $textHeaders, '');
    echo json_encode(['ok' => true, 'queued' => false, 'changed' => [], 'message' => 'The queued change was withdrawn.']);
    exit;
}

if (!isset($input['values']) || !is_array($input['values']) || array_is_list($input['values'])) {
    json_fail(400, 'send { "values": { "SETTING": value } }');
}
foreach ($input['values'] as $v) {
    if (!is_string($v) && !is_int($v) && !is_float($v)) {
        json_fail(400, 'every setting must be a single text or number value');
    }
}

$state = camera_state($base, $headers);
if (empty($state['reported']['settings'])) {
    json_fail(409, 'This camera has not reported its settings yet, so a change cannot be checked. It reports after it starts with the firmware that supports remote settings (publish it with ota-deploy.sh) and has reached the relay.');
}
$change = CamLogic::buildDeviceChange($keys, $gpios, $state['reported']['settings'], $input['values']);
if (!$change['ok']) {
    json_fail(400, $change['error']);
}
if ($change['line'] === '') {
    echo json_encode(['ok' => true, 'queued' => false, 'changed' => [], 'message' => 'Nothing to change — the camera already has these values.']);
    exit;
}
queue_on_relay($base, $textHeaders, $change['line']);
echo json_encode([
    'ok' => true,
    'queued' => true,
    'changed' => $change['changed'],
    'message' => 'Queued. The camera picks it up within about 30 seconds, stores it and restarts to apply it.',
]);
