<?php
// system-settings.php — the settings page's backend: reads and saves every setting of
// the main system, which used to live in two config files:
//   - the relay's (config.js): ports, keys, pre-roll, log, folders  — kept by the relay
//   - the dashboard's (config.php): login, relay address           — kept here
// plus the alarm recording length, so one page covers everything.
//
//   GET  system-settings.php
//        -> { fields: [ {key, type, label, help, group, restart, value | isSet, source, ...} ],
//             supervised, configWritable, cameras: [ {id, name, icon} ] }       (secrets are never sent, only whether they are set)
//   POST system-settings.php    body: { "values": { "preRollSeconds": 10, "auth_pass": "...", ... },
//                                       "confirm": true }   (confirm: needed for settings that
//                                       disconnect the cameras — camKey, pushPort)
//        -> { ok, changed: [...], restart: "not-needed" | "done" | "timeout" | "manual", message, relogin }
//
// What happens on a POST, in this order — so a mistake can't half-apply:
//   1. everything is checked (this server's part here, the relay's part by the relay) before
//      anything is saved; a bad value changes nothing
//   2. the relay saves its settings (and says whether they need a restart)
//   3. config.php is written (login, relay address; the control key and relay port
//      follow the relay's, so the dashboard keeps finding it and keeps its key)
//   4. if the relay needs a restart to apply what was saved, this asks it to restart itself
//      (its supervisor — systemd or pm2 — starts it again) and waits until it answers
// The dashboard's own settings apply at once; nothing has to be redeployed.
//
// Protected like recording-switch.php: the dashboard login, the X-Requested-With header only
// the dashboard's script sends, and the relay's control key (added here, never seen by the browser).

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/relay.php';
require_once __DIR__ . '/config_file.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    json_fail(405, 'GET or POST only');
}
if (!CamLogic::isDashboardAjaxRequest($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$configFile = __DIR__ . '/config.php';
$relayBase  = rtrim((string) ($config['relay_url'] ?? ''), '/');
$oldKey     = (string) ($config['relay_control_key'] ?? '');
if ($oldKey === '') {
    json_fail(503, 'Settings need the control key: add relay_control_key to config.php (and the same value as controlKey in the relay config.js) once, by hand — see "Switching recording ON / OFF" in INSTALL.md');
}
$actor   = CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
$headers = CamLogic::buildControlHeaders($oldKey, $actor);
$jsonHeaders = CamLogic::buildControlHeaders($oldKey, $actor, true);
if ($headers === null || $jsonHeaders === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

// Can this server rewrite config.php? (It runs as the web server's user.)
$configWritable = is_file($configFile) && is_writable($configFile);

if ($method === 'GET') {
    [$body, $resp] = relay_fetch($relayBase . '/system-settings', 'GET', 5, $headers);
    if ($body === false) {
        json_fail(502, 'Could not reach the relay');
    }
    $status = CamLogic::extractStatusCode($resp) ?? 200;
    $relay = json_decode($body, true);
    if ($status !== 200 || !is_array($relay) || !isset($relay['fields'])) {
        http_response_code($status === 200 ? 502 : $status);
        echo json_encode(['error' => is_array($relay) && isset($relay['error']) ? $relay['error'] : 'The relay did not answer with its settings (is it up to date? copy the new nodejs/camera-relay/ and restart it)']);
        exit;
    }
    $fields = $relay['fields'];
    foreach (CamLogic::dashboardFields() as $f) {
        if ($f['type'] === 'secret') {
            $f['isSet'] = (string) ($config[$f['key']] ?? '') !== '';
        } else {
            $f['value'] = $f['key'] === 'record_seconds' ? (string) CamLogic::recordSeconds($config)
                : ($f['key'] === 'switch_off_minutes' ? (string) CamLogic::switchOffMinutes($config)
                : (string) ($config[$f['key']] ?? ''));
        }
        $f['source'] = 'config.php';
        $fields[] = $f;
    }
    $camList = array_map(function ($c) {
        return ['id' => (string) $c['id'], 'name' => (string) ($c['name'] ?? ''), 'icon' => (string) ($c['icon'] ?? '')];
    }, $config['cameras'] ?? []);
    echo json_encode(['fields' => $fields, 'supervised' => (bool) ($relay['supervised'] ?? false), 'configWritable' => $configWritable, 'cameras' => $camList]);
    exit;
}

// ── POST ──
@set_time_limit(90); // saving can include waiting for the relay to restart
$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input) || !isset($input['values'])) {
    json_fail(400, 'send { "values": { "setting": value, ... } }');
}
$split = CamLogic::splitSettingsValues($input['values']);
if (!$split['ok']) {
    json_fail(400, $split['error']);
}
$relayValues = $split['relay'];

$check = CamLogic::validateDashboardUpdate($split['dashboard'], $config);
if (!$check['ok']) {
    json_fail(400, $check['error']);
}
$dashChanges = $check['changes'];

$newKey = isset($relayValues['controlKey']) && is_string($relayValues['controlKey']) ? $relayValues['controlKey'] : '';
if ($newKey !== '' && !CamLogic::isValidSecret($newKey)) {
    json_fail(400, 'controlKey must be 8-200 characters without spaces');
}
$breaking = array_values(array_filter(CamLogic::CAMERA_BREAKING_KEYS, function ($k) use ($relayValues) {
    return isset($relayValues[$k]) && $relayValues[$k] !== '';
}));
if ($breaking && empty($input['confirm'])) {
    json_fail(409, 'Changing ' . implode(' / ', $breaking) . ' stops every camera from connecting until each board is updated — confirm to go ahead');
}

// A new relay address must answer before it is saved: a wrong one would lock the dashboard out of the relay.
if (isset($dashChanges['relay_url']) && !isset($relayValues['port'])) {
    [$probe] = relay_fetch($dashChanges['relay_url'] . '/status', 'GET', 3);
    if ($probe === false) {
        json_fail(400, 'Nothing answers at the new relay address ' . $dashChanges['relay_url'] . ' — not saved');
    }
}

// Needed later? Then fail NOW, before the relay has saved anything.
$willWriteConfig = $dashChanges || $newKey !== '' || isset($relayValues['port']);
if ($willWriteConfig && !$configWritable) {
    json_fail(500, 'config.php is not writable by the web server — run once on the Pi: sudo chown www-data ' . $configFile . ' (deploy.sh does this)');
}

// 2. the relay
$changed = [];
$restartRequired = false;
if ($relayValues) {
    [$body, $resp] = relay_fetch($relayBase . '/system-settings', 'POST', 8, $jsonHeaders, json_encode($relayValues));
    if ($body === false) {
        json_fail(502, 'Could not reach the relay — nothing was saved');
    }
    $status = CamLogic::extractStatusCode($resp) ?? 200;
    $r = json_decode($body, true);
    if ($status !== 200 || !is_array($r) || empty($r['ok'])) {
        http_response_code($status === 200 ? 502 : $status);
        echo json_encode(['error' => is_array($r) && isset($r['error']) ? $r['error'] : 'The relay refused the settings']);
        exit;
    }
    $changed = $r['changed'] ?? [];
    $restartRequired = !empty($r['restartRequired']);
}

// 3. config.php
$newConfig = $config;
foreach ($dashChanges as $k => $v) {
    $newConfig[$k] = $v;
}
if (in_array('controlKey', $changed, true) && $newKey !== '') {
    $newConfig['relay_control_key'] = $newKey;
}
if (in_array('port', $changed, true) && !isset($dashChanges['relay_url'])) {
    $moved = CamLogic::replaceUrlPort((string) $newConfig['relay_url'], (int) $relayValues['port']);
    if ($moved !== null) {
        $newConfig['relay_url'] = $moved;
    }
}
$configChanged = $newConfig !== $config;
if ($configChanged) {
    $writeErr = camdash_write_config($configFile, $newConfig);
    if ($writeErr !== null) {
        json_fail(500, 'The relay saved its settings, but ' . $writeErr);
    }
}
foreach (array_keys($dashChanges) as $k) {
    $changed[] = $k;
}

// 4. restart the relay if what it saved needs one
$restart = 'not-needed';
$message = $changed ? 'Saved.' : 'Nothing changed.';
if ($restartRequired) {
    [$body, $resp] = relay_fetch($relayBase . '/restart', 'POST', 5, $headers);
    $status = CamLogic::extractStatusCode($resp) ?? 0;
    if ($body === false || $status !== 202) {
        $restart = 'manual';
        $detail = is_string($body) && is_array(json_decode($body, true)) ? (json_decode($body, true)['error'] ?? '') : 'the relay could not be reached';
        $message = 'Saved, but the relay could not restart itself (' . $detail . '). Restart it to apply: sudo systemctl restart camrelay';
    } else {
        $restart = 'timeout';
        $newBase = rtrim((string) $newConfig['relay_url'], '/');
        sleep(1);
        for ($i = 0; $i < 20; $i++) {
            [$up, $upResp] = relay_fetch($newBase . '/status', 'GET', 2);
            if ($up !== false && (CamLogic::extractStatusCode($upResp) ?? 0) === 200) {
                $restart = 'done';
                break;
            }
            sleep(1);
        }
        $message = $restart === 'done'
            ? 'Saved. The relay restarted and is running with the new settings.'
            : 'Saved, and the relay was told to restart, but it has not answered within 20 seconds — check: sudo systemctl status camrelay';
    }
}

echo json_encode([
    'ok' => true,
    'changed' => $changed,
    'restart' => $restart,
    'message' => $message,
    'relogin' => isset($dashChanges['auth_user']) || isset($dashChanges['auth_pass']),
    'breaking' => $breaking,
]);
