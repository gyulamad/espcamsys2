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
//                                                  "seen" flag; unseen ones are shown bold and bright, seen ones gray)
// GET  recordings.php?cam=ID&thumb=FILENAME     -> the picture of the first person found in that clip (JPEG)
// POST recordings.php?cam=ID&scan=FILENAME      -> sorts one clip out: checks it for a person, a clip with nobody in it is
//                                                  moved aside (or deleted, relay setting) — see INSTALL.md
// POST recordings.php?cam=ID&scanAll=1          -> the same for every clip of this camera not checked yet
// GET  recordings.php?cam=ID&archive=1          -> {"count": N}: how many clips the sorting out has put in the archive
//                                                  (the relay's recordings/<camera>/no-person/ folder)
// POST recordings.php?cam=ID&deleteArchive=1    -> deletes that camera's whole archive for good
//
// The POSTs need the dashboard's X-Requested-With header and a same-origin request (see
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

// ?cam[]=x, ?play[]=x ... are arrays, not names: refuse them plainly instead of crashing (review F-16)
if (CamLogic::firstNonStringParam($_GET, ['cam', 'download', 'play', 'delete', 'deleteAll', 'seen', 'thumb', 'scan', 'scanAll', 'archive', 'deleteArchive']) !== null) {
    http_response_code(400);
    exit('Invalid parameter');
}
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
$thumb = $_GET['thumb'] ?? null;
$scan = $_GET['scan'] ?? null;
$scanAll = isset($_GET['scanAll']);
$archive = isset($_GET['archive']);
$deleteArchive = isset($_GET['deleteArchive']);

// Streams a recording to the browser. Shared by $download and $play — the only
// difference between them is the Content-Disposition we send back; the byte
// stream from the relay is identical either way. Forwards the browser's
// Range header (sent while scrubbing an in-progress <video>) through to
// the relay, and forwards back whatever status/Content-Range/Accept-Ranges
// it responds with, instead of always answering a flat 200 with the whole
// file — that's what lets the built-in player's seek bar actually work.
function stream_recording($url, $filename, $disposition) {
    global $config;
    $reqHeaders = [];
    // Only ONE plain byte range is passed on; anything odd is dropped and the whole file is served (review F-14).
    $range = CamLogic::validRangeHeader($_SERVER['HTTP_RANGE'] ?? null);
    if ($range !== null) {
        $reqHeaders[] = 'Range: ' . $range;
    }

    // No redirects (review F-08): the Range header and anything else we send must not follow one to another host.
    $ctx = stream_context_create(['http' => CamLogic::relayHttpOptions('GET', 30, relay_read_headers($config) . implode("\r\n", $reqHeaders))]);
    $stream = @fopen($url, 'rb', false, $ctx);

    if (!$stream) {
        http_response_code(502);
        exit('Could not reach relay');
    }

    $headers = $http_response_header ?? [];
    $status = CamLogic::extractStatusCode($headers) ?? 200;
    if (CamLogic::passableStatus($status) === null) {   // a redirect, an informational code or nonsense: not repeated to the browser
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

// Streams the picture of the first person found in a clip, after checking the clip's name. The relay
// answers 404 for a clip without one; only a real JPEG status is passed on.
function stream_thumbnail($relayBase, $filename) {
    global $config;
    if (!CamLogic::isSafeFilename($filename)) {
        http_response_code(400);
        exit('Invalid filename');
    }
    [$body, $headers] = relay_fetch($relayBase . '/' . rawurlencode($filename) . '/thumbnail', 'GET', 10, relay_read_headers($config));
    // PHP is the trust boundary: only a real JPEG goes on to the browser.
    if ($body === false || CamLogic::extractStatusCode($headers ?? []) !== 200 || strncmp($body, "\xFF\xD8\xFF", 3) !== 0) {
        http_response_code(404);
        exit('No picture');
    }
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: image/jpeg');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, max-age=3600');
    echo $body;
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

if ($scan !== null || $scanAll) {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_fail(405, 'Use POST to sort out recordings');
    }
    require_dashboard_mutation();
    if ($scanAll) {
        relay_proxy_json($relayBase . '/scan', 'POST', 30, relay_actor_headers($config));
        exit;
    }
    if (!CamLogic::isSafeFilename($scan)) {
        json_fail(400, 'Invalid filename');
    }
    relay_proxy_json($relayBase . '/' . rawurlencode($scan) . '/scan', 'POST', 10, relay_actor_headers($config));
    exit;
}

if ($thumb !== null) {
    stream_thumbnail($relayBase, $thumb);
}

if ($archive) {
    header('Content-Type: application/json');
    [$archiveBody] = relay_fetch($relayBase . '/archive', 'GET', 10, relay_read_headers($config));
    if ($archiveBody === false) {
        json_fail(502, 'Could not reach relay');
    }
    // PHP is the trust boundary: only a plain number goes on to the browser.
    $archiveCount = CamLogic::sanitizeArchiveCount(json_decode($archiveBody, true));
    if ($archiveCount === null) {
        json_fail(502, 'The relay did not answer with the number of archived recordings');
    }
    echo json_encode(['count' => $archiveCount]);
    exit;
}

if ($deleteArchive) {
    header('Content-Type: application/json');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_fail(405, 'Use POST to delete the archive');
    }
    // Deletes for good, like DELETE ALL: only the dashboard's own page may ask for it.
    require_dashboard_mutation();
    audit_log('delete ARCHIVE of ' . $camera['id']);
    relay_proxy_json($relayBase . '/archive', 'DELETE', 30, relay_actor_headers($config, false));
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
[$listBody, $listHeaders] = relay_fetch($relayBase, 'GET', 10, relay_read_headers($config));
if ($listBody === false) {
    json_fail(502, 'Could not reach relay');
}
// PHP is the trust boundary: only clean recording filenames (and plain sizes / flags) go on to the browser.
$list = CamLogic::sanitizeRecordingList(json_decode($listBody, true));
if ($list === null) {
    json_fail(502, 'The relay did not answer with a list of recordings');
}
echo json_encode($list);
