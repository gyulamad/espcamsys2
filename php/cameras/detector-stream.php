<?php
// detector-stream.php — MJPEG proxy of a camera's paired person detector: the 96x96 grayscale
// picture the detector's model gets. Usage: detector-stream.php?cam=cam1  (cam = a camera id of
// config.php that has a 'detector'). The detector keeps one connection OPEN to the relay and pushes
// its pictures up it (it is often behind a NAT router, so nothing ever connects to it); the relay
// serves them to any number of viewers and this just pipes that stream, like stream.php does for
// the camera.
//
// The relay answers at once: frames, or an error that says why there are none. Whatever it says is
// passed on here as the response body and (at most every few minutes per detector) written to the
// web server's error log, so a detector that does not show is explainable from either end.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/relay.php';
require_once __DIR__ . '/lib/Logic.php';

// Ends the request with a plain-text explanation (the <img> on the dashboard only needs the status;
// a person opening this address directly reads the text).
function detector_stream_fail(int $status, string $message, string $logKey): void
{
    log_throttled('detector-stream:' . $logKey . ':' . $status, 'detector-stream.php: HTTP ' . $status . ': ' . $message);
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo $message;
    exit;
}

$camera = CamLogic::findCameraById($cameras, $_GET['cam'] ?? '');
if (!$camera) {
    http_response_code(404);
    exit('Camera not found');
}
$detectorId = CamLogic::detectorIdOf($camera);
if ($detectorId === null) {
    http_response_code(404);
    exit('This camera has no person detector');
}

$streamUrl = rtrim($camera['url'], '/') . '/detector/' . rawurlencode($detectorId) . '/stream';
$stream = @fopen($streamUrl, 'rb', false, stream_context_create(['http' => ['timeout' => 10, 'ignore_errors' => true]]));
if (!$stream) {
    $failure = CamLogic::detectorStreamFailure(null, '', (string) $camera['name'], last_php_error());
    detector_stream_fail($failure['status'], $failure['message'], $detectorId);
}

$meta = stream_get_meta_data($stream);
$relayStatus = CamLogic::extractStatusCode($meta['wrapper_data'] ?? []);
if ($relayStatus !== 200) {
    // The relay refused: its body says why (small JSON; it closes after it).
    $body = (string) stream_get_contents($stream, 4096);
    fclose($stream);
    $failure = CamLogic::detectorStreamFailure($relayStatus ?? 0, $body, (string) $camera['name']);
    detector_stream_fail($failure['status'], $failure['message'], $detectorId);
}
$contentType = CamLogic::extractContentType($meta['wrapper_data'] ?? [], 'multipart/x-mixed-replace; boundary=frame');

while (ob_get_level()) ob_end_clean();
header('Content-Type: ' . $contentType);
header('Cache-Control: no-cache, no-store');
header('X-Accel-Buffering: no');

set_time_limit(0);
ignore_user_abort(false);
while (!feof($stream) && !connection_aborted()) {
    echo fread($stream, 8192);
    flush();
}
fclose($stream);
