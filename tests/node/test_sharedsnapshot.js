'use strict';

// test_sharedsnapshot.js — one value worked out once for all its viewers (nodejs/camera-relay/lib/sharedsnapshot.js):
// nothing runs without a subscriber, one timer however many there are, a newcomer is told the newest value at once,
// a round that fails or overlaps is skipped.

const { assertEqual, assertTrue } = require('./framework');
const { createSharedSnapshot } = require('../../nodejs/camera-relay/lib/sharedsnapshot');

// The shared test() is synchronous; these tests wait for promises, so they run one after the other here.
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of queue) {
    try { await fn(); pass += 1; console.log(`[PASS] ${name}`); } catch (err) { fail += 1; console.error(`[FAIL] ${name} -- ${err.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
const flush = () => new Promise((r) => setImmediate(r));

function setup(computeImpl) {
  const t = { computes: 0, timers: [], cleared: 0, errors: [] };
  t.compute = computeImpl ? () => { t.computes += 1; return computeImpl(t.computes); } : async () => `v${++t.computes}`;
  t.setTimer = (fn, ms) => { t.timers.push({ fn, ms }); return t.timers.length; };
  t.clearTimer = () => { t.cleared += 1; };
  t.snapshot = createSharedSnapshot({ compute: t.compute, intervalMs: 2000, onError: (e) => t.errors.push(e.message), setTimer: t.setTimer, clearTimer: t.clearTimer });
  return t;
}

test('with nobody subscribed nothing runs: no timer, no work', async () => {
  const t = setup();
  await flush();
  assertEqual([t.computes, t.timers.length], [0, 0]);
});

test('the first subscriber starts one timer and gets the first value at once', async () => {
  const t = setup();
  const got = [];
  t.snapshot.subscribe((v) => got.push(v));
  await flush();
  assertEqual([t.timers.length, t.timers[0].ms, got], [1, 2000, ['v1']]);
});

test('every tick works the value out ONCE and hands it to every subscriber', async () => {
  const t = setup();
  const a = []; const b = [];
  t.snapshot.subscribe((v) => a.push(v));
  await flush();
  t.snapshot.subscribe((v) => b.push(v));
  t.timers[0].fn();
  await flush();
  assertEqual([t.computes, t.timers.length], [2, 1]);
  assertEqual([a, b], [['v1', 'v2'], ['v1', 'v2']], 'the newcomer was told the newest value at once, then the next one with the others');
});

test('a newcomer who comes before the first value exists simply gets it with the others', async () => {
  let release;
  const t = setup(() => new Promise((resolve) => { release = () => resolve('first'); }));
  const a = []; const b = [];
  t.snapshot.subscribe((v) => a.push(v));
  t.snapshot.subscribe((v) => b.push(v));
  release();
  await flush();
  assertEqual([a, b], [['first'], ['first']]);
});

test('a round still running when the next tick comes is not started twice', async () => {
  let release;
  const t = setup(() => new Promise((resolve) => { release = () => resolve('slow'); }));
  t.snapshot.subscribe(() => {});
  t.timers[0].fn();
  t.timers[0].fn();
  assertEqual(t.computes, 1);
  release();
  await flush();
  t.timers[0].fn();
  assertEqual(t.computes, 2, 'once it is done the next tick works again');
});

test('a round that fails is reported and skipped: the viewers keep what they had, the timer keeps going', async () => {
  const t = setup((n) => (n === 2 ? Promise.reject(new Error('disk gone')) : Promise.resolve(`v${n}`)));
  const got = [];
  t.snapshot.subscribe((v) => got.push(v));
  await flush();
  t.timers[0].fn();
  await flush();
  t.timers[0].fn();
  await flush();
  assertEqual([got, t.errors], [['v1', 'v3'], ['disk gone']]);
});

test('the last subscriber leaving stops the timer; leaving twice changes nothing; the next one starts it again with no old value', async () => {
  const t = setup();
  const a = []; const b = [];
  const stopA = t.snapshot.subscribe((v) => a.push(v));
  const stopB = t.snapshot.subscribe((v) => b.push(v));
  await flush();
  stopA();
  stopA();
  assertEqual(t.cleared, 0, 'one is still there');
  stopB();
  assertEqual(t.cleared, 1);
  const c = [];
  t.snapshot.subscribe((v) => c.push(v));
  assertEqual([t.timers.length, c], [2, []], 'no stale value: it waits for the first fresh one');
  await flush();
  assertEqual(c, ['v2']);
});

test('once everybody has left, two newcomers that arrive together are not told the old value', async () => {
  const t = setup();
  const stop = t.snapshot.subscribe(() => {});
  await flush();
  stop();
  const c1 = []; const c2 = [];
  t.snapshot.subscribe((v) => c1.push(v));
  t.snapshot.subscribe((v) => c2.push(v));
  assertEqual([c1, c2], [[], []], 'nothing from before they came');
  await flush();
  assertEqual([c1, c2], [['v2'], ['v2']]);
});

test('a subscriber that left hears nothing more', async () => {
  const t = setup();
  const a = [];
  const keep = [];
  const stop = t.snapshot.subscribe((v) => a.push(v));
  t.snapshot.subscribe((v) => keep.push(v));
  await flush();
  stop();
  t.timers[0].fn();
  await flush();
  assertEqual([a, keep], [['v1'], ['v1', 'v2']]);
});

runAll();
