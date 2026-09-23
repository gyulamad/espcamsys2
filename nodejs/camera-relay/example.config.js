// example.config.js — template. Copy this file to config.js and fill in
// your real values. config.js is gitignored, so the key never gets
// committed; this example file is what stays in the repo.
//
//   cp example.config.js config.js

module.exports = {
  port: 8080,       // HTTP: /stream, /snapshot, /status (and legacy /upload)
  pushPort: 8081,   // raw TCP: cameras push frames here continuously (see sketch)
  camKey: 'change-me', // must match API_KEY in each camera's sketch

  // AI Human Detection Alarm feature (plans/AI_ALARM_IMPLEMENTATION_PLAN.md).
  // Initial ai_enabled state for a camera the dashboard hasn't toggled yet
  // since this relay process last started (toggle it per-camera at
  // /ai-alarm/:id, proxied by the dashboard's ai-alarm.php). Optional —
  // defaults to `true` in server.js if omitted, so existing config.js files
  // don't need this key added just to keep running.
  aiAlarmEnabledDefault: true,
};
