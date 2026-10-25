<?php
// record.php — lets the dashboard start/stop/check a server-side recording
// for one camera. Recording itself happens on the relay (server.js), which
// writes incoming frames straight to a file on the Pi — nothing is recorded
// on the ESP32-CAM itself.
//
// GET  record.php?cam=ID                 -> current { recording, ... } status
// POST record.php?cam=ID&seconds=N       -> start recording for N seconds (1-3600)
// POST record.php?cam=ID&stop=1          -> stop early
//
// Both POSTs need the dashboard's X-Requested-With header and a same-origin request (see
// CamLogic::isDashboardMutationAllowed), and reach the relay with the control key and X-Actor.
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

// Start/stop change state: only the dashboard's own page may do that (not a form on another website).
require_dashboard_mutation();
$headers = relay_actor_headers($config);

if (isset($_GET['stop'])) {
    audit_log('stop recording ' . $camera['id']);
    // Forward the relay's actual status code (e.g. 409 "already recording").
    relay_proxy_json($base . '/stop', 'POST', 5, $headers, $unreachable);
    exit;
}

$seconds = CamLogic::validateRecordSeconds($_GET['seconds'] ?? '');
if ($seconds === null) {
    json_fail(400, 'seconds must be a whole number from 1 to ' . CamLogic::MAX_RECORD_SECONDS);
}
audit_log('start recording ' . $camera['id'] . ' for ' . $seconds . 's');
relay_proxy_json($base . '?seconds=' . urlencode((string) $seconds), 'POST', 5, $headers, $unreachable);
