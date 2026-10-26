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
// POST recordings.php?cam=ID&seen=FILENAME      -> marks one recording as seen (the list's
//                                                  "seen" flag; unseen ones are shown in bold)
//
// The three POSTs need the dashboard's X-Requested-With header and a same-origin request (see
// CamLogic::isDashboardMutationAllowed); they reach the relay with the control key and X-Actor,
// and deletes leave a line in the web server's error log.
//
// Camera lookup, filename validation, and header forwarding all live in
// lib/Logic.php (CamLogic) so they can be unit tested without a web
// server or a running relay — see tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

$camera = CamLogic::findCameraById($cameras, $_GET['cam'] ?? '');
if (!$camera) {
    http_response_code(404);
    exit('Camera not found');
}

$relayBase = rtrim($camera['url'], '/') . '/recordings/' . rawurlencode($camera['id']);
$download = $_GET['download'] ?? null;
$play = $_GET['play'] ?? null;
$delete = $_GET['delete'] ?? null;
$deleteAll = isset($_GET['deleteAll']);
$seen = $_GET['seen'] ?? null;

// Streams a recording to the browser. Shared by $download and $play — the only
// difference between them is the Content-Disposition we send back; the byte
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

    // No redirects (review F-08): the Range header and anything else we send must not follow one to another host.
    $ctx = stream_context_create(['http' => CamLogic::relayHttpOptions('GET', 30, implode("\r\n", $reqHeaders))]);
    $stream = @fopen($url, 'rb', false, $ctx);

    if (!$stream) {
        http_response_code(502);
        exit('Could not reach relay');
    }

    $headers = $http_response_header ?? [];
    $status = CamLogic::extractStatusCode($headers) ?? 200;
    if (CamLogic::isRedirectStatus($status)) {
        fclose($stream);
        http_response_code(502);
        exit('Could not reach relay');
    }
    $passThroughHeaders = CamLogic::extractPassThroughHeaders($headers);

    while (ob_get_level()) ob_end_clean();
    http_response_code($status);
    header('Content-Type: video/mp4');
    header('Cache-Control: private, no-cache');   // not no-store: players seek and resume badly without a cache
    header('Content-Disposition: ' . CamLogic::buildContentDispositionHeader($disposition, $filename));
    foreach ($passThroughHeaders as $header) {
        header($header);
    }
    fpassthru($stream);
    fclose($stream);
    exit;
}

// Streams one recording, after checking its name is one the relay would generate.
function stream_named_recording($relayBase, $filename, $disposition) {
    if (!CamLogic::isSafeFilename($filename)) {
        http_response_code(400);
        exit('Invalid filename');
    }
    stream_recording($relayBase . '/' . rawurlencode($filename), $filename, $disposition);
}

if ($seen !== null) {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_fail(405, 'Use POST to mark a recording as seen');
    }
    require_dashboard_mutation();
    if (!CamLogic::isSafeFilename($seen)) {
        json_fail(400, 'Invalid filename');
    }
    relay_proxy_json($relayBase . '/' . rawurlencode($seen) . '/seen', 'POST', 10, relay_actor_headers($config));
    exit;
}

if ($deleteAll || $delete !== null) {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_fail(405, 'Use POST to delete');
    }
    // The most destructive action of the dashboard: only its own page may ask for it.
    require_dashboard_mutation();
    $headers = relay_actor_headers($config, false);
    if ($deleteAll) {
        // No filename -> DELETE /recordings/:id (all of them).
        audit_log('delete ALL recordings of ' . $camera['id']);
        relay_proxy_json($relayBase, 'DELETE', 30, $headers);
        exit;
    }
    if (!CamLogic::isSafeFilename($delete)) {
        json_fail(400, 'Invalid filename');
    }
    audit_log('delete recording ' . $camera['id'] . '/' . $delete);
    relay_proxy_json($relayBase . '/' . rawurlencode($delete), 'DELETE', 10, $headers);
    exit;
}

if ($download !== null) {
    stream_named_recording($relayBase, $download, 'attachment');
}

if ($play !== null) {
    stream_named_recording($relayBase, $play, 'inline');
}

// Otherwise: list this camera's saved recordings as JSON.
header('Content-Type: application/json');
[$listBody, $listHeaders] = relay_fetch($relayBase, 'GET', 10);
if ($listBody === false) {
    json_fail(502, 'Could not reach relay');
}
// PHP is the trust boundary: only clean recording filenames (and plain sizes / flags) go on to the browser.
$list = CamLogic::sanitizeRecordingList(json_decode($listBody, true));
if ($list === null) {
    json_fail(502, 'The relay did not answer with a list of recordings');
}
echo json_encode($list);
