'use strict';

// recswitch.js — the recording ON/OFF switch, as pure logic.
//
// Each camera is either recording-enabled (the default) or switched OFF, and an
// OFF is either for a number of minutes (it switches itself back ON when the
// time is up) or "forever" (only an explicit ON ends it). The relay's "all
// cameras" button is nothing special: it just sets every camera it knows at
// that moment, one by one — afterwards each camera can be changed on its own.
//
// Why a switch at all: when people are at the surveilled place the cameras
// would record all that movement for no reason, and someone has to go through
// the footage by hand afterwards.
//
// What the state looks like in the file (only OFF cameras appear; absent = ON):
//   { "v": 1, "cameras": { "cam1": { "until": 1791000000000 },   // OFF until that epoch-ms time
//                          "cam2": { "until": null } } }          // OFF until switched ON
// A timed OFF is stored as an ABSOLUTE time, not "N minutes left", so it keeps
// counting down while the relay is stopped and is still right when it restarts.
//
// A damaged or unreadable file means everything is ON: for a surveillance
// system, losing the switch must fail towards RECORDING, never towards silence.
//
// Pure: no fs, no clock (the caller passes the time), no Express.

const { CAMERA_ID_RE } = require('./logentry');

const DEFAULT_OFF_MINUTES = 60;
const MAX_OFF_MINUTES = 525600; // one year — anything longer is "forever" in all but name, so ask for forever instead

// Reads the minutes a user asked for:
//   missing / empty        -> the default (60)
//   0 or negative          -> 0, meaning "forever" (no countdown)
//   1 .. MAX_OFF_MINUTES   -> that many minutes
// Anything that isn't a whole number, or is absurdly large, is an error.
// Accepts a number or a numeric string (query parameters arrive as strings).
function parseMinutes(value) {
  if (value === undefined || value === null || value === '') return { ok: true, minutes: DEFAULT_OFF_MINUTES };
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) n = Number(value.trim());
  else return { ok: false, error: 'minutes must be a whole number (0 or negative = until switched back ON)' };
  if (!Number.isInteger(n)) return { ok: false, error: 'minutes must be a whole number (0 or negative = until switched back ON)' };
  if (n <= 0) return { ok: true, minutes: 0 };
  if (n > MAX_OFF_MINUTES) return { ok: false, error: `minutes must be at most ${MAX_OFF_MINUTES} (use 0 for "until switched back ON")` };
  return { ok: true, minutes: n };
}

// An OFF entry that has not run out yet.
function alive(entry, nowMs) {
  return entry.until === null || entry.until > nowMs;
}

class RecordingSwitch {
  constructor() {
    this._off = new Map(); // cameraId -> { until: number | null }
  }

  // Switches a camera OFF for `minutes` (0 = until switched ON). Returns its entry.
  turnOff(id, minutes, nowMs) {
    const entry = { until: minutes > 0 ? nowMs + minutes * 60000 : null };
    this._off.set(id, entry);
    return entry;
  }

  // Switches a camera ON. Returns true if it had been OFF.
  turnOn(id) {
    return this._off.delete(id);
  }

  // null when the camera may record; { until } (null = no end) when it is OFF.
  // A timed OFF whose time has passed counts as ON even if expire() hasn't run yet.
  offState(id, nowMs) {
    const e = this._off.get(id);
    return e && alive(e, nowMs) ? { until: e.until } : null;
  }

  // Removes every OFF whose time has run out and returns { id, until } for each
  // — `until` being the moment it actually ran out, which can be earlier than
  // now if nobody asked for a while; the caller needs it to know exactly when
  // recording became allowed again.
  expire(nowMs) {
    const ended = [];
    for (const [id, e] of this._off) {
      if (!alive(e, nowMs)) { this._off.delete(id); ended.push({ id, until: e.until }); }
    }
    return ended;
  }

  // Ids of the cameras that are OFF right now.
  offIds(nowMs) {
    const ids = [];
    for (const [id, e] of this._off) if (alive(e, nowMs)) ids.push(id);
    return ids.sort();
  }

  serialize() {
    const cameras = {};
    for (const id of [...this._off.keys()].sort()) cameras[id] = { until: this._off.get(id).until };
    return JSON.stringify({ v: 1, cameras }, null, 2) + '\n';
  }

  // Reads a state file. Never throws and never fails towards "silent": whatever
  // can't be understood is dropped with a warning (and everything is ON if the
  // whole file is unusable). `expired` lists cameras whose timed OFF ran out
  // while the relay was stopped, so the caller can say so.
  static parse(text, nowMs) {
    const sw = new RecordingSwitch();
    const warnings = [];
    const expired = [];
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { sw, warnings: ['the recording-switch file is not valid JSON — ignoring it, every camera records'], expired };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.cameras || typeof data.cameras !== 'object' || Array.isArray(data.cameras)) {
      return { sw, warnings: ['the recording-switch file has an unexpected shape — ignoring it, every camera records'], expired };
    }
    for (const id of Object.keys(data.cameras)) {
      const e = data.cameras[id];
      const validUntil = e && typeof e === 'object' && (e.until === null || (typeof e.until === 'number' && Number.isFinite(e.until)));
      if (!CAMERA_ID_RE.test(id) || !validUntil) {
        warnings.push(`ignored an unusable entry for "${String(id).slice(0, 40)}" in the recording-switch file`);
        continue;
      }
      if (!alive(e, nowMs)) { expired.push(id); continue; }
      sw._off.set(id, { until: e.until });
    }
    return { sw, warnings, expired };
  }
}

// What an OFF state looks like to the outside world (JSON for /status etc).
// `remainingMs` is given so a browser can count down without trusting that its
// clock agrees with the relay's.
function describeOff(state, nowMs) {
  if (!state) return null;
  if (state.until === null) return { forever: true, until: null, remainingMs: null };
  return { forever: false, until: new Date(state.until).toISOString(), remainingMs: Math.max(0, state.until - nowMs) };
}

module.exports = { DEFAULT_OFF_MINUTES, MAX_OFF_MINUTES, parseMinutes, RecordingSwitch, describeOff };
