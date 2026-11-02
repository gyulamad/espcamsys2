'use strict';
// live-pictures.js — the rules for keeping the dashboard's live pictures alive, with no DOM, no network
// and no clock of its own, so tests/node/test_live_pictures.js can run every rule.
// Loaded by the page as a plain script (window.CamLivePictures) and by the tests with require().
//
// A live picture (stream.php, detector-stream.php) is an <img> on a response that never ends. When the
// response DOES end — the relay restarted, the relay went quiet and the proxy gave up, the network
// dropped — the browser fires no event and records nothing useful (Chrome reports a multipart picture's
// Resource Timing at its FIRST frame, not at its end): it keeps showing the last frame, and the picture
// looks frozen. The one thing that always shows it is the picture itself: a live camera never sends the
// same pixels twice (sensor noise), a stalled one shows the same ones for ever.
//
//   fingerprint            a small number that identifies the pixels of a picture
//   createStallDetector    notices a picture whose fingerprint has not changed for too long
//   retryDelayMs           how long to wait before the n-th retry (exponential, capped)
//   createRetryScheduler   the retries themselves: one timer per picture, backing off while it keeps failing
//   leavesPage             does a click navigate this tab to another page (so the connections must be freed)

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamLivePictures = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const RETRY_BASE_MS = 2000;
  const RETRY_MAX_MS = 60000;
  // A picture that played at least this long was healthy: its next failure starts the back-off over.
  const STABLE_MS = 30000;

  // FNV-1a over the bytes of a small copy of the picture (RGBA pixels from a canvas) -> an unsigned 32-bit
  // number. Different pictures give different numbers except by a one-in-four-billion accident.
  function fingerprint(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  // Watches pictures by key. observe(key, fingerprint, nowMs) is called every few seconds with what the
  // picture looks like now; it answers null while the picture is changing (or has not stood still long
  // enough), and { playedMs } once the same picture has been on screen for `stallMs` — playedMs is how long
  // the picture was alive before it stopped, which the retry back-off uses. The caller forgets a picture
  // when it restarts it, so the new connection is judged afresh.
  function createStallDetector(stallMs) {
    const seen = new Map();   // key -> { fingerprint, since: first seen, changedAt: last time it changed }
    return {
      observe(key, print, nowMs) {
        const s = seen.get(key);
        if (!s) {
          seen.set(key, { fingerprint: print, since: nowMs, changedAt: nowMs });
          return null;
        }
        if (s.fingerprint !== print) {
          s.fingerprint = print;
          s.changedAt = nowMs;
          return null;
        }
        if (nowMs - s.changedAt < stallMs) return null;
        return { playedMs: s.changedAt - s.since };
      },
      forget(key) { seen.delete(key); },
    };
  }

  // The delay before retry number `attempt` (0 = the first): 2 s, 4 s, 8 s ... never more than a minute.
  function retryDelayMs(attempt) {
    const n = Math.max(0, Math.floor(attempt) || 0);
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n, 16));
  }

  // One pending retry per key (a picture). schedule() replaces whatever is pending for the key, so a picture
  // that fails twice before the timer fires is retried once. `lastedMs` is how long the failed picture
  // played: a stable one starts the back-off over, a picture that keeps dying at once backs off further.
  function createRetryScheduler(setTimer, clearTimer) {
    const pending = new Map();   // key -> timer
    const attempts = new Map();  // key -> failures in a row
    return {
      schedule(key, run, lastedMs = 0) {
        if (lastedMs >= STABLE_MS) attempts.delete(key);
        clearTimer(pending.get(key));
        const attempt = attempts.get(key) || 0;
        attempts.set(key, attempt + 1);
        pending.set(key, setTimer(() => { pending.delete(key); run(); }, retryDelayMs(attempt)));
      },
      cancel(key) {
        clearTimer(pending.get(key));
        pending.delete(key);
      },
      cancelAll() {
        for (const timer of pending.values()) clearTimer(timer);
        pending.clear();
      },
      isPending: (key) => pending.has(key),
    };
  }

  // Does this click take THIS tab to another page of the same site? `click` is { button, ctrlKey, metaKey,
  // shiftKey, altKey, defaultPrevented } and `link` is { href, target, download } of the <a> that was
  // clicked (null when the click was not on a link). Only then must the page give its connections back:
  // the browser allows about 6 per address, the live pictures hold them all, and the next page would wait
  // in the queue until the user pressed the browser's stop button.
  function leavesPage(click, link, pageUrl) {
    if (!link || !link.href || click.defaultPrevented) return false;
    if (click.button !== 0 || click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return false;
    if (link.download != null && link.download !== false) return false;
    if (link.target && link.target !== '_self') return false;
    let target;
    let here;
    try {
      here = new URL(pageUrl);
      target = new URL(link.href, here);
    } catch (err) {
      return false;
    }
    if (target.origin !== here.origin) return false;
    if (!/^https?:$/.test(target.protocol)) return false;
    return !(target.pathname === here.pathname && target.search === here.search && target.hash !== '');   // "#top": same page
  }

  return { fingerprint, createStallDetector, retryDelayMs, createRetryScheduler, leavesPage, STABLE_MS, RETRY_BASE_MS, RETRY_MAX_MS };
});
