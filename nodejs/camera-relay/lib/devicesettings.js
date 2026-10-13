'use strict';
// Settings the relay keeps ready for boards that are MISSING some.
//
// A board's settings live in its own flash. When a new firmware needs a setting
// the board doesn't have yet, the board can't run (settings have no defaults) —
// and before this existed it waited for someone with a USB cable. Now a board
// whose Wi-Fi / relay settings are fine asks the relay for the missing ones
// (GET /device-settings/<type>/<id>) and the relay answers with a line staged
// here, in the same KEY=value;KEY=value text the serial console takes.
//
// The relay deliberately does NOT understand the settings: it stores and hands
// out one line of text. Splitting it, validating every value and deciding what
// to use is the board's job (settings_logic.h) — so the relay never needs
// updating when a firmware gains a setting, and a staged line can't make a
// board accept something its own firmware would refuse.
//
// Two scopes, both optional:
//   <dir>/<type>/<id>.txt     staged for one device
//   <dir>/<type>/_fleet.txt   staged for every device of that type
// A device's own file wins over the fleet file (first character of an id is a
// letter or digit, so an id can never collide with "_fleet").
//
// Pure functions only (no Express, no files read here except through the
// callbacks of the caller), so everything is unit-tested in
// tests/node/test_devicesettings.js.

const path = require('path');

const TYPES = ['recorder', 'detector'];
const MAX_LINE = 1024; // same limit as the serial console (MAX_LINE_LENGTH in settings_logic.h)
const MAX_NEED_KEYS = 64;

// The same rule the relay applies to camera ids elsewhere.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// Setting names are upper-case letters, digits and underscores (NVS keys are <= 15 characters).
const KEY_PATTERN = /^[A-Z0-9_]{1,32}$/;

function isType(t) {
  return typeof t === 'string' && TYPES.includes(t);
}

function isId(s) {
  return typeof s === 'string' && ID_PATTERN.test(s);
}

// ?need=KEY1,KEY2 — the settings the board is missing. Used only for the log,
// so a bad value is dropped rather than an error: a board must never be refused
// its settings because of a malformed hint.
function parseNeed(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  const keys = [];
  for (const part of raw.split(',')) {
    if (KEY_PATTERN.test(part) && !keys.includes(part) && keys.length < MAX_NEED_KEYS) keys.push(part);
  }
  return keys;
}

// Validates a line an operator wants to stage. Shallow on purpose (see the top
// of the file). An empty body means "remove what is staged".
//   -> { ok: true, line }            line === '' means remove
//   -> { ok: false, error }
function checkStagedLine(text) {
  if (typeof text !== 'string') return { ok: false, error: 'the body must be text (send the KEY=value;... line as the request body)' };
  const line = text.replace(/[\r\n\t ]+$/, '');
  if (line === '') return { ok: true, line: '' };
  if (line.length > MAX_LINE) return { ok: false, error: `the line is too long (${line.length} characters, the limit is ${MAX_LINE})` };
  // Control characters (a newline in the middle included) never belong in one settings line.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(line)) return { ok: false, error: 'the line must be a single line of plain text (no control characters)' };
  if (!line.includes('=')) return { ok: false, error: 'the line is not KEY=value;KEY=value;...' };
  return { ok: true, line };
}

// The setting NAMES in a staged line, for the log. Values are never logged:
// they can be Wi-Fi passwords and API keys. Honors the backslash escapes the
// boards use (\; \: \\), so an escaped ';' inside a value doesn't start a new name.
function keyNames(line) {
  const names = [];
  let piece = '';
  const flush = () => {
    const eq = piece.indexOf('=');
    if (eq > 0) {
      const name = piece.slice(0, eq).trim().toUpperCase();
      if (KEY_PATTERN.test(name)) names.push(name);
    }
    piece = '';
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\') { piece += c + (line[i + 1] || ''); i += 1; continue; }
    if (c === ';') { flush(); continue; }
    piece += c;
  }
  flush();
  return names;
}

// The file for one scope. id === null is the fleet file of that type. Callers
// validate type and id first (isType / isId), which is what makes the result
// safe to open.
function fileFor(dir, type, id) {
  return path.join(dir, type, id === null ? '_fleet.txt' : `${id}.txt`);
}

// Which staged line a device gets: its own, else the fleet's.
//   -> { line, source: 'device' | 'fleet' } or null when nothing is staged
function pickStaged(deviceLine, fleetLine) {
  if (typeof deviceLine === 'string' && deviceLine !== '') return { line: deviceLine, source: 'device' };
  if (typeof fleetLine === 'string' && fleetLine !== '') return { line: fleetLine, source: 'fleet' };
  return null;
}

// A board in this state asks every few seconds, and reboots and asks again, so
// "it asked" would flood the log. This lets a line through when what happened
// changed (a new outcome, or a different set of missing settings) or when it
// has been quiet for a while — a stuck board stays visible without filling the file.
class FetchLogGate {
  constructor(quietMs) {
    this.quietMs = quietMs;
    this.last = new Map(); // id -> { signature, at }
  }

  check(id, signature, nowMs) {
    const prev = this.last.get(id);
    if (prev && prev.signature === signature && nowMs - prev.at < this.quietMs) return false;
    this.last.set(id, { signature, at: nowMs });
    // Bounded: a relay that sees many ids must not grow without limit.
    if (this.last.size > 1000) this.last.delete(this.last.keys().next().value);
    return true;
  }
}

module.exports = { TYPES, MAX_LINE, isType, isId, parseNeed, checkStagedLine, keyNames, fileFor, pickStaged, FetchLogGate };
