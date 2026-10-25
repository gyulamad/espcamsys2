<?php
// settings.php — lets the dashboard read the alarm setting that
// is stored on the relay (server.js, settings.json): how long an alarm
// recording runs. Because the relay holds it, the camera boards never need
// to be reflashed to change it.
//
// GET  settings.php
//        -> { alarmRecordSeconds, preRollSeconds }
//           (preRollSeconds is read-only — it's set in the relay's config.js)
// (Saving moved to system-settings.php; POST here answers 405.)
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

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    // Changing settings moved to system-settings.php (guarded by the dashboard header, the same-origin
    // check and the control key). This old unguarded POST was a CSRF hole and is gone.
    header('Allow: GET');
    json_fail(405, 'Read-only. Change settings with system-settings.php');
}
relay_proxy_json($relayUrl);
