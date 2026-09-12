<?php
// cameras.php — builds the $cameras array from config.php.
// To add/remove/rename cameras or change the relay address, edit
// config.php (see example.config.php for the template) — not this file.

$config = require __DIR__ . '/config.php';

$relayUrl = rtrim($config['relay_url'], '/');

// Every camera streams via the server.js relay at {relay_url}/stream/{id}
$cameras = array_map(function ($cam) use ($relayUrl) {
    $cam['url'] = $relayUrl;
    return $cam;
}, $config['cameras']);
