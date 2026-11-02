<?php
// simple-list.php — every camera as a small live thumbnail, nothing else. Each thumbnail links to the
// large view (simple-view.php). The thumbnails are sized to fit the screen by js/simple-list.js (never
// below a recognisable size: then the page scrolls). Markup: CamLayout::simpleListPage(), rules:
// js/simple-logic.js — both unit tested.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';

header('Content-Type: text/html; charset=utf-8');
echo CamLayout::simpleListPage($cameras);
