<?php
// lib/Logic.php — pure, dependency-free helper functions factored out of
// the various dashboard endpoints so they can be unit tested from the
// command line (`php tests/php/test_logic.php`) with no web server, no
// running relay, and no framework (no PHPUnit/Composer).
//
// Rules for anything added to this file:
//   - No $_GET/$_POST/$_SERVER access, no filesystem, no network calls.
//   - Every function takes plain values in and returns a plain value out,
//     so it can be called identically from a real request or from a test.
//
// See tests/php/test_logic.php for the unit tests covering this file.

class CamLogic
{
    // Only ever matches filenames the relay itself generates for saved
    // recordings — also rules out path traversal (no '/', no '..').
    const SAFE_FILENAME_PATTERN = '/^[A-Za-z0-9_.-]+\.mp4$/';

    // Constant-time comparison of both the username and password against
    // config — mirrors auth.php's use of hash_equals() so a wrong guess
    // doesn't leak timing info about how much of it was right.
    public static function checkCredentials(string $configUser, string $configPass, string $suppliedUser, string $suppliedPass): bool
    {
        return hash_equals($configUser, $suppliedUser) && hash_equals($configPass, $suppliedPass);
    }

    // Attaches the relay's base URL to every camera from config.php —
    // exactly what cameras.php does to build the $cameras array used by
    // every other endpoint.
    public static function attachRelayUrl(array $camerasConfig, string $relayUrl): array
    {
        $relayUrl = rtrim($relayUrl, '/');
        return array_map(function ($cam) use ($relayUrl) {
            $cam['url'] = $relayUrl;
            return $cam;
        }, $camerasConfig);
    }

    // Finds one camera by its 'id' in the $cameras array built above.
    // Returns null if there's no match — the "camera not found" case every
    // proxying endpoint checks before doing anything else.
    public static function findCameraById(array $cameras, string $id): ?array
    {
        foreach ($cameras as $cam) {
            if ($cam['id'] === $id) {
                return $cam;
            }
        }
        return null;
    }

    // Grid column count for the dashboard: 1 camera -> 1 column, up to 4 ->
    // 2 columns, more than that -> 3 columns. Pure presentation logic, but
    // easy to get subtly wrong at the boundaries, so worth pinning down.
    public static function computeGridColumns(int $count): int
    {
        if ($count === 1) return 1;
        return $count <= 4 ? 2 : 3;
    }

    // Interprets a raw ?seconds= value the way settings.php/record.php do:
    // must be written in plain digits (ctype_digit) and be at least 1.
    // Returns null for anything else (missing, non-numeric, zero, negative,
    // or containing anything but digits — e.g. a leading '+' or '-').
    public static function validatePositiveIntParam($raw): ?int
    {
        if ($raw === null || $raw === '') return null;
        if (!ctype_digit((string) $raw)) return null;
        $n = (int) $raw;
        return $n >= 1 ? $n : null;
    }

    // Builds the "alarmRecordSeconds=.." query string settings.php sends
    // through to the relay's POST /settings. Returns '' if nothing was
    // provided, so the caller can answer 400 instead of making a pointless
    // request. (Takes a nullable value rather than a bare int so "not
    // provided" stays distinguishable from a real value.)
    public static function buildSettingsQuery(?int $alarmRecordSeconds): string
    {
        if ($alarmRecordSeconds === null) {
            return '';
        }
        return 'alarmRecordSeconds=' . urlencode((string) $alarmRecordSeconds);
    }

    // Pulls the numeric HTTP status code out of the header array
    // $http_response_header gives you after a stream_context_create()
    // request, so the proxying endpoints can forward the relay's actual
    // status (e.g. 400, 409) instead of always answering 200. Returns null
    // if none of the headers look like a status line.
    public static function extractStatusCode(array $headers): ?int
    {
        foreach ($headers as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) {
                return (int) $m[1];
            }
        }
        return null;
    }

    // Filters a raw header array down to just the ones recordings.php
    // forwards on to the browser while streaming a recording — the ones
    // that make Range-based seeking in the <video> player work.
    public static function extractPassThroughHeaders(array $headers): array
    {
        return array_values(array_filter($headers, function ($header) {
            return preg_match('#^(Content-Range|Content-Length|Accept-Ranges):#i', $header) === 1;
        }));
    }

    // True for exactly the filenames the relay generates for recordings —
    // used to reject path traversal / arbitrary filenames before ever
    // building a URL or filesystem path out of user input.
    public static function isSafeFilename(string $name): bool
    {
        return preg_match(self::SAFE_FILENAME_PATTERN, $name) === 1;
    }

    // The Content-Disposition header value recordings.php sends when
    // streaming a recording down as either a download or an inline
    // <video>-player source.
    public static function buildContentDispositionHeader(string $disposition, string $filename): string
    {
        return $disposition . '; filename="' . $filename . '"';
    }

    // Picks the Content-Type to forward for a proxied MJPEG stream:
    // whatever the relay actually sent, or a sane fallback if it didn't say
    // (or said something empty).
    public static function extractContentType(array $wrapperData, string $fallback): string
    {
        foreach ($wrapperData as $header) {
            if (stripos($header, 'Content-Type:') === 0) {
                $value = trim(substr($header, strlen('Content-Type:')));
                if ($value !== '') return $value;
            }
        }
        return $fallback;
    }

    // ── FILES (N) button — the recording count shown when the page first loads ──
    //
    // The count is worked out HERE, on the server, while the page is built, and
    // written straight into the HTML — so it's there the moment the page
    // appears, instead of waiting for a background request from the browser
    // (which, over Tor, may be slow or, if it fails, never fill it in).

    // The text of a camera's FILES button. No number when the count isn't
    // known (relay unreachable) — better than a wrong one. The dashboard's
    // JavaScript (setFilesCount in index.php) produces the identical text when
    // it updates the number later.
    public static function formatFilesButtonLabel(?int $count): string
    {
        return $count === null ? '📼 FILES' : '📼 FILES (' . $count . ')';
    }

    // Reads the relay's GET /status JSON into [cameraId => recordingCount],
    // keeping only cameras that carry a whole-number count. Anything else — an
    // error body, garbage, or a relay too old to report counts (no
    // recordingCount field) — simply contributes nothing, so the caller can
    // fall back to another way of finding out.
    public static function parseStatusCounts(string $json): array
    {
        $data = json_decode($json, true);
        if (!is_array($data) || isset($data['error'])) {
            return [];
        }
        $counts = [];
        foreach ($data as $id => $entry) {
            if (is_array($entry) && isset($entry['recordingCount'])
                && is_int($entry['recordingCount']) && $entry['recordingCount'] >= 0) {
                $counts[(string) $id] = $entry['recordingCount'];
            }
        }
        return $counts;
    }

    // Reads the relay's GET /recordings/<id> JSON — a plain list of files —
    // into how many there are. Null if it isn't a list (an error body, garbage).
    // That endpoint exists on every relay version, which is why it's the fallback.
    public static function parseRecordingCount(string $json): ?int
    {
        $data = json_decode($json, true);
        if (!is_array($data)) {
            return null;
        }
        // A JSON list decodes to keys 0..n-1; an error object like {"error":"..."} does not.
        if ($data !== [] && array_keys($data) !== range(0, count($data) - 1)) {
            return null;
        }
        return count($data);
    }

    // Works out [cameraId => recordingCount] for the dashboard, asking the relay
    // through $fetch — a function(string $url): ?string returning the response
    // body, or null if the relay couldn't be reached. (Injected so this can be
    // tested without a network; index.php passes one with a short timeout.)
    //
    //   1. ONE request: the relay's /status, which carries every camera's count.
    //      If the relay can't be reached at all, stop right there — the page
    //      must not sit through one timeout per camera.
    //   2. For any camera still without a count (a relay that predates counts in
    //      /status, or one that hasn't seen the camera and has no footage),
    //      ask its file list instead and count that. If the relay stops
    //      answering midway, stop asking.
    // Cameras whose count couldn't be found are left out of the result.
    public static function collectRecordingCounts(array $cameras, callable $fetch): array
    {
        if (empty($cameras)) {
            return [];
        }
        $statusBody = $fetch(rtrim($cameras[0]['url'], '/') . '/status');
        if ($statusBody === null) {
            return [];
        }
        $counts = self::parseStatusCounts($statusBody);
        foreach ($cameras as $cam) {
            if (isset($counts[$cam['id']])) {
                continue;
            }
            $listBody = $fetch(rtrim($cam['url'], '/') . '/recordings/' . rawurlencode($cam['id']));
            if ($listBody === null) {
                break;
            }
            $n = self::parseRecordingCount($listBody);
            if ($n !== null) {
                $counts[$cam['id']] = $n;
            }
        }
        return $counts;
    }

    // ── Recording ON/OFF switch (recording-switch.php) ──────────────────────
    //
    // Switching recording off is a security-relevant action — it is exactly
    // what someone who wants to go unrecorded would try — so beyond the
    // dashboard login it is protected twice more:
    //   * the relay wants its own CONTROL key (relay_control_key here,
    //     controlKey in the relay's config.js), which this server adds; the
    //     browser never sees it, and it is not the key flashed into cameras;
    //   * the request must carry a custom header, which a page on another
    //     website cannot make a browser send (it would need permission via
    //     CORS first) — so a malicious page can't trigger "OFF" using the
    //     login the browser has cached for the dashboard.

    // The value the dashboard's JavaScript sends in X-Requested-With.
    const AJAX_HEADER_VALUE = 'camdash';

    public static function isDashboardAjaxRequest(array $server): bool
    {
        return ($server['HTTP_X_REQUESTED_WITH'] ?? '') === self::AJAX_HEADER_VALUE;
    }

    // Checks a switch request and turns it into the URL to call on the relay.
    //   action   on | off
    //   scope    camera (needs cam=ID, one of the configured cameras) | all
    //   minutes  off only, optional: a whole number, possibly 0 or negative
    //            ("until switched ON"); left out, the relay uses 60
    // Returns ['ok' => true, 'url' => ...] or ['ok' => false, 'status' => 4xx, 'error' => ...].
    public static function buildSwitchRequest(array $query, array $cameras): array
    {
        $action = $query['action'] ?? '';
        if ($action !== 'on' && $action !== 'off') {
            return ['ok' => false, 'status' => 400, 'error' => 'action must be "on" or "off"'];
        }
        $scope = $query['scope'] ?? '';
        if ($scope !== 'camera' && $scope !== 'all') {
            return ['ok' => false, 'status' => 400, 'error' => 'scope must be "camera" or "all"'];
        }

        $suffix = '';
        if ($action === 'off' && isset($query['minutes']) && $query['minutes'] !== '') {
            if (!is_string($query['minutes']) || !preg_match('/^\s*-?\d+\s*$/', $query['minutes'])) {
                return ['ok' => false, 'status' => 400, 'error' => 'minutes must be a whole number (0 or negative = until switched back ON)'];
            }
            $suffix = '?minutes=' . urlencode(trim($query['minutes']));
        }

        if ($scope === 'camera') {
            $camera = self::findCameraById($cameras, is_string($query['cam'] ?? null) ? $query['cam'] : '');
            if (!$camera) {
                return ['ok' => false, 'status' => 404, 'error' => 'Camera not found'];
            }
            $url = rtrim($camera['url'], '/') . '/recording/camera/' . rawurlencode($camera['id']) . '/' . $action;
        } else {
            if (empty($cameras)) {
                return ['ok' => false, 'status' => 404, 'error' => 'No cameras configured'];
            }
            $url = rtrim($cameras[0]['url'], '/') . '/recording/all/' . $action;
        }
        return ['ok' => true, 'url' => $url . $suffix];
    }

    // Who is acting, for the relay's log: "<dashboard user>@<their address>",
    // reduced to harmless characters (it goes into an HTTP header and a log line).
    public static function buildActor(string $user, string $remoteAddr): string
    {
        $actor = preg_replace('/[^A-Za-z0-9_.:@-]/', '_', $user . '@' . $remoteAddr);
        return substr($actor, 0, 80);
    }

    // The request headers for the relay call. Null if the key could not be
    // sent safely (a line break in it would let it inject extra headers).
    public static function buildSwitchHeaders(string $controlKey, string $actor): ?string
    {
        if ($controlKey === '' || preg_match('/[\r\n]/', $controlKey)) {
            return null;
        }
        return "Content-Length: 0\r\nX-Control-Key: " . $controlKey . "\r\nX-Actor: " . $actor . "\r\n";
    }
}
