<?php
// settings.php — lets the dashboard read and change the alarm setting that
// is stored on the relay (server.js, settings.json): how long an alarm
// recording runs. Because the relay holds it, the camera boards never need
// to be reflashed to change it.
//
// GET  settings.php
//        -> { alarmRecordSeconds, preRollSeconds }
//           (preRollSeconds is read-only — it's set in the relay's config.js)
// POST settings.php?alarmRecordSeconds=N
//        -> saves it, returns the new settings
//
// Settings are relay-wide (not per camera), so — like status.php — one
// request to the relay covers everything, using the first camera's relay URL.
// Param validation and query-string building live in lib/Logic.php
// (CamLogic) so they can be unit tested — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');

if (empty($cameras)) {
    json_fail(404, 'No cameras configured');
}

$relayUrl = rtrim($cameras[0]['url'], '/') . '/settings';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    relay_proxy_json($relayUrl);
    exit;
}

$raw = $_GET['alarmRecordSeconds'] ?? '';
$record = null;
if ($raw !== '') {
    $record = CamLogic::validatePositiveIntParam($raw);
    if ($record === null) {
        json_fail(400, 'alarmRecordSeconds must be a positive integer');
    }
}

$query = CamLogic::buildSettingsQuery($record);
if ($query === '') {
    json_fail(400, 'provide alarmRecordSeconds');
}

// Forward the relay's actual status code (e.g. 400 for an out-of-range
// value) instead of always answering 200.
relay_proxy_json($relayUrl . '?' . $query, 'POST', 5, RELAY_EMPTY_POST_HEADER);
