'use strict';

// Tests the event-loop watch (nodejs/camera-relay/lib/loopwatch.js): the pulse
// that says whether the relay's single-threaded loop is still turning, and how
// long it was gone when it wasn't. What has to hold:
//   * a clean loop logs nothing but the periodic heartbeat line, which quotes
//     the worst stall since the previous line
//   * a stall that crosses a threshold is ONE WARN with the measured duration
//     (not one per threshold crossed), and ONE INFO when the loop catches up
//   * a stall that deepens logs the higher threshold too
//   * mild jitter (a busy-but-healthy loop) never warns, but the heartbeat
//     still reports it
//   * stop() cancels the timer and is idempotent; start() likewise
//   * a broken log, snapshot or probe never stops the watch, and the heartbeat
//     line just omits what it could not read
//
// The clock is faked (schedule/cancel/now injected) so a "stall" is simply a
// time jump between two fires of the poll timer — exactly what the module
// measures. (Sync style: the module never awaits, so neither do these tests.)

const { createLoopWatch, DEFAULT_POLL_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_THRESHOLDS_MS } = require('../../nodejs/camera-relay/lib/loopwatch');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

// A hand-driven clock: jump(ms) moves time forward and then fires every timer
// that became due, in schedule order. A timer scheduled for t+pollMs is NOT due
// at t, so one jump fires at most the one pending poll — a long jump means the
// loop "was blocked" the whole time and the timer fires once, late.
function fakeClock(startAt = 0) {
  let t = startAt;
  let seq = 0;
  const timers = new Map(); // seq -> { at, fn }
  return {
    now: () => t,
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    cancel: (h) => timers.delete(h),
    pending: () => timers.size,
    jump(ms) {
      t += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[0] - b[0]);
        if (due.length === 0) return;
        for (const [id, v] of due) { timers.delete(id); v.fn(); }
      }
    },
  };
}

// Collects what the watch logged, the way relayLog would have seen it.
function recorder() {
  const lines = [];
  return {
    log: (level, message) => { lines.push({ level, message }); },
    lines,
    warns: () => lines.filter((l) => l.level === 'WARN').map((l) => l.message),
    infos: () => lines.filter((l) => l.level === 'INFO').map((l) => l.message),
    text: () => lines.map((l) => `${l.level} ${l.message}`).join('\n'),
  };
}

const PROBES = { memory: () => ({ rss: 120 * 1048576, heapUsed: 40 * 1048576 }), fdCount: () => 87, uptime: () => 3600, snapshot: () => '3/4 cameras connected' };

// One clean minute: 245 poll steps of exactly pollMs, so every timer is on time.
function runCleanMinute(clock) {
  for (let i = 0; i < Math.ceil(DEFAULT_HEARTBEAT_MS / DEFAULT_POLL_MS); i++) clock.jump(DEFAULT_POLL_MS);
}

(() => {
  // ── the clean loop ──
  const clock = fakeClock();
  const rec = recorder();
  const watch = createLoopWatch({ log: rec.log, now: clock.now, schedule: clock.schedule, cancel: clock.cancel, ...PROBES });
  watch.start();
  runCleanMinute(clock);
  test('a clean loop logs exactly one heartbeat per minute, no warnings', () => {
    assertEqual(rec.warns(), []);
    assertEqual(rec.infos().length, 1);
    assertTrue(rec.infos()[0].includes('event loop alive'));
  });
  test('the heartbeat quotes the worst stall, memory, fds, uptime and the snapshot', () => {
    const line = rec.infos()[0];
    assertTrue(line.includes('worst stall since the last line: 0ms'), line);
    assertTrue(line.includes('rss 120MB, heap 40MB'), line);
    assertTrue(line.includes('87 fds'), line);
    assertTrue(line.includes('uptime 1h'), line);
    assertTrue(line.includes('3/4 cameras connected'), line);
  });

  // ── stalls ──
  // `stalled(D)`: four on-time polls, then the loop is "blocked" for D past the
  // due time of the next poll, then four on-time polls again.
  const stalled = (stallMs) => {
    const clock2 = fakeClock();
    const rec2 = recorder();
    const w = createLoopWatch({ log: rec2.log, now: clock2.now, schedule: clock2.schedule, cancel: clock2.cancel });
    w.start();
    for (let i = 0; i < 4; i++) clock2.jump(DEFAULT_POLL_MS);            // t=1000, next poll due at 1250
    clock2.jump(stallMs + DEFAULT_POLL_MS);                               // fires D late
    for (let i = 0; i < 4; i++) clock2.jump(DEFAULT_POLL_MS);            // caught up
    return { warns: rec2.warns(), infos: rec2.infos(), line: rec2.warns()[0] || '', recovered: rec2.infos().some((m) => m.includes('caught up')) };
  };

  let s = stalled(1500);
  test('a 1.5s stall is one WARN naming the measured duration', () => {
    assertEqual(s.warns.length, 1);
    assertTrue(s.line.includes('1.5s'), s.line);
    assertTrue(s.line.includes('one synchronous step'), s.line);
  });
  test('...and one INFO when the loop catches up again', () => assertTrue(s.recovered));

  s = stalled(6500);
  test('a 6.5s stall crosses two thresholds but logs ONE WARN, at the deeper level', () => {
    assertEqual(s.warns.length, 1);
    assertTrue(s.line.includes('6.5s'), s.line);
    assertTrue(s.line.includes('stuck on one synchronous thing'), s.line);
  });

  s = stalled(32000);
  test('a 32s stall logs the frozen level', () => {
    assertEqual(s.warns.length, 1);
    assertTrue(s.line.includes('32s'), s.line);
    assertTrue(s.line.includes('frozen'), s.line);
  });

  // ── jitter and cadence ──
  const clock3 = fakeClock();
  const rec3 = recorder();
  const watch3 = createLoopWatch({ log: rec3.log, now: clock3.now, schedule: clock3.schedule, cancel: clock3.cancel });
  watch3.start();
  for (let i = 0; i < Math.ceil(60000 / 370); i++) clock3.jump(370); // every poll 120ms late
  test('mild jitter (120ms) never warns, but the heartbeat reports the worst', () => {
    assertEqual(rec3.warns(), []);
    assertTrue(rec3.infos()[0].includes('worst stall since the last line: 120ms'), rec3.infos()[0]);
  });

  const clock4 = fakeClock();
  const rec4 = recorder();
  const watch4 = createLoopWatch({ log: rec4.log, now: clock4.now, schedule: clock4.schedule, cancel: clock4.cancel });
  watch4.start();
  for (let i = 0; i < Math.ceil(125000 / DEFAULT_POLL_MS); i++) clock4.jump(DEFAULT_POLL_MS);
  test('heartbeats come once a minute, not in a burst', () => assertEqual(rec4.infos().length, 2));

  // ── start/stop ──
  const clock5 = fakeClock();
  const rec5 = recorder();
  const watch5 = createLoopWatch({ log: rec5.log, now: clock5.now, schedule: clock5.schedule, cancel: clock5.cancel });
  watch5.start();
  watch5.start();
  clock5.jump(DEFAULT_POLL_MS);
  test('start() twice still leaves one poll timer', () => assertEqual(clock5.pending(), 1));
  watch5.stop();
  watch5.stop();
  test('stop() cancels the timer and is idempotent', () => assertEqual(clock5.pending(), 0));
  clock5.jump(120000);
  test('a stopped watch logs nothing', () => assertEqual(rec5.lines.length, 0));

  // ── custom thresholds ──
  const clock6 = fakeClock();
  const rec6 = recorder();
  const watch6 = createLoopWatch({ log: rec6.log, now: clock6.now, schedule: clock6.schedule, cancel: clock6.cancel, thresholds: [100] });
  watch6.start();
  clock6.jump(DEFAULT_POLL_MS * 4);
  clock6.jump(250); // 250ms late on a 100ms threshold
  test('injected thresholds are respected', () => assertEqual(rec6.warns().length, 1));

  // ── broken dependencies ──
  let logAttempts = 0;
  const clock7 = fakeClock();
  const watch7 = createLoopWatch({
    log: () => { logAttempts += 1; throw new Error('broken log'); },
    now: clock7.now, schedule: clock7.schedule, cancel: clock7.cancel,
  });
  watch7.start();
  runCleanMinute(clock7);
  test('a broken log never stops the watch', () => {
    assertTrue(logAttempts >= 1);
    assertEqual(clock7.pending(), 1);
  });

  const clock8 = fakeClock();
  const rec8 = recorder();
  const watch8 = createLoopWatch({
    log: rec8.log, now: clock8.now, schedule: clock8.schedule, cancel: clock8.cancel,
    memory: () => { throw new Error('broken'); },
    fdCount: () => { throw new Error('broken'); },
    snapshot: () => { throw new Error('broken'); },
    uptime: () => { throw new Error('broken'); },
  });
  watch8.start();
  runCleanMinute(clock8);
  test('broken probes degrade to a heartbeat without their parts', () => {
    assertEqual(rec8.warns(), []);
    assertEqual(rec8.infos().length, 1);
    const line = rec8.infos()[0];
    assertTrue(line.includes('event loop alive'), line);
    assertTrue(!line.includes('rss'), line);
    assertTrue(!line.includes('fds'), line);
    assertTrue(!line.includes('uptime'), line);
  });

  const clock9 = fakeClock();
  const rec9 = recorder();
  const watch9 = createLoopWatch({ log: rec9.log, now: clock9.now, schedule: clock9.schedule, cancel: clock9.cancel, fdCount: () => null, snapshot: () => '' });
  watch9.start();
  runCleanMinute(clock9);
  test('a null fdCount and an empty snapshot are simply omitted', () => {
    const line = rec9.infos()[0];
    assertTrue(!line.includes('fds'), line);
    assertTrue(line.endsWith(')'), line); // no dangling separator
  });

  test('defaults are the documented ones', () => {
    assertEqual(DEFAULT_POLL_MS, 250);
    assertEqual(DEFAULT_HEARTBEAT_MS, 60000);
    assertEqual(DEFAULT_THRESHOLDS_MS, [1000, 5000, 30000]);
  });
})();

summarize();
