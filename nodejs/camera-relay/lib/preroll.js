'use strict';

// preroll.js — the relay's "airplane black box": a short, rolling, in-memory
// window of each camera's most recent frames, so a recording that starts
// *after* something happened (a person walking past, an alarm edge that took
// a slow Wi-Fi round trip to reach us) can still begin with the footage from
// just BEFORE the trigger.
//
// Pure and side-effect free like the rest of lib/ — no fs, no timers, no
// Express — so it can be unit tested with plain `node` (see
// tests/node/test_preroll.js). server.js owns one PreRollBuffer per camera,
// feeds it every incoming frame, and asks it for the pre-roll when a
// recording starts.

const DEFAULT_PRE_ROLL_SECONDS = 5;
const MAX_PRE_ROLL_SECONDS = 60;
const DEFAULT_PRE_ROLL_MAX_BYTES = 8 * 1024 * 1024; // per camera
const MAX_PRE_ROLL_FRAMES = 2000;                    // hard safety cap per camera

// Turns the raw `preRollSeconds` / `preRollMaxBytes` values from config.js
// (or the PREROLL_* env overrides — which arrive as strings) into a valid
// { seconds, maxBytes } plus a list of human-readable warnings for anything
// that had to be replaced. Missing values silently use the default; values
// that are present but unusable fall back to the default WITH a warning, so
// a typo in config.js can't quietly turn the feature off or let it eat RAM.
// seconds === 0 is valid and means "pre-roll disabled".
function resolvePreRollConfig({ seconds, maxBytes } = {}) {
  const warnings = [];

  let outSeconds = DEFAULT_PRE_ROLL_SECONDS;
  if (seconds !== undefined && seconds !== null && seconds !== '') {
    const n = Number(seconds);
    if (Number.isFinite(n) && n >= 0 && n <= MAX_PRE_ROLL_SECONDS) {
      outSeconds = n;
    } else {
      warnings.push(
        `preRollSeconds=${JSON.stringify(seconds)} is not a number between 0 and ${MAX_PRE_ROLL_SECONDS}; using ${DEFAULT_PRE_ROLL_SECONDS}`
      );
    }
  }

  let outMaxBytes = DEFAULT_PRE_ROLL_MAX_BYTES;
  if (maxBytes !== undefined && maxBytes !== null && maxBytes !== '') {
    const n = Number(maxBytes);
    if (Number.isFinite(n) && n >= 64 * 1024) {
      outMaxBytes = Math.floor(n);
    } else {
      warnings.push(
        `preRollMaxBytes=${JSON.stringify(maxBytes)} is not a number >= 65536; using ${DEFAULT_PRE_ROLL_MAX_BYTES}`
      );
    }
  }

  return { seconds: outSeconds, maxBytes: outMaxBytes, warnings };
}

// Time-windowed ring buffer of JPEG frames, bounded three ways (age, bytes,
// frame count) so a noisy camera or a mis-set config can never exhaust the
// Pi's RAM. Timestamps are the relay's own arrival time in ms, forced to be
// non-decreasing (a clock step backwards must not reorder footage).
class PreRollBuffer {
  constructor({ seconds = DEFAULT_PRE_ROLL_SECONDS, maxBytes = DEFAULT_PRE_ROLL_MAX_BYTES, maxFrames = MAX_PRE_ROLL_FRAMES } = {}) {
    if (!(seconds >= 0)) throw new RangeError('seconds must be >= 0');
    this.windowMs = seconds * 1000;
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this._frames = []; // [{ ts, jpeg }], oldest first
    this._bytes = 0;
  }

  // Stores a frame and returns the timestamp it was filed under (ts, or the
  // previous frame's ts if ts would have gone backwards) — callers should use
  // the RETURNED value if they need to refer to this frame's time later.
  //
  // The buffer keeps its own private, compact copy. Frames coming off the
  // push socket are slices of a larger receive buffer; holding on to a slice
  // would pin that whole buffer in memory (and make the byte cap a lie), and
  // a caller reusing its buffer would silently corrupt what's stored here.
  push(jpeg, ts = Date.now()) {
    const last = this._frames[this._frames.length - 1];
    if (last && ts < last.ts) ts = last.ts;
    if (this.windowMs === 0) return ts; // pre-roll disabled: nothing to keep

    const copy = Buffer.from(jpeg);
    this._frames.push({ ts, jpeg: copy });
    this._bytes += copy.length;
    this._evict(ts);
    return ts;
  }

  // The frames to put at the start of a recording triggered at triggerTs:
  // everything from the last `windowMs` before the trigger, oldest first,
  // optionally excluding anything at or before `afterTs`. server.js passes the
  // end of the previous recording as afterTs so two back-to-back clips never
  // contain the same footage twice. Returns a new array (safe to keep using
  // while more frames arrive and old ones are evicted).
  preRollFor(triggerTs = Date.now(), afterTs = -Infinity) {
    const since = triggerTs - this.windowMs;
    return this._frames.filter((f) => f.ts >= since && f.ts > afterTs);
  }

  get stats() {
    const n = this._frames.length;
    const span = n > 1 ? (this._frames[n - 1].ts - this._frames[0].ts) / 1000 : 0;
    return {
      frames: n,
      bytes: this._bytes,
      bufferedSeconds: Math.round(span * 10) / 10,
      windowSeconds: this.windowMs / 1000,
    };
  }

  _evict(now) {
    const minTs = now - this.windowMs;
    const len = this._frames.length;
    let drop = 0;
    while (
      drop < len &&
      (this._frames[drop].ts < minTs || len - drop > this.maxFrames || this._bytes > this.maxBytes)
    ) {
      this._bytes -= this._frames[drop].jpeg.length;
      drop++;
    }
    if (drop) this._frames.splice(0, drop);
  }
}

module.exports = {
  DEFAULT_PRE_ROLL_SECONDS,
  MAX_PRE_ROLL_SECONDS,
  DEFAULT_PRE_ROLL_MAX_BYTES,
  MAX_PRE_ROLL_FRAMES,
  resolvePreRollConfig,
  PreRollBuffer,
};
