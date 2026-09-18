<?php
// control.php — lets the dashboard pause/resume a camera's actual capture
// on the device itself (power + bandwidth saving), not just hide the
// stream in one browser tab. Proxies to the server.js relay's /control/:id,
// which forwards an on/off byte down to the camera's persistent connection.
//
// GET  control.php?cam=ID              -> current { id, enabled } state
// POST control.php?cam=ID&enabled=0|1  -> set state, returns new { id, enabled }

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';

header('Content-Type: application/json');

$requested = $_GET['cam'] ?? '';

$camera = null;
foreach ($cameras as $cam) {
    if ($cam['id'] === $requested) {
        $camera = $cam;
        break;
    }
}

if (!$camera) {
    http_response_code(404);
    echo json_encode(['error' => 'Camera not found']);
    exit;
}

$relayUrl = rtrim($camera['url'], '/') . '/control/' . rawurlencode($camera['id']);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $enabled = $_GET['enabled'] ?? '';
    if ($enabled !== '0' && $enabled !== '1') {
        http_response_code(400);
        echo json_encode(['error' => 'enabled must be 0 or 1']);
        exit;
    }
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'POST',
            'header'        => "Content-Length: 0\r\n",
            'timeout'       => 5,
            'ignore_errors' => true,
        ],
    ]);
    $result = @file_get_contents($relayUrl . '?enabled=' . $enabled, false, $ctx);
} else {
    $ctx = stream_context_create([
        'http' => ['timeout' => 5, 'ignore_errors' => true],
    ]);
    $result = @file_get_contents($relayUrl, false, $ctx);
}

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay for ' . $camera['name']]);
    exit;
}

// The relay already returns { id, enabled } JSON — pass it straight through.
echo $result;
