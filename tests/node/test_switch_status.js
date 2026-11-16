'use strict';

// test_switch_status.js — the recording switch's words (js/switch-status.js): how long recording stays OFF
// ("59 s", "2 min", "1 h 05 min"), the pill's text for each state, and the list of EVERY text a countdown can
// show (F-35: the page reserves the pill's width for it, so a tick of the countdown can never move the layout).
// Pure rules with the time passed in — no DOM, no clock.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const S = require('../../php/cameras/js/switch-status');

const MIN = 60000, HOUR = 3600000;

test('formatRemaining: seconds below a minute (never 0)', () => {
  assertEqual(S.formatRemaining(59000), '59 s');
  assertEqual(S.formatRemaining(1000), '1 s');
  assertEqual(S.formatRemaining(0), '1 s');
  assertEqual(S.formatRemaining(59999), '60 s');
});

test('formatRemaining: whole minutes below an hour (rounded up)', () => {
  assertEqual(S.formatRemaining(MIN), '1 min');
  assertEqual(S.formatRemaining(3540000), '59 min');
  assertEqual(S.formatRemaining(59.2 * MIN), '1 h');   // 60 whole minutes read as their hour
});

test('formatRemaining: hours, with the minutes at two digits', () => {
  assertEqual(S.formatRemaining(HOUR), '1 h');
  assertEqual(S.formatRemaining(61 * MIN), '1 h 01 min');
  assertEqual(S.formatRemaining(2 * HOUR + 5 * MIN), '2 h 05 min');
});

test('label: no state is REC ON; forever is until switched ON', () => {
  assertEqual(S.label(null, 1000), { text: 'REC ON', off: false });
  assertEqual(S.label(undefined, 1000), { text: 'REC ON', off: false });
  assertEqual(S.label({ forever: true, untilAt: null }, 1000), { text: 'REC OFF · until switched ON', off: true });
});

test('label: a timed OFF names what is left and when it ends (the time is passed in, not read off a clock)', () => {
  const st = { forever: false, untilAt: 10 * MIN };
  assertEqual(S.label(st, 0).text, 'REC OFF · 10 min left (until ' + new Date(10 * MIN).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')');
  assertTrue(S.label(st, 0).off === true);
  // past the end (the tick came late): what is left never goes below "1 s"
  assertTrue(/^\d+ s$/.test(S.label(st, 10 * MIN + 5000).text.match(/· (.*) left/)[1]), 'past the end, seconds only');
});

test('labelCandidates: the widest of every shape a countdown from `ms` passes, with the page\'s own "(until ...)"', () => {
  const c = S.labelCandidates(2 * MIN, '14:05');
  assertEqual(c.length, new Set(c).size, 'no duplicates');
  assertTrue(c.includes('REC OFF · 59 s left (until 14:05)'), 'the widest seconds');
  assertTrue(c.includes('REC OFF · 59 min left (until 14:05)'), 'the widest minutes (a 2-minute window only says "1 min"/"2 min": narrower)');
  assertTrue(c.includes('REC ON'), 'the ON state can show at any time');
  assertTrue(c.includes('REC OFF · until switched ON'), 'the forever state can show at any time');
  assertTrue(!c.some((t) => t.includes(' h ')), 'a window below an hour never shows hours');
  // nothing the countdown can show is wider than the list's widest
  const widest = Math.max(...c.map((t) => t.length));
  for (let s = 1; s <= 120; s += 1) {
    const text = `REC OFF · ${S.formatRemaining(s * 1000)} left (until 14:05)`;
    assertTrue(text.length <= widest, text);
  }
});

test('labelCandidates: a longer window covers its hours; no reachable text is wider than the list\'s widest', () => {
  const c = S.labelCandidates(65 * MIN, '08:00');
  assertTrue(c.includes('REC OFF · 1 h left (until 08:00)'), 'the exact hour');
  assertTrue(c.includes('REC OFF · 1 h 05 min left (until 08:00)'), 'the window itself, hours with minutes');
  // every text formatRemaining() can produce inside the window is at most as wide as one of the candidates
  const widest = Math.max(...c.map((t) => t.length));
  for (let m = 1; m <= 65; m += 1) {
    const text = `REC OFF · ${S.formatRemaining(m * MIN)} left (until 08:00)`;
    assertTrue(text.length <= widest, text);
  }
  for (let s = 1; s <= 59; s += 1) {
    const text = `REC OFF · ${S.formatRemaining(s * 1000)} left (until 08:00)`;
    assertTrue(text.length <= widest, text);
  }
});

test('labelCandidates: a negative or missing window is just the two standing texts', () => {
  assertEqual(S.labelCandidates(0), ['REC ON', 'REC OFF · until switched ON']);
  assertEqual(S.labelCandidates(-5), ['REC ON', 'REC OFF · until switched ON']);
  assertEqual(S.labelCandidates(), ['REC ON', 'REC OFF · until switched ON']);
});

test('labelCandidates: without an `until` the labels carry no "(until ...)"', () => {
  const c = S.labelCandidates(2 * MIN);
  assertTrue(c.includes('REC OFF · 59 min left'), 'no suffix');
});

test('labelCandidates of a week-long window stays small enough to reserve from (the candidates are the widest of each shape, not every tick)', () => {
  const c = S.labelCandidates(7 * 24 * HOUR, '12:34');
  assertTrue(c.length < 20, `${c.length} candidates`);
  assertTrue(c.some((t) => t.includes('168 h left')), 'the week\'s own hour shape');
  assertTrue(c.some((t) => t.includes('167 h 59 min left')), 'hours with minutes, at the hour below (the window itself is a whole hour)');
  // nothing a week-long countdown can show is wider than the list's widest
  const widest = Math.max(...c.map((t) => t.length));
  for (let m = 1; m <= 7 * 24 * 60; m += 1) {
    const text = `REC OFF · ${S.formatRemaining(m * MIN)} left (until 12:34)`;
    assertTrue(text.length <= widest, text);
  }
});

test('labelCandidates of a window that is not a whole hour: the window itself is the widest hours-with-minutes text', () => {
  const windowMs = 65 * MIN + 30 * 1000;
  const c = S.labelCandidates(windowMs, '08:00');
  assertTrue(c.includes(`REC OFF · ${S.formatRemaining(windowMs)} left (until 08:00)`), formatRemainingAsString(windowMs));
  const widest = Math.max(...c.map((t) => t.length));
  for (let m = 1; m <= 66; m += 1) {
    const text = `REC OFF · ${S.formatRemaining(m * MIN)} left (until 08:00)`;
    assertTrue(text.length <= widest, text);
  }
});

function formatRemainingAsString(ms) {
  return `the window's own remaining time (${S.formatRemaining(ms)})`;
}

test('NO_DATA is the pill\'s third look (the relay answers nothing)', () => {
  assertEqual(S.NO_DATA, 'NO DATA');
});

summarize();
