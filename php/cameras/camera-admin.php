<?php
// camera-admin.php — add, rename and remove the cameras shown on the dashboard (the `cameras`
// list of config.php). Used by the settings pages.
//
//   POST camera-admin.php   body: { "action": "add",    "id": "cam3", "name": "Garage", "icon": "🚗" }
//                                 { "action": "update", "id": "cam3", "name": "Garage door", "icon": "🚪" }
//                                 { "action": "remove", "id": "cam3" }
//        -> { ok, cameras: [ {id, name, icon} ], message }
//
// The id is what ties an entry to a board: it must equal the board's CAMERA_ID setting, so it can
// not be edited (remove the entry and add it again). Adding an entry does not touch any board, and
// removing one does not delete its recordings — it only stops the dashboard from showing the camera.
//
// Same protection as the other settings endpoints: dashboard login, the dashboard's own request header.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';
require_once __DIR__ . '/config_file.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    json_fail(405, 'POST only');
}
if (!CamLogic::isDashboardAjaxRequest($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input) || !isset($input['action']) || !is_string($input['action'])) {
    json_fail(400, 'send { "action": "add" | "update" | "remove", "id": ..., "name": ..., "icon": ... }');
}
$id   = isset($input['id']) && is_string($input['id']) ? trim($input['id']) : '';
$name = isset($input['name']) && is_string($input['name']) ? $input['name'] : '';
$icon = isset($input['icon']) && is_string($input['icon']) ? trim($input['icon']) : '';
$cameras = $config['cameras'] ?? [];

switch ($input['action']) {
    case 'add':
        $r = CamLogic::addCamera($cameras, $id, $name, $icon);
        $done = 'added';
        break;
    case 'update':
        $r = CamLogic::updateCamera($cameras, $id, $name, $icon);
        $done = 'saved';
        break;
    case 'remove':
        $r = CamLogic::removeCamera($cameras, $id);
        $done = 'removed from the dashboard';
        break;
    default:
        json_fail(400, 'unknown action');
}
if (!$r['ok']) {
    json_fail(400, $r['error']);
}

$newConfig = $config;
$newConfig['cameras'] = $r['cameras'];
$err = camdash_write_config(__DIR__ . '/config.php', $newConfig);
if ($err !== null) {
    json_fail(500, $err);
}

$message = 'Camera ' . $id . ' ' . $done . '.';
if ($input['action'] === 'add') {
    $message .= ' Make sure the board\'s CAMERA_ID setting is exactly ' . $id . '.';
}
if ($input['action'] === 'remove') {
    // A change still queued for a camera that is no longer on the dashboard would surprise someone later.
    $key = (string) ($config['relay_control_key'] ?? '');
    $headers = $key !== '' ? CamLogic::buildControlHeaders($key, CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? '')), true) : null;
    if ($headers !== null) {
        relay_fetch(rtrim((string) $config['relay_url'], '/') . '/device-settings/recorder/' . rawurlencode($id) . '/change', 'PUT', 4, $headers, '');
    }
    $message .= ' Its recordings are kept.';
}

echo json_encode([
    'ok' => true,
    'message' => $message,
    'cameras' => array_map(function ($c) {
        return ['id' => (string) $c['id'], 'name' => (string) ($c['name'] ?? ''), 'icon' => (string) ($c['icon'] ?? '')];
    }, $r['cameras']),
]);
