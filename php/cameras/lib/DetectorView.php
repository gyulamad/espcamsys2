<?php
// DetectorView.php — the pure part of detector-view.php: checking what the browser asks for and building the
// relay call. No I/O, so it is unit tested (tests/php/test_detector_view.php).
//
// A detector streams its sensor values and small picture only while somebody wants to look: the page's
// WATCH button asks the relay (through detector-view.php) and keeps asking while it is open.

require_once __DIR__ . '/Logic.php';

final class CamDetectorView
{
    public const ACTIONS = ['on', 'keep', 'off'];

    // The query of detector-view.php (?cam=<camera id>&action=on|keep|off), checked against the cameras
    // of config.php. The relay address and detector id come from there, never from the browser.
    // -> ['ok' => true, 'url' => <relay url>] | ['ok' => false, 'status' => int, 'error' => string]
    public static function buildRequest(array $query, array $cameras): array
    {
        if (CamLogic::firstNonStringParam($query, ['cam', 'action']) !== null) {
            return self::refuse(400, 'Invalid parameter');
        }
        $action = $query['action'] ?? '';
        if (!in_array($action, self::ACTIONS, true)) {
            return self::refuse(400, 'action must be one of: ' . implode(', ', self::ACTIONS));
        }
        $camera = CamLogic::findCameraById($cameras, $query['cam'] ?? '');
        if (!$camera) {
            return self::refuse(404, 'Camera not found');
        }
        $detectorId = CamLogic::detectorIdOf($camera);
        if ($detectorId === null) {
            return self::refuse(404, 'This camera has no person detector');
        }
        return ['ok' => true, 'url' => rtrim($camera['url'], '/') . '/detector/' . rawurlencode($detectorId) . '/view?action=' . $action];
    }

    private static function refuse(int $status, string $error): array
    {
        return ['ok' => false, 'status' => $status, 'error' => $error];
    }
}
