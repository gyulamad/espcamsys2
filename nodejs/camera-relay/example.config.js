// example.config.js — template. Copy this file to config.js and fill in
// your real values. config.js is gitignored, so the key never gets
// committed; this example file is what stays in the repo.
//
//   cp example.config.js config.js

module.exports = {
  port: 8080,       // HTTP: /stream, /snapshot, /status (and legacy /upload)
  pushPort: 8081,   // raw TCP: cameras push frames here continuously (see sketch)
  camKey: 'change-me', // must match API_KEY in each camera's sketch

  // Discovery: when the router gives the Pi a new address, the cameras find it again by themselves
  // (they ask over UDP, and this answers; the answer proves the relay knows camKey without sending it).
  // The port must equal RELAY_FIND_PORT in the firmware (default 8082). 0 switches it off. Optional.
  // The Pi's firewall must let UDP in on it — see "Cameras find the relay by themselves" in INSTALL.md.
  // discoveryPort: 8082,

  // Pre-roll ("black box"): the relay always keeps the last N seconds of every
  // camera in RAM, and every recording — alarm, person detector, or the
  // dashboard's RECORD button — starts with that footage, so the clip begins
  // BEFORE the trigger even if the trigger was slow to arrive. 0 disables it.
  preRollSeconds: 5,                 // 0–60, default 5
  // preRollMaxBytes: 8 * 1024 * 1024, // optional RAM cap per camera (default 8 MiB); the
  //                                   // buffer drops its oldest frames first if it's hit

  // Low-storage warning: when the free space on the disk holding the recordings drops below this many
  // MB, every dashboard page shows an alert asking the user to delete old recordings. 0 = no warning.
  // Also editable on the dashboard's SETTINGS page (applies at once).
  // minFreeStorageMB: 1024,            // 0–1048576, default 1024

  // Log file: what the cameras report (instead of printing to a serial port nobody can
  // see) plus what the relay observes — cameras connecting/dropping, recordings, errors
  // with stack traces. Plain text, `tail -f` friendly. All optional:
  // logFile: 'logs/camera.log',     // default; a relative path is relative to this folder
  // logMaxBytes: 5 * 1024 * 1024,   // rotate when the file would pass this size (default 5 MiB)
  // logKeepFiles: 2,                // rotated files kept: camera.log.1, camera.log.2 (default 2)
  //                                 // => at most (keep + 1) * maxBytes of disk, ever

  // Settings staged for boards that are missing one (see "Missing settings after a
  // firmware update" in INSTALL.md). A relative path is relative to this folder; optional.
  // Staging them needs controlKey above.
  // deviceSettingsDir: 'device-settings',   // default

  // Firmware for the boards (over-the-air update, see "Over-the-air updates" in INSTALL.md).
  // ota-deploy.sh publishes the compiled sketches here with the controlKey below; the boards
  // poll for them with the camera key. A relative path is relative to this folder; optional.
  // firmwareDir: 'firmware',   // default

  // Recording ON/OFF switch (dashboard buttons: switch recording OFF per camera, or for every
  // camera at once, for N minutes or until switched back ON — e.g. while people are on site).
  // Changing it needs this key, sent by the dashboard's server as an X-Control-Key header.
  // Use a DIFFERENT key from camKey: camKey is flashed into every camera board, so anyone who
  // got hold of a board could otherwise switch your whole system off. Without a controlKey the
  // switch is simply refused. Generate one with:  openssl rand -hex 24
  controlKey: '',

  // Sorting out footage without a person (see "Sorting out footage without a person" in INSTALL.md).
  // A YOLO ONNX model checks each recording frame by frame on the Pi, stops at the first person (that frame
  // becomes the clip's thumbnail) and files a clip that shows nobody under <camera>/no-person/ or deletes it.
  // A clip is NEVER removed unless the whole clip was read and no person found; any failure keeps it.
  // personScan: {
  //   enabled: false,            // switch on after installing the model (INSTALL.md)
  //   auto: true,                // check every recording right after it is saved
  //   action: 'move',            // 'move' (safe) or 'delete' a clip with nobody in it
  //   model: 'models/person.onnx', // relative to this folder
  //   script: 'tools/person_scan.py', // the detector, shipped with the relay
  //   python: 'python3',
  //   confidence: 0.4,           // 0 < c <= 1; lower keeps more doubtful clips
  //   stride: 1,                 // analyse every Nth frame (raise to go faster on a slow Pi)
  //   timeoutSeconds: 900,
  // },

  // How long (minutes) a person detector keeps streaming its sensor values and small picture after somebody
  // pressed WATCH on the dashboard (and again after every ask while they keep watching). It rests the rest of
  // the time. Whole number 1-1440; the board counts the time itself. Also: DETECTOR_VIEW_MINUTES.
  // detectorViewMinutes: 10,   // default
  // switchFile: 'recording-switch.json',  // where the state is kept so it survives a restart (default shown)

  // Notifications (see lib/notify/README.md): the relay can message you — a text and, where there is one, a
  // thumbnail. Each channel is optional; configure one or more. Secrets can live in the environment instead
  // (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), which wins over this file. Check a setup with:
  //   curl -X POST -H "X-Control-Key: <controlKey>" http://localhost:8080/notifications/test
  // notifications: {
  //   telegram: {
  //     botToken: '123456789:AA...',   // from @BotFather
  //     chatId: '123456789',           // your chat (a group's is negative), or '@channelname'
  //   },
  //   // A person found in a NEW recording (needs personScan above) is announced with its thumbnail:
  //   footageBaseUrl: 'http://raspberrypi.local/camdash',  // the dashboard as your phone reaches it; the message
  //                                                        // links to the clip there (omit: no link)
  //   cooldownSeconds: 60,           // at most one message per camera in this time (0 = every detection)
  // },
};
