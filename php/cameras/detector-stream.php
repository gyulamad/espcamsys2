<?php
// detector-stream.php — MJPEG proxy of a camera's paired person detector: the 96x96 grayscale
// picture the detector's model gets. Usage: detector-stream.php?cam=cam1  (cam = a camera id of
// config.php that has a 'detector'). The detector reports its picture to the relay, which serves it
// to any number of viewers; this just pipes that stream, like stream.php does for the camera.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';

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
    http_response_code(502);
    exit('Could not connect to the detector of: ' . htmlspecialchars($camera['name']));
}

$meta = stream_get_meta_data($stream);
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
