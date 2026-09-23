<?php
// ai-alarm.php — dashboard endpoint for the AI Human Detection Alarm
// feature's per-camera ON/OFF toggle (plans/AI_ALARM_IMPLEMENTATION_PLAN.md
// §7 step 2). Proxies to the server.js relay's /ai-alarm/:id, which pushes
// the new ai_enabled value down to the camera's persistent connection (see
// sendAiAlarmCommand() in server.js) — the same command channel plan step
// 1 built, now actually mutated for the first time. No AI inference exists
// yet (that's plan step 3) — this only flips the flag the device currently
// just logs on receipt.
//
// GET  ai-alarm.php?cam=ID              -> current { id, aiEnabled, livePeekUntilEpoch } state
// POST ai-alarm.php?cam=ID&enabled=1|0  -> turn AI-alarm monitoring on/off for this camera
//
// `live_peek_until_epoch` is not settable here — that's plan step 7 (Live
// Peek). This endpoint only ever passes it through unchanged from whatever
// the relay already has.
//
// Same proxy/validation/status-forwarding pattern as control.php — see
// that file's header comment and lib/Logic.php (CamLogic) for why this
// logic lives there instead of inline. Reuses CamLogic::buildControlQuery()
// for the "enabled=0|1" query string: /ai-alarm/:id takes the exact same
// single param /control/:id does when no `seconds` is involved.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';

header('Content-Type: application/json');

$requested = $_GET['cam'] ?? '';
$camera = CamLogic::findCameraById($cameras, $requested);

if (!$camera) {
    http_response_code(404);
    echo json_encode(['error' => 'Camera not found']);
    exit;
}

$relayUrl = rtrim($camera['url'], '/') . '/ai-alarm/' . rawurlencode($camera['id']);
$method = $_SERVER['REQUEST_METHOD'];

function ai_alarm_proxy_post($url) {
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'POST',
            'header'        => "Content-Length: 0\r\n",
            'timeout'       => 5,
            'ignore_errors' => true,
        ],
    ]);
    return [@file_get_contents($url, false, $ctx), $http_response_header ?? []];
}

if ($method === 'POST') {
    $enabled = CamLogic::validateEnabledParam($_GET['enabled'] ?? '');
    if ($enabled === null) {
        http_response_code(400);
        echo json_encode(['error' => 'enabled must be 0 or 1']);
        exit;
    }

    $query = CamLogic::buildControlQuery($enabled);
    [$result, $headers] = ai_alarm_proxy_post($relayUrl . '?' . $query);
} else {
    $ctx = stream_context_create([
        'http' => ['timeout' => 5, 'ignore_errors' => true],
    ]);
    $result = @file_get_contents($relayUrl, false, $ctx);
    $headers = $http_response_header ?? [];
}

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay for ' . $camera['name']]);
    exit;
}

// Forward the relay's actual status code (e.g. 400 "enabled must be ...")
// instead of always answering 200.
$statusCode = CamLogic::extractStatusCode($headers);
if ($statusCode !== null) {
    http_response_code($statusCode);
}

// The relay already returns { id, aiEnabled, livePeekUntilEpoch } JSON —
// pass it straight through.
echo $result;
