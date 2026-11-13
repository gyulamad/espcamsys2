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

// ── Commands: a queued line that is not a change of settings ──
//
// "Restart this board" travels the same way a settings change does — one slot per device, the same
// number, the board's own answer ("applied" / "rejected", which the dashboard shows) — but its line is
// a reserved word instead of KEY=value. A settings line always contains "=" (checkStagedLine insists), so
// the two can never be confused, and nothing sent to the settings routes can ever become a command: only
// queueCommand() makes one. A board whose firmware knows no commands answers "rejected" (not KEY=value)
// instead of ignoring it, so the dashboard says so.
//
// A command is time-limited. "Reboot now" is meaningless a week later, when a board that was switched
// off comes back and would restart for no reason; past COMMAND_TTL_MS the relay stops offering it (and
// stops showing it as waiting) — the slot is simply free again.

const COMMAND_LINES = { reboot: '!reboot' };
const COMMAND_TTL_MS = 10 * 60 * 1000;

// The command a pending entry carries ('reboot'), or null for an ordinary change.
function commandOf(pending) {
  if (!pending) return null;
  for (const [name, line] of Object.entries(COMMAND_LINES)) if (pending.line === line) return name;
  return null;
}

// The pending entry that is still worth offering: an ordinary change always; a command until it is
// COMMAND_TTL_MS old. Pass `nowMs` to apply the expiry (without it nothing expires).
function livePending(state, nowMs) {
  const p = state.pending;
  if (!p) return null;
  if (typeof nowMs === 'number' && commandOf(p) !== null && nowMs - p.at > COMMAND_TTL_MS) return null;
  return p;
}

// Queues a command for the board (replacing what was waiting, like any change).
//   -> { state, rev } like queueChange; an unknown name throws (a programming error)
function queueCommand(state, name, nowMs, by) {
  if (!Object.prototype.hasOwnProperty.call(COMMAND_LINES, name)) throw new Error(`unknown device command: ${name}`);
  return queueChange(state, COMMAND_LINES[name], nowMs, by);
}

// Why a command can not be queued for this device, or null. A board the relay has never heard from
// either does not exist, runs a firmware that does not talk to the relay about settings (and so would
// never fetch the command), or has the wrong id: queueing would only look like it worked.
function commandRefusal(state) {
  if (state.reported) return null;
  return 'the relay has not heard from this device yet (it reports when it starts with a firmware that supports remote commands), so a command to it would never be picked up';
}

// For the board: what to answer to "is a change queued?" -> `<rev>\n<line>\n` or null.
function changeReply(state, nowMs) {
  const p = livePending(state, nowMs);
  return p ? `${p.rev}\n${p.line}\n` : null;
}

// For the dashboard. The queued line's VALUES are not included (names only), the same rule as the log.
// A command shows as `command: 'reboot'` (and no keys).
function viewState(state, nowMs) {
  const p = livePending(state, nowMs);
  const command = commandOf(p);
  return {
    reported: state.reported ? { settings: parseSettingsLine(state.reported.line), at: state.reported.at } : null,
    pending: p ? { rev: p.rev, keys: keyNames(p.line), at: p.at, by: p.by, ...(command ? { command } : {}) } : null,
    last: state.last,
  };
}

// ── SETUP_MODE: boards that are armed for setup ──
//
// A board with SETUP_MODE=1 opens its own setup Wi-Fi at boot and waits there until it is configured or
// exited; anyone in range who knows the master password can reconfigure it meanwhile, so the operator must
// be told to finish or exit it. The boards already report their stored
// settings (secrets masked), so the relay only has to read what they last said. Exactly "1" counts:
// the setting is optional (absent = off) and anything else ("0", "", "true") is not on.

// The id a state file name stands for ("cam2.json" -> "cam2"), or null when the name is not one the
// relay wrote (a stray file, a temp file of an atomic write, an id that is not valid).
function stateIdFromFileName(name) {
  if (typeof name !== 'string' || !name.endsWith('.json')) return null;
  const id = name.slice(0, -'.json'.length);
  return isId(id) ? id : null;
}

// Which devices last reported SETUP_MODE=1.
//   entries: [{ type, id, state }] — states already loaded (parseState), so no files are read here
//   -> [{ type, id, reportedAt }] sorted by type, then id (a stable answer the dashboard can compare)
function setupModeDevices(entries) {
  const found = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !isType(e.type) || !isId(e.id) || !e.state || !e.state.reported) continue;
    if (parseSettingsLine(e.state.reported.line).SETUP_MODE !== '1') continue;
    found.push({ type: e.type, id: e.id, reportedAt: e.state.reported.at });
  }
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return found.sort((a, b) => byText(a.type, b.type) || byText(a.id, b.id));
}

module.exports = {
  TYPES, MAX_LINE, isType, isId, parseNeed, checkStagedLine, keyNames, fileFor, pickStaged, FetchLogGate,
  MAX_REPORT_LINE, stateFile, emptyState, parseState, parseSettingsLine, parseReportBody, nextRev, queueChange, applyReport, changeReply, viewState,
  COMMAND_LINES, COMMAND_TTL_MS, commandOf, livePending, queueCommand, commandRefusal,
  stateIdFromFileName, setupModeDevices,
};
