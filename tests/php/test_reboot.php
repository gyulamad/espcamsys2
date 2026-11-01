<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Reboot.php';

function camtest_reboot_cams(): array
{
    return CamLogic::attachRelayUrl([
        ['id' => 'cam1', 'name' => 'A', 'detector' => 'det-1'],
        ['id' => 'cam2', 'name' => 'B'],
    ], 'http://relay:8080/');
}

function camtest_plan(array $q): array
{
    return CamReboot::plan($q, camtest_reboot_cams());
}

// What a plan does, as short strings: "device:recorder:cam1", "relay", "host:reboot" ...
function camtest_steps(array $plan): array
{
    return array_map(function ($s) {
        if ($s['kind'] === 'device') return 'device:' . $s['device'] . ':' . $s['cam'];
        return $s['kind'] === 'host' ? 'host:' . $s['action'] : $s['kind'];
    }, $plan['steps']);
}

// ── plan: one camera's boards ────────────────────────────────────────

camtest_test('plan detector: the detector of the camera, reached through its own PAIRED id', function () {
    $r = camtest_plan(['target' => 'detector', 'cam' => 'cam1']);
    camtest_assert_equal($r['ok'], true);
    camtest_assert_equal($r['cam'], 'cam1');
    camtest_assert_equal($r['steps'][0]['url'], 'http://relay:8080/device-settings/detector/det-1/reboot');
});

camtest_test('plan camera: the recorder of the camera, by the camera id', function () {
    $r = camtest_plan(['target' => 'camera', 'cam' => 'cam2']);
    camtest_assert_equal(camtest_steps($r), ['device:recorder:cam2']);
    camtest_assert_equal($r['steps'][0]['url'], 'http://relay:8080/device-settings/recorder/cam2/reboot');
});

camtest_test('plan both: the camera and then its detector', function () {
    camtest_assert_equal(camtest_steps(camtest_plan(['target' => 'both', 'cam' => 'cam1'])), ['device:recorder:cam1', 'device:detector:cam1']);
});

camtest_test('plan: an unknown or missing target is 400 whatever else is sent', function () {
    foreach ([[], ['target' => ''], ['target' => 'toaster', 'cam' => 'cam1'], ['target' => ['detector'], 'cam' => 'cam1'], ['target' => 'Detector', 'cam' => 'cam1']] as $q) {
        $r = camtest_plan($q);
        camtest_assert_equal([$r['ok'], $r['status']], [false, 400]);
    }
});

camtest_test('plan: an unknown camera is 404 for every camera target', function () {
    foreach (['detector', 'camera', 'both'] as $t) {
        foreach (['nope', '', '..%2Fx'] as $cam) {
            $r = camtest_plan(['target' => $t, 'cam' => $cam]);
            camtest_assert_equal([$r['ok'], $r['status']], [false, 404], $t . ' ' . $cam);
        }
        $r = camtest_plan(['target' => $t]);
        camtest_assert_equal($r['status'], 404);
        $r = camtest_plan(['target' => $t, 'cam' => ['cam1']]);
        camtest_assert_equal($r['status'], 404);
    }
});

camtest_test('plan: a camera without a paired detector is 404 for detector and both, but can still reset itself', function () {
    foreach (['detector', 'both'] as $t) {
        $r = camtest_plan(['target' => $t, 'cam' => 'cam2']);
        camtest_assert_equal([$r['ok'], $r['status']], [false, 404], $t);
    }
    camtest_assert_equal(camtest_plan(['target' => 'camera', 'cam' => 'cam2'])['ok'], true);
});

camtest_test('plan: an invalid detector id counts as no detector (never written into a URL)', function () {
    $cams = CamLogic::attachRelayUrl([['id' => 'cam1', 'name' => 'A', 'detector' => '../x?y']], 'http://relay:8080');
    camtest_assert_equal(CamReboot::plan(['target' => 'detector', 'cam' => 'cam1'], $cams)['status'], 404);
});

// ── plan: the servers and everything ─────────────────────────────────

camtest_test('plan nodejs: only the relay\'s own restart; php: only the web server', function () {
    $n = camtest_plan(['target' => 'nodejs']);
    camtest_assert_equal(camtest_steps($n), ['relay']);
    camtest_assert_equal($n['steps'][0]['url'], 'http://relay:8080/restart');
    camtest_assert_equal(camtest_steps(camtest_plan(['target' => 'php'])), ['host:restart-php']);
});

camtest_test('plan relay: Node.js first, then PHP', function () {
    camtest_assert_equal(camtest_steps(camtest_plan(['target' => 'relay'])), ['relay', 'host:restart-php']);
});

camtest_test('plan all: every camera and every paired detector first, the Pi itself LAST', function () {
    camtest_assert_equal(camtest_steps(camtest_plan(['target' => 'all'])), ['device:recorder:cam1', 'device:detector:cam1', 'device:recorder:cam2', 'host:reboot']);
});

camtest_test('plan: the relay-address targets need a camera entry (the address comes with them)', function () {
    foreach (['nodejs', 'relay', 'all'] as $t) {
        $r = CamReboot::plan(['target' => $t], []);
        camtest_assert_equal([$r['ok'], $r['status']], [false, 404], $t);
    }
    camtest_assert_equal(CamReboot::plan(['target' => 'php'], [])['ok'], true, 'restarting PHP needs no relay');
});

camtest_test('every target the menus offer is known to the planner (no button gets "unknown target")', function () {
    $offered = array_merge(array_keys(CamLogic::rebootMenu('system')['options']), array_keys(CamLogic::rebootMenu('camera')['options']));
    foreach ($offered as $t) {
        $r = camtest_plan(['target' => $t, 'cam' => 'cam1']);
        camtest_assert_true($r['ok'], $t);
    }
});

camtest_test('needsHost: only plans with a host step', function () {
    camtest_assert_equal(CamReboot::needsHost(camtest_plan(['target' => 'detector', 'cam' => 'cam1'])['steps']), false);
    camtest_assert_equal(CamReboot::needsHost(camtest_plan(['target' => 'nodejs'])['steps']), false);
    camtest_assert_equal(CamReboot::needsHost(camtest_plan(['target' => 'php'])['steps']), true);
    camtest_assert_equal(CamReboot::needsHost(camtest_plan(['target' => 'all'])['steps']), true);
});

camtest_test('every host action a plan can contain is in the list the helper and sudoers allow', function () {
    foreach (['php', 'relay', 'all'] as $t) {
        foreach (camtest_plan(['target' => $t])['steps'] as $s) {
            if ($s['kind'] === 'host') camtest_assert_true(in_array($s['action'], CamReboot::HOST_ACTIONS, true), $s['action']);
        }
    }
});

// ── run ──────────────────────────────────────────────────────────────

// A fake relay: answers by URL ([body, status]); records what was called, in order. A fake host likewise.
function camtest_run(array $plan, array $answers = [], array $hostAnswers = []): array
{
    $calls = [];
    $post = function (string $url) use (&$calls, $answers) {
        $calls[] = 'POST ' . $url;
        foreach ($answers as $needle => $answer) {
            if (strpos($url, $needle) !== false) return $answer;
        }
        return [json_encode(['ok' => true]), strpos($url, '/restart') !== false ? 202 : 200];
    };
    $host = function (string $action) use (&$calls, $hostAnswers) {
        $calls[] = 'HOST ' . $action;
        return $hostAnswers[$action] ?? ['ok' => true];
    };
    return [CamReboot::run($plan['steps'], $post, $host), $calls];
}

camtest_test('run: steps are carried out in order, host steps last, and all report ok', function () {
    [$results, $calls] = camtest_run(camtest_plan(['target' => 'all']));
    camtest_assert_equal(array_column($results, 'ok'), [true, true, true, true]);
    camtest_assert_equal($calls[count($calls) - 1], 'HOST reboot');
    camtest_assert_equal(count($calls), 4);
});

camtest_test('run: the relay\'s restart is accepted only as 202 + ok, a device reset only as 200 + ok', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'nodejs']), ['/restart' => [json_encode(['ok' => true]), 200]]);
    camtest_assert_equal($r[0]['ok'], false, 'a 200 from /restart is not what the relay answers');
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['ok' => true]), 202]]);
    camtest_assert_equal($r[0]['ok'], false);
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['ok' => false]), 200]]);
    camtest_assert_equal($r[0]['ok'], false, '200 but not ok');
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => ['not json', 200]]);
    camtest_assert_equal($r[0]['ok'], false);
});

camtest_test('run: the relay\'s own refusal and status are kept; an unreachable relay is 502', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['error' => 'not reported yet']), 409]]);
    camtest_assert_equal([$r[0]['ok'], $r[0]['status'], $r[0]['error']], [false, 409, 'not reported yet']);
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [false, null]]);
    camtest_assert_equal([$r[0]['ok'], $r[0]['status']], [false, 502]);
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['x' => 1]), null]]);
    camtest_assert_equal($r[0]['ok'], false, 'no status at all is read as 200, which still needs ok:true');
});

camtest_test('run: one board that cannot be reset does not stop the others, nor the Pi reboot', function () {
    [$results, $calls] = camtest_run(camtest_plan(['target' => 'all']), ['detector/det-1' => [json_encode(['error' => 'not reported yet']), 409]]);
    camtest_assert_equal(array_column($results, 'ok'), [true, false, true, true]);
    camtest_assert_equal($calls[count($calls) - 1], 'HOST reboot');
});

camtest_test('run: when the relay did not restart, PHP is NOT restarted either (the two stay in step)', function () {
    [$results, $calls] = camtest_run(camtest_plan(['target' => 'relay']), ['/restart' => [json_encode(['error' => 'not supervised']), 409]]);
    camtest_assert_equal(array_column($results, 'ok'), [false, false]);
    camtest_assert_true(!in_array('HOST restart-php', $calls, true), 'PHP was left alone');
    camtest_assert_true(strpos($results[1]['error'], 'relay did not restart') !== false);
});

camtest_test('run: a failed device step does NOT hold back a host step (resetting everything goes on)', function () {
    [, $calls] = camtest_run(camtest_plan(['target' => 'all']), ['/reboot' => [false, null]]);
    camtest_assert_true(in_array('HOST reboot', $calls, true));
});

camtest_test('run: a host action that fails is reported with its reason', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'php']), [], ['restart-php' => ['ok' => false, 'error' => 'sudo: a password is required']]);
    camtest_assert_equal([$r[0]['ok'], $r[0]['error']], [false, 'sudo: a password is required']);
});

// ── summarize ────────────────────────────────────────────────────────

camtest_test('summarize: everything done is 200 with a message naming what was done', function () {
    [$results] = camtest_run(camtest_plan(['target' => 'both', 'cam' => 'cam1']));
    $s = CamReboot::summarize('both', $results);
    camtest_assert_equal($s['status'], 200);
    camtest_assert_equal([$s['json']['ok'], $s['json']['target']], [true, 'both']);
    camtest_assert_true(strpos($s['json']['message'], 'camera cam1') !== false && strpos($s['json']['message'], 'detector of cam1') !== false && strpos($s['json']['message'], '30 seconds') !== false);
    camtest_assert_true(!isset($s['json']['partial']));
});

camtest_test('summarize: the host and relay messages say what the user will see happen', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'relay']));
    $m = CamReboot::summarize('relay', $r)['json']['message'];
    camtest_assert_true(strpos($m, 'Node.js') !== false && strpos($m, 'reload this page') !== false, $m);
    [$r] = camtest_run(camtest_plan(['target' => 'all']));
    $m = CamReboot::summarize('all', $r)['json']['message'];
    camtest_assert_true(strpos($m, 'Raspberry Pi reboots') !== false && strpos($m, 'camera cam2') !== false, $m);
});

camtest_test('summarize: a single failure keeps the relay\'s status and reason', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['error' => 'this detector has not reported yet']), 409]]);
    $s = CamReboot::summarize('detector', $r);
    camtest_assert_equal($s['status'], 409);
    camtest_assert_equal($s['json'], ['error' => 'this detector has not reported yet']);
});

camtest_test('summarize: a status that is not a real error is not passed on (502)', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'detector', 'cam' => 'cam1']), ['/reboot' => [json_encode(['error' => 'x']), 302]]);
    camtest_assert_equal(CamReboot::summarize('detector', $r)['status'], 502);
});

camtest_test('summarize: a host failure says it is the Pi side', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'php']), [], ['restart-php' => ['ok' => false, 'error' => 'helper missing']]);
    $s = CamReboot::summarize('php', $r);
    camtest_assert_equal($s['status'], 500, 'a server-side problem, not a bad gateway');
    camtest_assert_true(strpos($s['json']['error'], 'on the Pi') !== false && strpos($s['json']['error'], 'helper missing') !== false);
});

camtest_test('summarize: several failures and nothing done is 502 listing each', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'both', 'cam' => 'cam1']), ['/reboot' => [false, null]]);
    $s = CamReboot::summarize('both', $r);
    camtest_assert_equal($s['status'], 502);
    camtest_assert_true(strpos($s['json']['error'], 'camera cam1') !== false && strpos($s['json']['error'], 'detector of cam1') !== false && !isset($s['json']['ok']));
});

camtest_test('summarize: some done and some not is 200, ok, partial, and the message says what was NOT done', function () {
    [$r] = camtest_run(camtest_plan(['target' => 'both', 'cam' => 'cam1']), ['detector/det-1' => [json_encode(['error' => 'has not reported yet']), 409]]);
    $s = CamReboot::summarize('both', $r);
    camtest_assert_equal($s['status'], 200);
    camtest_assert_equal([$s['json']['ok'], $s['json']['partial']], [true, true]);
    camtest_assert_true(strpos($s['json']['message'], 'NOT done: detector of cam1: has not reported yet') !== false, $s['json']['message']);
});

camtest_test('summarize: no results at all is an error, not a success', function () {
    $s = CamReboot::summarize('all', []);
    camtest_assert_equal($s['status'], 502);
    camtest_assert_true(isset($s['json']['error']));
});

exit(camtest_summarize());
