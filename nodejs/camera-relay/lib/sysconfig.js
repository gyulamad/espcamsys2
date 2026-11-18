'use strict';

// sysconfig.js — pure logic for the relay's SYSTEM settings: the values that used
// to be edited only in config.js (ports, keys, pre-roll, log, folders), now also
// editable from the dashboard's settings page.
//
// How it fits together:
//   - config.js stays the bootstrap file (it is what a fresh install starts with).
//   - What the settings page saves goes to a small JSON file next to server.js
//     (system-settings.json) and is laid OVER config.js when the relay starts, so
//     config.js is never rewritten by a program.
//   - Environment variables (PORT, CAM_KEY, ...) still win over both; the page shows
//     such a field as read-only, because saving it could not change anything. Which
//     variable belongs to which setting is in SETTINGS.md.
//   - The rows themselves (key, type, default, tier, restart, ...) are in lib/sysfields.js. A value
//     that is read once at startup has `restart: true`: saving a change to it means the relay has to
//     restart — the dashboard does that for you through POST /restart. The few `restart: false` ones
//     (alarmRecordSeconds, minFreeStorageMB, maxAlarmRecordings, ...) count at once.
//   - A `locked` row (the programs the relay runs) is shown but never changed from here.
//
// No fs, no Express: server.js does the I/O and passes plain values in and out, so
// all of this is unit tested with plain `node` — see tests/node/test_sysconfig.js.

const sounds = require('./sounds');
const { cleanBaseUrl } = require('./detectionnotice');
const { chatIdEntries, CHAT_ID_RE } = require('./notify/telegram');
const { FIELDS } = require('./sysfields');

const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
// Saved in the system settings file (everything that is not the live alarm value, which lives in settings.json — see
// lib/settings.js — and not a locked row: those are only ever read from config.js).
const OVERRIDE_KEYS = FIELDS.filter((f) => f.key !== 'alarmRecordSeconds' && !f.locked).map((f) => f.key);
const LOCKED_KEYS = FIELDS.filter((f) => f.locked).map((f) => f.key);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_G = /[\u0000-\u001f\u007f]+/g;

// Checks ONE value. -> { value } or { error }
// A decimal like 0.4 or .55 (not 1e-1, 0x1, 0,5), as text or a number, inside the field's range. -> { value } or { error }
const DECIMAL = /^\s*(\d+(\.\d*)?|\.\d+)\s*$/;
function checkFloat(field, raw) {
  const fail = { error: `${field.key} must be a number ${field.minExclusive ? 'above' : 'from'} ${field.min} and at most ${field.max}` };
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.length <= 32 && DECIMAL.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return fail;
  const aboveMin = field.minExclusive ? n > field.min : n >= field.min;
  return aboveMin && n <= field.max ? { value: n } : fail;
}

// true or false, as a boolean or as the text "true" / "false" (what the settings page sends) — nothing else: no 1,
// yes or on, so a typo can never switch a feature that moves footage. -> { value } or { error }
function checkBool(field, raw) {
  const v = typeof raw === 'string' ? raw.replace(/^ +| +$/g, '').toLowerCase() : raw;   // spaces only: a line break is refused
  if (v === true || v === 'true') return { value: true };
  if (v === false || v === 'false') return { value: false };
  return { error: `${field.key} must be true or false` };
}

// One of the field's words. -> { value } or { error }
function checkChoice(field, raw) {
  return field.options.includes(raw) ? { value: raw } : { error: `${field.key} must be one of: ${field.options.join(', ')}` };
}

// A plain http(s) address (the same rule as the one in lib/detectionnotice.js), or '' for none. -> { value } (normalised) or { error }
function checkUrl(field, raw) {
  if (raw === '') return { value: '' };
  const clean = cleanBaseUrl(raw);
  return clean === null ? { error: `${field.key} must be a plain http:// or https:// address, like http://raspberrypi.local/camdash — or empty for none` } : { value: clean };
}

// Telegram chat ids: a list or a comma separated text -> { value: 'id1,id2' } (no blanks, no repeats) or { error }. An array is
// accepted because config.js may hold one.
function checkChatIds(field, raw) {
  if (typeof raw !== 'string' && !Array.isArray(raw)) return { error: `${field.key} must be text: chat ids separated by commas` };
  const ids = [];
  for (const entry of chatIdEntries(raw)) {
    if (!CHAT_ID_RE.test(entry)) return { error: `${field.key}: "${entry.slice(0, 40).replace(CONTROL_CHARS_G, '?')}" is not a chat id (a number, a negative number for a group, or @channelname)` };
    if (!ids.includes(entry)) ids.push(entry);
  }
  return { value: ids.join(',') };
}

// The address the HTTP port listens on: an IP address or a host name, letters, digits and . : _ - only. -> { value } or { error }
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
function checkHost(field, raw) {
  return HOST_RE.test(raw) ? { value: raw } : { error: `${field.key} must be an address or host name, like 0.0.0.0 or 127.0.0.1` };
}

function checkValue(field, raw) {
  if (field.type === 'float') return checkFloat(field, raw);
  if (field.type === 'bool') return checkBool(field, raw);
  if (field.type === 'int') {
    const s = typeof raw === 'number' ? String(raw) : raw;
    if (typeof s !== 'string' || !/^\s*-?\d+\s*$/.test(s)) return { error: `${field.key} must be a whole number between ${field.min} and ${field.max}` };
    const n = parseInt(s, 10);
    if (!Number.isSafeInteger(n) || n < field.min || n > field.max) return { error: `${field.key} must be a whole number between ${field.min} and ${field.max}` };
    return { value: n };
  }
  if (field.type === 'chatids') return checkChatIds(field, raw);
  if (typeof raw !== 'string') return { error: `${field.key} must be text` };
  if (CONTROL_CHARS.test(raw)) return { error: `${field.key} must not contain control characters or line breaks` };
  if (field.type === 'secret') {
    if (/\s/.test(raw)) return { error: `${field.key} must not contain spaces` };
    if (raw.length < field.min || raw.length > field.max) return { error: `${field.key} must be ${field.min}-${field.max} characters long` };
    return { value: raw };
  }
  const v = raw.trim();
  if (field.type === 'sound') return v === '' || sounds.isSoundName(v) ? { value: v } : { error: `${field.key} must be the name of a sound file (or empty for no sound)` };
  if (field.type === 'choice') return checkChoice(field, v);
  if (field.type === 'url') return checkUrl(field, v);
  if (field.type === 'host') return checkHost(field, v);
  if (field.type === 'argv') return { error: `${field.key} is a command and cannot be set from here` };
  if (v.length < field.min || v.length > field.max) return { error: `${field.key} must be ${field.min}-${field.max} characters long` };
  return { value: v };
}

// The four path settings (logFile, switchFile, firmwareDir, deviceSettingsDir) say where the relay WRITES. Anyone
// holding the control key can change them from the dashboard, so a value set there must stay inside the relay's own
// folder and must not name the relay's own code or state (review R-04): a plain relative path, no leading / or ~,
// no ".." , no backslash or ":" (drive letters), no segment starting with a dot, not under lib/, node_modules/ or
// recordings/, and not one of the relay's own files; a file setting also has to carry its own extension (.log /
// .json), so it cannot be pointed at server.js or config.js. A path that is already in force (it came from
// config.js, which only the machine's owner can edit) is left alone: only a CHANGE made here is checked. The check
// is on the text — it cannot see a symlink inside the folder; the owner's own folder layout is theirs to trust.
// -> { value } (normalised: no empty or "." segments) or { error }
const PROTECTED_DIRS = ['lib', 'node_modules', 'recordings'];
const PROTECTED_FILES = ['server.js', 'config.js', 'example.config.js', 'package.json', 'package-lock.json', 'settings.json', 'system-settings.json'];
function checkRelayPath(field, value) {
  const fail = (why) => ({ error: `${field.key} ${why}` });
  const kindHint = field.path === 'file' ? ` ending in ${field.ext}` : '';
  const shape = `must be a path inside the relay's own folder${kindHint}, like ${field.default}`;
  if (typeof value !== 'string' || value === '') return fail(shape);
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\') || value.includes(':')) return fail(`${shape} — no leading / or ~, no backslash, no drive letter`);
  const segs = value.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.length === 0) return fail(shape);
  if (segs.some((x) => x === '..')) return fail(`${shape} — ".." is not allowed`);
  if (segs.some((x) => x.startsWith('.'))) return fail(`${shape} — nothing in it may start with a dot`);
  if (PROTECTED_DIRS.includes(segs[0].toLowerCase())) return fail(`${shape} — not under ${segs[0]}/ (the relay's own code or recordings live there)`);
  if (field.path === 'file') {
    const name = segs[segs.length - 1].toLowerCase();
    if (PROTECTED_FILES.includes(name)) return fail(`${shape} — ${segs[segs.length - 1]} is one of the relay's own files`);
    if (!name.endsWith(field.ext) || name === field.ext) return fail(shape);
  }
  return { value: segs.join('/') };
}

// What the relay starts with: config.js, with the saved system settings over it. A
// saved value that is no longer valid (file edited by hand, a limit that tightened) is
// skipped — with a warning — and config.js's value is used, so a damaged file can never
// stop the relay from starting.
//   -> { config, overrides, warnings }
function parseOverrides(text) {
  const overrides = {};
  const warnings = [];
  if (typeof text !== 'string' || text.trim() === '') return { overrides, warnings };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { overrides, warnings: ['the system settings file is not valid JSON — ignored, config.js is used'] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { overrides, warnings: ['the system settings file is not a JSON object — ignored'] };
  for (const key of LOCKED_KEYS) {
    if (obj[key] !== undefined) warnings.push(`system settings file: ${key} is locked (it decides what the relay runs) — ignored, set it in config.js`);
  }
  for (const key of OVERRIDE_KEYS) {
    if (obj[key] === undefined) continue;
    const r = checkValue(BY_KEY[key], obj[key]);
    if (r.error) warnings.push(`system settings file: ${r.error} — using the value from config.js instead`);
    else overrides[key] = r.value;
  }
  if (overrides.port !== undefined && overrides.pushPort !== undefined && overrides.port === overrides.pushPort) {
    warnings.push('system settings file: port and pushPort are the same — both ignored');
    delete overrides.port;
    delete overrides.pushPort;
  }
  return { overrides, warnings };
}

// config.js's value for a field: its own top-level key, or (for a setting that config.js nests) the path in `config`.
function configValue(field, base) {
  if (!field.config) return base[field.key];
  return field.config.reduce((v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined), base);
}

// A copy of `obj` with `value` at `path` (a list of keys); the blocks on the way are copied, never changed, and a block that
// is missing or is not a plain object is replaced by one.
function setPath(obj, path, value) {
  const [head, ...rest] = path;
  if (rest.length === 0) return { ...obj, [head]: value };
  const child = obj[head];
  const block = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : {};
  return { ...obj, [head]: setPath(block, rest, value) };
}

// config.js with the saved settings laid over it. A setting that config.js nests (personScanConfidence ->
// personScan.confidence, telegramChatId -> notifications.telegram.chatId) is put where the code that reads config.js
// looks for it; `base` itself is not changed.
function mergeConfig(base, overrides) {
  let merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const f = BY_KEY[key];
    merged = setPath(merged, f && f.config ? f.config : [key], value);
  }
  return merged;
}

// The value a field has right now and where it comes from.
// What an environment variable says for a field. A true/false switch whose variable has an older meaning keeps it
// (envFlag in lib/sysfields.js): RELAY_HSTS is on only for exactly "1", READ_KEY_REQUIRED is off only for exactly "0".
function envValue(field, raw) {
  const flag = field.envFlag;
  if (!flag) return raw;
  return flag.trueWhen !== undefined ? raw === flag.trueWhen : raw !== flag.falseWhen;
}

function effective(field, base, overrides, env) {
  const envName = field.env;
  if (envName && env[envName] !== undefined) return { value: envValue(field, env[envName]), source: 'environment' };
  if (overrides[field.key] !== undefined) return { value: overrides[field.key], source: 'settings' };
  const fromConfig = configValue(field, base);
  if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') return { value: fromConfig, source: 'config.js' };
  return { value: field.default, source: 'default' };
}

// The value a setting (a number, a true/false switch or a sound's name) has right now, checked like a saved one. A
// value that is no longer valid (config.js edited by hand, an environment variable with text in it) falls back to the
// default, so a bad value can never break the code that reads it.   -> number | boolean | string
function currentValue(key, { base, overrides, env }) {
  const f = BY_KEY[key];
  const r = checkValue(f, effective(f, base, overrides, env).value);
  return r.error ? f.default : r.value;
}

// What GET /system-settings returns: the schema plus the current values. Secrets are
// NEVER sent back — only whether one is set.
// How a value is shown to the settings page, per type (a switch is the text "true" / "false", like the page sends it).
const VIEW_VALUE = {
  int: Number,
  float: Number,
  bool: (v) => v === true || v === 'true',
  string: String,
  secret: String,
  sound: String,
  choice: String,
  url: String,
  chatids: (v) => (Array.isArray(v) ? v.join(',') : String(v)),
  host: String,
  argv: (v) => (Array.isArray(v) ? v.slice() : []),
};

// soundNames: the sounds in the folder right now — what a `sound` setting can be set to (sent as its `options`).
function buildView({ base, overrides, alarmRecordSeconds, env, soundNames = [] }) {
  const fields = FIELDS.map((f) => {
    const out = { key: f.key, type: f.type, label: f.label, help: f.help, group: f.group, tier: f.tier, restart: f.restart };
    if (f.locked) out.locked = true;
    if (f.type === 'secret') {
      out.min = f.min; out.max = f.max;
      const e = effective(f, base, overrides, env);
      out.isSet = e.value !== undefined && e.value !== '';
      out.source = e.source;
    } else if (f.key === 'alarmRecordSeconds') {
      out.min = f.min; out.max = f.max; out.value = alarmRecordSeconds; out.source = 'settings';
    } else {
      const e = effective(f, base, overrides, env);
      out.min = f.min; out.max = f.max; out.value = VIEW_VALUE[f.type](e.value); out.source = e.source;
      if (f.type === 'float') { out.step = f.step; out.minExclusive = Boolean(f.minExclusive); }
      if (f.type === 'sound') out.options = soundNames.slice();
      if (f.type === 'choice') out.options = f.options.slice();
    }
    if (f.type !== 'secret' && f.default !== undefined) out.default = VIEW_VALUE[f.type](f.default);
    out.envOverride = Boolean(f.env && env[f.env] !== undefined);
    if (out.envOverride) out.envName = f.env;
    return out;
  });
  return { fields };
}

// Applies an update ({ key: value, ... }) on top of the current state. All-or-nothing:
// any invalid value, unknown key, or a read-only (environment) field means nothing changes.
// Empty text for a secret means "keep the current one". A sound can only be set to one that is in the folder
// (`soundNames`; left out = not checked, which is what a caller without a folder gets): one that was deleted since
// but is still the saved choice is not an error until somebody picks it again.
//   -> { error } | { overrides, alarmRecordSeconds, changed: [keys], restartRequired }
// Is `raw` what the environment variable already says — as the text in it, or as the value the page was shown for it?
function echoesEnvironment(field, raw, shownValue, env) {
  return String(raw) === String(env[field.env]) || String(raw) === String(shownValue);
}

function applyUpdate({ base, overrides, alarmRecordSeconds, env, soundNames }, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { error: 'send the settings as a JSON object: { "key": value, ... }' };
  const nextOverrides = { ...overrides };
  let nextAlarm = alarmRecordSeconds;
  const changed = [];
  let restartRequired = false;
  for (const key of Object.keys(values)) {
    const f = BY_KEY[key];
    if (!f) return { error: `unknown setting: ${key}` };
    const raw = values[key];
    if (f.locked) {
      // Not an error when it is merely echoed back unchanged by a page that shows it.
      if (JSON.stringify(raw) === JSON.stringify(effective(f, base, overrides, env).value)) continue;
      return { error: `${key} is locked: it decides what program the relay runs, so it can only be changed in config.js on the machine itself` };
    }
    if (f.type === 'secret' && (raw === '' || raw === null || raw === undefined)) continue;
    if (f.env && env[f.env] !== undefined) {
      // Not an error when it is merely echoed back unchanged by the page.
      if (f.type !== 'secret' && echoesEnvironment(f, raw, effective(f, base, overrides, env).value, env)) continue;
      return { error: `${key} is set by the ${f.env} environment variable and cannot be changed here` };
    }
    const r = checkValue(f, raw);
    if (r.error) return { error: r.error };
    const current = key === 'alarmRecordSeconds' ? alarmRecordSeconds : effective(f, base, overrides, env).value;
    if (f.type !== 'secret' && (f.type === 'float' ? Number(current) === r.value : String(current) === String(r.value))) continue; // unchanged
    if (f.type === 'secret' && current === r.value) continue;
    if (f.type === 'sound' && r.value !== '' && Array.isArray(soundNames) && !soundNames.includes(r.value)) {
      return { error: `there is no sound called \"${r.value}\" in the sounds folder — upload it first` };
    }
    let value = r.value;
    if (f.path) {
      const pr = checkRelayPath(f, value);
      if (pr.error) return { error: pr.error };
      if (String(current) === pr.value) continue; // the same path, only written differently ("firmware/")
      value = pr.value;
    }
    if (key === 'alarmRecordSeconds') nextAlarm = value;
    else nextOverrides[key] = value;
    changed.push(key);
    if (f.restart) restartRequired = true;
  }
  if (changed.includes('authLockSeconds') || changed.includes('authLockMaxSeconds')) {
    const first = Number(effective(BY_KEY.authLockSeconds, base, nextOverrides, env).value);
    const longest = Number(effective(BY_KEY.authLockMaxSeconds, base, nextOverrides, env).value);
    if (longest < first) return { error: 'authLockMaxSeconds must not be shorter than authLockSeconds' };
  }

  const port = effective(BY_KEY.port, base, nextOverrides, env).value;
  const pushPort = effective(BY_KEY.pushPort, base, nextOverrides, env).value;
  if (String(port) === String(pushPort)) return { error: 'port and pushPort must be different' };

  // (review NODE-013) camKey is flashed into every camera board, so allowing it to equal
  // controlKey hands the dashboard's full power (recording switch, settings, firmware
  // publish, restart) to anyone holding a single physical board. Refuse it at save time,
  // not just at startup, so an operator cannot paint themselves into this corner.
  const camKey = effective(BY_KEY.camKey, base, nextOverrides, env).value;
  const controlKey = effective(BY_KEY.controlKey, base, nextOverrides, env).value;
  if (camKey !== undefined && controlKey !== undefined && camKey !== '' && controlKey !== '' && String(camKey) === String(controlKey)) {
    return { error: 'camKey and controlKey must be different (camKey is flashed into every camera board: equality would hand the dashboard full power to anyone holding a single board)' };
  }

  return { overrides: nextOverrides, alarmRecordSeconds: nextAlarm, changed, restartRequired };
}

// Is this process run by something that starts it again after it exits (systemd, pm2)?
// Restarting a relay started by hand would just stop it, so the relay refuses that.
function isSupervised(env) {
  return env.RELAY_SUPERVISED === '1' || (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID !== '') || env.pm_id !== undefined;
}

// Non-zero on purpose: systemd's `Restart=on-failure` (the unit in SETUP.md) only
// restarts after a non-zero exit. (75 = EX_TEMPFAIL, "try again".)
const RESTART_EXIT_CODE = 75;

module.exports = { FIELDS, OVERRIDE_KEYS, checkValue, checkRelayPath, parseOverrides, mergeConfig, currentValue, buildView, applyUpdate, isSupervised, RESTART_EXIT_CODE };
