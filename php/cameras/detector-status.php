<?php
// detector-status.php — the numbers of every camera's paired person detector, for the dashboard
// to poll (about once a second, to aim a detector and tune its thresholds).
//
// GET detector-status.php
//   -> { camId: { detector, state, online, hasPicture, connected, ageMs, pictureAgeMs, ip, message,
//                 report: { scene: {state, brightness, motion, darkBelow, motionAtLeast, holdS},
//                           person: {score, detectAt, clearAt, detected}, gpio: {pin, high}, ip, fw,
//                           uptimeMs, rssi, link: {...} } } }
// Only cameras with a 'detector' in config.php appear. `state` is online / no-picture / offline /
// never and `message` says why a detector is not (fully) showing — the dashboard prints it. The
// detector pushes its numbers and pictures to the relay over one connection it keeps open (so it can
// sit behind a NAT router); the picture itself is detector-stream.php.

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

[$body, $responseHeaders] = relay_fetch(rtrim($cameras[0]['url'], '/') . '/detectors', 'GET', 3);
if ($body === false) {
    log_throttled('detector-status:unreachable', 'detector-status.php: could not reach the relay for GET /detectors (' . (last_php_error() ?: 'no reason given') . ')');
    json_fail(502, 'The dashboard cannot reach the relay (the web server\'s error log has the reason)');
}
$relayDetectors = json_decode($body, true);
if (!is_array($relayDetectors)) {
    $status = CamLogic::extractStatusCode($responseHeaders);
    log_throttled('detector-status:garbage', 'detector-status.php: the relay answered GET /detectors with HTTP ' . ($status ?? '?') . ' and something that is not JSON — is the relay older than this dashboard? Update nodejs/camera-relay on the Pi and restart it');
    json_fail(502, 'The relay did not answer the detector list (HTTP ' . ($status ?? '?') . '): it may be older than this dashboard — update and restart it');
}
echo json_encode((object) CamLogic::buildDetectorStatus($cameras, $relayDetectors));
