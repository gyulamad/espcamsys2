'use strict';

// validation.js — pure request-parameter parsing/validation, extracted out
// of server.js's route handlers so it can be unit tested without an HTTP
// server, Express, or a network connection. Nothing here reads req/res —
// callers pass in the raw query value and get back either a parsed value
// or null.

// Parses a query-string value as a plain integer and checks it falls in
// [min, max] inclusive. Returns null for anything that doesn't parse
// cleanly (missing, non-numeric, out of range) — same rule server.js used
// inline for `seconds` on /record/:id and /record/all.
function parseIntInRange(raw, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

// Matches only the filenames the relay itself generates for recordings —
// also rules out path traversal (no '/', no '..').
const SAFE_FILENAME_RE = /^[A-Za-z0-9_.-]+\.mp4$/;
function isSafeFilename(name) {
  return SAFE_FILENAME_RE.test(name);
}

module.exports = { parseIntInRange, isSafeFilename, SAFE_FILENAME_RE };
