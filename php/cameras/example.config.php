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
    // The dashboard REFUSES to start (HTTP 503) while either is empty, still "change-me",
    // or the password is shorter than 8 characters:  openssl rand -base64 24
    'auth_user' => 'change-me',
    'auth_pass' => 'change-me',

    // Base URL of the server.js relay that all cameras push frames to.
    'relay_url' => 'http://192.168.4.9:8080',

    // Needed for the dashboard's recording ON/OFF buttons. Must be EXACTLY the same
    // as `controlKey` in the relay's config.js. Use a long random value that is not
    // the cameras' key:  openssl rand -hex 24
    // (This server adds it when it passes your click on to the relay; the browser never
    // sees it. Left empty, the buttons are disabled.)
    'relay_control_key' => '',

    // Recording buttons on the dashboard (both also editable on the SETTINGS page).
    // Length of a manual recording (RECORD / RECORD ALL), in seconds.
    'record_seconds' => 60,
    // How long the recording OFF buttons keep recording off, in minutes (0 or -1 = until switched ON).
    'switch_off_minutes' => 60,

    // Cameras shown on the dashboard. 'id' must exactly match the
    // CAMERA_ID configured in that device's sketch (its CAMERA_ID setting).
    // Optional 'detector' => '<DETECTOR_ID>' pairs the camera with the person detector board wired to
    // its alarm input: the dashboard then shows that detector's 96x96 picture and its brightness /
    // motion / person values, thresholds and alarm pin level under the camera's picture. (Also
    // settable on the camera's SETTINGS page.) One detector per camera.
    'cameras' => [
        ['id' => 'cam1', 'name' => 'Front Door', 'icon' => '🚪', 'detector' => 'detector-1'],
        ['id' => 'cam2', 'name' => 'Back Yard',  'icon' => '🌿'],
        ['id' => 'cam3', 'name' => 'Garage',     'icon' => '🏠'],
        ['id' => 'cam4', 'name' => 'Hallway',    'icon' => '💡'],
    ],
];
