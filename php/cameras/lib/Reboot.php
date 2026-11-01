<?php
// Reboot.php — what "reset this part of the system" means, without any I/O of its own.
//
//   CamReboot::plan()       a request (target + camera) -> the ordered STEPS that carry it out
//   CamReboot::run()        carries the steps out through two injected callables (relay POST, host action)
//   CamReboot::summarize()  the results -> the HTTP status and JSON the dashboard gets
//
// reboot.php supplies the real relay call and the real host command; the unit tests supply fakes
// (tests/php/test_reboot.php). A step is one of
//   ['kind' => 'device', 'device' => 'recorder'|'detector', 'cam' => camera id, 'label' => ..., 'url' => relay URL]
//       queue a hard reset on a board (the relay hands it over, the board answers and restarts)
//   ['kind' => 'relay', 'label' => ..., 'url' => relay URL]       the relay's Node.js server restarts itself
//   ['kind' => 'host', 'action' => 'restart-php'|'reboot', 'label' => ...]   the Pi's web server / the Pi
//
// The target names are the ones CamLogic::rebootMenu() puts on the buttons.

require_once __DIR__ . '/Logic.php';

class CamReboot
{
    const TARGETS = ['detector', 'camera', 'both', 'nodejs', 'php', 'relay', 'all'];
    const HOST_ACTIONS = ['restart-php', 'reboot'];

    // -> ['ok' => true, 'target' => ..., 'steps' => [...]] | ['ok' => false, 'status' => 400|404, 'error' => ...]
    public static function plan(array $query, array $cameras): array
    {
        $target = is_string($query['target'] ?? null) ? $query['target'] : '';
        if (!in_array($target, self::TARGETS, true)) {
            return self::refusal(400, 'unknown target');
        }
        if (in_array($target, ['nodejs', 'relay', 'all'], true) && empty($cameras)) {
            return self::refusal(404, 'No cameras configured');   // the relay's address comes with the cameras
        }

        if ($target === 'php') {
            return self::planned($target, [self::hostStep('restart-php')]);
        }
        if ($target === 'nodejs') {
            return self::planned($target, [self::relayStep($cameras)]);
        }
        if ($target === 'relay') {
            return self::planned($target, [self::relayStep($cameras), self::hostStep('restart-php')]);
        }
        if ($target === 'all') {
            // Every board first (they are told while the relay is still up; the relay keeps the command
            // for 10 minutes, so a board that polls while the Pi is rebooting still gets it), the Pi last.
            $steps = [];
            foreach ($cameras as $cam) {
                $steps[] = self::deviceStep($cam, 'recorder');
                if (CamLogic::detectorIdOf($cam) !== null) {
                    $steps[] = self::deviceStep($cam, 'detector');
                }
            }
            $steps[] = self::hostStep('reboot');
            return self::planned($target, $steps);
        }

        // detector | camera | both: one camera's boards
        $camera = CamLogic::findCameraById($cameras, is_string($query['cam'] ?? null) ? $query['cam'] : '');
        if (!$camera) {
            return self::refusal(404, 'Camera not found');
        }
        $wantsDetector = $target !== 'camera';
        if ($wantsDetector && CamLogic::detectorIdOf($camera) === null) {
            return self::refusal(404, 'This camera has no person detector paired');
        }
        $steps = [];
        if ($target !== 'detector') {
            $steps[] = self::deviceStep($camera, 'recorder');
        }
        if ($wantsDetector) {
            $steps[] = self::deviceStep($camera, 'detector');
        }
        $plan = self::planned($target, $steps);
        $plan['cam'] = $camera['id'];
        return $plan;
    }

    // Does carrying this plan out need the host helper (so the caller can check it is there BEFORE anything is done)?
    public static function needsHost(array $steps): bool
    {
        foreach ($steps as $step) {
            if ($step['kind'] === 'host') {
                return true;
            }
        }
        return false;
    }

    // Carries the steps out, in order.
    //   $post(url)   -> [body|false, status|null]   one POST to the relay (no body)
    //   $host(action) -> ['ok' => bool, 'error' => string]
    // Boards are independent of each other: one that cannot be reached does not stop the others. A relay
    // restart that is refused DOES stop the host steps after it (restarting PHP "with the relay" while the
    // relay did not restart would leave the two out of step).
    // -> one result per step: ['step' => step, 'ok' => bool, 'status' => int, 'error' => string]
    public static function run(array $steps, callable $post, callable $host): array
    {
        $results = [];
        $relayFailed = false;
        foreach ($steps as $step) {
            if ($step['kind'] === 'host' && $relayFailed) {
                $results[] = ['step' => $step, 'ok' => false, 'status' => 0, 'error' => 'not done, because the relay did not restart'];
                continue;
            }
            if ($step['kind'] === 'host') {
                $answer = $host($step['action']);
                $results[] = ['step' => $step, 'ok' => !empty($answer['ok']), 'status' => 500, 'error' => (string) ($answer['error'] ?? '')];
                continue;
            }
            $result = self::runRelayStep($step, $post);
            $relayFailed = $relayFailed || ($step['kind'] === 'relay' && !$result['ok']);
            $results[] = $result;
        }
        return $results;
    }

    // -> ['status' => int, 'json' => array]
    //   everything done            200 { ok, target, message }
    //   something done, not all    200 { ok, target, message, partial: true }   (the message says what was not)
    //   nothing done               the relay's own status when there was a single failure, else 502; { error }
    public static function summarize(string $target, array $results): array
    {
        $done = [];
        $failed = [];
        foreach ($results as $r) {
            if ($r['ok']) {
                $done[] = $r;
            } else {
                $failed[] = $r;
            }
        }
        if (!$done) {
            $first = $failed[0] ?? ['status' => 502, 'error' => 'Nothing to do'];
            if (count($failed) === 1) {
                $status = CamLogic::passableStatus($first['status']);
                return ['status' => $status !== null && $status >= 400 ? $status : 502, 'json' => ['error' => self::describeFailure($first)]];
            }
            return ['status' => 502, 'json' => ['error' => 'Nothing was reset. ' . self::failureList($failed)]];
        }
        $message = self::doneMessage($done);
        $json = ['ok' => true, 'target' => $target, 'message' => $message];
        if ($failed) {
            $json['partial'] = true;
            $json['message'] = $message . ' NOT done: ' . self::failureList($failed);
        }
        return ['status' => 200, 'json' => $json];
    }

    // ── internals ──

    private static function refusal(int $status, string $error): array
    {
        return ['ok' => false, 'status' => $status, 'error' => $error];
    }

    private static function planned(string $target, array $steps): array
    {
        return ['ok' => true, 'target' => $target, 'steps' => $steps];
    }

    private static function deviceStep(array $cam, string $device): array
    {
        $deviceId = $device === 'detector' ? (string) CamLogic::detectorIdOf($cam) : (string) $cam['id'];
        return [
            'kind' => 'device',
            'device' => $device,
            'cam' => (string) $cam['id'],
            'label' => $device === 'detector' ? 'detector of ' . $cam['id'] : 'camera ' . $cam['id'],
            'url' => rtrim($cam['url'], '/') . '/device-settings/' . $device . '/' . rawurlencode($deviceId) . '/reboot',
        ];
    }

    private static function relayStep(array $cameras): array
    {
        return ['kind' => 'relay', 'label' => "the relay's Node.js server", 'url' => rtrim($cameras[0]['url'], '/') . '/restart'];
    }

    private static function hostStep(string $action): array
    {
        return ['kind' => 'host', 'action' => $action, 'label' => $action === 'reboot' ? 'the Raspberry Pi' : "the dashboard's PHP server"];
    }

    private static function runRelayStep(array $step, callable $post): array
    {
        [$body, $status] = $post($step['url']);
        $status = $status ?? 200;
        if ($body === false) {
            return ['step' => $step, 'ok' => false, 'status' => 502, 'error' => 'could not reach the relay'];
        }
        $answer = json_decode($body, true);
        $expected = $step['kind'] === 'relay' ? 202 : 200;   // /restart answers 202 Accepted
        if ($status === $expected && is_array($answer) && !empty($answer['ok'])) {
            return ['step' => $step, 'ok' => true, 'status' => $status, 'error' => ''];
        }
        $reason = is_array($answer) && isset($answer['error']) && is_string($answer['error']) ? $answer['error'] : 'the relay refused the request';
        return ['step' => $step, 'ok' => false, 'status' => $status === $expected ? 502 : $status, 'error' => $reason];
    }

    private static function describeFailure(array $r): string
    {
        return $r['step']['kind'] === 'host' ? 'Could not do it on the Pi: ' . $r['error'] : $r['error'];
    }

    private static function failureList(array $failed): string
    {
        $parts = [];
        foreach ($failed as $r) {
            $parts[] = $r['step']['label'] . ': ' . $r['error'];
        }
        return implode('; ', $parts) . '.';
    }

    private static function doneMessage(array $done): string
    {
        $boards = [];
        $other = [];
        foreach ($done as $r) {
            $step = $r['step'];
            if ($step['kind'] === 'device') {
                $boards[] = $step['label'];
            } elseif ($step['kind'] === 'relay') {
                $other[] = "The relay's Node.js server is restarting.";
            } elseif ($step['action'] === 'restart-php') {
                $other[] = 'The PHP server restarts in a few seconds: reload this page after that.';
            } else {
                $other[] = 'The Raspberry Pi reboots in a few seconds; everything is back in a few minutes.';
            }
        }
        $parts = [];
        if ($boards) {
            $parts[] = 'Reset requested for ' . implode(', ', $boards) . '. They restart within about 30 seconds.';
        }
        return implode(' ', array_merge($parts, $other));
    }
}
