<?php
// detector-status.php — the numbers of every camera's paired person detector, for the dashboard
// to poll (about once a second, to aim a detector and tune its thresholds).
//
// GET detector-status.php
//   -> { camId: { detector, online, ageMs, report: { scene: {state, brightness, motion, darkBelow,
//        motionAtLeast, holdS}, person: {score, detectAt, clearAt, detected}, gpio: {pin, high}, ... } } }
// Only cameras with a 'detector' in config.php appear. The detector reports to the relay; the
// picture itself is detector-stream.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$paired = array_filter($cameras, function ($c) { return CamLogic::detectorIdOf($c) !== null; });
if (empty($paired)) {
    echo json_encode(new stdClass());
    exit;
}

[$body] = relay_fetch(rtrim($cameras[0]['url'], '/') . '/detectors', 'GET', 3);
$relayDetectors = $body === false ? null : json_decode($body, true);
if (!is_array($relayDetectors)) {
    json_fail(502, 'Could not reach relay');
}
echo json_encode((object) CamLogic::buildDetectorStatus($cameras, $relayDetectors));
