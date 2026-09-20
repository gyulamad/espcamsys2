'use strict';

// validation.js — pure request-parameter parsing/validation, extracted out
// of server.js's route handlers so it can be unit tested without an HTTP
// server, Express, or a network connection. Nothing here reads req/res —
// callers pass in the raw query value and get back either a parsed value
// or null.

// Parses a query-string value as a plain integer and checks it falls in
// [min, max] inclusive. Returns null for anything that doesn't parse
// cleanly (missing, non-numeric, out of range) — same rule server.js used
// inline for `seconds` on /record/:id, /record/all and /control/:id.
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

// Interprets the ?enabled= query param used by /control/:id. Must be
// exactly the string '0' or '1'; anything else is invalid.
function parseEnabledFlag(raw) {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

module.exports = { parseIntInRange, isSafeFilename, parseEnabledFlag, SAFE_FILENAME_RE };
