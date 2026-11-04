<?php
// detector-view.php — the WATCH button of a person detector: asks the relay to switch the detector's live
// view (its sensor values and small picture) on, keep it on, or off.
//
//   POST detector-view.php?cam=<camera id>&action=on     somebody wants to look
//   POST detector-view.php?cam=<camera id>&action=keep   still looking (the open page sends this every ~20 s)
//   POST detector-view.php?cam=<camera id>&action=off    stop now
//   -> the relay's JSON: { ok, view: { supported, wanted, wantedForMs, ... } }
//
// The detector rests (no connection, Wi-Fi modem asleep) unless somebody wants to see it, so it does not
// stream all day. It asks the relay every ~30 s whether to stream, so ON can take up to that long to show.
//
// Protected like the recording switch (recording-switch.php): the dashboard login, the header only the
// dashboard's own script sends (a page on another site cannot make a browser send it) and the relay's
// control key, which the browser never sees. The relay logs who did it.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/relay.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/DetectorView.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    json_fail(405, 'POST only');
}
require_dashboard_mutation();

if ((string) ($config['relay_control_key'] ?? '') === '') {
    json_fail(503, 'The live view switch is not set up: add relay_control_key to config.php (and the same value as controlKey in the relay config)');
}

$request = CamDetectorView::buildRequest($_GET, $cameras);
if (!$request['ok']) {
    json_fail($request['status'], $request['error']);
}

// The relay's own answer and status are passed on (401 wrong key, 404 detector not known to it yet ...).
relay_proxy_json($request['url'], 'POST', 5, relay_actor_headers($config), 'Could not reach the relay');
