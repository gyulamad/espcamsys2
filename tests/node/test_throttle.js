'use strict';

const { test, assertEqual, summarize } = require('./framework');
const { Throttle } = require('../../nodejs/camera-relay/lib/throttle');

test('Throttle: the first occurrence is allowed, with nothing suppressed', () => {
  assertEqual(new Throttle(1000).check('a', 0), { allow: true, suppressed: 0 });
});

test('Throttle: repeats inside the window are suppressed', () => {
  const t = new Throttle(1000);
  t.check('a', 0);
  assertEqual(t.check('a', 10).allow, false);
  assertEqual(t.check('a', 999).allow, false);
});

test('Throttle: the first one after the window is allowed and reports how many were skipped', () => {
  const t = new Throttle(1000);
  t.check('a', 0);
  t.check('a', 100); t.check('a', 200); t.check('a', 300);
  assertEqual(t.check('a', 1000), { allow: true, suppressed: 3 });
  assertEqual(t.check('a', 1100).allow, false, 'a new window starts');
  assertEqual(t.check('a', 2000), { allow: true, suppressed: 1 });
});

test('Throttle: different keys are independent', () => {
  const t = new Throttle(1000);
  t.check('a', 0);
  assertEqual(t.check('b', 1).allow, true);
  assertEqual(t.check('a', 2).allow, false);
});

test('Throttle: a clock that jumps backwards does not suppress forever', () => {
  const t = new Throttle(1000);
  t.check('a', 5000);
  assertEqual(t.check('a', 100).allow, true);
});

test('Throttle: forgets expired keys so changing keys cannot grow memory without bound', () => {
  const t = new Throttle(1000, 10);
  for (let i = 0; i < 50; i++) t.check(`k${i}`, i); // all inside one window: nothing expired yet
  t.check('late', 5000); // everything before has now expired and is pruned
  assertEqual(t._state.size <= 2, true, `size=${t._state.size}`);
});

summarize();
