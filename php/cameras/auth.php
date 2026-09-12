<?php
// auth.php — HTTP Basic Auth gate for the Tor-facing camera dashboard.
// require_once this at the very top of any page reachable over Tor
// (index.php, stream.php) before any other output.
// Credentials come from config.php — see example.config.php for the template.

$config = require __DIR__ . '/config.php';

$suppliedUser = $_SERVER['PHP_AUTH_USER'] ?? '';
$suppliedPass = $_SERVER['PHP_AUTH_PW'] ?? '';

// hash_equals() avoids leaking timing info about how much of the guess was right
$userOk = hash_equals($config['auth_user'], $suppliedUser);
$passOk = hash_equals($config['auth_pass'], $suppliedPass);

if (!($userOk && $passOk)) {
    header('WWW-Authenticate: Basic realm="Camera Dashboard"');
    header('HTTP/1.1 401 Unauthorized');
    exit('Authentication required.');
}
