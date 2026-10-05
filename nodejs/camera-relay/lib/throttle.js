'use strict';

// throttle.js — "say this at most once per window, and tell me how many times
// it was left out". Used so that something repeating very fast (a camera
// reconnecting every second, a scanner hammering the push port) produces a
// handful of log lines carrying counts, not thousands of identical ones that
// bury everything else and wear the SD card.
//
// Pure: the caller passes the time.

class Throttle {
  constructor(windowMs, maxKeys = 1000) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this._state = new Map(); // key -> { lastAllowedAt, suppressed }
  }

  // { allow, suppressed }: `allow` says whether to log this occurrence now;
  // when it is true, `suppressed` is how many were skipped since the last time
  // one was allowed (0 the first time).
  check(key, nowMs) {
    const s = this._state.get(key);
    if (!s || nowMs - s.lastAllowedAt >= this.windowMs || nowMs < s.lastAllowedAt) {
      this._state.set(key, { lastAllowedAt: nowMs, suppressed: 0 });
      this._prune(nowMs);
      return { allow: true, suppressed: s ? s.suppressed : 0 };
    }
    s.suppressed += 1;
    return { allow: false, suppressed: 0 };
  }

  // Keeps the map from growing without bound if keys keep changing (e.g. an
  // attacker cycling source addresses): forget keys whose window has passed.
  _prune(nowMs) {
    if (this._state.size <= this.maxKeys) return;
    for (const [k, s] of this._state) {
      if (nowMs - s.lastAllowedAt >= this.windowMs) this._state.delete(k);
    }
  }
}

module.exports = { Throttle };
