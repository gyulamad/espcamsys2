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
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');

$camera = CamLogic::findCameraById($cameras, $_GET['cam'] ?? '');
if (!$camera) {
    json_fail(404, 'Camera not found');
}

$base = rtrim($camera['url'], '/') . '/record/' . rawurlencode($camera['id']);
$unreachable = 'Could not reach relay for ' . $camera['name'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    relay_proxy_json($base, 'GET', 5, '', $unreachable);
    exit;
}

if (isset($_GET['stop'])) {
    // Forward the relay's actual status code (e.g. 409 "already recording").
    relay_proxy_json($base . '/stop', 'POST', 5, RELAY_EMPTY_POST_HEADER, $unreachable);
    exit;
}

$seconds = CamLogic::validatePositiveIntParam($_GET['seconds'] ?? '');
if ($seconds === null) {
    json_fail(400, 'seconds must be a positive integer');
}
relay_proxy_json($base . '?seconds=' . urlencode((string) $seconds), 'POST', 5, RELAY_EMPTY_POST_HEADER, $unreachable);
