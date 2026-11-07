'use strict';

// keypolicy.js — pure helper that decides whether a shared secret (camKey or
// controlKey) is safe to use at runtime. (review NODE-001)
//
// The relay binds to the LAN, so a copied example.config.js that ships
// `camKey: 'change-me'` would otherwise expose every camera-keyed route to
// anyone who has seen the public repository. This module is the single place
// that decides what "weak" means, so the rules can be unit-tested and shared
// by the relay (startup) and the system-settings endpoint (apply-time).

// Template / placeholder values that appear in committed examples and must
// never reach a live deployment.
const WEAK_KEY_VALUES = new Set([
  '',
  'change-me',
  'changeme',
  'test',
  'secret',
  'password',
  'changeme123456', // a real mistake observed in the wild
]);

// Prefixes that mark a value as "still the template the operator forgot to
// replace". `change-` is the one used in example.config.js; the others cover
// the usual paraphrases. Each ends in `-` (or `:` for non-alpha markers) so
// a strong key that happens to start with the same letters is not flagged.
const WEAK_KEY_PREFIXES = ['change-', 'changeme-', 'replace-', 'todo-', 'xxx-'];

// 12 chars is the floor recommended by NIST SP 800-63B §5.1.1.2 for a
// human-typed secret; we expect operators to use `openssl rand -hex 24` (48
// chars) but 12 is the loud-failure threshold.
const MIN_KEY_LENGTH = 12;

// Returns null when the value is acceptable, or a short human-readable string
// explaining the problem otherwise. Empty string is treated as "unset", which
// is the caller's concern (the relay separately logs whether a key is set).
function keyStrengthProblem(name, value) {
  if (typeof value !== 'string') return `${name} is not a string`;
  if (value === '') return `${name} is empty`;
  const lower = value.toLowerCase();
  if (WEAK_KEY_VALUES.has(lower)) return `${name} is a known template or weak value`;
  for (const p of WEAK_KEY_PREFIXES) {
    if (lower.startsWith(p)) return `${name} starts with the template prefix '${p.slice(0, -1)}'`;
  }
  if (value.length < MIN_KEY_LENGTH) return `${name} is too short (${value.length} chars, at least ${MIN_KEY_LENGTH} recommended)`;
  return null;
}

// True when the two keys are equal AND both non-empty. Used by the
// system-settings endpoint to refuse saving a controlKey that matches the
// camera key (because the camera key is flashed into every board, so equality
// hands the dashboard's full power to anyone holding a single physical board).
function keysAreEqualAndNonEmpty(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === '' || b === '') return false;
  return a === b;
}

module.exports = { WEAK_KEY_VALUES, WEAK_KEY_PREFIXES, MIN_KEY_LENGTH, keyStrengthProblem, keysAreEqualAndNonEmpty };
