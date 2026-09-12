<?php
// cameras.php — Edit this file to add/remove/rename ESP32-CAM streams
// Place this file in the same directory as index.php on your Pi

$cameras = [
    [
        'id'    => 'cam1',
        'name'  => 'Front Door',
        'url'   => 'http://192.168.1.101',   // ← change to your ESP32-CAM IP
        'icon'  => '🚪',
    ],
    [
        'id'    => 'cam2',
        'name'  => 'Back Yard',
        'url'   => 'http://192.168.1.102',
        'icon'  => '🌿',
    ],
    [
        'id'    => 'cam3',
        'name'  => 'Garage',
        'url'   => 'http://192.168.1.103',
        'icon'  => '🏠',
    ],
    [
        'id'    => 'cam4',
        'name'  => 'Hallway',
        'url'   => 'http://192.168.1.104',
        'icon'  => '💡',
    ],
];
