<?php
// ota-status.php — the firmware status of the boards, for the OTA & LOGS page: the answer of the relay's
// GET /ota/status (what `curl -H 'X-Control-Key: ...' http://127.0.0.1:8080/ota/status` prints), as JSON.
//
// GET ota-status.php -> { "at": "2026-11-17T10:00:05+01:00",
//                         "rows": [ { "id": "cam1", "type": "recorder", "target": "<published version>", "running": "<its version>",
//                                     "state": "updated|pending|offline|nothing-published", "seen": "4s", "error": "-" } ] }
//   or { "error": "..." }: the relay's own refusal (missing or wrong control key), or 502 when it cannot be reached.
//
// Reading only. relay_proxy_sanitized() (relay.php) adds the control key and never sends it to the browser; the relay's
// text is cut down to those fields by CamLogic::sanitizeOtaStatus (unit tested in tests/php/test_logic.php).

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';

relay_proxy_sanitized($config, '/ota/status', 5, fn (string $text): array => CamLogic::sanitizeOtaStatus($text, time()));
