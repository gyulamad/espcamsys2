'use strict';

// auth.js — checking the shared secret (camKey) that cameras present.
// Pure apart from `crypto`; no Express, no fs.

const crypto = require('crypto');

// Compares a presented secret with the expected one in CONSTANT time, so how
// long the comparison takes can't be used to guess the key a character at a
// time. Both sides are hashed first so their lengths never matter (a plain
// timingSafeEqual throws on different lengths, and checking the length first
// would itself leak it).
//
// An empty expected secret ("camKey: ''" left blank in config.js) never
// matches anything: an unset key must not turn into "no password needed".
function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Where a request carries the key: the X-Api-Key header (preferred — it
// doesn't end up in URLs or access logs), or ?key= (the same convention the
// legacy /upload route uses; handy with curl). Returns '' if absent.
function extractKey(req) {
  const header = req.headers && req.headers['x-api-key'];
  if (typeof header === 'string' && header !== '') return header;
  const q = req.query && req.query.key;
  return typeof q === 'string' ? q : '';
}

module.exports = { safeEqual, extractKey };
