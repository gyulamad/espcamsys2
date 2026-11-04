<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/DetectorView.php';

$cams = [
    ['id' => 'camA', 'name' => 'A', 'url' => 'http://relay:8080/', 'detector' => 'det-A'],
    ['id' => 'camB', 'name' => 'B', 'url' => 'http://relay:8080'],
];

camtest_test('a good request becomes the relay URL, built from config and the checked action only', function () use ($cams) {
    foreach (['on', 'keep', 'off'] as $a) {
        $r = CamDetectorView::buildRequest(['cam' => 'camA', 'action' => $a], $cams);
        camtest_assert_true($r['ok']);
        camtest_assert_equal($r['url'], 'http://relay:8080/detector/det-A/view?action=' . $a);
    }
});

camtest_test('an action that is not on / keep / off is a 400 that lists the choices', function () use ($cams) {
    foreach (['', 'toggle', 'ON', 'on;x', 'off&cam=x'] as $a) {
        $r = CamDetectorView::buildRequest(['cam' => 'camA', 'action' => $a], $cams);
        camtest_assert_true(!$r['ok'] && $r['status'] === 400 && strpos($r['error'], 'on, keep, off') !== false, 'action ' . $a);
    }
    camtest_assert_equal(CamDetectorView::buildRequest(['cam' => 'camA'], $cams)['status'], 400);
});

camtest_test('an array parameter is refused, not a crash', function () use ($cams) {
    camtest_assert_equal(CamDetectorView::buildRequest(['cam' => ['x'], 'action' => 'on'], $cams)['status'], 400);
    camtest_assert_equal(CamDetectorView::buildRequest(['cam' => 'camA', 'action' => ['on']], $cams)['status'], 400);
});

camtest_test('an unknown camera and a camera without a detector are 404s', function () use ($cams) {
    $r = CamDetectorView::buildRequest(['cam' => 'nope', 'action' => 'on'], $cams);
    camtest_assert_true(!$r['ok'] && $r['status'] === 404);
    $r = CamDetectorView::buildRequest(['cam' => 'camB', 'action' => 'on'], $cams);
    camtest_assert_true(!$r['ok'] && $r['status'] === 404 && strpos($r['error'], 'no person detector') !== false);
});

camtest_test('the detector id is taken from config only: nothing from the query reaches the URL', function () use ($cams) {
    $r = CamDetectorView::buildRequest(['cam' => 'camA', 'action' => 'on', 'detector' => '../x', 'url' => 'http://evil'], $cams);
    camtest_assert_true($r['ok'] && strpos($r['url'], 'evil') === false && strpos($r['url'], '..') === false);
});

exit(camtest_summarize());
