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

// (review NODE-011) JPEG magic bytes: every JPEG file starts with FF D8 FF.
// POST /upload accepts any body up to 2MB and stores it as the camera's "frame",
// which is later served back to viewers with Content-Type: image/jpeg. A
// compromised camera (or anyone with the camKey) could push a non-JPEG body —
// HTML with script, SVG with embedded JS — that a non-browser client or an
// older browser that MIME-sniffs may render. Reject anything that does not
// start with the JPEG magic.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf.subarray(0, 3).equals(JPEG_MAGIC);
}

module.exports = { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic, isJpeg };
