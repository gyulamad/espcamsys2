<?php
// relay.php — how the dashboard's pages talk to the relay (server.js).
//
// Every proxying page used to build its own stream context, check for an
// unreachable relay and forward the relay's status code; that lives here once.
// (Unlike lib/Logic.php this does real network I/O, so it is not unit tested —
// the end-to-end tests exercise it through the pages.)

// Header for POSTs that carry no body, the way the relay expects them.
const RELAY_EMPTY_POST_HEADER = "Content-Length: 0\r\n";

// Answers with a JSON error and stops.
function json_fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

// One request to the relay. Returns [body, response headers]; the body is
// false when the relay could not be reached. HTTP error statuses are not
// failures here — the caller gets the body and the status line like any other.
function relay_fetch(string $url, string $method = 'GET', int $timeout = 5, string $headers = '', ?string $body = null): array
{
    $http = ['method' => $method, 'timeout' => $timeout, 'ignore_errors' => true];
    if ($headers !== '') {
        $http['header'] = $headers;
    }
    if ($body !== null) {
        $http['content'] = $body;
    }
    $response = @file_get_contents($url, false, stream_context_create(['http' => $http]));
    return [$response, $http_response_header ?? []];
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
