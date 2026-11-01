<?php
// detector-events.php — the numbers of every camera's paired person detector, PUSHED to the dashboard
// (Server-Sent Events) the moment the relay receives them. Same data as detector-status.php, which stays
// as the fallback when this stream cannot be had.
//
// GET detector-events.php
//   -> text/event-stream; every message is `event: detectors` with, as data, the { camId: status } map
//      detector-status.php answers. The relay pushes on every change and once a second besides, so ages
//      and "offline" keep moving.
// Auth, the control key and the shaping of the data stay HERE (the browser never talks to the relay).
// Failures are plain HTTP errors BEFORE the stream starts (a browser's EventSource gives up for good on
// those, and the dashboard then falls back to polling); once it runs, the end of the stream is just the
// end, and the browser reconnects by itself.

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/relay.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/EventStream.php';

header('Cache-Control: no-store');
header('Content-Type: application/json'); // for the errors below; replaced once the stream starts

$paired = array_filter($cameras, function ($c) { return CamLogic::detectorIdOf($c) !== null; });
if (empty($paired)) {
    json_fail(404, 'No camera has a person detector');
}

$stream = @fopen(rtrim($cameras[0]['url'], '/') . '/detectors/events', 'rb', false, stream_context_create(['http' => CamLogic::relayHttpOptions('GET', 10, relay_read_headers($config))]));
if (!$stream) {
    log_throttled('detector-events:unreachable', 'detector-events.php: could not reach the relay for GET /detectors/events (' . (last_php_error() ?: 'no reason given') . ')');
    json_fail(502, 'The dashboard cannot reach the relay (the web server\'s error log has the reason)');
}
$meta = stream_get_meta_data($stream);
$relayStatus = CamLogic::extractStatusCode($meta['wrapper_data'] ?? []);
$relayType = strtolower(CamLogic::extractContentType($meta['wrapper_data'] ?? [], ''));
if ($relayStatus !== 200 || strpos($relayType, 'text/event-stream') !== 0) {
    fclose($stream);
    log_throttled('detector-events:refused', 'detector-events.php: the relay answered GET /detectors/events with HTTP ' . ($relayStatus ?? '?') . ' (' . ($relayType ?: 'no content type') . ') — is the relay older than this dashboard? Update nodejs/camera-relay on the Pi and restart it');
    json_fail(502, 'The relay did not open the live detector stream (HTTP ' . ($relayStatus ?? '?') . '): it may be older than this dashboard — update and restart it');
}

while (ob_get_level()) ob_end_clean();
header('Content-Type: text/event-stream; charset=utf-8');
header('X-Accel-Buffering: no');
header('X-Content-Type-Options: nosniff');

set_time_limit(0);
ignore_user_abort(false);
echo CamEventStream::preamble();
flush();

// Read without blocking: a blocking fread() on the relay's stream waits for a whole buffer of data, so a push
// would sit there until the next one. (The stream cannot be stream_select()ed — it is decoded through a
// filter — so poll it; 5 ms is the most a push is ever held back.)
stream_set_blocking($stream, false);
$buffer = '';
$lastDataAt = microtime(true);
while (!feof($stream) && !connection_aborted()) {
    $chunk = fread($stream, 8192);
    if ($chunk === false || $chunk === '') {
        if (microtime(true) - $lastDataAt > CamEventStream::RELAY_SILENCE_SECONDS) {
            break; // the relay pushes at least once a second: silence means it is gone; the browser reconnects
        }
        usleep(CamEventStream::POLL_MICROSECONDS);
        continue;
    }
    $lastDataAt = microtime(true);
    $buffer .= $chunk;
    $messages = CamEventStream::takeMessages($buffer);
    if ($messages === null) {
        break;
    }
    // Only the newest message of what has arrived is worth sending: the older ones are out of date.
    $latest = null;
    foreach ($messages as $data) {
        $out = CamEventStream::forward($data, $cameras);
        if ($out !== null) {
            $latest = $out;
        }
    }
    if ($latest !== null) {
        echo $latest;
        flush();
    }
}
fclose($stream);
