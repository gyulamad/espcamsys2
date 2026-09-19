<?php
// status.php — a single combined snapshot of every camera the relay
// currently knows about: power state + auto-off timer, and whether each
// is recording (plus when that recording will end). The dashboard polls
// this on an interval so state changes that didn't originate from a click
// in that browser tab — another tab, another user, or a camera's own
// alarm-trigger GPIO calling /record directly on the relay — still show
// up here without needing a page reload.
//
// GET status.php -> relay's { camId: { enabled, enabledUntil, recording, recordingEndAt, ... } } JSON

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';

header('Content-Type: application/json');

if (empty($cameras)) {
    echo json_encode([]);
    exit;
}

// Every camera in config.php shares the same relay, so one request covers
// all of them — no need to loop per camera the way record.php/control.php do.
$relayUrl = rtrim($cameras[0]['url'], '/') . '/status';

$ctx = stream_context_create(['http' => ['timeout' => 5, 'ignore_errors' => true]]);
$result = @file_get_contents($relayUrl, false, $ctx);

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay']);
    exit;
}

echo $result;
