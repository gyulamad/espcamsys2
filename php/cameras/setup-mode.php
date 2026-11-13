<?php
// setup-mode.php — is any board armed for setup? A board with SETUP_MODE=1 opens its own setup WiFi at boot and
// waits there, not working normally, until someone saves its settings or exits setup; anyone in range who knows
// the master password can reconfigure it meanwhile, so the operator has to be reminded to finish or exit it. The boards report their stored settings to the relay (server.js), which knows which
// ones say SETUP_MODE=1; this asks it and passes on only what the browser needs.
//
// GET setup-mode.php -> { "on": false }
//                    or { "on": true, "devices": [ { "type": "recorder", "id": "cam2" } ], "message": "SETUP MODE is ON for cam2 (camera). ..." }
//
// Every dashboard page calls this on load and every 60 s (CamLayout::setupModeAlertScript) and shows the
// message in a banner that stays while it is true. The relay route needs the CONTROL key (it lists devices
// and what they report), which is added here and never sent to the browser. Reading only: nothing is changed.
//
// Cleaning the relay's answer and building the message live in lib/Logic.php (CamLogic) so they can be
// unit tested — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$key = (string) ($config['relay_control_key'] ?? '');
if ($key === '') {
    json_fail(503, 'The setup-mode check needs the control key: add relay_control_key to config.php (and the same value as controlKey in the relay config.js)');
}
$headers = CamLogic::buildControlHeaders($key, request_actor());
if ($headers === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

[$body] = relay_fetch(rtrim((string) ($config['relay_url'] ?? ''), '/') . '/setup-mode', 'GET', 5, $headers);
if ($body === false) {
    json_fail(502, 'Could not reach relay');
}
echo json_encode(CamLogic::sanitizeSetupModeStatus(json_decode($body, true)));
