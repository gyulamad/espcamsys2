'use strict';

// Tests the scale of the motion bar on the dashboard page (php/cameras/index.php) by running exactly the block
// between its <motion-scale> markers. The stick that sets MOTION_THRESH is placed and dragged on this scale, so
// the scale has to stay still: it may depend on the threshold the detector REPORTS and on nothing else.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <motion-scale>\n([\s\S]*?)\/\/ <\/motion-scale>/.exec(page);
assertTrue(!!m, 'the page has a <motion-scale> block');
const { MOTION_SCALE_HEADROOM, MOTION_SCALE_MIN, nextMotionScale } = new Function(`${m[1]}\nreturn { MOTION_SCALE_HEADROOM, MOTION_SCALE_MIN, nextMotionScale };`)();

test('the bar is a fixed multiple of the reported threshold wide: room above it to raise the value', () => {
  assertEqual(MOTION_SCALE_HEADROOM, 4);
  assertEqual(nextMotionScale(undefined, 300), { reported: 300, scale: 1200 });
  assertEqual(nextMotionScale(undefined, 1000).scale, 4000);
});

test('a small (or switched off) threshold still gets a usable bar', () => {
  assertEqual([nextMotionScale(undefined, 5).scale, nextMotionScale(undefined, 25).scale, nextMotionScale(undefined, 26).scale], [MOTION_SCALE_MIN, MOTION_SCALE_MIN, 104]);
  assertEqual(nextMotionScale(undefined, 0).scale, MOTION_SCALE_MIN);
});

test('while the reported threshold stays, the scale is the very same object: the stick cannot move on its own', () => {
  const first = nextMotionScale(undefined, 300);
  for (let i = 0; i < 5; i += 1) assertTrue(nextMotionScale(first, 300) === first);
});

test('the scale follows the REPORTED threshold when the detector reports another one (after APPLY)', () => {
  const first = nextMotionScale(undefined, 300);
  assertEqual(nextMotionScale(first, 60), { reported: 60, scale: 240 });
  assertEqual(nextMotionScale(nextMotionScale(first, 60), 300), { reported: 300, scale: 1200 });
});

test('it does not take the live motion reading or a dragged value: the function has no way to see them', () => {
  assertEqual(nextMotionScale.length, 2);
  assertTrue(!/sc\.motion\b/.test(m[1]) && !/pending|detPending|eff\./.test(m[1]));
});

test('the page feeds it the detector\'s reported threshold only (never the pending one)', () => {
  assertTrue(/detScale\[id\] = nextMotionScale\(detScale\[id\], sc\.motionAtLeast\);/.test(page));
  assertTrue(!/motionScale\(id, [^)]*eff/.test(page));
});

summarize();
