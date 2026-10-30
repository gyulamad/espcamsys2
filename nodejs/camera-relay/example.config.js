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
  // switchFile: 'recording-switch.json',  // where the state is kept so it survives a restart (default shown)
};
