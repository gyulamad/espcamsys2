<?php
// reboot.php — lets the dashboard hard-reset a part of the system.
//
//   POST reboot.php?target=detector&cam=ID   the person detector paired with camera ID
//   POST reboot.php?target=camera&cam=ID     the camera board itself
//   POST reboot.php?target=both&cam=ID       the camera and its detector
//   POST reboot.php?target=nodejs            the relay's Node.js server
//   POST reboot.php?target=php               the dashboard's PHP (web) server
//   POST reboot.php?target=relay             Node.js, then PHP
//   POST reboot.php?target=all               every camera and detector, then the Raspberry Pi itself
//
// Answers { ok: true, target, message } (also { partial: true } when some part could not be done and the
// message says which) or { error } with a matching status.
//
// Boards are reset through the relay: it queues a "reboot" command, the board picks it up on its next
// poll (about 30 s), answers "applied" and restarts. The relay restarts itself (its supervisor starts it
// again). The web server and the Pi are restarted by a small root-owned helper
// (tools/camdash-power.sh, installed by deploy.sh) that this page may run through one narrow sudo rule.
//
// Protected like recording-switch.php: dashboard login, the X-Requested-With header (a page on another
// website cannot make a browser send it), and the relay's CONTROL key, added here and never sent to the
// browser. What each target does lives in lib/Reboot.php (CamReboot), unit tested.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Reboot.php';
require_once __DIR__ . '/relay.php';

// The command that runs the privileged helper; the action is appended as ONE argument (never through a
// shell). config.php may change it ('power_command' => [...]); the helper is the last element.
const POWER_COMMAND_DEFAULT = ['sudo', '-n', '/usr/local/sbin/camdash-power'];

function power_command(array $config): array
{
    $c = $config['power_command'] ?? POWER_COMMAND_DEFAULT;
    return is_array($c) && $c && array_is_list($c) && !array_filter($c, fn($p) => !is_string($p) || $p === '') ? $c : POWER_COMMAND_DEFAULT;
}

// Is the helper installed? (Whether sudo lets us run it is only known by trying.)
function power_helper_present(array $command): bool
{
    return is_executable($command[count($command) - 1]);
}

// Runs the helper with one action from the fixed list. -> ['ok' => bool, 'error' => string]
function run_power_action(array $command, string $action): array
{
    if (!in_array($action, CamReboot::HOST_ACTIONS, true)) {
        return ['ok' => false, 'error' => 'unknown action'];
    }
    $proc = @proc_open(array_merge($command, [$action]), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        return ['ok' => false, 'error' => 'could not run the helper'];
    }
    $out = trim((string) stream_get_contents($pipes[1]) . ' ' . (string) stream_get_contents($pipes[2]));
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    if ($code === 0) {
        return ['ok' => true, 'error' => ''];
    }
    error_log('camdash: power helper failed (' . $action . ', exit ' . $code . '): ' . $out);
    return ['ok' => false, 'error' => 'the helper failed (' . ($out !== '' ? substr($out, 0, 200) : 'exit ' . $code) . '). See "Resetting from the browser" in INSTALL.md'];
}

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    json_fail(405, 'POST only');
}
if (!CamLogic::isDashboardMutationAllowed($_SERVER)) {
    json_fail(403, 'This request must come from the dashboard page itself');
}

$controlKey = (string) ($config['relay_control_key'] ?? '');
if ($controlKey === '') {
    json_fail(503, 'Reset is not set up: add relay_control_key to config.php (and the same value as controlKey in the relay config)');
}

$plan = CamReboot::plan($_GET, $cameras);
if (!$plan['ok']) {
    json_fail($plan['status'], $plan['error']);
}

$command = power_command($config);
if (CamReboot::needsHost($plan['steps']) && !power_helper_present($command)) {
    // Checked BEFORE anything is done, so a half-installed system does not reset the boards and then fail.
    json_fail(503, 'Restarting the web server or the Pi is not set up: run "sudo ./deploy.sh" from the repo (it installs the helper and its sudo rule) — see "Resetting from the browser" in INSTALL.md');
}

$headers = CamLogic::buildSwitchHeaders($controlKey, request_actor());
if ($headers === null) {
    json_fail(500, 'relay_control_key in config.php contains a line break');
}

$results = CamReboot::run(
    $plan['steps'],
    function (string $url) use ($headers): array {
        [$body, $responseHeaders] = relay_fetch($url, 'POST', 6, $headers);
        return [$body, $body === false ? null : CamLogic::extractStatusCode($responseHeaders)];
    },
    function (string $action) use ($command): array {
        return run_power_action($command, $action);
    }
);

foreach ($results as $r) {
    if ($r['ok']) {
        audit_log('requested a reset of ' . $r['step']['label']);
    }
}
$summary = CamReboot::summarize($plan['target'], $results);
http_response_code($summary['status']);
echo json_encode($summary['json']);
