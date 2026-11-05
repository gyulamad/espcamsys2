<?php
// mux.php — the live pictures of several cameras, of their person detectors, and the detectors' readings, on ONE
// connection.
// Usage: mux.php?cams=cam1,cam2[&dets=cam1][&status=1][&rec=1]
//   cams    the cameras whose picture is wanted (every id must match a camera in config.php)
//   dets    the cameras whose paired DETECTOR's picture is wanted too (ids of cameras that have a detector)
//   status  1 = also the readings of the detectors, the { camId: status } map detector-status.php answers
//   rec     1 = also the recording state of the cameras, the map status.php answers
//
// stream.php opens one connection per camera, and a browser allows only about 6 per address over HTTP/1.1: with a
// few cameras every other request of the dashboard waited in the browser's queue for ever. This page passes the
// relay's /mux stream on instead (format: nodejs/camera-relay/lib/muxcodec.js, read by js/mux-client.js). The relay
// speaks in its own names; what the browser gets is renamed and shaped in lib/MuxStream.php, and only what it asked for.
// On unless 'mux_enabled' => false is in config.php: then the dashboard uses stream.php as before.
//
// The decisions (is it on, which cameras, is the answer the mux stream) live in lib/Logic.php (CamLogic) so they
// can be unit tested without a web server — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/MuxStream.php';
require_once __DIR__ . '/relay.php';

if (!CamLogic::muxEnabled($config)) {
    http_response_code(404);
    exit('mux is switched off in config.php');
}

// ?cams[]=x is an array, not a list: refuse it plainly instead of crashing (review F-16)
if (CamLogic::firstNonStringParam($_GET, ['cams', 'dets', 'status', 'rec']) !== null) {
    http_response_code(400);
    exit('Invalid parameter');
}
$ids = CamLogic::muxCameraIds($cameras, $_GET['cams'] ?? '');
if ($ids === null) {
    http_response_code(400);
    exit('cams must list cameras that exist, separated by commas');
}
$detectorCams = CamLogic::muxDetectorCameraIds($cameras, $_GET['dets'] ?? '');
if ($detectorCams === null) {
    http_response_code(400);
    exit('dets must list cameras that have a detector, separated by commas');
}
$detectorByCamera = CamLogic::detectorIdsByCamera($cameras, $detectorCams);
$status = ($_GET['status'] ?? '') === '1';
$recording = ($_GET['rec'] ?? '') === '1';

// (no redirects: review F-08)
$ctx = stream_context_create(['http' => CamLogic::relayHttpOptions('GET', 10, relay_read_headers($config))]);
$stream = @fopen(CamLogic::muxUrl($config['relay_url'], $ids, array_values($detectorByCamera), $status, $recording), 'rb', false, $ctx);
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

$allowed = CamMuxStream::allowedSources($ids, $detectorByCamera);
$states = CamMuxStream::wantedStates($status, $recording);
$buffer = '';
relay_pipe_stream($stream, function (string $chunk) use (&$buffer, $allowed, $states, $cameras): ?string {
    $buffer .= $chunk;
    $messages = CamMuxStream::takeMessages($buffer);
    return $messages === null ? null : CamMuxStream::forward($messages, $allowed, $states, $cameras);
});
fclose($stream);
