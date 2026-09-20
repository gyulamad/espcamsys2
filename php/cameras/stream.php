<?php
// stream.php — MJPEG proxy for ESP32-CAM
// Usage: stream.php?cam=cam1
// The cam parameter must match an 'id' in config.php
//
// Camera lookup and content-type extraction live in lib/Logic.php
// (CamLogic) so they can be unit tested without a web server or a running
// relay — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';

$requested = $_GET['cam'] ?? '';
$camera = CamLogic::findCameraById($cameras, $requested);

if (!$camera) {
    http_response_code(404);
    exit('Camera not found');
}

// All cameras push frames to the server.js relay; fetch the live MJPEG
// stream for this camera's id from there.
$streamUrl = rtrim($camera['url'], '/') . '/stream/' . rawurlencode($camera['id']);

// Open the stream from the relay
$ctx = stream_context_create([
    'http' => [
        'timeout'        => 10,
        'ignore_errors'  => true,
    ]
]);

$stream = @fopen($streamUrl, 'rb', false, $ctx);

if (!$stream) {
    http_response_code(502);
    exit('Could not connect to camera: ' . htmlspecialchars($camera['name']));
}

// Get response headers so we can forward the content-type
// (ESP32 sends multipart/x-mixed-replace; boundary=...)
$meta        = stream_get_meta_data($stream);
$wrapperData = $meta['wrapper_data'] ?? [];
$contentType = CamLogic::extractContentType($wrapperData, 'multipart/x-mixed-replace; boundary=frame');

// Disable output buffering so frames reach the browser immediately
while (ob_get_level()) ob_end_clean();

header('Content-Type: ' . $contentType);
header('Cache-Control: no-cache, no-store');
header('X-Accel-Buffering: no'); // tell nginx not to buffer either

// Pipe the stream — runs until client disconnects or camera drops
set_time_limit(0);
ignore_user_abort(false);

while (!feof($stream) && !connection_aborted()) {
    echo fread($stream, 8192);
    flush();
}

fclose($stream);
