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

    // Interprets a raw ?enabled= value the way control.php does: must be
    // exactly the string '0' or '1'; anything else is invalid.
    public static function validateEnabledParam($raw): ?bool
    {
        if ($raw === '1') return true;
        if ($raw === '0') return false;
        return null;
    }

    // Interprets a raw ?seconds= value the way control.php/record.php do:
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

    // Builds the "enabled=..&seconds=.." query string control.php sends
    // through to the relay's /control/:id. `seconds` is only included when
    // turning the camera on (relay ignores it when turning off).
    public static function buildControlQuery(bool $enabled, ?int $seconds = null): string
    {
        $query = 'enabled=' . ($enabled ? '1' : '0');
        if ($enabled && $seconds !== null) {
            $query .= '&seconds=' . urlencode((string) $seconds);
        }
        return $query;
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
}
