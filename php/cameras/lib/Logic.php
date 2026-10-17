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

    // ── Settings page ──
    // The dashboard's own settings (config.php) and the plumbing for saving them
    // together with the relay's (see system-settings.php). The relay's settings are
    // described and validated by the relay itself (lib/sysconfig.js); here is only what
    // is the dashboard's: the login, and the address of the relay.

    // Settings that make cameras unable to connect until each board is updated.
    const CAMERA_BREAKING_KEYS = ['camKey', 'pushPort'];

    // The dashboard's own settings, described the way the relay describes its own,
    // so the page can draw both the same way.
    public static function dashboardFields(): array
    {
        return [
            ['key' => 'auth_user', 'type' => 'string', 'group' => 'Dashboard', 'restart' => false, 'scope' => 'dashboard',
             'label' => 'Dashboard username', 'help' => 'The HTTP login of this dashboard. After saving, the browser asks you to log in again.'],
            ['key' => 'auth_pass', 'type' => 'secret', 'group' => 'Dashboard', 'restart' => false, 'scope' => 'dashboard', 'min' => 8, 'max' => 200,
             'label' => 'Dashboard password', 'help' => 'At least 8 characters. Leave empty to keep the current one.'],
            ['key' => 'relay_url', 'type' => 'string', 'group' => 'Dashboard', 'restart' => false, 'scope' => 'dashboard',
             'label' => 'Relay address', 'help' => 'Where this dashboard reaches the relay, e.g. http://127.0.0.1:8080. A new address is tested before it is saved.'],
        ];
    }

    public static function isDashboardKey(string $key): bool
    {
        foreach (self::dashboardFields() as $f) {
            if ($f['key'] === $key) {
                return true;
            }
        }
        return false;
    }

    // Splits the submitted { key: value } into the dashboard's own settings and the
    // relay's. Only plain values are accepted (no arrays or objects).
    //   -> ['ok' => true, 'dashboard' => [...], 'relay' => [...]] | ['ok' => false, 'error' => ...]
    public static function splitSettingsValues($values): array
    {
        if (!is_array($values) || array_is_list($values)) {
            return ['ok' => false, 'error' => 'values must be an object of { setting: value }'];
        }
        $dash = [];
        $relay = [];
        foreach ($values as $key => $value) {
            if (!is_string($key) || !(is_string($value) || is_int($value) || is_float($value))) {
                return ['ok' => false, 'error' => 'every setting must be a single text or number value'];
            }
            if (self::isDashboardKey($key)) {
                $dash[$key] = (string) $value;
            } else {
                $relay[$key] = $value;
            }
        }
        return ['ok' => true, 'dashboard' => $dash, 'relay' => $relay];
    }

    // The relay address as it is stored: http(s)://host[:port][/path] without a trailing
    // slash, no login in it, no query. Null if it is not usable.
    public static function normalizeRelayUrl(string $raw): ?string
    {
        $raw = trim($raw);
        if ($raw === '' || strlen($raw) > 300 || preg_match('/[\x00-\x20\x7f]/', $raw)) {
            return null;
        }
        $p = parse_url($raw);
        if ($p === false || !isset($p['scheme'], $p['host'])) {
            return null;
        }
        if (!in_array(strtolower($p['scheme']), ['http', 'https'], true)) {
            return null;
        }
        if (isset($p['user']) || isset($p['pass']) || isset($p['query']) || isset($p['fragment'])) {
            return null;
        }
        if (isset($p['port']) && ($p['port'] < 1 || $p['port'] > 65535)) {
            return null;
        }
        return rtrim($raw, '/');
    }

    // The same address with another port (the relay's port changed, and the dashboard
    // has to keep finding it). Null if the address has no usable host.
    public static function replaceUrlPort(string $url, int $port): ?string
    {
        $p = parse_url($url);
        if ($p === false || !isset($p['scheme'], $p['host']) || $port < 1 || $port > 65535) {
            return null;
        }
        return $p['scheme'] . '://' . $p['host'] . ':' . $port . rtrim($p['path'] ?? '', '/');
    }

    // Checks the dashboard's part of a settings update against the current config.
    // Only real changes are returned: a value equal to the current one, or an empty
    // password ("keep it"), is not a change.
    //   -> ['ok' => true, 'changes' => ['auth_user' => ..., ...]] | ['ok' => false, 'error' => ...]
    public static function validateDashboardUpdate(array $values, array $current): array
    {
        $changes = [];
        foreach ($values as $key => $value) {
            if ($key === 'auth_user') {
                $v = trim($value);
                if ($v === '' || strlen($v) > 64 || preg_match('/[\x00-\x1f\x7f:]/', $v)) {
                    return ['ok' => false, 'error' => 'auth_user must be 1-64 characters, without a colon or line breaks'];
                }
                if ($v !== ($current['auth_user'] ?? null)) {
                    $changes[$key] = $v;
                }
            } elseif ($key === 'auth_pass') {
                if ($value === '') {
                    continue;
                }
                if (strlen($value) < 8 || strlen($value) > 200 || preg_match('/[\x00-\x1f\x7f]/', $value)) {
                    return ['ok' => false, 'error' => 'auth_pass must be 8-200 characters, without line breaks'];
                }
                if ($value !== ($current['auth_pass'] ?? null)) {
                    $changes[$key] = $value;
                }
            } elseif ($key === 'relay_url') {
                $v = self::normalizeRelayUrl($value);
                if ($v === null) {
                    return ['ok' => false, 'error' => 'relay_url must look like http://host:port (no login, no query)'];
                }
                if ($v !== rtrim((string) ($current['relay_url'] ?? ''), '/')) {
                    $changes[$key] = $v;
                }
            } else {
                return ['ok' => false, 'error' => 'unknown dashboard setting: ' . $key];
            }
        }
        return ['ok' => true, 'changes' => $changes];
    }

    // A shared secret (the control key) the way it will be sent in a header and stored.
    public static function isValidSecret(string $secret): bool
    {
        return strlen($secret) >= 8 && strlen($secret) <= 200 && !preg_match('/[\s\x00-\x1f\x7f]/', $secret);
    }

    // The text of config.php for a config array — everything in it, `cameras` included,
    // so saving the settings never loses a camera.
    public static function buildConfigPhp(array $config): string
    {
        return "<?php\n"
            . "// config.php — written by the dashboard's settings page. You can still edit it by hand;\n"
            . "// see example.config.php for what each setting means.\n"
            . 'return ' . var_export($config, true) . ";\n";
    }

    // Request headers for a call to the relay that needs the control key and carries a
    // JSON body (PHP adds Content-Length itself). Null if the key could not be sent safely.
    public static function buildControlHeaders(string $controlKey, string $actor, bool $json = false): ?string
    {
        if ($controlKey === '' || preg_match('/[\r\n]/', $controlKey)) {
            return null;
        }
        return 'X-Control-Key: ' . $controlKey . "\r\nX-Actor: " . $actor . "\r\n" . ($json ? "Content-Type: application/json\r\n" : "Content-Length: 0\r\n");
    }

    // ── Cameras on the dashboard (the `cameras` list of config.php) ──
    // Add, rename and remove from the settings pages. The id is what ties an entry to a board
    // (its CAMERA_ID setting), so it can never be edited — remove the entry and add a new one.

    const CAMERA_ID_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/';

    // Null when fine, else what is wrong. The icon is shown on the page (it is escaped there too).
    // Length in characters (not bytes) without the mbstring extension; -1 if it is not valid UTF-8.
    public static function charLength(string $s): int
    {
        $n = preg_match_all('/./su', $s);
        return $n === false ? -1 : $n;
    }

    public static function validateCameraDetails(string $name, string $icon): ?string
    {
        $name = trim($name);
        $nameLen = self::charLength($name);
        $iconLen = self::charLength($icon);
        if ($name === '' || $nameLen < 0 || $nameLen > 60 || preg_match('/[\x00-\x1f\x7f]/', $name)) {
            return 'the name must be 1-60 characters, without line breaks';
        }
        if ($icon === '' || $iconLen < 0 || $iconLen > 8 || preg_match('/[\x00-\x1f\x7f<>&"\']/', $icon)) {
            return 'the icon must be 1-8 characters (an emoji is fine), without < > & or quotes';
        }
        return null;
    }

    // -> ['ok' => true, 'cameras' => [...]] | ['ok' => false, 'error' => ...]. Other keys of an entry are kept.
    public static function addCamera(array $cameras, string $id, string $name, string $icon): array
    {
        if (!preg_match(self::CAMERA_ID_PATTERN, $id)) {
            return ['ok' => false, 'error' => 'the id must be 1-64 characters: letters, digits, _ . - (it starts with a letter or digit)'];
        }
        foreach ($cameras as $c) {
            if (strcasecmp((string) ($c['id'] ?? ''), $id) === 0) {
                return ['ok' => false, 'error' => 'there is already a camera with the id ' . $c['id']];
            }
        }
        $err = self::validateCameraDetails($name, $icon);
        if ($err !== null) {
            return ['ok' => false, 'error' => $err];
        }
        $cameras[] = ['id' => $id, 'name' => trim($name), 'icon' => $icon];
        return ['ok' => true, 'cameras' => array_values($cameras)];
    }

    public static function updateCamera(array $cameras, string $id, string $name, string $icon): array
    {
        $err = self::validateCameraDetails($name, $icon);
        if ($err !== null) {
            return ['ok' => false, 'error' => $err];
        }
        foreach ($cameras as $i => $c) {
            if (($c['id'] ?? null) === $id) {
                $cameras[$i]['name'] = trim($name);
                $cameras[$i]['icon'] = $icon;
                return ['ok' => true, 'cameras' => array_values($cameras)];
            }
        }
        return ['ok' => false, 'error' => 'no camera with the id ' . $id];
    }

    // ── The person detector paired with a camera ──
    // A camera entry may carry 'detector' => '<DETECTOR_ID of its person detector board>'. The
    // dashboard then shows that detector's 96x96 picture and sensor numbers under the camera's
    // picture. Optional; the pairing lives only here (no board is touched, so re-pairing needs no
    // reflash). A detector belongs to one camera.

    // The paired detector id of a camera entry, or null.
    public static function detectorIdOf(array $cam): ?string
    {
        $d = $cam['detector'] ?? null;
        return is_string($d) && preg_match(self::CAMERA_ID_PATTERN, $d) ? $d : null;
    }

    // Pairs ($detectorId) or unpairs ('') a camera. Other keys of the entry stay.
    // -> ['ok' => true, 'cameras' => [...]] | ['ok' => false, 'error' => ...]
    public static function setCameraDetector(array $cameras, string $id, string $detectorId): array
    {
        $detectorId = trim($detectorId);
        if ($detectorId !== '' && !preg_match(self::CAMERA_ID_PATTERN, $detectorId)) {
            return ['ok' => false, 'error' => 'the detector id must be 1-64 characters: letters, digits, _ . - (it starts with a letter or digit)'];
        }
        $found = false;
        foreach ($cameras as $i => $c) {
            $cid = (string) ($c['id'] ?? '');
            if ($cid === $id) {
                $found = true;
                continue;
            }
            if ($detectorId !== '' && self::detectorIdOf($c) === $detectorId) {
                return ['ok' => false, 'error' => 'the detector ' . $detectorId . ' is already paired with the camera ' . $cid];
            }
            if ($detectorId !== '' && strcasecmp($cid, $detectorId) === 0) {
                return ['ok' => false, 'error' => 'the detector id must not be the id of a camera (' . $cid . ')'];
            }
        }
        if (!$found) {
            return ['ok' => false, 'error' => 'no camera with the id ' . $id];
        }
        foreach ($cameras as $i => $c) {
            if (($c['id'] ?? null) === $id) {
                if ($detectorId === '') {
                    unset($cameras[$i]['detector']);
                } else {
                    $cameras[$i]['detector'] = $detectorId;
                }
            }
        }
        return ['ok' => true, 'cameras' => array_values($cameras)];
    }

    // What detector-status.php answers: for every camera with a paired detector,
    // { camId: { detector, online, ageMs, report } }, from the relay's GET /detectors answer
    // ($relayDetectors: id => { online, ageMs, report }). A detector the relay has not heard from
    // is offline with no numbers.
    public static function buildDetectorStatus(array $cameras, array $relayDetectors): array
    {
        $out = [];
        foreach ($cameras as $c) {
            $d = self::detectorIdOf($c);
            if ($d === null) {
                continue;
            }
            $v = $relayDetectors[$d] ?? null;
            $out[(string) $c['id']] = [
                'detector' => $d,
                'online' => is_array($v) && !empty($v['online']),
                'ageMs' => is_array($v) && isset($v['ageMs']) ? $v['ageMs'] : null,
                'report' => is_array($v) && isset($v['report']) ? $v['report'] : null,
            ];
        }
        return $out;
    }

    public static function removeCamera(array $cameras, string $id): array
    {
        $kept = array_values(array_filter($cameras, function ($c) use ($id) {
            return ($c['id'] ?? null) !== $id;
        }));
        if (count($kept) === count($cameras)) {
            return ['ok' => false, 'error' => 'no camera with the id ' . $id];
        }
        return ['ok' => true, 'cameras' => $kept];
    }

    public static function findCamera(array $cameras, string $id): ?array
    {
        foreach ($cameras as $c) {
            if (($c['id'] ?? null) === $id) {
                return $c;
            }
        }
        return null;
    }

    // ── A camera's own settings (stored in the board's flash) ──
    // The settings page checks a change here first so a mistake is answered at once; the board
    // checks again and has the last word (a change it refuses comes back as "rejected").
    // $schemaKeys / $gpios come from lib/device_schema.php (generated from the firmware's table).

    // -> ['ok' => true, 'value' => canonical text] | ['ok' => false, 'error' => ...]. Never echoes the value.
    public static function normalizeDeviceValue(array $def, array $gpios, string $raw): array
    {
        $bad = function (string $why) use ($def): array { return ['ok' => false, 'error' => $def['name'] . ' ' . $why]; };
        if (preg_match('/[\x00-\x1f\x7f]/', $raw)) {
            return $bad('must not contain control characters or line breaks');
        }
        $isInt = function (string $v): bool { return (bool) preg_match('/^-?\d{1,15}$/', $v); };
        switch ($def['kind']) {
            case 'int':
                if (!$isInt($raw) || (int) $raw < $def['min'] || (int) $raw > $def['max']) {
                    return $bad('must be a whole number from ' . $def['min'] . ' to ' . $def['max']);
                }
                return ['ok' => true, 'value' => (string) (int) $raw];
            case 'float':
                if (!preg_match('/^-?\d+(\.\d+)?$/', $raw) || (float) $raw < $def['min'] || (float) $raw > $def['max']) {
                    return $bad('must be a number from ' . $def['min'] . ' to ' . $def['max']);
                }
                return ['ok' => true, 'value' => $raw];
            case 'bool':
                $l = strtolower($raw);
                if (in_array($l, ['1', 'true', 'yes', 'on'], true)) {
                    return ['ok' => true, 'value' => '1'];
                }
                if (in_array($l, ['0', 'false', 'no', 'off'], true)) {
                    return ['ok' => true, 'value' => '0'];
                }
                return $bad('must be 1 or 0');
            case 'level':
                $u = strtoupper($raw);
                if ($u === 'LOW' || $u === '0') {
                    return ['ok' => true, 'value' => 'LOW'];
                }
                if ($u === 'HIGH' || $u === '1') {
                    return ['ok' => true, 'value' => 'HIGH'];
                }
                return $bad('must be LOW or HIGH');
            case 'pin':
            case 'pin_or_off':
                if ($isInt($raw) && (int) $raw === -1 && $def['kind'] === 'pin_or_off') {
                    return ['ok' => true, 'value' => '-1'];
                }
                if (!$isInt($raw) || !in_array((int) $raw, $gpios, true)) {
                    return $bad('must be one of the usable GPIOs (' . implode(', ', $gpios) . ($def['kind'] === 'pin_or_off' ? ', or -1 for off' : '') . ')');
                }
                return ['ok' => true, 'value' => (string) (int) $raw];
            case 'host':
            case 'id':
                $max = $def['kind'] === 'host' ? 253 : 64;
                if ($raw === '' || strlen($raw) > $max || !preg_match('/^[A-Za-z0-9_.-]+$/', $raw)) {
                    return $bad('may only contain letters, digits and _ . - (1 to ' . $max . ' characters)');
                }
                return ['ok' => true, 'value' => $raw];
            case 'text':
                if ($raw === '') {
                    return $bad('must not be empty');
                }
                return ['ok' => true, 'value' => $raw];
        }
        return $bad('can only be changed over the serial port');   // secret, wifi
    }

    // Is this setting needed, given the values the camera would hold?
    public static function isDeviceSettingRequired(array $def, array $values): bool
    {
        if ($def['cond'] === 'always' || $def['condKey'] === null) {
            return true;
        }
        if (!isset($values[$def['condKey']])) {
            return true;
        }
        $equal = $values[$def['condKey']] === $def['condValue'];
        return $def['cond'] === 'equals' ? $equal : !$equal;
    }

    // A value as it goes in a "KEY=value;KEY=value" line: \ and ; are escaped.
    public static function escapeSettingValue(string $v): string
    {
        $out = '';
        for ($i = 0, $n = strlen($v); $i < $n; $i++) {
            if ($v[$i] === '\\' || $v[$i] === ';') {
                $out .= '\\';
            }
            $out .= $v[$i];
        }
        return $out;
    }

    // Turns the submitted { SETTING: value } into the line to queue for the camera.
    //   $reported: what the camera says it holds ({ SETTING: text }, secrets masked).
    //   -> ['ok' => true, 'line' => '...' ('' when nothing differs), 'changed' => [names]]
    //    | ['ok' => false, 'error' => ...]
    public static function buildDeviceChange(array $schemaKeys, array $gpios, array $reported, array $values): array
    {
        $byName = [];
        foreach ($schemaKeys as $k) {
            $byName[$k['name']] = $k;
        }
        $changes = [];
        foreach ($values as $name => $raw) {
            $name = (string) $name;
            if (!isset($byName[$name])) {
                return ['ok' => false, 'error' => 'unknown setting ' . $name];
            }
            $def = $byName[$name];
            if ($def['locked'] || in_array($def['kind'], ['secret', 'wifi'], true)) {
                return ['ok' => false, 'error' => $name . ' can only be changed over the serial port (a wrong value would cut the camera off from the relay)'];
            }
            $n = self::normalizeDeviceValue($def, $gpios, (string) $raw);
            if (!$n['ok']) {
                return $n;
            }
            if (isset($reported[$name]) && $reported[$name] === $n['value']) {
                continue;
            }
            $changes[$name] = $n['value'];
        }
        if (!$changes) {
            return ['ok' => true, 'line' => '', 'changed' => []];
        }
        // The camera must not be left needing a setting it does not have (the board checks this too).
        $after = array_merge($reported, $changes);
        foreach ($schemaKeys as $def) {
            if (self::isDeviceSettingRequired($def, $after) && !isset($after[$def['name']])) {
                return ['ok' => false, 'error' => $def['name'] . ' is needed too — it has no value yet'];
            }
        }
        $parts = [];
        foreach ($changes as $name => $value) {
            $parts[] = $name . '=' . self::escapeSettingValue($value);
        }
        return ['ok' => true, 'line' => implode(';', $parts), 'changed' => array_keys($changes)];
    }
}
