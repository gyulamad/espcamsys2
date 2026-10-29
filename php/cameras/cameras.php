<?php
// cameras.php — builds the $cameras array from config.php.
// To add/remove/rename cameras or change the relay address, edit
// config.php (see example.config.php for the template) — not this file.
//
// The actual "attach relay URL to every camera" logic lives in
// lib/Logic.php (CamLogic::attachRelayUrl()) so it can be unit tested
// without a web server — see tests/php/test_logic.php.

require_once __DIR__ . '/lib/Logic.php';

require_once __DIR__ . '/config_file.php';
$config = camdash_load_config(__DIR__);   // config.php with the settings saved on the dashboard (data/settings.json) on top

$validCameras = CamLogic::onlyValidCameras($config['cameras'], $skippedCameras);
foreach ($skippedCameras as $skippedId) {
    error_log('camdash: camera "' . $skippedId . '" in config.php is ignored: an id may only contain letters, digits, _ . - (start with a letter or digit, at most 64 characters)');
}
$cameras = CamLogic::attachRelayUrl($validCameras, $config['relay_url']);
