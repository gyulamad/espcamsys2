'use strict';

// lockout.js — makes guessing a key slow. Pure: no Express, no timers, no fs — the caller passes `now` (ms).
//
// lib/throttle.js only keeps the LOG quiet; it never refuses anything. This one does: after `maxFailures`
// wrong keys from one source inside `windowMs`, that source is locked out for `baseLockMs`, and every lock that
// follows (before the source has been quiet for `forgetMs`) lasts twice as long, up to `maxLockMs`. While locked
// out even the RIGHT key is refused — otherwise the lock would only slow the guessing down for the first guess
// after it, not for the guesses themselves.
//
// What counts as a failure is decided by the caller (the relay counts a key that was presented and was wrong,
// not a request that carried no key at all: that is a client that forgot it, not a guess).
//
// Memory is bounded: at most `maxEntries` sources are remembered; expired ones go first, then the oldest.

class Lockout {
  constructor({ maxFailures = 10, windowMs = 60 * 1000, baseLockMs = 60 * 1000, maxLockMs = 15 * 60 * 1000, forgetMs = 30 * 60 * 1000, maxEntries = 2000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.forgetMs = forgetMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // source -> { fails, windowStart, lockedUntil, level, lastSeen }
  }

  // Is this source locked out right now? -> { blocked: false } or { blocked: true, retryAfterSec }
  check(source, now) {
    const e = this.entries.get(source);
    if (!e || e.lockedUntil <= now) return { blocked: false };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((e.lockedUntil - now) / 1000)) };
  }

  // One wrong key. -> { locked: false } while the source is still under the limit, or
  // { locked: true, lockSec, level, failures } at the moment the lock starts (so the caller can log it once).
  fail(source, now) {
    let e = this.entries.get(source);
    if (e && e.lockedUntil > now) return { locked: false, alreadyLocked: true }; // nothing to add: it is refused anyway
    if (e && now - e.lastSeen > this.forgetMs) e = null;                          // quiet for long enough: start over
    if (!e) {
      this.makeRoom(now);
      e = { fails: 0, windowStart: now, lockedUntil: 0, level: 0, lastSeen: now };
    }
    this.entries.delete(source); // re-inserted below, so Map order = least recently active first
    if (now - e.windowStart > this.windowMs) { e.fails = 0; e.windowStart = now; }
    e.fails += 1;
    e.lastSeen = now;
    let result = { locked: false };
    if (e.fails >= this.maxFailures) {
      e.level += 1;
      const lockMs = Math.min(this.baseLockMs * 2 ** (e.level - 1), this.maxLockMs);
      e.lockedUntil = now + lockMs;
      result = { locked: true, lockSec: Math.ceil(lockMs / 1000), level: e.level, failures: e.fails };
      e.fails = 0;
      e.windowStart = now;
    }
    this.entries.set(source, e);
    return result;
  }

  // The right key from a source that is not locked out: forget its failures. (Never called for a locked source.)
  success(source, now) {
    const e = this.entries.get(source);
    if (e && e.lockedUntil <= now) this.entries.delete(source);
  }

  size() {
    return this.entries.size;
  }

  // Before adding a source to a full table: drop expired entries, then the least recently active.
  makeRoom(now) {
    if (this.entries.size < this.maxEntries) return;
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.lastSeen > this.windowMs) this.entries.delete(k);
    }
    // Still full: drop the least recently active source that is NOT locked out (a lock in force is the one thing
    // worth keeping); only if every remaining source is locked does the oldest of them go.
    while (this.entries.size >= this.maxEntries) {
      let victim = null;
      for (const [k, e] of this.entries) {
        if (e.lockedUntil <= now) { victim = k; break; }
      }
      this.entries.delete(victim !== null ? victim : this.entries.keys().next().value);
    }
  }
}

module.exports = { Lockout };
