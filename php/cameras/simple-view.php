<?php
// simple-view.php — one camera in large, for a big screen: the picture, a PREV / NEXT pager, a status
// line (time, camera name, recording ON/off) and a SLIDESHOW button (the time per camera is the slideshow_seconds
// setting). Usage: simple-view.php?cam=cam1 (no cam = the first camera).
//
// The cam parameter must match an 'id' in config.php, as for mux.php's cams. Markup: CamLayout::simpleViewPage();
// the pager, the status line and the slideshow rules are in js/simple-logic.js and js/simple-view.js; the "camera
// offline" cover over the picture of a camera that is not connected is shown by js/camera-offline.js.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';

// ?cam[]=x is an array, not a name: refuse it plainly (review F-16)
if (CamLogic::firstNonStringParam($_GET, ['cam']) !== null) {
    http_response_code(400);
    exit('Invalid parameter');
}
$requested = $_GET['cam'] ?? '';
$camera = CamLogic::selectCamera($cameras, $requested);
if ($camera === null && $requested !== '') {   // asked for a camera that is not there (no cam and no cameras: the page says so)
    http_response_code(404);
    exit('Camera not found');
}

header('Content-Type: text/html; charset=utf-8');
echo CamLayout::simpleViewPage($cameras, $camera, CamLogic::slideshowSeconds($config));
