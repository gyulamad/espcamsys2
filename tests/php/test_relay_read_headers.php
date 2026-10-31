<?php
// test_relay_read_headers.php — relay_read_headers() (php/cameras/relay.php): the headers every READ from the
// relay carries (security review R-08). The relay answers live video, pictures, recordings and the status only to a
// caller with the control key, so the dashboard must send it on those calls — and must send nothing when no key is
// configured, exactly as the relay then lets reads through.

require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';
require_once __DIR__ . '/../../php/cameras/relay.php';

$_SERVER['PHP_AUTH_USER'] = 'owner';
$_SERVER['REMOTE_ADDR'] = '192.0.2.7';

camtest_test('relay_read_headers: no control key configured -> no headers at all', function () {
    camtest_assert_equal(relay_read_headers([]), '');
    camtest_assert_equal(relay_read_headers(['relay_control_key' => '']), '');
    camtest_assert_equal(relay_read_headers(['relay_control_key' => null]), '');
});

camtest_test('relay_read_headers: with a key, the key and who is asking — one header per line, each ended by CRLF', function () {
    $h = relay_read_headers(['relay_control_key' => 'a-long-secret-control-key-0123456789']);
    camtest_assert_equal($h, "X-Control-Key: a-long-secret-control-key-0123456789\r\nX-Actor: owner@192.0.2.7\r\n");
});

camtest_test('relay_read_headers: a read has no body, so no Content-Length is sent', function () {
    camtest_assert_true(stripos(relay_read_headers(['relay_control_key' => 'k-0123456789']), 'Content-Length') === false);
});

camtest_test('relay_read_headers: the result can be put in front of a Range header without breaking either', function () {
    $h = relay_read_headers(['relay_control_key' => 'k-0123456789']) . implode("\r\n", ['Range: bytes=0-3']);
    $lines = explode("\r\n", $h);
    camtest_assert_equal($lines, ['X-Control-Key: k-0123456789', 'X-Actor: owner@192.0.2.7', 'Range: bytes=0-3']);
});

camtest_test('relay_read_headers: and in front of nothing', function () {
    $h = relay_read_headers(['relay_control_key' => 'k-0123456789']) . implode("\r\n", []);
    camtest_assert_equal(explode("\r\n", rtrim($h, "\r\n")), ['X-Control-Key: k-0123456789', 'X-Actor: owner@192.0.2.7']);
});

exit(camtest_summarize());
