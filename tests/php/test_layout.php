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

// ── storageWarningScript ─────────────────────────────────────────────

camtest_test('storageWarningScript is one script that asks storage.php and alerts the server\'s own message', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, '<script>') === 0 && substr($html, -9) === '</script>', 'one script, nothing around it');
    camtest_assert_equal(substr_count($html, '<script'), 1);
    camtest_assert_true(strpos($html, "fetch('storage.php'") !== false, 'asks storage.php');
    camtest_assert_true(strpos($html, 'alert(d.message)') !== false, 'shows the message in an alert box');
});

camtest_test('storageWarningScript only alerts for a real low answer with a text message, and never reports its own failure', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, 'd.low === true') !== false, 'strict: only an actual true');
    camtest_assert_true(strpos($html, "typeof d.message === 'string'") !== false, 'only text');
    camtest_assert_true(strpos($html, '.catch(function () {})') !== false, 'a failed request is silent');
    camtest_assert_true(strpos($html, 'r.ok ?') !== false, 'an error status is not read as a warning');
});

camtest_test('storageWarningScript asks with the login, never from cache, and writes nothing into the page', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, "credentials: 'same-origin'") !== false);
    camtest_assert_true(strpos($html, "cache: 'no-store'") !== false);
    camtest_assert_true(!preg_match('/innerHTML|document\.write|eval\(|localStorage/', $html), 'the message goes to alert() only');
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
