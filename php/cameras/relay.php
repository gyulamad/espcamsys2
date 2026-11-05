<?php
// relay.php — how the dashboard's pages talk to the relay (server.js).
//
// Every proxying page used to build its own stream context, check for an
// unreachable relay and forward the relay's status code; that lives here once.
// (Unlike lib/Logic.php this does real network I/O, so it is not unit tested —
// the end-to-end tests exercise it through the pages.)

// Header for POSTs that carry no body, the way the relay expects them.
const RELAY_EMPTY_POST_HEADER = "Content-Length: 0\r\n";

// Reading a LIVE stream from the relay (pictures, pushed numbers).
// A blocking fread() on the relay's stream does not return what has arrived: it waits until it has a whole
// buffer (8 KB). A small picture — the detector's 96x96 JPEG is 1-3 KB — then sits in PHP until three or
// four more have followed, and the browser gets them in bursts about once a second instead of one by one.
// So live streams are read without blocking, and relay_read_available() takes a short nap when nothing has
// come yet (the stream cannot be stream_select()ed: PHP decodes it through a filter). 5 ms is the most a
// picture is ever held back.
const RELAY_POLL_MICROSECONDS = 5000;
const RELAY_SILENCE_SECONDS = 15;      // a live stream with no byte for this long is given up on

function relay_stream_nonblocking($stream): void
{
    stream_set_blocking($stream, false);
}

// What the relay has sent so far: bytes, '' when nothing is there yet (after the nap), null at the end of the
// stream — or when the relay has sent nothing at all for $silenceSeconds (a stalled relay must not keep a PHP
// worker spinning for a browser that has long gone; the browser reconnects if it is still there).
// $lastDataAt (start it with microtime(true)) is kept up to date here. Needs relay_stream_nonblocking() first.
function relay_read_available($stream, float &$lastDataAt, int $silenceSeconds = RELAY_SILENCE_SECONDS): ?string
{
    if (feof($stream)) {
        return null;
    }
    $chunk = fread($stream, 8192);
    if ($chunk === false) {
        return null;
    }
    if ($chunk !== '') {
        $lastDataAt = microtime(true);
        return $chunk;
    }
    if (microtime(true) - $lastDataAt > $silenceSeconds) {
        return null;
    }
    usleep(RELAY_POLL_MICROSECONDS);
    return '';
}

// Passes a live stream from the relay on to the browser until the browser leaves or the relay stops (or goes
// silent). Runs for as long as the browser stays: no time limit. The relay's heartbeats mean PHP writes (and so
// notices a browser that has gone) at least every few seconds, even when no camera has a picture.
// $filter, if given, turns each chunk read into what is sent ('' = nothing yet) or null = stop (not the stream
// it should be); without it the bytes are passed on as they are.
function relay_pipe_stream($stream, ?callable $filter = null): void
{
    set_time_limit(0);
    ignore_user_abort(false);
    relay_stream_nonblocking($stream);
    $lastDataAt = microtime(true);
    while (!connection_aborted() && ($chunk = relay_read_available($stream, $lastDataAt)) !== null) {
        if ($chunk === '') {
            continue;
        }
        $out = $filter === null ? $chunk : $filter($chunk);
        if ($out === null) {
            return;
        }
        if ($out === '') {
            continue;
        }
        echo $out;
        flush();
    }
}

// Answers with a JSON error and stops.
function json_fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

// Stops with 403 unless this state-changing request comes from the dashboard's own page.
function require_dashboard_mutation(): void
{
    if (!CamLogic::isDashboardMutationAllowed($_SERVER)) {
        json_fail(403, 'This request must come from the dashboard page itself');
    }
}

// "<dashboard user>@<address>" of whoever is making this request (for the relay and the audit log).
function request_actor(): string
{
    return CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
}

// Headers for a state-changing call to the relay: X-Actor, and X-Control-Key when config.php has one.
function relay_actor_headers(array $config, bool $withLength = true): string
{
    $headers = CamLogic::buildActorHeaders((string) ($config['relay_control_key'] ?? ''), request_actor(), $withLength);
    if ($headers === null) {
        json_fail(500, 'relay_control_key in config.php contains a line break');
    }
    return $headers;
}

// Headers for a READ from the relay (live video, pictures, recordings, status): the relay answers these only
// to a caller that holds the control key, once one is configured (review R-08). Empty when config.php has no key,
// so an installation that has not set one yet keeps working, exactly as the relay lets it.
function relay_read_headers(array $config): string
{
    return (string) ($config['relay_control_key'] ?? '') === '' ? '' : relay_actor_headers($config, false);
}

// One line in the web server's error log for a destructive action, so there is a trail of who did what.
function audit_log(string $what): void
{
    error_log('camdash audit: ' . request_actor() . ' ' . $what);
}

// One request to the relay. Returns [body, response headers]; the body is
// false when the relay could not be reached (or answered with a redirect). HTTP error statuses are not
// failures here — the caller gets the body and the status line like any other.
function relay_fetch(string $url, string $method = 'GET', int $timeout = 5, string $headers = '', ?string $body = null): array
{
    // Redirects are not followed (they would carry X-Control-Key to another host, review F-08):
    // a redirecting relay counts as one that cannot be used.
    $response = @file_get_contents($url, false, stream_context_create(['http' => CamLogic::relayHttpOptions($method, $timeout, $headers, $body)]));
    $responseHeaders = $http_response_header ?? [];
    if (CamLogic::isRedirectStatus(CamLogic::extractStatusCode($responseHeaders))) {
        error_log('camdash: the relay answered ' . $method . ' with a redirect, which is never followed (the control key must not be sent anywhere else) — check relay_url in config.php');
        return [false, $responseHeaders];
    }
    return [$response, $responseHeaders];
}

// Passes the relay's JSON answer straight through to the browser: 502 if the
// relay is unreachable, otherwise its body — and, when $forwardStatus is set,
// its status code too (so a 400 or 409 reaches the dashboard as such).
function relay_proxy_json(
    string $url,
    string $method = 'GET',
    int $timeout = 5,
    string $headers = '',
    string $unreachableMessage = 'Could not reach relay',
    bool $forwardStatus = true
): void {
    [$body, $responseHeaders] = relay_fetch($url, $method, $timeout, $headers);
    if ($body === false) {
        json_fail(502, $unreachableMessage);
    }
    $status = $forwardStatus ? CamLogic::extractStatusCode($responseHeaders) : null;
    if ($status !== null) {
        if (CamLogic::passableStatus($status) === null) {   // not a real final answer (review F-14)
            json_fail(502, 'The relay answered with a status the dashboard does not pass on');
        }
        http_response_code($status);
    }
    echo $body;
}

// Writes to the web server's error log, but not more than once per $everySec seconds for the same $key:
// a dashboard that re-asks for a missing picture every few seconds must leave a line, not a flood. The
// time of the last write is the modification time of a small marker file in the temp directory (no
// session, no database; if the directory is not writable the line is simply written every time).
function log_throttled(string $key, string $message, int $everySec = 300): void
{
    $marker = sys_get_temp_dir() . '/camdash-log-' . sha1($key);
    $last = @filemtime($marker);
    if (!CamLogic::logDue($last === false ? null : $last, time(), $everySec)) {
        return;
    }
    @touch($marker);
    error_log('camdash: ' . $message);
}

// PHP's reason for the last failed call (what the @ in front of it swallowed), for the error log.
function last_php_error(): string
{
    $e = error_get_last();
    return $e && isset($e['message']) ? $e['message'] : '';
}
