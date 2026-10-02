'use strict';

// settings.js — pure logic for the relay's persistent, dashboard-editable
// settings (currently the alarm durations). No fs, no Express: server.js
// does the file I/O and passes plain values in/out, so everything here can
// be unit tested with plain `node` — see tests/node/test_settings.js.

const { parseIntInRange } = require('./validation');

const MIN_SECONDS = 1;
const MAX_SECONDS = 3600; // same sanity cap as recording / power-on

// Used until the dashboard saves something, and as the per-field fallback
// if settings.json is missing or contains junk. 60 matches the old
// hardcoded ALARM_RECORD_SECONDS in the ESP32 sketch.
const DEFAULT_SETTINGS = Object.freeze({
  alarmRecordSeconds: 60, // how long an alarm-triggered recording runs
  alarmPowerSeconds: 60,  // how long the camera is guaranteed to stay on after an alarm
});

const FIELDS = Object.keys(DEFAULT_SETTINGS);

// Turns the raw text of settings.json into a complete, valid settings
// object. Anything missing, unparsable, or out of range falls back to the
// default for that field, so a corrupt file can never stop the relay
// from starting or leave an alarm with a nonsense duration.
function parseStoredSettings(text) {
  let obj = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch (e) {
    // fall through with defaults
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const f of FIELDS) {
    const n = parseIntInRange(obj[f], MIN_SECONDS, MAX_SECONDS);
    if (n !== null) out[f] = n;
  }
  return out;
}

// Applies a settings update (the query params of POST /settings) on top of
// the current settings. Only fields that are present are changed; at least
// one known field must be present, and every present one must be valid —
// otherwise nothing is changed and an error message is returned.
// Returns { settings } on success or { error } on failure.
function applySettingsUpdate(current, query) {
  const next = { ...current };
  let changed = 0;
  for (const f of FIELDS) {
    if (query[f] === undefined) continue;
    const n = parseIntInRange(query[f], MIN_SECONDS, MAX_SECONDS);
    if (n === null) {
      return { error: `${f} must be an integer between ${MIN_SECONDS} and ${MAX_SECONDS}` };
    }
    next[f] = n;
    changed++;
  }
  if (changed === 0) {
    return { error: `provide at least one of: ${FIELDS.join(', ')}` };
  }
  return { settings: next };
}

module.exports = { DEFAULT_SETTINGS, MIN_SECONDS, MAX_SECONDS, parseStoredSettings, applySettingsUpdate };
