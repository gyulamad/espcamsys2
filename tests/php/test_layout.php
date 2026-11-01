<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Layout.php';

// ── logoutForm ───────────────────────────────────────────────────────

camtest_test('logoutForm is a POST form to logout.php with one submit button', function () {
    $html = CamLayout::logoutForm();
    camtest_assert_true(strpos($html, '<form ') === 0 && substr($html, -7) === '</form>', 'one form, nothing around it');
    camtest_assert_true(strpos($html, 'method="post"') !== false, 'must POST: a link could be triggered by another website');
    camtest_assert_true(strpos($html, 'action="logout.php"') !== false);
    camtest_assert_equal(substr_count($html, '<button'), 1);
    camtest_assert_true(strpos($html, 'type="submit"') !== false);
    camtest_assert_true(strpos($html, 'LOG OUT') !== false);
});

camtest_test('logoutForm needs no JavaScript and carries nothing a page could be tricked by', function () {
    $html = CamLayout::logoutForm();
    camtest_assert_true(!preg_match('/<script|\bon[a-z]+\s*=|javascript:|href=/i', $html), 'no script, no inline handler, no link');
    camtest_assert_true(!preg_match('/<input/i', $html), 'no fields: nothing to forge, nothing to leak');
});

// ── rebootMenu ───────────────────────────────────────────────────────

require_once __DIR__ . '/../../php/cameras/lib/Logic.php';

camtest_test('rebootMenu: a split button — main button runs the default, the arrow opens a list with every target', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('system'), 'btn');
    camtest_assert_equal(substr_count($html, 'reboot-main'), 1);
    camtest_assert_equal(substr_count($html, 'reboot-caret'), 1);
    camtest_assert_equal(substr_count($html, 'role="menuitem"'), 4, 'one list entry per target');
    camtest_assert_true(preg_match('/class="btn danger reboot-main" data-target="all"/', $html) === 1, 'the main button is the default target');
    camtest_assert_true(strpos($html, '⟳ REBOOT ALL') !== false);
    camtest_assert_true(preg_match('/<span class="reboot-list" role="menu" hidden>/', $html) === 1, 'the list starts closed');
    camtest_assert_true(strpos($html, 'aria-expanded="false"') !== false);
    camtest_assert_equal(substr_count($html, 'reboot-item default'), 1, 'exactly one entry is marked as the default');
});

camtest_test('rebootMenu: lists every target of the menu, in order, with its label', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', 'cam1');
    camtest_assert_true(preg_match_all('/class="reboot-item[^"]*" data-target="([a-z]+)"/', $html, $m) === 3);
    camtest_assert_equal($m[1], ['camera', 'detector', 'both']);
    foreach (['RESET CAMERA', 'RESET DETECTOR', 'RESET (BOTH)'] as $label) {
        camtest_assert_true(strpos($html, '>' . $label . '</button>') !== false, "$label is listed");
    }
});

camtest_test('rebootMenu: the style class and the camera id are the caller\'s; the system menu has no camera', function () {
    $card = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', 'cam1');
    camtest_assert_true(strpos($card, 'class="reboot-menu" data-cam="cam1"') !== false);
    camtest_assert_true(strpos($card, 'class="cam-btn danger reboot-main"') !== false && strpos($card, 'class="btn ') === false);
    $header = CamLayout::rebootMenu(CamLogic::rebootMenu('system'), 'btn');
    camtest_assert_true(strpos($header, 'class="reboot-menu">') !== false && strpos($header, 'data-cam') === false);
});

camtest_test('rebootMenu: every action carries its confirmation text, line breaks kept', function () {
    $menu = CamLogic::rebootMenu('system');
    $html = CamLayout::rebootMenu($menu, 'btn');
    camtest_assert_equal(substr_count($html, 'data-confirm="'), 5, 'the main button and the four list entries');
    camtest_assert_true(strpos($html, '&#10;') !== false, 'a line break is written as &#10; so the attribute keeps it');
    camtest_assert_true(strpos($html, "\n") === false, 'no raw line break inside the markup');
});

camtest_test('rebootMenu: needs no inline script and escapes what it is given', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', '"><script>alert(1)</script>');
    camtest_assert_true(!preg_match('/<script|\bon[a-z]+\s*=|javascript:/i', $html), 'no script, no inline handler');
    camtest_assert_true(strpos($html, '&quot;&gt;&lt;script&gt;') !== false, 'the camera id is escaped');
    $menu = ['default' => 'x', 'mainLabel' => '<b>M</b>', 'options' => ['x' => ['label' => '<i>L</i>', 'confirm' => "a \"quoted\" <text>"]]];
    $html = CamLayout::rebootMenu($menu, 'btn');
    camtest_assert_true(strpos($html, '<b>') === false && strpos($html, '<i>') === false, 'labels are text, never markup');
    camtest_assert_true(strpos($html, 'a &quot;quoted&quot; &lt;text&gt;') !== false, 'the confirmation text is escaped');
});

// ── loggedOutPage ────────────────────────────────────────────────────

camtest_test('loggedOutPage says logged out and links back to the dashboard', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(strpos($html, '<!DOCTYPE html>') === 0);
    camtest_assert_true(stripos($html, 'LOGGED OUT') !== false);
    camtest_assert_true(strpos($html, 'href="./"') !== false, 'a way back to the dashboard folder (".../camdash/")');
    camtest_assert_true(strpos($html, 'index.php') === false, 'never the .../index.php address: the browser does not ask for the login again there');
});

camtest_test('loggedOutPage explains the login prompt that comes with it', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(stripos($html, 'Cancel') !== false, 'tells the owner to press Cancel');
    camtest_assert_true(stripos($html, 'close every window') !== false, 'admits browsers differ and says how to be sure');
});

camtest_test('loggedOutPage is self-contained: no script, no outside resource', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(!preg_match('/<script|https?:\/\/|@import|<link|<img|<iframe/i', $html));
});

exit(camtest_summarize());
