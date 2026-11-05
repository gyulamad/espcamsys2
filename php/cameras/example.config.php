<?php
// example.config.php — template. Copy this file to config.php and fill in
// your real values. config.php is gitignored, so your secrets never get
// committed; this example file is what stays in the repo.
//
// After `sudo ./deploy.sh` the web server can only READ config.php. Whatever you change on the
// dashboard's settings pages is saved in data/settings.json (in the same folder, never served) and
// takes precedence over the value written here; to change such a value by hand, change it on the
// dashboard, or delete it from data/settings.json.
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

    // Base URL of the server.js relay that all cameras push frames to. The dashboard runs on the same
    // Pi, so 127.0.0.1 keeps working when the router gives the Pi another address.
    'relay_url' => 'http://127.0.0.1:8080',

    // Needed for the dashboard's recording ON/OFF buttons. Must be EXACTLY the same
    // as `controlKey` in the relay's config.js. Use a long random value that is not
    // the cameras' key:  openssl rand -hex 24
    // (This server adds it when it passes your click on to the relay; the browser never
    // sees it. Left empty, the buttons are disabled.)
    'relay_control_key' => '',
    // The command the reset menu uses to restart the web server / reboot the Pi (installed by `sudo ./deploy.sh`).
    // Only needed if you installed the helper somewhere else; the action is added as the last argument.
    // 'power_command' => ['sudo', '-n', '/usr/local/sbin/camdash-power'],

    // Recording buttons on the dashboard (both also editable on the SETTINGS page).
    // Length of a manual recording (RECORD / RECORD ALL), in seconds.
    'record_seconds' => 60,
    // How long the recording OFF buttons keep recording off, in minutes (0 or -1 = until switched ON).
    'switch_off_minutes' => 60,
    // How long the SLIDESHOW on the simple view page (simple-view.php) shows one camera, in seconds (2-300).
    // A camera that starts recording, or whose person detector sees motion, is shown at once.
    'slideshow_seconds' => 10,

    // Show every camera's live picture through ONE connection (mux.php) instead of one connection per camera
    // (stream.php). A browser allows only about 6 connections per address over HTTP/1.1, and a connection per camera
    // used up all of them: the file list, a clip or the other requests of the page then waited for ever. The relay
    // (server.js) must be the version that has GET /mux. If it cannot be used from the browser, the dashboard
    // goes back to one connection per camera by itself. On unless this says false; false = one connection per
    // camera, as before. The same connection also carries the detectors' pictures and numbers and the cameras'
    // recording state (the REC pills, FILES counts and switches), which are otherwise fetched on their own.
    'mux_enabled' => true,

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
