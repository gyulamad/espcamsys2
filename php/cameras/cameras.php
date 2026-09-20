<?php
// cameras.php — builds the $cameras array from config.php.
// To add/remove/rename cameras or change the relay address, edit
// config.php (see example.config.php for the template) — not this file.
//
// The actual "attach relay URL to every camera" logic lives in
// lib/Logic.php (CamLogic::attachRelayUrl()) so it can be unit tested
// without a web server — see tests/php/test_logic.php.

require_once __DIR__ . '/lib/Logic.php';

$config = require __DIR__ . '/config.php';

$cameras = CamLogic::attachRelayUrl($config['cameras'], $config['relay_url']);
