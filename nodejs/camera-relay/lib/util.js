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

// The pixel size of a JPEG, read from its start-of-frame (SOF) marker, or null
// when the buffer is not a JPEG a size can be read from. Pure buffer parsing:
// no files, no dependencies. Needed because a camera walks its frame-size
// ladder while its link is slow, so the frames of one recording are not all
// the same size any more — the encoder scales them back to the clip's first
// size (see video.js) and needs to know the sizes to tell.
//
// Walks the marker segments ([FF][marker][length u16 BE][payload]) until the
// first start-of-frame marker, whose payload starts with
// [precision u8][height u16 BE][width u16 BE]. Segment markers without a
// payload (restart markers, RSTn) and the standalones are skipped; hitting the
// scan data (SOS) or the end (EOI) before any SOF means no size is carried —
// and so does anything malformed: a wrong-looking buffer yields null, never a
// guess, because a guessed size would silently mis-scale a recording.
function jpegDimensions(buf) {
  if (!isJpeg(buf)) return null;
  let i = 2; // past the SOI marker; isJpeg() guarantees the FF at i
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null; // a marker must start here — not a well-formed JPEG
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no payload
    if (marker === 0xd9 || marker === 0xda) return null; // image data or end before any size was seen
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null; // segment must fit in the buffer
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc; // C4/C8/CC are DHT/JPG/DAC, not sizes
    if (isStartOfFrame) {
      if (len < 8) return null; // precision + height + width + at least one component
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

module.exports = { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic, isJpeg, jpegDimensions };
