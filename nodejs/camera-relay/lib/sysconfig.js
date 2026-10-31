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
//     such a field as read-only, because saving it could not change anything.
//   - Everything except `alarmRecordSeconds` is read once at startup, so saving a
//     change to those means the relay has to restart (`restart: true` below) —
//     the dashboard does that for you through POST /restart.
//
// No fs, no Express: server.js does the I/O and passes plain values in and out, so
// all of this is unit tested with plain `node` — see tests/node/test_sysconfig.js.

const MIB = 1024 * 1024;

// One entry per setting. `type`: int | string | secret.
//   env      the environment variable that overrides it (or null)
//   group    the section of the settings page
//   restart  does a change need a relay restart to take effect
//   default  what the relay uses when neither config.js nor the settings file say anything
const FIELDS = [
  { key: 'alarmRecordSeconds', type: 'int', min: 1, max: 3600, default: 60, env: null, group: 'Recording', restart: false,
    label: 'Alarm recording length (seconds)', help: 'How long a recording started by a camera\'s alarm input runs. Applies to the next alarm — no restart.' },
  { key: 'preRollSeconds', type: 'int', min: 0, max: 60, default: 5, env: 'PREROLL_SECONDS', group: 'Recording', restart: true,
    label: 'Pre-roll (seconds)', help: 'Footage from BEFORE the trigger that every recording starts with. 0 switches it off.' },
  { key: 'preRollMaxBytes', type: 'int', min: 64 * 1024, max: 1024 * MIB, default: 8 * MIB, env: 'PREROLL_MAX_BYTES', group: 'Recording', restart: true,
    label: 'Pre-roll RAM cap per camera (bytes)', help: 'The buffer drops its oldest frames first when it reaches this size. Default 8 MiB = 8388608.' },

  { key: 'port', type: 'int', min: 1, max: 65535, default: 8080, env: 'PORT', group: 'Network', restart: true,
    label: 'HTTP port', help: 'The relay\'s HTTP port (/stream, /snapshot, /status ...). The dashboard\'s relay address is updated to match when you change it here.' },
  { key: 'pushPort', type: 'int', min: 1, max: 65535, default: 8081, env: 'PUSH_PORT', group: 'Network', restart: true,
    label: 'Camera push port', help: 'The raw TCP port the cameras push their frames to. It is flashed into every camera (their relay port setting) — change it and the cameras can no longer connect until they are updated.' },

  { key: 'camKey', type: 'secret', min: 8, max: 200, env: 'CAM_KEY', group: 'Keys', restart: true,
    label: 'Camera key', help: 'Must match the API key of every camera. It is flashed into the boards: changing it disconnects every camera until each one is updated. Leave empty to keep the current one.' },
  { key: 'controlKey', type: 'secret', min: 8, max: 200, env: 'CONTROL_KEY', group: 'Keys', restart: true,
    label: 'Control key', help: 'Protects recording ON/OFF, these settings and firmware publishing. Use a different value from the camera key. The dashboard\'s copy is updated for you. Leave empty to keep the current one.' },

  { key: 'logFile', type: 'string', path: 'file', ext: '.log', min: 1, max: 300, default: 'logs/camera.log', env: 'LOG_FILE', group: 'Log', restart: true,
    label: 'Log file', help: 'A path inside the relay\'s own folder, ending in .log (for example logs/camera.log). To keep it somewhere else, set logFile in config.js.' },
  { key: 'logMaxBytes', type: 'int', min: 64 * 1024, max: 1024 * MIB, default: 5 * MIB, env: 'LOG_MAX_BYTES', group: 'Log', restart: true,
    label: 'Log rotation size (bytes)', help: 'The file rotates when it would pass this size. Default 5 MiB = 5242880.' },
  { key: 'logKeepFiles', type: 'int', min: 1, max: 20, default: 2, env: 'LOG_KEEP_FILES', group: 'Log', restart: true,
    label: 'Rotated log files kept', help: 'Disk use is at most (this + 1) x the rotation size.' },

  { key: 'deviceSettingsDir', type: 'string', path: 'dir', min: 1, max: 300, default: 'device-settings', env: 'DEVICE_SETTINGS_DIR', group: 'Folders', restart: true,
    label: 'Staged device settings folder', help: 'Where settings staged for boards missing some are kept. A folder inside the relay\'s own folder; for one elsewhere, set deviceSettingsDir in config.js.' },
  { key: 'firmwareDir', type: 'string', path: 'dir', min: 1, max: 300, default: 'firmware', env: 'FIRMWARE_DIR', group: 'Folders', restart: true,
    label: 'Firmware folder', help: 'Where the over-the-air firmware is published. A folder inside the relay\'s own folder; for one elsewhere, set firmwareDir in config.js.' },
  { key: 'switchFile', type: 'string', path: 'file', ext: '.json', min: 1, max: 300, default: 'recording-switch.json', env: 'SWITCH_FILE', group: 'Folders', restart: true,
    label: 'Recording on/off state file', help: 'Where the recording ON/OFF state is kept so it survives a restart. A .json file inside the relay\'s own folder; for one elsewhere, set switchFile in config.js.' },
];

const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
// Saved in the system settings file (everything that is not the live alarm value,
// which lives in settings.json — see lib/settings.js).
const OVERRIDE_KEYS = FIELDS.filter((f) => f.key !== 'alarmRecordSeconds').map((f) => f.key);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Checks ONE value. -> { value } or { error }
function checkValue(field, raw) {
  if (field.type === 'int') {
    const s = typeof raw === 'number' ? String(raw) : raw;
    if (typeof s !== 'string' || !/^\s*-?\d+\s*$/.test(s)) return { error: `${field.key} must be a whole number between ${field.min} and ${field.max}` };
    const n = parseInt(s, 10);
    if (!Number.isSafeInteger(n) || n < field.min || n > field.max) return { error: `${field.key} must be a whole number between ${field.min} and ${field.max}` };
    return { value: n };
  }
  if (typeof raw !== 'string') return { error: `${field.key} must be text` };
  if (CONTROL_CHARS.test(raw)) return { error: `${field.key} must not contain control characters or line breaks` };
  if (field.type === 'secret') {
    if (/\s/.test(raw)) return { error: `${field.key} must not contain spaces` };
    if (raw.length < field.min || raw.length > field.max) return { error: `${field.key} must be ${field.min}-${field.max} characters long` };
    return { value: raw };
  }
  const v = raw.trim();
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

function mergeConfig(base, overrides) {
  return { ...base, ...overrides };
}

// The value a field has right now and where it comes from.
function effective(field, base, overrides, env) {
  const envName = field.env;
  if (envName && env[envName] !== undefined) return { value: env[envName], source: 'environment' };
  if (overrides[field.key] !== undefined) return { value: overrides[field.key], source: 'settings' };
  if (base[field.key] !== undefined && base[field.key] !== null && base[field.key] !== '') return { value: base[field.key], source: 'config.js' };
  return { value: field.default, source: 'default' };
}

// What GET /system-settings returns: the schema plus the current values. Secrets are
// NEVER sent back — only whether one is set.
function buildView({ base, overrides, alarmRecordSeconds, env }) {
  const fields = FIELDS.map((f) => {
    const out = { key: f.key, type: f.type, label: f.label, help: f.help, group: f.group, restart: f.restart };
    if (f.type === 'secret') {
      out.min = f.min; out.max = f.max;
      const e = effective(f, base, overrides, env);
      out.isSet = e.value !== undefined && e.value !== '';
      out.source = e.source;
    } else if (f.key === 'alarmRecordSeconds') {
      out.min = f.min; out.max = f.max; out.value = alarmRecordSeconds; out.source = 'settings';
    } else {
      const e = effective(f, base, overrides, env);
      out.min = f.min; out.max = f.max; out.value = f.type === 'int' ? Number(e.value) : String(e.value); out.source = e.source;
    }
    out.envOverride = Boolean(f.env && env[f.env] !== undefined);
    if (out.envOverride) out.envName = f.env;
    return out;
  });
  return { fields };
}

// Applies an update ({ key: value, ... }) on top of the current state. All-or-nothing:
// any invalid value, unknown key, or a read-only (environment) field means nothing changes.
// Empty text for a secret means "keep the current one".
//   -> { error } | { overrides, alarmRecordSeconds, changed: [keys], restartRequired }
function applyUpdate({ base, overrides, alarmRecordSeconds, env }, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { error: 'send the settings as a JSON object: { "key": value, ... }' };
  const nextOverrides = { ...overrides };
  let nextAlarm = alarmRecordSeconds;
  const changed = [];
  let restartRequired = false;
  for (const key of Object.keys(values)) {
    const f = BY_KEY[key];
    if (!f) return { error: `unknown setting: ${key}` };
    const raw = values[key];
    if (f.type === 'secret' && (raw === '' || raw === null || raw === undefined)) continue;
    if (f.env && env[f.env] !== undefined) {
      // Not an error when it is merely echoed back unchanged by the page.
      if (f.type !== 'secret' && String(raw) === String(env[f.env])) continue;
      return { error: `${key} is set by the ${f.env} environment variable and cannot be changed here` };
    }
    const r = checkValue(f, raw);
    if (r.error) return { error: r.error };
    const current = key === 'alarmRecordSeconds' ? alarmRecordSeconds : effective(f, base, overrides, env).value;
    if (f.type !== 'secret' && String(current) === String(r.value)) continue; // unchanged
    if (f.type === 'secret' && current === r.value) continue;
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
  const port = effective(BY_KEY.port, base, nextOverrides, env).value;
  const pushPort = effective(BY_KEY.pushPort, base, nextOverrides, env).value;
  if (String(port) === String(pushPort)) return { error: 'port and pushPort must be different' };
  return { overrides: nextOverrides, alarmRecordSeconds: nextAlarm, changed, restartRequired };
}

// Is this process run by something that starts it again after it exits (systemd, pm2)?
// Restarting a relay started by hand would just stop it, so the relay refuses that.
function isSupervised(env) {
  return env.RELAY_SUPERVISED === '1' || (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID !== '') || env.pm_id !== undefined;
}

// Non-zero on purpose: systemd's `Restart=on-failure` (the unit in INSTALL.md) only
// restarts after a non-zero exit. (75 = EX_TEMPFAIL, "try again".)
const RESTART_EXIT_CODE = 75;

module.exports = { FIELDS, OVERRIDE_KEYS, checkValue, checkRelayPath, parseOverrides, mergeConfig, buildView, applyUpdate, isSupervised, RESTART_EXIT_CODE };
