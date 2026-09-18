<?php
// record.php — lets the dashboard start/stop/check a server-side recording
// for one camera. Recording itself happens on the relay (server.js), which
// writes incoming frames straight to a file on the Pi — nothing is recorded
// on the ESP32-CAM itself.
//
// GET  record.php?cam=ID                 -> current { recording, ... } status
// POST record.php?cam=ID&seconds=N       -> start recording for N seconds
// POST record.php?cam=ID&stop=1          -> stop early

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
    $seconds = $_GET['seconds'] ?? '';
    if (!ctype_digit((string) $seconds) || (int) $seconds < 1) {
        http_response_code(400);
        echo json_encode(['error' => 'seconds must be a positive integer']);
        exit;
    }
    [$result, $headers] = proxy_post($base . '?seconds=' . urlencode($seconds));
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
foreach ($headers as $header) {
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) {
        http_response_code((int) $m[1]);
        break;
    }
}

echo $result;
