<?php
// logs-tail.php — the end of the relay's log and of Apache's error log, for the OTA & LOGS page: the answer of the
// relay's GET /logs/tail, as JSON.
//
// GET logs-tail.php?lines=1000&levels=WARN,ERROR
//   lines   1 to 5000 (default 1000): the last N lines of each file are taken first, then filtered, like `tail -n N | grep`
//   levels  a comma-separated list of WARN, ERROR, DEBUG, INFO; absent = every level
//   -> { "at": "2026-11-17T10:00:06+01:00",
//        "sources": [ { "kind": "relay|apache", "path": "/.../camera.log", "ok": true, "lines": [ "..." ] },
//                     { "kind": "apache", "path": "/var/log/apache2/error.log", "ok": false, "error": "..." } ] }
//   or { "error": "..." }: 400 for a query that is not understood, the relay's own refusal (missing or wrong control key),
//   502 when it cannot be reached or sends something else.
//
// The relay reads the two files (its config says which); this page never opens a file and never takes a path from the
// browser. Reading only. Every query value is checked first (CamLogic::logTailQuery) and relay_proxy_sanitized() (relay.php)
// adds the control key, which never reaches the browser, and cuts the answer down to the shape above
// (CamLogic::sanitizeLogTail); both unit tested in tests/php/test_logic.php.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

$query = CamLogic::logTailQuery($_GET);
if ($query === null) {
    json_fail(400, 'lines must be a whole number from 1 to 5000, and levels a comma-separated list of WARN, ERROR, DEBUG, INFO');
}
relay_proxy_sanitized($config, '/logs/tail?' . $query, 10, fn (string $body): ?array => CamLogic::sanitizeLogTail(json_decode($body, true), time()));
