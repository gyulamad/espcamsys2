'use strict';

// sounds.js — the alarm sound library, as pure rules: which names a sound file may have, which formats it
// may be in, and what makes an uploaded file acceptable. No fs, no Express: lib/soundstore.js does the disk and
// server.js the HTTP, so all of this is unit tested with plain `node` (tests/node/test_sounds.js).
//
// A sound is only ever played by name, and the name is the file's name inside ONE folder (the relay's sounds
// folder). So the rules here are what keeps a name from reaching anywhere else: one plain path segment, no dot
// at the start, no "..", no separators. The same rule is applied again where a name becomes a path
// (soundstore.pathOf) and in the dashboard (php/cameras/lib/Sounds.php), which must agree with this file.

// A little under Apache's 2 MiB request cap (apache/camdash-protect.conf), because an upload goes through the
// dashboard's PHP first: a file the relay would take must also fit through the web server. 1 MiB is about six
// seconds of 44.1 kHz stereo WAV — and an alarm sound is short; an MP3 or OGG of the same length is far smaller.
const MAX_SOUND_BYTES = 1024 * 1024;
const MIN_SOUND_BYTES = 44;          // a WAV header alone is 44 bytes: anything shorter is not a sound
const MAX_SOUNDS = 20;               // 20 x 1 MiB at most on the Pi's disk
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const ascii = (buf, from, to) => buf.toString('latin1', from, to);

// What each extension stands for: the Content-Type a browser is told, and whether the bytes really look like that
// format. The check is on the file's first bytes only (a decodable file is the player's business): it is there so
// that a renamed HTML page or executable is refused, and so a .wav is not secretly an .mp3.
const FORMATS = {
  '.wav': { contentType: 'audio/wav', matches: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  '.mp3': { contentType: 'audio/mpeg', matches: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  '.ogg': { contentType: 'audio/ogg', matches: (b) => ascii(b, 0, 4) === 'OggS' },
};

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

// Is this the name of a sound the library may hold?  (Whether such a file EXISTS is another question.)
function isSoundName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return false;
  if (name.includes('..')) return false;
  return Object.prototype.hasOwnProperty.call(FORMATS, extensionOf(name));
}

// The Content-Type a sound is served with, or null for a name that is not a sound's.
function contentTypeOf(name) {
  return isSoundName(name) ? FORMATS[extensionOf(name)].contentType : null;
}

// May `buf` be stored as the sound `name`?  -> { ok: true } | { ok: false, error }
function checkSound(name, buf) {
  if (!isSoundName(name)) {
    return { ok: false, error: `the name must be 1-64 characters from A-Z a-z 0-9 . _ - (starting with a letter or digit) and end in ${Object.keys(FORMATS).join(', ')}` };
  }
  if (!Buffer.isBuffer(buf)) return { ok: false, error: 'the body must be the raw sound file' };
  if (buf.length < MIN_SOUND_BYTES) return { ok: false, error: `the file is too small (${buf.length} bytes) to be a sound` };
  if (buf.length > MAX_SOUND_BYTES) return { ok: false, error: `the file is too large (${buf.length} bytes, at most ${MAX_SOUND_BYTES})` };
  if (!FORMATS[extensionOf(name)].matches(buf)) return { ok: false, error: `this is not a ${extensionOf(name).slice(1).toUpperCase()} file (its first bytes say otherwise)` };
  return { ok: true };
}

// The files found in the sounds folder -> the library: only names a sound may have (so a stray file, a
// half-written upload ".tmp" or a dot-file is never offered), sorted by name.   [{ name, bytes }]
function describeSounds(entries) {
  return entries
    .filter((e) => e && isSoundName(e.name) && Number.isInteger(e.bytes) && e.bytes >= 0)
    .map((e) => ({ name: e.name, bytes: e.bytes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  MAX_SOUND_BYTES, MIN_SOUND_BYTES, MAX_SOUNDS, NAME_PATTERN, FORMATS,
  isSoundName, contentTypeOf, checkSound, describeSounds,
};
