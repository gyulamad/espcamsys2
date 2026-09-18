<?php
// recordings.php — lists and downloads footage saved by record.php's
// recordings. The files themselves live on the Pi, written by server.js;
// this just proxies them through the same Tor/Basic-Auth-gated layer as
// everything else, since the relay port isn't meant to be reachable directly.
//
// GET recordings.php?cam=ID                     -> JSON list of saved files
// GET recordings.php?cam=ID&download=FILENAME   -> streams that file down

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';

$requested = $_GET['cam'] ?? '';

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

$relayBase = rtrim($camera['url'], '/') . '/recordings/' . rawurlencode($camera['id']);
$download = $_GET['download'] ?? null;
$delete = $_GET['delete'] ?? null;

if ($delete !== null) {
    header('Content-Type: application/json');

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Use POST to delete']);
        exit;
    }
    // Only ever matches filenames the relay itself generates — also rules
    // out path traversal (no '/', no '..').
    if (!preg_match('/^[A-Za-z0-9_.-]+\.mp4$/', $delete)) {
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

    foreach ($http_response_header ?? [] as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) {
            http_response_code((int) $m[1]);
            break;
        }
    }

    echo $result;
    exit;
}

if ($download !== null) {
    // Only ever matches filenames the relay itself generates — also rules
    // out path traversal (no '/', no '..').
    if (!preg_match('/^[A-Za-z0-9_.-]+\.mp4$/', $download)) {
        http_response_code(400);
        exit('Invalid filename');
    }

    $url = $relayBase . '/' . rawurlencode($download);
    $ctx = stream_context_create(['http' => ['timeout' => 30, 'ignore_errors' => true]]);
    $stream = @fopen($url, 'rb', false, $ctx);

    if (!$stream) {
        http_response_code(502);
        exit('Could not reach relay');
    }

    while (ob_get_level()) ob_end_clean();
    header('Content-Type: video/mp4');
    header('Content-Disposition: attachment; filename="' . $download . '"');
    fpassthru($stream);
    fclose($stream);
    exit;
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
