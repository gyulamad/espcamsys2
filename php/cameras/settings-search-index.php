<?php
// settings-search-index.php — the "Jump to any setting" search index as JSON (F-29 T7b,
// designs/Search-v2.png). The settings page's search box (settings-page.php, F-38) loads it once
// and matches the query against names, labels and help text in the browser.
//
//   GET settings-search-index.php
//     -> { scopes: ['cameras', 'detectors', 'relay'],
//          entries: [ { scope, key, label, help, category, tier, apply, locked,
//                       deviceId, deviceName, deviceIcon, value, url } ... ],
//          relayError: null | text }                    (secrets are never sent, only "(set)")
//
// One entry per setting per device: a camera's key, a detector's key (the CALIBRATE page of the
// camera it is paired with), a relay or dashboard field. Each hit's url opens the page the setting
// is edited on with ?find=KEY, so the page shows the category (or, on the relay page, just the row)
// with the setting highlighted. The relay is asked for each device's reported values and its own
// settings, best effort: when it cannot be reached every key is still listed with its default and
// relayError says what is missing.
//
// Protected like camera-settings.php: the dashboard login, the X-Requested-With header only the
// dashboard's script sends, and the relay's control key (added here, never seen by the browser).

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/SearchIndex.php';
require_once __DIR__ . '/relay.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET');
    json_fail(405, 'GET only');
}
if (!CamLogic::isDashboardMutationAllowed($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$key = (string) ($config['relay_control_key'] ?? '');
if ($key === '') {
    json_fail(503, 'The settings search needs the control key: add relay_control_key to config.php (and the same value as controlKey in the relay config.js) — see "Switching recording ON / OFF" in MANUAL.md');
}
$actor   = CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
$headers = CamLogic::buildControlHeaders($key, $actor);
if ($headers === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

$schema = require __DIR__ . '/lib/device_schema.php';

// What the relay knows about one device, or null when it cannot be asked (the search falls back to
// the schema's defaults — the values the settings page would show a board that has not reported).
// Best effort on purpose: unlike camera-settings.php this does not answer with an error, so one
// dead device cannot blank the whole index. Secrets are masked here, like on every settings page.
function search_device_state(string $base, string $headers): ?array
{
    [$body, $resp] = relay_fetch($base . '/state', 'GET', 4, $headers);
    if ($body === false || (CamLogic::extractStatusCode($resp) ?? 200) !== 200) {
        return null;
    }
    $j = json_decode($body, true);
    return is_array($j) ? $j : null;
}

$statesByCam = [];
$detectorStates = [];
foreach ($config['cameras'] ?? [] as $camera) {
    if (!is_array($camera) || !isset($camera['id']) || !is_string($camera['id']) || $camera['id'] === '') {
        continue;
    }
    $base = rtrim((string) ($config['relay_url'] ?? ''), '/') . '/device-settings/recorder/' . rawurlencode($camera['id']);
    $state = search_device_state($base, $headers);
    if ($state !== null) {
        $statesByCam[$camera['id']] = CamLogic::maskStateSecrets($schema['recorder']['keys'] ?? [], $state);
    }
    $detectorId = CamLogic::detectorIdOf($camera);
    if ($detectorId !== null && $detectorId !== '') {
        $base = rtrim((string) ($config['relay_url'] ?? ''), '/') . '/device-settings/detector/' . rawurlencode($detectorId);
        $state = search_device_state($base, $headers);
        if ($state !== null) {
            $detectorStates[$detectorId] = CamLogic::maskStateSecrets($schema['detector']['keys'] ?? [], $state);
        }
    }
}

// The relay's own settings, in one call (the same one the settings page makes).
$relayFields = null;
$relayError = null;
[$body, $resp] = relay_fetch(rtrim((string) ($config['relay_url'] ?? ''), '/') . '/system-settings', 'GET', 5, $headers);
if ($body === false) {
    $relayError = 'The relay could not be reached, so its own settings are not in this search — the cameras and detectors are.';
} else {
    $j = json_decode($body, true);
    if (!is_array($j) || !isset($j['fields']) || !is_array($j['fields']) || (CamLogic::extractStatusCode($resp) ?? 200) !== 200) {
        $relayError = 'The relay did not answer with its settings (is it up to date?), so they are not in this search — the cameras and detectors are.';
    } else {
        $relayFields = CamLogic::visibleRelayFields($j['fields']);
    }
}

echo json_encode(CamSearchIndex::build($schema, $config['cameras'] ?? [], $statesByCam, $detectorStates, $relayFields, $relayError, $config));
