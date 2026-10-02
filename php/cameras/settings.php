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

header('Content-Type: application/json');

if (empty($cameras)) {
    http_response_code(404);
    echo json_encode(['error' => 'No cameras configured']);
    exit;
}

$relayUrl = rtrim($cameras[0]['url'], '/') . '/settings';
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    $record = null;

    if (isset($_GET['alarmRecordSeconds']) && $_GET['alarmRecordSeconds'] !== '') {
        $record = CamLogic::validatePositiveIntParam($_GET['alarmRecordSeconds']);
        if ($record === null) {
            http_response_code(400);
            echo json_encode(['error' => 'alarmRecordSeconds must be a positive integer']);
            exit;
        }
    }

    $query = CamLogic::buildSettingsQuery($record);
    if ($query === '') {
        http_response_code(400);
        echo json_encode(['error' => 'provide alarmRecordSeconds']);
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
    $result = @file_get_contents($relayUrl . '?' . $query, false, $ctx);
} else {
    $ctx = stream_context_create(['http' => ['timeout' => 5, 'ignore_errors' => true]]);
    $result = @file_get_contents($relayUrl, false, $ctx);
}
$headers = $http_response_header ?? [];

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay']);
    exit;
}

// Forward the relay's actual status code (e.g. 400 for an out-of-range
// value) instead of always answering 200.
$statusCode = CamLogic::extractStatusCode($headers);
if ($statusCode !== null) {
    http_response_code($statusCode);
}

echo $result;
