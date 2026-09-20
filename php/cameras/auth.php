<?php
// auth.php — HTTP Basic Auth gate for the Tor-facing camera dashboard.
// require_once this at the very top of any page reachable over Tor
// (index.php, stream.php) before any other output.
// Credentials come from config.php — see example.config.php for the template.
//
// The actual credential comparison lives in lib/Logic.php
// (CamLogic::checkCredentials()) so it can be unit tested without a web
// server — see tests/php/test_logic.php.

require_once __DIR__ . '/lib/Logic.php';

$config = require __DIR__ . '/config.php';

$suppliedUser = $_SERVER['PHP_AUTH_USER'] ?? '';
$suppliedPass = $_SERVER['PHP_AUTH_PW'] ?? '';

if (!CamLogic::checkCredentials($config['auth_user'], $config['auth_pass'], $suppliedUser, $suppliedPass)) {
    header('WWW-Authenticate: Basic realm="Camera Dashboard"');
    header('HTTP/1.1 401 Unauthorized');
    exit('Authentication required.');
}
