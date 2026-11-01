<?php
// storage.php — is the Pi's recording storage running out? The relay (server.js) owns the recordings,
// so it knows the free space; this asks it and passes on only what the browser needs.
//
// GET storage.php -> { "low": false }
//                 or { "low": true, "freeMB": 312, "message": "The recording storage is almost empty (only 312 MB is free). Please delete old files." }
//
// Every dashboard page calls this once on load (CamLayout::storageWarningScript) and shows the message in
// an alert box. The minimum free space is the "Minimum free recording storage (MB)" setting on the
// settings page (kept by the relay, 0 = no warning). Reading only: no state is changed.
//
// Cleaning the relay's answer and building the message live in lib/Logic.php (CamLogic) so they can be
// unit tested — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if (empty($cameras)) {
    json_fail(404, 'No cameras configured');
}

// Every camera in config.php shares the same relay, so the first one's address is the relay's.
[$body] = relay_fetch(rtrim($cameras[0]['url'], '/') . '/storage', 'GET', 5, relay_read_headers($config));
if ($body === false) {
    json_fail(502, 'Could not reach relay');
}
echo json_encode(CamLogic::sanitizeStorageStatus(json_decode($body, true)));
