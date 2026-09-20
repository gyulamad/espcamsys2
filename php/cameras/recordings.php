<?php
// recordings.php — lists, plays, downloads and deletes footage saved by
// record.php's recordings. The files themselves live on the Pi, written by
// server.js; this just proxies them through the same Tor/Basic-Auth-gated
// layer as everything else, since the relay port isn't meant to be
// reachable directly.
//
// GET  recordings.php?cam=ID                    -> JSON list of saved files
// GET  recordings.php?cam=ID&download=FILENAME  -> streams that file down as an attachment
// GET  recordings.php?cam=ID&play=FILENAME      -> streams that file inline, for <video src="">
// POST recordings.php?cam=ID&delete=FILENAME    -> deletes one recording
// POST recordings.php?cam=ID&deleteAll=1        -> deletes every recording for this camera
//
// Camera lookup, filename validation, and header forwarding all live in
// lib/Logic.php (CamLogic) so they can be unit tested without a web
// server or a running relay — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';

$requested = $_GET['cam'] ?? '';
$camera = CamLogic::findCameraById($cameras, $requested);

if (!$camera) {
    http_response_code(404);
    exit('Camera not found');
}

$relayBase = rtrim($camera['url'], '/') . '/recordings/' . rawurlencode($camera['id']);
$download = $_GET['download'] ?? null;
$play = $_GET['play'] ?? null;
$delete = $_GET['delete'] ?? null;
$deleteAll = isset($_GET['deleteAll']);

if ($deleteAll) {
    header('Content-Type: application/json');

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Use POST to delete']);
        exit;
    }

    $ctx = stream_context_create(['http' => [
        'method'        => 'DELETE',
        'timeout'       => 30,
        'ignore_errors' => true,
    ]]);
    $result = @file_get_contents($relayBase, false, $ctx); // no filename -> DELETE /recordings/:id (all of them)

    if ($result === false) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not reach relay']);
        exit;
    }

    $statusCode = CamLogic::extractStatusCode($http_response_header ?? []);
    if ($statusCode !== null) {
        http_response_code($statusCode);
    }

    echo $result;
    exit;
}

if ($delete !== null) {
    header('Content-Type: application/json');

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Use POST to delete']);
        exit;
    }
    if (!CamLogic::isSafeFilename($delete)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid filename']);
        exit;
    }

    $url = $relayBase . '/' . rawurlencode($delete);
    $ctx = stream_context_create(['http' => [
        'method'        => 'DELETE',
        'timeout'       => 10,
        'ignore_errors' => true,
    ]]);
    $result = @file_get_contents($url, false, $ctx);

    if ($result === false) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not reach relay']);
        exit;
    }

    $statusCode = CamLogic::extractStatusCode($http_response_header ?? []);
    if ($statusCode !== null) {
        http_response_code($statusCode);
    }

    echo $result;
    exit;
}

// Shared by both $download and $play below — the only difference between
// "download" and "play" is the Content-Disposition we send back; the byte
// stream from the relay is identical either way. Forwards the browser's
// Range header (sent while scrubbing an in-progress <video>) through to
// the relay, and forwards back whatever status/Content-Range/Accept-Ranges
// it responds with, instead of always answering a flat 200 with the whole
// file — that's what lets the built-in player's seek bar actually work.
function stream_recording($url, $filename, $disposition) {
    $reqHeaders = [];
    if (isset($_SERVER['HTTP_RANGE'])) {
        $reqHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    }

    $ctx = stream_context_create(['http' => [
        'timeout'       => 30,
        'ignore_errors' => true,
        'header'        => implode("\r\n", $reqHeaders),
    ]]);
    $stream = @fopen($url, 'rb', false, $ctx);

    if (!$stream) {
        http_response_code(502);
        exit('Could not reach relay');
    }

    $headers = $http_response_header ?? [];
    $status = CamLogic::extractStatusCode($headers) ?? 200;
    $passThroughHeaders = CamLogic::extractPassThroughHeaders($headers);

    while (ob_get_level()) ob_end_clean();
    http_response_code($status);
    header('Content-Type: video/mp4');
    header('Content-Disposition: ' . CamLogic::buildContentDispositionHeader($disposition, $filename));
    foreach ($passThroughHeaders as $header) {
        header($header);
    }
    fpassthru($stream);
    fclose($stream);
    exit;
}

if ($download !== null) {
    if (!CamLogic::isSafeFilename($download)) {
        http_response_code(400);
        exit('Invalid filename');
    }
    stream_recording($relayBase . '/' . rawurlencode($download), $download, 'attachment');
}

if ($play !== null) {
    if (!CamLogic::isSafeFilename($play)) {
        http_response_code(400);
        exit('Invalid filename');
    }
    stream_recording($relayBase . '/' . rawurlencode($play), $play, 'inline');
}

// Otherwise: list this camera's saved recordings as JSON.
header('Content-Type: application/json');
$ctx = stream_context_create(['http' => ['timeout' => 10, 'ignore_errors' => true]]);
$result = @file_get_contents($relayBase, false, $ctx);

if ($result === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Could not reach relay']);
    exit;
}

echo $result;
