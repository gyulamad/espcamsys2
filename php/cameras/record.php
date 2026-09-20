<?php
// record.php — lets the dashboard start/stop/check a server-side recording
// for one camera. Recording itself happens on the relay (server.js), which
// writes incoming frames straight to a file on the Pi — nothing is recorded
// on the ESP32-CAM itself.
//
// GET  record.php?cam=ID                 -> current { recording, ... } status
// POST record.php?cam=ID&seconds=N       -> start recording for N seconds
// POST record.php?cam=ID&stop=1          -> stop early
//
// Camera lookup, seconds validation, and status-code forwarding all live
// in lib/Logic.php (CamLogic) so they can be unit tested without a web
// server or a running relay — see tests/php/test_logic.php.

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

$base = rtrim($camera['url'], '/') . '/record/' . rawurlencode($camera['id']);
$method = $_SERVER['REQUEST_METHOD'];

function proxy_post($url) {
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

if ($method === 'POST' && isset($_GET['stop'])) {
    [$result, $headers] = proxy_post($base . '/stop');
} elseif ($method === 'POST') {
    $seconds = CamLogic::validatePositiveIntParam($_GET['seconds'] ?? '');
    if ($seconds === null) {
        http_response_code(400);
        echo json_encode(['error' => 'seconds must be a positive integer']);
        exit;
    }
    [$result, $headers] = proxy_post($base . '?seconds=' . urlencode((string) $seconds));
} else {
    $ctx = stream_context_create(['http' => ['timeout' => 5, 'ignore_errors' => true]]);
    $result = @file_get_contents($base, false, $ctx);
    $headers = $http_response_header ?? [];
}

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay for ' . $camera['name']]);
    exit;
}

// Forward the relay's actual status code (e.g. 409 "already recording")
// instead of always answering 200.
$statusCode = CamLogic::extractStatusCode($headers);
if ($statusCode !== null) {
    http_response_code($statusCode);
}

echo $result;
