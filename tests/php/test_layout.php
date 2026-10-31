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

// ── loggedOutPage ────────────────────────────────────────────────────

camtest_test('loggedOutPage says logged out and links back to the dashboard', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(strpos($html, '<!DOCTYPE html>') === 0);
    camtest_assert_true(stripos($html, 'LOGGED OUT') !== false);
    camtest_assert_true(strpos($html, 'href="index.php"') !== false, 'a way back to the login');
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
