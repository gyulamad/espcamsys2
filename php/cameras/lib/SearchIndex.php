<?php
// SearchIndex.php — the "Jump to any setting" search index (F-29 T7b, designs/Search-v2.png): every
// setting of every camera, of every detector and of the relay/dashboard as one flat list of entries,
// so the settings page's search box (settings-page.php, F-38) can match a query against names,
// labels and help text and open the right page with the setting highlighted (the pages' ?find=KEY).
//
// One entry per CONCRETE place a setting is edited: a camera's key (its own settings page), a
// detector's key (the CALIBRATE page of the camera it is paired with), a relay or dashboard field
// (the main settings page). A key several cameras hold is one entry per camera, so a hit always
// opens the device it came from and can show that device's value.
//
// Pure data building only — no request, no output. The relay calls that feed build() are made by
// settings-search-index.php, which is also what serves the index as JSON. Unit tested in
// tests/php/test_search_index.php.

require_once __DIR__ . '/Logic.php';

class CamSearchIndex
{
    // The scopes in the order the search page offers them ("All scopes" is the page's own).
    public const SCOPES = ['cameras', 'detectors', 'relay'];

    // The scope's name as it is shown ("Scope / category" path chip).
    public const SCOPE_LABELS = ['cameras' => 'Cameras', 'detectors' => 'Detectors', 'relay' => 'Relay'];

    // ── one device's keys (a camera's, or a detector's — the device schema's own order) ──
    // $keys: the device schema's key rows (device_schema.php). $camera: the dashboard's camera row
    // the page is opened through ('id', 'name', 'icon'); the detector's own id travels as
    // $detectorId only for the state lookup, the URL keeps the camera's. $state: what the relay
    // answered for the device (or null: the keys are still listed, showing their defaults, the
    // same values the settings page shows for a board that has not reported). Secrets are
    // expected already masked (CamLogic::maskStateSecrets, the settings pages' rule).
    public static function deviceEntries(string $scope, array $keys, array $camera, $state, string $type): array
    {
        $reported = is_array($state) && isset($state['reported']['settings']) && is_array($state['reported']['settings'])
            ? $state['reported']['settings']
            : [];
        $name = (string) ($camera['name'] ?? '');
        $device = ['id' => (string) ($camera['id'] ?? ''), 'name' => $name !== '' ? $name : (string) ($camera['id'] ?? ''),
                   'icon' => (string) ($camera['icon'] ?? '')];
        $out = [];
        foreach ($keys as $k) {
            if (!is_array($k) || !isset($k['name']) || !is_string($k['name'])) {
                continue;
            }
            $stored = $reported[$k['name']] ?? null;
            $out[] = [
                'scope' => $scope,
                'key' => $k['name'],
                'label' => (string) ($k['label'] ?? ''),
                'help' => (string) ($k['help'] ?? ''),
                'category' => (string) ($k['category'] ?? ''),
                'tier' => (string) ($k['tier'] ?? ''),
                'apply' => (string) ($k['apply'] ?? ''),
                'locked' => (bool) ($k['locked'] ?? false),
                'deviceId' => $device['id'],
                'deviceName' => $device['name'],
                'deviceIcon' => $device['icon'],
                'value' => self::deviceValue($k, $stored),
                'url' => self::deviceUrl($device['id'], $type, $k['name']),
            ];
        }
        return $out;
    }

    // The value a hit shows: what the board stores, else the default it falls back to (what the
    // settings page would show), else nothing. A boolean reads as on/off wherever it is spoken
    // about in words — the same rule as the settings pages' fmtBool.
    private static function deviceValue(array $key, $stored)
    {
        if ($stored === null && isset($key['default']) && is_string($key['default'])) {
            $stored = $key['default'];
        }
        if ($stored === null) {
            return null;
        }
        $text = is_string($stored) ? $stored : (is_int($stored) || is_float($stored) ? (string) $stored : '');
        if ($text === '') {
            return null;
        }
        return ($key['kind'] ?? '') === 'bool' ? ($text === '1' ? 'on' : ($text === '0' ? 'off' : $text)) : $text;
    }

    public static function deviceUrl(string $camId, string $type, string $key): string
    {
        $url = 'camera-settings-page.php?cam=' . rawurlencode($camId);
        if ($type === 'detector') {
            $url .= '&type=detector';
        }
        return $url . '&find=' . rawurlencode($key);
    }

    // ── the relay's and the dashboard's fields (settings-page.php edits them) ──
    // The fields are the relay's /system-settings rows as CamLogic::visibleRelayFields passes them
    // (values included), plus the dashboard's own (CamLogic::dashboardFields, shaped by
    // dashboardEntries below). A field's `group` is its category; `restart` is the relay's word for
    // what the device schema calls `reboot`. A locked row keeps its flag — the hit opens it where
    // the page shows it read-only.
    public static function relayEntries(array $fields): array
    {
        $out = [];
        foreach ($fields as $f) {
            if (!is_array($f) || !isset($f['key']) || !is_string($f['key'])) {
                continue;
            }
            $out[] = [
                'scope' => 'relay',
                'key' => $f['key'],
                'label' => (string) ($f['label'] ?? ''),
                'help' => (string) ($f['help'] ?? ''),
                'category' => (string) ($f['group'] ?? ''),
                'tier' => (string) ($f['tier'] ?? ''),
                'apply' => !empty($f['restart']) ? 'reboot' : 'live',
                'locked' => (bool) ($f['locked'] ?? false),
                'deviceId' => '',
                'deviceName' => self::SCOPE_LABELS['relay'],
                'deviceIcon' => '',
                'value' => self::relayValue($f),
                'url' => self::relayUrl($f['key']),
            ];
        }
        return $out;
    }

    // A secret never leaves the server: whether it is set, and no more — the same rule the
    // settings pages keep (they show "(set — leave empty to keep)" or "(not set)").
    private static function relayValue(array $f)
    {
        if (($f['type'] ?? '') === 'secret') {
            return !empty($f['isSet']) ? '(set)' : '(not set)';
        }
        $v = $f['value'] ?? null;
        if (is_bool($v)) {
            return $v ? 'true' : 'false';   // the text the relay stores and the page's ON/OFF switch sends
        }
        if (is_array($v)) {
            return implode(' ', $v);
        }
        return is_string($v) || is_int($v) || is_float($v) ? (string) $v : null;
    }

    public static function relayUrl(string $key): string
    {
        return 'settings-page.php?find=' . rawurlencode($key);
    }

    // The dashboard's own settings as search entries, from CamLogic::dashboardFields() — the same
    // rows, with the values read out of config.php the way system-settings.php shows them.
    public static function dashboardEntries(array $config): array
    {
        $out = [];
        foreach (CamLogic::dashboardFields() as $f) {
            if (($f['type'] ?? '') === 'secret') {
                $f['isSet'] = (string) ($config[$f['key']] ?? '') !== '';
                unset($f['value']);
            } else {
                $f['value'] = ($f['type'] ?? '') === 'int'
                    ? (string) CamLogic::intSetting($config, $f['key'])
                    : (string) ($config[$f['key']] ?? '');
            }
            $out = array_merge($out, self::relayEntries([$f]));
        }
        return $out;
    }

    // The whole index. $statesByCamId / $detectorStatesByDetId: what the relay answered per device
    // (absent = the device has not reported). $relayFields: the relay's visible fields, or null when
    // the relay could not be asked ($relayError says why — the search stays useful for the devices;
    // the relay's and the dashboard's own settings are left out, like their page, which needs the
    // relay to show anything).
    public static function build(array $schema, array $cameras, array $statesByCamId, array $detectorStatesByDetId, $relayFields, ?string $relayError, array $config): array
    {
        $entries = [];
        foreach ($cameras as $camera) {
            if (!is_array($camera) || !isset($camera['id']) || !is_string($camera['id']) || $camera['id'] === '') {
                continue;
            }
            $camId = $camera['id'];
            $entries = array_merge($entries, self::deviceEntries('cameras', $schema['recorder']['keys'] ?? [], $camera, $statesByCamId[$camId] ?? null, 'recorder'));
            $detectorId = CamLogic::detectorIdOf($camera);
            if ($detectorId !== null && $detectorId !== '') {
                $entries = array_merge($entries, self::deviceEntries('detectors', $schema['detector']['keys'] ?? [], $camera, $detectorStatesByDetId[$detectorId] ?? null, 'detector'));
            }
        }
        if ($relayFields !== null) {
            $entries = array_merge($entries, self::relayEntries($relayFields), self::dashboardEntries($config));
        }
        return ['scopes' => self::SCOPES, 'entries' => $entries, 'relayError' => $relayError];
    }
}
