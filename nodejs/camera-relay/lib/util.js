'use strict';

// util.js — small helpers the relay needs in several places, kept here so each
// rule exists once.

const fs = require('fs');

// An environment variable if it is set (even to ''), otherwise the config.js
// value. The relay lets PORT, CAM_KEY, LOG_FILE, ... override config.js this way.
function envOr(env, name, fallback) {
  return env[name] !== undefined ? env[name] : fallback;
}

// The text of a thrown value: its .message for an Error, the value itself for
// anything else (something that threw a string, say).
function errorMessage(err) {
  return err && err.message ? err.message : err;
}

// The stack trace of a thrown value, or its string form when it has none.
function errorTrace(err) {
  return err && err.stack ? err.stack : String(err);
}

// The console method a log level is echoed with: errors and warnings go to
// stderr (so journalctl / pm2 file them as such), everything else to stdout.
function consoleMethodFor(level) {
  if (level === 'ERROR') return 'error';
  if (level === 'WARN') return 'warn';
  return 'log';
}

// Writes via a temp file and a rename, so a crash or power loss halfway through
// can never leave a half-written file behind — the reader sees the old content
// or the new, never a mix.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic };
