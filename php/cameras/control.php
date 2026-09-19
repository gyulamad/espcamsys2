<?php
// control.php — lets the dashboard pause/resume a camera's actual capture
// on the device itself (power + bandwidth saving), not just hide the
// stream in one browser tab. Proxies to the server.js relay's /control/:id,
// which forwards an on/off byte down to the camera's persistent connection.
//
// Turning a camera on works the same way recording does: it runs for a
// given number of seconds (300 by default) and then switches itself back
// off on its own, so nobody has to remember to turn it off. Turning it on
// again while already on extends it — the relay resets its countdown to
// the new seconds value measured from this request, rather than adding on
// top of what was left. Turning off is immediate.
//
// GET  control.php?cam=ID                       -> current { id, enabled, enabledUntil } state
// POST control.php?cam=ID&enabled=1&seconds=N    -> turn on for N seconds (default 300)
// POST control.php?cam=ID&enabled=0              -> turn off now, returns new { id, enabled } state

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

function control_proxy_post($url) {
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
    $enabled = $_GET['enabled'] ?? '';
    if ($enabled !== '0' && $enabled !== '1') {
        http_response_code(400);
        echo json_encode(['error' => 'enabled must be 0 or 1']);
        exit;
    }

    $query = 'enabled=' . $enabled;
    if ($enabled === '1' && isset($_GET['seconds']) && $_GET['seconds'] !== '') {
        $seconds = $_GET['seconds'];
        if (!ctype_digit((string) $seconds) || (int) $seconds < 1) {
            http_response_code(400);
            echo json_encode(['error' => 'seconds must be a positive integer']);
            exit;
        }
        $query .= '&seconds=' . urlencode($seconds);
    }

    [$result, $headers] = control_proxy_post($relayUrl . '?' . $query);
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

// Forward the relay's actual status code (e.g. 400 "seconds must be ...")
// instead of always answering 200.
foreach ($headers as $header) {
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) {
        http_response_code((int) $m[1]);
        break;
    }
}

// The relay already returns { id, enabled, enabledUntil } JSON — pass it
// straight through.
echo $result;
