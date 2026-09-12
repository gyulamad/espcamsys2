<?php
// example.config.php — template. Copy this file to config.php and fill in
// your real values. config.php is gitignored, so your secrets never get
// committed; this example file is what stays in the repo.
//
//   cp example.config.php config.php

return [
    // HTTP Basic Auth credentials gating the Tor-facing dashboard.
    // Pick a long random password — this is the only thing standing
    // between "anyone with the .onion address" and your cameras.
    'auth_user' => 'change-me',
    'auth_pass' => 'change-me',

    // Base URL of the server.js relay that all cameras push frames to.
    'relay_url' => 'http://192.168.4.9:8080',

    // Cameras shown on the dashboard. 'id' must exactly match the
    // CAMERA_ID configured in that device's sketch (see example.config.h).
    'cameras' => [
        ['id' => 'cam1', 'name' => 'Front Door', 'icon' => '🚪'],
        ['id' => 'cam2', 'name' => 'Back Yard',  'icon' => '🌿'],
        ['id' => 'cam3', 'name' => 'Garage',     'icon' => '🏠'],
        ['id' => 'cam4', 'name' => 'Hallway',    'icon' => '💡'],
    ],
];
