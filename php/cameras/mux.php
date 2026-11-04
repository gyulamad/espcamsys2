<?php
// mux.php — the live pictures of several cameras on ONE connection.
// Usage: mux.php?cams=cam1,cam2   (every id must match a camera in config.php)
//
// stream.php opens one connection per camera, and a browser allows only about 6 per address over HTTP/1.1: with a
// few cameras every other request of the dashboard waited in the browser's queue for ever. This page passes the
// relay's /mux stream on instead (format: nodejs/camera-relay/lib/muxcodec.js, read by js/mux-client.js).
// Switched off with 'mux_enabled' => false in config.php: then the pages use stream.php as before.
//
// The decisions (is it on, which cameras, is the answer the mux stream) live in lib/Logic.php (CamLogic) so they
// can be unit tested without a web server — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

if (!CamLogic::muxEnabled($config)) {
    http_response_code(404);
    exit('mux is switched off in config.php');
}

// ?cams[]=x is an array, not a list: refuse it plainly instead of crashing (review F-16)
if (CamLogic::firstNonStringParam($_GET, ['cams']) !== null) {
    http_response_code(400);
    exit('Invalid parameter');
}
$ids = CamLogic::muxCameraIds($cameras, $_GET['cams'] ?? '');
if ($ids === null) {
    http_response_code(400);
    exit('cams must list cameras that exist, separated by commas');
}

// (no redirects: review F-08)
$ctx = stream_context_create(['http' => CamLogic::relayHttpOptions('GET', 10, relay_read_headers($config))]);
$stream = @fopen(CamLogic::muxUrl($config['relay_url'], $ids), 'rb', false, $ctx);
if (!$stream) {
    http_response_code(502);
    exit('Could not connect to the relay');
}

$wrapperData = stream_get_meta_data($stream)['wrapper_data'] ?? [];
if (CamLogic::isRedirectStatus(CamLogic::extractStatusCode($wrapperData)) || !CamLogic::isMuxContentType($wrapperData)) {
    fclose($stream);
    error_log('camdash: mux.php: the relay did not answer with the mux stream — refused');
    http_response_code(502);
    exit('Could not connect to the relay');
}

// Disable output buffering so pictures reach the browser immediately
while (ob_get_level()) ob_end_clean();

header('Content-Type: ' . CamLogic::MUX_CONTENT_TYPE);
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-cache, no-store');
header('X-Accel-Buffering: no'); // tell nginx not to buffer either

relay_pipe_stream($stream);
fclose($stream);
