<?php
// auth.php — HTTP Basic Auth gate for the Tor-facing camera dashboard.
// require_once this at the very top of any page reachable over Tor
// (index.php, stream.php) before any other output.
// Credentials come from config.php — see example.config.php for the template.
//
// What it does, in order:
//   1. Refuses to run (503) while the login in config.php is unsafe: an empty username or
//      password, a password shorter than 8 characters, or the template's "change-me".
//   2. Asks the browser for a login (401) when none was sent. That is not a failed attempt.
//   3. Slows down guessing: after 10 wrong logins in a row every attempt is refused (429) for a
//      growing time, up to 15 minutes. The counter is global, because over Tor every visitor
//      arrives from 127.0.0.1. (Trade-off: while someone is guessing, the owner is locked out
//      too — Tor v3 client authorization, see INSTALL.md, keeps strangers from reaching the
//      login at all.) Every wrong login is written to the web server's error log.
//
// The actual credential and throttle rules live in lib/Logic.php (CamLogic) so they can be unit
// tested without a web server — see tests/php/test_logic.php. Only the file handling is here.

require_once __DIR__ . '/lib/Logic.php';

// Safe response headers for every page and endpoint (all of them require this file first), also on
// the 401 / 429 / 503 answers below. They break nothing today:
//   nosniff             - the browser must not guess a type for a response (a recording name is not a script)
//   Referrer-Policy     - a click on an outside link does not tell that site which dashboard it came from
//   frame-ancestors     - no other website can put the dashboard in a frame (clickjacking); the older
//                         X-Frame-Options says the same to browsers that do not know the CSP directive
//   Cache-Control       - nothing from the dashboard (camera ids, recording names, settings) is kept in a cache
// Endpoints that need something different set their own value later (header() replaces).
// A full Content-Security-Policy (default-src 'self'; script-src 'self') has to wait until the inline
// handlers and scripts are gone (review F-05, F-19). The Apache vhost in apache/camdash.conf sets
// the same headers too, so error pages that never reach PHP carry them as well.
function camdash_security_headers(): void
{
    if (headers_sent()) {
        return;
    }
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: frame-ancestors 'none'");
    header('X-Frame-Options: DENY');
    header('Cache-Control: no-store');
}
camdash_security_headers();

require_once __DIR__ . '/config_file.php';
$config = camdash_load_config(__DIR__);   // config.php with the settings saved on the dashboard (data/settings.json) on top

// Runs $fn on the stored throttle state while holding a lock, and stores what it returns, so
// parallel guesses cannot all slip past the counter. Null if the state file cannot be used
// (then logins still work, just unthrottled).
function camdash_throttle_locked(callable $fn)
{
    $file = sys_get_temp_dir() . '/camdash-login-' . sha1(__DIR__) . '.json';
    $old = umask(0077);
    $h = @fopen($file, 'c+');
    umask($old);
    if (!$h) {
        error_log('camdash: cannot open the login throttle file ' . $file . ' — failed logins are NOT being slowed down');
        return null;
    }
    try {
        if (!flock($h, LOCK_EX)) {
            return null;
        }
        $raw = json_decode((string) stream_get_contents($h), true);
        $state = CamLogic::loginThrottleState($raw, time());
        [$result, $newState] = $fn($state);
        if ($newState !== $state) {
            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($newState));
            fflush($h);
        }
        return $result;
    } finally {
        fclose($h);
    }
}

function camdash_login_gate(array $config): void
{
    $problem = CamLogic::credentialProblem($config['auth_user'] ?? null, $config['auth_pass'] ?? null);
    if ($problem !== null) {
        error_log('camdash: the dashboard is switched off — ' . $problem . '. Fix auth_user / auth_pass in config.php.');
        http_response_code(503);
        header('Content-Type: text/plain');
        exit('The dashboard login is not set up safely yet. Set a real username and password in config.php (details are in the web server error log).');
    }

    $challenge = function () {
        header('WWW-Authenticate: Basic realm="Camera Dashboard"');
        header('HTTP/1.1 401 Unauthorized');
        exit('Authentication required.');
    };

    if (!isset($_SERVER['PHP_AUTH_USER'])) {
        $challenge();   // the browser has not asked the owner yet: not a failed attempt
    }
    $user = (string) $_SERVER['PHP_AUTH_USER'];
    $pass = (string) ($_SERVER['PHP_AUTH_PW'] ?? '');

    $outcome = camdash_throttle_locked(function (array $state) use ($config, $user, $pass) {
        $now = time();
        $wait = CamLogic::loginLockRemaining($state, $now);
        if ($wait > 0) {
            return [['locked', $wait, 0], $state];
        }
        if (CamLogic::checkCredentials($config['auth_user'], $config['auth_pass'], $user, $pass)) {
            return [['ok', 0, 0], CamLogic::loginAfterSuccess($state)];
        }
        $next = CamLogic::loginAfterFailure($state, $now);
        return [['failed', CamLogic::loginLockRemaining($next, $now), $next['fails']], $next];
    });

    if ($outcome === null) {   // no usable state file: still check the login, just without the throttle
        if (CamLogic::checkCredentials($config['auth_user'], $config['auth_pass'], $user, $pass)) {
            return;
        }
        $outcome = ['failed', 0, 0];
    }

    [$status, $wait, $fails] = $outcome;
    if ($status === 'ok') {
        return;
    }
    if ($status === 'locked') {
        http_response_code(429);
        header('Retry-After: ' . $wait);
        header('Content-Type: text/plain');
        exit('Too many failed logins. Try again in ' . $wait . ' seconds.');
    }
    // A wrong login. Log it, without the password and with the username made harmless.
    error_log('camdash: failed login for user "' . preg_replace('/[^A-Za-z0-9_.@-]/', '?', substr($user, 0, 40)) . '" from ' . ($_SERVER['REMOTE_ADDR'] ?? '?')
        . ' (' . $fails . ' in a row' . ($wait > 0 ? ', locked for ' . $wait . 's' : '') . ')');
    $challenge();
}

camdash_login_gate($config);
