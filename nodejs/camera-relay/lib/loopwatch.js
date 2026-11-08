'use strict';

// loopwatch.js — the relay's own pulse: how late the event loop runs, logged so a
// hanging dashboard can be split into "the relay is stuck" or "the relay is fine,
// the web server is not" without guessing.
//
// WHY THIS EXISTS. Everything the relay does for a camera — ingesting a frame,
// feeding a viewer, answering /status, reading a detector's uplink — happens on
// ONE event loop. When that loop is busy on a single synchronous step (a slow
// SD-card write, a blocked syscall), every camera stalls at once, detector boards
// reboot on their "the relay stopped accepting data" watchdog, and the dashboard
// looks dead even though the process is up. From the outside that is
// indistinguishable from the web server (Apache workers tied up by long-lived
// stream connections) being the problem — the two need the OPPOSITE fix, so the
// first fact to establish is which one it is.
//
// A repeating timer is the cheapest possible probe: Node fires timers in order,
// and a timer that runs late says the loop was unreachable for exactly that long
// (a healthy-but-busy relay shows a few milliseconds of jitter; seconds mean
// blocked). While the loop IS blocked no JavaScript runs — no log line either —
// so the absence of the heartbeat lines is itself the finding, and the moment the
// loop comes back the next tick reports how long it was gone.
//
// Behaviour:
//   * a poll timer fires every pollMs (250ms by default) and measures its own
//     lateness; the worst since the last heartbeat line is quoted in that line
//   * a stall crossing a threshold (1s / 5s / 30s by default) is one WARN at
//     once, with the measured duration and what to do while it lasts; a stall
//     that deepens logs the higher level too, and one INFO line says when the
//     loop caught up again
//   * every heartbeatMs (60s) one INFO line: worst stall, memory, open file
//     descriptors, uptime, and whatever `snapshot()` reports (who is connected)
//   * everything this module calls is guarded: a broken log, snapshot or probe
//     must never stop the watch, let alone the relay
//   * timers are unref'd, so the watch never keeps the process alive by itself
//
//   createLoopWatch({ log, now?, schedule?, cancel?, pollMs?, heartbeatMs?, thresholds?, memory?, fdCount?, uptime?, snapshot? })
//     -> { start(), stop() }   (both idempotent)
//
// server.js turns it off with LOOPWATCH=0; the thresholds and cadence are
// injectable so the tests (tests/node/test_loopwatch.js) drive a fake clock.

const fs = require('fs');

const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 60 * 1000;
const DEFAULT_THRESHOLDS_MS = [1000, 5000, 30000];

// What the WARN for a stall says, per threshold: the deeper the stall, the
// stronger the hint. The DEBUG runbook (download/14-dashboard-hang-debug-runbook.pdf)
// holds the actual commands; the log line only points there.
const THRESHOLD_NOTES = [
  'one synchronous step is blocking everything the relay does',
  'the relay is stuck on one synchronous thing — take a backtrace while it lasts (see the debug runbook)',
  'the relay is frozen — capture the evidence now (see the debug runbook)',
];

// A duration the way the relay's log already speaks: "12ms", "6.5s", "32s".
function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// An uptime the way people read it: "45s", "60m", "1h", "3.4h", "12h".
function uptimeText(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1).replace(/\.0$/, '')}h`;
}

// The default timer pair, unref'd (see header). Returned as an opaque handle.
function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
function defaultCancel(timer) {
  clearTimeout(timer);
}

// Linux: how many file descriptors the process holds. The listing briefly
// includes the one readdir itself opens, so one is subtracted. Anything else
// (not Linux), or a process already at its limit — readdir needs one more fd —
// answers null and the heartbeat simply says nothing about fds: the field
// disappearing from a line that used to have it is itself a hint.
function defaultFdCount() {
  try {
    return fs.readdirSync('/proc/self/fd').length - 1;
  } catch (err) {
    return null;
  }
}

function createLoopWatch({
  log,
  now = Date.now,
  schedule = defaultSchedule,
  cancel = defaultCancel,
  pollMs = DEFAULT_POLL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  thresholds = DEFAULT_THRESHOLDS_MS,
  memory = () => process.memoryUsage(),
  fdCount = defaultFdCount,
  uptime = () => process.uptime(),
  snapshot = () => null,
}) {
  if (typeof log !== 'function') throw new TypeError('log must be a function');

  // A reporting call that can never throw (a broken reporter must not stop the
  // watch — the same rule as lib/framequeue.js's guarded()).
  const safeLog = (level, message) => {
    try { log(level, message); } catch (err) { /* the reporter itself is broken; nothing to do */ }
  };
  const safeCall = (fn, fallback) => {
    try { return fn(); } catch (err) { return fallback; }
  };

  let timer = null;
  let running = false;
  let expectedAt = 0;      // when the pending poll timer should have fired
  let nextHeartbeatAt = 0; // when the next heartbeat line is due
  let worstLagMs = 0;      // worst stall since the last heartbeat line
  let level = -1;          // highest threshold the current stall crossed (-1: none)

  // The highest threshold a lag crosses, or -1 for none.
  const levelOf = (lag) => {
    let hit = -1;
    for (let i = 0; i < thresholds.length; i++) {
      if (lag >= thresholds[i]) hit = i;
    }
    return hit;
  };

  function heartbeat(t) {
    const mem = safeCall(memory, null);
    const fds = safeCall(fdCount, null);
    const up = safeCall(uptime, null);
    const snap = safeCall(snapshot, null);
    const parts = [
      `worst stall since the last line: ${worstLagMs > 0 ? duration(worstLagMs) : '0ms'}`,
      mem ? `rss ${Math.round(mem.rss / 1048576)}MB, heap ${Math.round(mem.heapUsed / 1048576)}MB` : null,
      fds !== null ? `${fds} fds` : null,
      up !== null && Number.isFinite(up) ? `uptime ${uptimeText(up)}` : null,
      typeof snap === 'string' && snap ? snap : null,
    ].filter(Boolean);
    safeLog('INFO', `event loop alive (${parts.join('; ')})`);
    worstLagMs = 0;
    while (nextHeartbeatAt <= t) nextHeartbeatAt += heartbeatMs; // catch up, don't burst
  }

  function tick() {
    if (!running) return;
    const t = now();
    const lag = Math.max(0, t - expectedAt);
    worstLagMs = Math.max(worstLagMs, lag);
    const newLevel = levelOf(lag);
    if (newLevel > level) {
      // One stall, one WARN — at the level the measured duration reaches. The
      // message quotes the MEASurement, which can be far past the threshold.
      safeLog('WARN', `the event loop stalled for ${duration(lag)} — ${THRESHOLD_NOTES[newLevel] || 'the relay was blocked'}`);
    } else if (level >= 0 && newLevel < 0) {
      safeLog('INFO', 'the event loop caught up again');
    }
    level = newLevel;
    if (t >= nextHeartbeatAt) heartbeat(t);
    expectedAt = t + pollMs;
    timer = schedule(tick, pollMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      const t = now();
      expectedAt = t + pollMs;
      nextHeartbeatAt = t + heartbeatMs;
      timer = schedule(tick, pollMs);
    },
    stop() {
      running = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}

module.exports = { createLoopWatch, DEFAULT_POLL_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_THRESHOLDS_MS };
