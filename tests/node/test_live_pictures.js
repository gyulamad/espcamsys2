'use strict';

// test_live_pictures.js — the rules that keep the dashboard's live pictures alive
// (php/cameras/js/live-pictures.js): noticing a picture that stopped moving, retrying with back-off, and
// knowing when a click leaves the page (so the pictures give their connections back first).

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const L = require('../../php/cameras/js/live-pictures');

const BASE = 'http://pi.local/camdash/index.php';
const abs = (p) => 'http://pi.local/camdash/' + p;

// ── fingerprint ──────────────────────────────────────────────────────

test('fingerprint: the same pixels give the same number, different pixels another', () => {
  const a = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  const same = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  const noisy = Uint8Array.from([1, 2, 3, 255, 4, 5, 7, 255]);   // one value off by one
  assertEqual(L.fingerprint(a), L.fingerprint(same));
  assertTrue(L.fingerprint(a) !== L.fingerprint(noisy), 'a single changed value changes it');
});

test('fingerprint: order matters, and the result is an unsigned 32-bit number', () => {
  assertTrue(L.fingerprint([1, 2]) !== L.fingerprint([2, 1]));
  for (const bytes of [[], [0], [255, 255, 255, 255], new Uint8Array(5000).fill(7)]) {
    const f = L.fingerprint(bytes);
    assertTrue(Number.isInteger(f) && f >= 0 && f <= 0xffffffff, `${f} is not an unsigned 32-bit number`);
  }
});

// ── createStallDetector ──────────────────────────────────────────────

test('stall: a picture that keeps changing is never stalled', () => {
  const d = L.createStallDetector(10000);
  for (let t = 0; t <= 60000; t += 2000) assertEqual(d.observe('cam:a', t, t), null);
});

test('stall: the same picture for the whole stall time is stalled, and not a moment before', () => {
  const d = L.createStallDetector(10000);
  assertEqual(d.observe('k', 7, 0), null);
  assertEqual(d.observe('k', 7, 9999), null);
  assertTrue(d.observe('k', 7, 10000) !== null);
});

test('stall: the time stood still counts from the LAST change, not from the first look', () => {
  const d = L.createStallDetector(10000);
  d.observe('k', 1, 0);
  d.observe('k', 2, 6000);   // it moved at 6 s
  assertEqual(d.observe('k', 2, 15999), null);
  assertTrue(d.observe('k', 2, 16000) !== null);
});

test('stall: it says how long the picture was alive before it stopped (for the retry back-off)', () => {
  const d = L.createStallDetector(10000);
  d.observe('k', 1, 1000);
  d.observe('k', 2, 21000);   // alive from 1 s to 21 s
  assertEqual(d.observe('k', 2, 31000), { playedMs: 20000 });
});

test('stall: a picture that never moved was alive for no time', () => {
  const d = L.createStallDetector(5000);
  d.observe('k', 9, 0);
  assertEqual(d.observe('k', 9, 5000), { playedMs: 0 });
});

test('stall: pictures are judged separately, and a forgotten one starts afresh', () => {
  const d = L.createStallDetector(10000);
  d.observe('a', 1, 0); d.observe('b', 1, 0);
  d.observe('b', 2, 8000);
  assertTrue(d.observe('a', 1, 10000) !== null, 'a stood still');
  assertEqual(d.observe('b', 2, 10000), null, 'b moved two seconds ago');
  d.forget('a');
  assertEqual(d.observe('a', 1, 10001), null, 'a is new again: its stall time starts now');
  assertEqual(d.observe('a', 1, 20000), null);
  assertTrue(d.observe('a', 1, 20001) !== null);
});

test('stall: forgetting a picture that was never seen is harmless', () => {
  L.createStallDetector(1000).forget('nothing');
});

// ── retryDelayMs ─────────────────────────────────────────────────────

test('retryDelayMs: doubles from the base and stops at the cap', () => {
  assertEqual([0, 1, 2, 3, 4, 5, 6, 7].map(L.retryDelayMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('retryDelayMs: nonsense attempts get the first delay, huge ones do not overflow', () => {
  assertEqual([-3, NaN, undefined, 1.9].map(L.retryDelayMs), [2000, 2000, 2000, 4000]);
  assertEqual(L.retryDelayMs(1e9), L.RETRY_MAX_MS);
});

// ── createRetryScheduler ─────────────────────────────────────────────

function fakeTimers() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    set: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    count: () => timers.size,
  };
}

test('scheduler: the retry runs once after the delay, not before', () => {
  const t = fakeTimers(), s = L.createRetryScheduler(t.set, t.clear);
  let runs = 0;
  s.schedule('cam:a', () => { runs += 1; });
  assertTrue(s.isPending('cam:a'));
  t.advance(1999);
  assertEqual(runs, 0);
  t.advance(1);
  assertEqual(runs, 1);
  assertTrue(!s.isPending('cam:a'));
});

test('scheduler: a picture that keeps failing backs off; each failure waits longer', () => {
  const t = fakeTimers(), s = L.createRetryScheduler(t.set, t.clear);
  let runs = 0;
  const go = () => { runs += 1; };
  s.schedule('k', go); t.advance(2000);
  s.schedule('k', go); t.advance(3999); assertEqual(runs, 1); t.advance(1);
  s.schedule('k', go); t.advance(7999); assertEqual(runs, 2); t.advance(1);
  assertEqual(runs, 3);
});

test('scheduler: a picture that played long enough starts the back-off over', () => {
  const t = fakeTimers(), s = L.createRetryScheduler(t.set, t.clear);
  let runs = 0;
  const go = () => { runs += 1; };
  s.schedule('k', go); t.advance(2000);
  s.schedule('k', go); t.advance(4000);
  s.schedule('k', go, L.STABLE_MS); t.advance(2000);   // healthy for a while: back to the first delay
  assertEqual(runs, 3);
});

test('scheduler: failing twice before the timer fires still retries only once', () => {
  const t = fakeTimers(), s = L.createRetryScheduler(t.set, t.clear);
  let runs = 0;
  s.schedule('k', () => { runs += 1; });
  s.schedule('k', () => { runs += 1; });
  assertEqual(t.count(), 1);
  t.advance(60000);
  assertEqual(runs, 1);
});

test('scheduler: pictures are independent, and cancel / cancelAll stop what is pending', () => {
  const t = fakeTimers(), s = L.createRetryScheduler(t.set, t.clear);
  const ran = [];
  s.schedule('a', () => ran.push('a'));
  s.schedule('b', () => ran.push('b'));
  s.schedule('c', () => ran.push('c'));
  s.cancel('a');
  s.cancel('nothing-pending');
  t.advance(2000);
  assertEqual(ran.sort(), ['b', 'c']);
  s.schedule('d', () => ran.push('d'));
  s.cancelAll();
  t.advance(120000);
  assertEqual(ran.includes('d'), false);
  assertEqual(t.count(), 0);
});

// ── leavesPage ───────────────────────────────────────────────────────

const click = (extra) => Object.assign({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false }, extra);
const link = (href, extra) => Object.assign({ href, target: '', download: null }, extra);

test('leavesPage: a plain click on a link to another page of the site leaves', () => {
  assertTrue(L.leavesPage(click(), link(abs('simple-list.php')), BASE));
  assertTrue(L.leavesPage(click(), link('all-recordings.php'), BASE));
  assertTrue(L.leavesPage(click(), link(abs('index.php?x=1')), BASE));
});

test('leavesPage: a click that opens somewhere else, or does not navigate, does not leave', () => {
  assertTrue(!L.leavesPage(click({ ctrlKey: true }), link(abs('simple-list.php')), BASE));
  assertTrue(!L.leavesPage(click({ metaKey: true }), link(abs('simple-list.php')), BASE));
  assertTrue(!L.leavesPage(click({ shiftKey: true }), link(abs('simple-list.php')), BASE));
  assertTrue(!L.leavesPage(click({ button: 1 }), link(abs('simple-list.php')), BASE));
  assertTrue(!L.leavesPage(click({ defaultPrevented: true }), link(abs('simple-list.php')), BASE));
  assertTrue(!L.leavesPage(click(), link(abs('simple-list.php'), { target: '_blank' }), BASE));
  assertTrue(!L.leavesPage(click(), link(abs('f.mp4'), { download: '' }), BASE));
});

test('leavesPage: _self counts as this tab; another site, a script address and a jump on the same page do not leave', () => {
  assertTrue(L.leavesPage(click(), link(abs('simple-list.php'), { target: '_self' }), BASE));
  assertTrue(!L.leavesPage(click(), link('https://example.com/'), BASE));
  assertTrue(!L.leavesPage(click(), link('javascript:void(0)'), BASE));
  assertTrue(!L.leavesPage(click(), link('#top'), BASE));
  assertTrue(!L.leavesPage(click(), link(abs('index.php#cam1')), BASE));
});

test('leavesPage: a click that is not on a link, or on a link without an address, does not leave', () => {
  assertTrue(!L.leavesPage(click(), null, BASE));
  assertTrue(!L.leavesPage(click(), link(''), BASE));
  assertTrue(!L.leavesPage(click(), link(abs('x.php')), 'not a url'));
});

summarize();
