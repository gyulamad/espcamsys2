<?php
// stream.php — MJPEG proxy for ESP32-CAM
// Usage: stream.php?cam=cam1
// The cam parameter must match an 'id' in cameras.php

require_once __DIR__ . '/cameras.php';

$requested = $_GET['cam'] ?? '';

// Find the matching camera
$camera = null;
foreach ($cameras as $cam) {
    if ($cam['id'] === $requested) {
        $camera = $cam;
        break;
    }
}

if (!$camera) {
    http_response_code(404);
    exit('Camera not found');
}

// The stream path — ESP32-CAM default is /stream
// If your firmware uses a different path (e.g. /?action=stream), change here
$streamUrl = rtrim($camera['url'], '/') . '/stream';

// Open the stream from the ESP32
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
$contentType = 'multipart/x-mixed-replace; boundary=frame'; // fallback

foreach ($wrapperData as $header) {
    if (stripos($header, 'Content-Type:') === 0) {
        $contentType = trim(substr($header, 13));
        break;
    }
}

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
