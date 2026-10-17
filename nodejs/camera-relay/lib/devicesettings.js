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


// ── Changes queued from the dashboard, and what the board says it holds ──
//
// The dashboard's settings page can change settings that are ALREADY stored in a board's
// flash (the staging above only fills gaps). The relay still does not understand the
// settings: it keeps, per device, one small state document —
//   pending   the line queued for the board (one at a time; a new one replaces it) + a number
//   reported  what the board last said it holds (secrets arrive already masked)
//   last      how the board's last attempt ended: applied / rejected, and why
// The board asks for `pending` (GET .../change), applies it with its own checks, and tells
// the relay the outcome with its current settings (POST .../report). A change that was
// answered (applied or rejected) is cleared, so the board is not offered it again.
//
// State lives in <dir>/<type>/state/<id>.json. Pure functions only — the caller reads and
// writes the file. Tested in tests/node/test_devicesettings.js.

const MAX_REPORT_LINE = 4096;
const MAX_MESSAGE = 500;
const RESULTS = ['boot', 'applied', 'rejected'];

function stateFile(dir, type, id) {
  return path.join(dir, type, 'state', `${id}.json`);
}

function emptyState() {
  return { pending: null, reported: null, last: null, lastRev: 0 };
}

// The state document from its file text; anything damaged is an empty state, never an error
// (a board must not be locked out of the relay by a broken file).
function parseState(text) {
  const st = emptyState();
  if (typeof text !== 'string' || text.trim() === '') return st;
  let o;
  try { o = JSON.parse(text); } catch (e) { return st; }
  if (!o || typeof o !== 'object') return st;
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  if (o.pending && typeof o.pending === 'object' && /^\d{1,16}$/.test(String(o.pending.rev)) && str(o.pending.line, MAX_LINE) && num(o.pending.at) !== null) {
    st.pending = { rev: String(o.pending.rev), line: o.pending.line, at: o.pending.at, by: str(o.pending.by, 100) || '' };
  }
  if (o.reported && typeof o.reported === 'object' && str(o.reported.line, MAX_REPORT_LINE) !== null && num(o.reported.at) !== null) {
    st.reported = { line: o.reported.line, at: o.reported.at };
  }
  if (o.last && typeof o.last === 'object' && RESULTS.includes(o.last.result) && num(o.last.at) !== null) {
    st.last = { rev: String(o.last.rev || ''), result: o.last.result, message: str(o.last.message, MAX_MESSAGE) || '', at: o.last.at };
  }
  st.lastRev = num(o.lastRev) || (st.pending ? Number(st.pending.rev) : 0);
  return st;
}

// "KEY=value;KEY=value" -> { KEY: value } with the backslash escapes undone (\; \: \\).
// First occurrence of a name wins; names that are not setting names are skipped.
function parseSettingsLine(line) {
  const out = {};
  if (typeof line !== 'string') return out;
  const pieces = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i += 1; continue; }
    if (c === ';') { pieces.push(cur); cur = ''; continue; }
    cur += c;
  }
  pieces.push(cur);
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim().toUpperCase();
    if (!KEY_PATTERN.test(key) || Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = piece.slice(eq + 1).replace(/\\(.)/g, '$1');
  }
  return out;
}

// The body a board POSTs: "<number>\n<result>\n<message>\n<KEY=value;...>".
//   -> { ok: true, rev, result, message, line } | { ok: false, error }
function parseReportBody(text) {
  if (typeof text !== 'string') return { ok: false, error: 'the body must be text' };
  const parts = [];
  let rest = text;
  for (let i = 0; i < 3; i += 1) {
    const nl = rest.indexOf('\n');
    if (nl < 0) return { ok: false, error: 'expected: number, result, message, then the settings line, each on its own line' };
    parts.push(rest.slice(0, nl));
    rest = rest.slice(nl + 1);
  }
  const [rev, result, message] = parts;
  const line = rest.replace(/[\r\n]+$/, '');
  if (!/^\d{1,16}$/.test(rev)) return { ok: false, error: 'the first line must be the change number (digits)' };
  if (!RESULTS.includes(result)) return { ok: false, error: `the result must be one of ${RESULTS.join(', ')}` };
  if (message.length > MAX_MESSAGE) return { ok: false, error: 'the message is too long' };
  if (line.length > MAX_REPORT_LINE) return { ok: false, error: 'the settings line is too long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(message + line)) return { ok: false, error: 'control characters are not allowed' };
  return { ok: true, rev, result, message, line };
}

// A change number that is always larger than the last one given out, and readable as a time.
function nextRev(prevRev, nowMs) {
  return String(Math.max(Number(nowMs), Number(prevRev) + 1));
}

// Queues a change for the board (replacing one still waiting); an empty line cancels.
//   -> { state, rev } — `state` is a new object
function queueChange(state, line, nowMs, by) {
  if (line === '') return { state: { ...state, pending: null }, rev: null };
  const rev = nextRev(state.lastRev, nowMs);
  return { state: { ...state, lastRev: Number(rev), pending: { rev, line, at: nowMs, by: by || '' } }, rev };
}

// What the board said. A boot report only refreshes `reported`; an applied/rejected one is also the
// answer to change `rev` — which clears it when it is the change still waiting (an answer to an
// older, replaced change must not cancel the newer one).
function applyReport(state, rep, nowMs) {
  const next = { ...state, reported: { line: rep.line, at: nowMs } };
  if (rep.result === 'boot') return next;
  next.last = { rev: rep.rev, result: rep.result, message: rep.message, at: nowMs };
  if (state.pending && state.pending.rev === rep.rev) next.pending = null;
  return next;
}

// For the board: what to answer to "is a change queued?" -> `<rev>\n<line>\n` or null.
function changeReply(state) {
  return state.pending ? `${state.pending.rev}\n${state.pending.line}\n` : null;
}

// For the dashboard. The queued line's VALUES are not included (names only), the same rule as the log.
function viewState(state) {
  return {
    reported: state.reported ? { settings: parseSettingsLine(state.reported.line), at: state.reported.at } : null,
    pending: state.pending ? { rev: state.pending.rev, keys: keyNames(state.pending.line), at: state.pending.at, by: state.pending.by } : null,
    last: state.last,
  };
}

module.exports = {
  TYPES, MAX_LINE, isType, isId, parseNeed, checkStagedLine, keyNames, fileFor, pickStaged, FetchLogGate,
  MAX_REPORT_LINE, stateFile, emptyState, parseState, parseSettingsLine, parseReportBody, nextRev, queueChange, applyReport, changeReply, viewState,
};
