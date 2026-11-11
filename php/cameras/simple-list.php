<?php
// simple-list.php — every camera as a small live thumbnail, nothing else. Each thumbnail links to the
// large view (simple-view.php). The thumbnails are sized to fit the screen by js/simple-list.js (never
// below a recognisable size: then the page scrolls). A camera that is not connected has its last picture covered
// with a "camera offline" message (js/camera-offline.js). Markup: CamLayout::simpleListPage(), rules:
// js/simple-logic.js — both unit tested. The pictures and the recording state arrive on one mux.php connection.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';

header('Content-Type: text/html; charset=utf-8');
echo CamLayout::simpleListPage($cameras);
