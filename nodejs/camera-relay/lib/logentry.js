'use strict';

// logentry.js — validating and cleaning what a camera POSTs to /log.
//
// Everything arriving here comes from a device on the network, so nothing in
// it is trusted: types are checked, text is cleaned of control characters and
// length-capped, numbers are range-limited. Cleaning matters for more than
// tidiness — a message containing a newline must never be able to fake a
// second log line (see logfile.js, which also guards this independently).
//
// Pure: no fs, no Express, no clock.

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const LIMITS = {
  entriesPerBatch: 50,
  message: 2000,
  trace: 8000,
  fw: 80,
  maxAgeMs: 30 * 24 * 3600 * 1000, // an entry older than 30 days is nonsense (a clock/wrap bug), treat age as unknown
};
const CAMERA_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Normalises line endings, drops control characters other than newline and
// tab, and caps the length (marking the cut). Non-strings become ''.
function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + '...';
  return s;
}

function normalizeLevel(value) {
  const up = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (up === 'WARNING') return 'WARN';
  return LEVELS.includes(up) ? up : 'INFO';
}

// A non-negative whole number no larger than `max`, else null ("not provided").
function toCount(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}
// A whole number (may be negative — RSSI is), within ±1e9, else null.
function toInt(value) {
  return Number.isInteger(value) && Math.abs(value) <= 1e9 ? value : null;
}

// Parses the JSON body of POST /log.
//   { camera, fw?, attempt?, dropped?, entries: [ { seq?, level, ageMs?, uptimeMs?, heap?, rssi?, message, trace? } ] }
// Returns { ok: true, batch, rejected } — `rejected` counts entries that were
// unusable and skipped — or { ok: false, error } when nothing usable is there.
function parseLogBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  if (typeof body.camera !== 'string' || !CAMERA_ID_RE.test(body.camera)) {
    return { ok: false, error: 'camera must be 1-64 characters of A-Z a-z 0-9 _ . -' };
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0) return { ok: false, error: 'entries must be a non-empty array' };
  if (body.entries.length > LIMITS.entriesPerBatch) return { ok: false, error: `at most ${LIMITS.entriesPerBatch} entries per request` };

  const entries = [];
  let rejected = 0;
  for (const raw of body.entries) {
    const message = raw && typeof raw === 'object' ? cleanText(raw.message, LIMITS.message) : '';
    if (message === '') { rejected += 1; continue; }
    const age = toCount(raw.ageMs, LIMITS.maxAgeMs);
    entries.push({
      seq: toCount(raw.seq),
      level: normalizeLevel(raw.level),
      ageMs: age === null ? 0 : age,
      uptimeMs: toCount(raw.uptimeMs),
      heap: toInt(raw.heap),
      rssi: toInt(raw.rssi),
      message,
      trace: cleanText(raw.trace, LIMITS.trace),
    });
  }
  if (entries.length === 0) return { ok: false, error: 'no usable entries (each needs a non-empty message)' };

  return {
    ok: true,
    rejected,
    batch: {
      camera: body.camera,
      fw: cleanText(body.fw, LIMITS.fw).replace(/\n/g, ' '),
      attempt: toCount(body.attempt, 1000) || 0,
      dropped: toCount(body.dropped) || 0,
      entries,
    },
  };
}

module.exports = { LEVELS, LIMITS, CAMERA_ID_RE, cleanText, normalizeLevel, parseLogBatch };
