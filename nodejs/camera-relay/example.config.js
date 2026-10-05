// example.config.js — template. Copy this file to config.js and fill in
// your real values. config.js is gitignored, so the key never gets
// committed; this example file is what stays in the repo.
//
//   cp example.config.js config.js

module.exports = {
  port: 8080,       // HTTP: /stream, /snapshot, /status (and legacy /upload)
  pushPort: 8081,   // raw TCP: cameras push frames here continuously (see sketch)
  camKey: 'change-me', // must match API_KEY in each camera's sketch

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
};
