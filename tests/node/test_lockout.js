'use strict';

// test_lockout.js — lib/lockout.js: guessing a key must get slower and slower (security review R-04).
// Pure logic with an injected clock: nothing here waits.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { Lockout } = require('../../nodejs/camera-relay/lib/lockout');

const SEC = 1000;
const make = (over = {}) => new Lockout(Object.assign({ maxFailures: 3, windowMs: 10 * SEC, baseLockMs: 60 * SEC, maxLockMs: 600 * SEC, forgetMs: 1800 * SEC, maxEntries: 100 }, over));
const failTimes = (l, src, n, t0 = 0, step = 100) => { let last; for (let i = 0; i < n; i += 1) last = l.fail(src, t0 + i * step); return last; };

test('a source that has done nothing is not blocked', () => {
  assertEqual(make().check('1.2.3.4', 0), { blocked: false });
});

test('failures under the limit do not lock anyone', () => {
  const l = make();
  const r = failTimes(l, 'a', 2);
  assertEqual(r.locked, false);
  assertEqual(l.check('a', 500).blocked, false);
});

test('the Nth wrong key inside the window locks the source, and says so exactly once', () => {
  const l = make();
  assertEqual(l.fail('a', 0).locked, false);
  assertEqual(l.fail('a', 100).locked, false);
  const r = l.fail('a', 200);
  assertEqual(r, { locked: true, lockSec: 60, level: 1, failures: 3 });
  assertEqual(l.fail('a', 300), { locked: false, alreadyLocked: true }); // refused anyway; not reported again
  const c = l.check('a', 1200);
  assertTrue(c.blocked, 'blocked');
  assertEqual(c.retryAfterSec, 59);
});

test('the lock ends on time, and the source may try again', () => {
  const l = make();
  failTimes(l, 'a', 3);                       // locked at t=200 for 60 s
  assertTrue(l.check('a', 60 * SEC).blocked);
  assertEqual(l.check('a', 60 * SEC + 300).blocked, false);
});

test('failures further apart than the window do not add up', () => {
  const l = make();
  l.fail('a', 0); l.fail('a', 1 * SEC);
  assertEqual(l.fail('a', 30 * SEC).locked, false);  // the window has passed: counting starts again
  assertEqual(l.check('a', 30 * SEC).blocked, false);
});

test('each lock is twice as long as the one before, up to the maximum', () => {
  const l = make();
  let now = 0; const secs = [];
  for (let i = 0; i < 6; i += 1) {
    const r = failTimes(l, 'a', 3, now);
    secs.push(r.lockSec);
    now += r.lockSec * SEC + 1000; // wait the lock out, then start guessing again
  }
  assertEqual(secs, [60, 120, 240, 480, 600, 600]);
});

test('while locked out the RIGHT key is refused too (the caller checks the lock first)', () => {
  const l = make();
  failTimes(l, 'a', 3);
  assertTrue(l.check('a', 5 * SEC).blocked);
  l.success('a', 5 * SEC); // must not unlock a locked source
  assertTrue(l.check('a', 5 * SEC).blocked);
});

test('a right key from a source that is not locked forgets its earlier failures', () => {
  const l = make();
  l.fail('a', 0); l.fail('a', 100);
  l.success('a', 200);
  assertEqual(l.fail('a', 300).locked, false);
  assertEqual(l.fail('a', 400).locked, false);   // only 2 since the success
  assertEqual(l.size(), 1);
  l.success('a', 500);
  assertEqual(l.size(), 0);
});

test('sources are independent of each other', () => {
  const l = make();
  failTimes(l, 'a', 3);
  assertTrue(l.check('a', 1000).blocked);
  assertEqual(l.check('b', 1000).blocked, false);
  assertEqual(l.fail('b', 1000).locked, false);
});

test('after a long quiet time the doubling starts over', () => {
  const l = make();
  failTimes(l, 'a', 3);                                   // level 1 (60 s)
  let r = failTimes(l, 'a', 3, 61 * SEC);                 // level 2 (120 s)
  assertEqual(r.lockSec, 120);
  r = failTimes(l, 'a', 3, 5000 * SEC);                   // quiet for > forgetMs
  assertEqual(r.lockSec, 60);
});

test('the table of sources is bounded: expired entries go first, then the least recently active', () => {
  const l = make({ maxEntries: 5 });
  for (let i = 0; i < 5; i += 1) l.fail(`old${i}`, i);
  assertEqual(l.size(), 5);
  l.fail('new1', 100 * SEC);                              // old ones are quiet for > windowMs: dropped to make room
  assertTrue(l.size() <= 5, `size ${l.size()}`);
  for (let i = 0; i < 50; i += 1) l.fail(`spray${i}`, 100 * SEC + i);
  assertTrue(l.size() <= 5, `size ${l.size()} after a spray from many sources`);
});

test('a lock in force survives a spray from many sources that fills the table', () => {
  const l = make({ maxEntries: 3 });
  failTimes(l, 'attacker', 3, 0);                         // locked until t=60 s
  for (let i = 0; i < 20; i += 1) l.fail(`spray${i}`, 1000 + i);
  assertTrue(l.size() <= 3, `size ${l.size()}`);
  assertTrue(l.check('attacker', 2000).blocked, 'the attacker is still locked out');
});

test('when every source in a full table is locked, the oldest lock gives way (the table stays bounded)', () => {
  const l = make({ maxEntries: 2 });
  failTimes(l, 'a', 3, 0); failTimes(l, 'b', 3, 1000); failTimes(l, 'c', 3, 2000);
  assertEqual(l.size(), 2);
  assertTrue(l.check('c', 3000).blocked);
});

test('retryAfterSec is at least 1 and rounds up', () => {
  const l = make();
  failTimes(l, 'a', 3);                                   // locked until 200 + 60000
  assertEqual(l.check('a', 60 * SEC + 199).retryAfterSec, 1);
  assertEqual(l.check('a', 200).retryAfterSec, 60);
});

summarize();
