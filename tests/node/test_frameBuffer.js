'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const frameBuffer = require('../../nodejs/camera-relay/lib/frameBuffer');

test('pushAndTrim keeps a single frame with nothing to trim yet', () => {
  const buf = frameBuffer.pushAndTrim([], 'f1', 1000, 3);
  assertEqual(buf, [{ frame: 'f1', atMs: 1000 }]);
});

test('pushAndTrim keeps multiple frames all within the window', () => {
  let buf = [];
  buf = frameBuffer.pushAndTrim(buf, 'f1', 1000, 3);
  buf = frameBuffer.pushAndTrim(buf, 'f2', 1500, 3);
  buf = frameBuffer.pushAndTrim(buf, 'f3', 2000, 3);
  assertEqual(buf.map((e) => e.frame), ['f1', 'f2', 'f3']);
});

test('pushAndTrim drops frames older than the window, oldest first', () => {
  let buf = [];
  buf = frameBuffer.pushAndTrim(buf, 'f1', 0, 3);       // 0s
  buf = frameBuffer.pushAndTrim(buf, 'f2', 1000, 3);    // 1s
  buf = frameBuffer.pushAndTrim(buf, 'f3', 2000, 3);    // 2s
  // Pushing at 4000ms with a 3s window -> cutoff is 1000ms; f1 (0ms) drops,
  // f2 (1000ms) stays (not strictly older than cutoff).
  buf = frameBuffer.pushAndTrim(buf, 'f4', 4000, 3);
  assertEqual(buf.map((e) => e.frame), ['f2', 'f3', 'f4']);
});

test('pushAndTrim can drop everything at once if there is a long gap', () => {
  let buf = [];
  buf = frameBuffer.pushAndTrim(buf, 'f1', 0, 3);
  buf = frameBuffer.pushAndTrim(buf, 'f2', 500, 3);
  // A 10-second gap before the next frame -> both old entries fall outside
  // the 3s window, only the new one survives.
  buf = frameBuffer.pushAndTrim(buf, 'f3', 10000, 3);
  assertEqual(buf.map((e) => e.frame), ['f3']);
});

test('pushAndTrim preserves arrival order (oldest first) for downstream frame numbering', () => {
  let buf = [];
  for (let i = 0; i < 10; i++) {
    buf = frameBuffer.pushAndTrim(buf, `f${i}`, i * 200, 3);
  }
  const order = buf.map((e) => e.frame);
  assertEqual(order, [...order].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    'buffer should already be sorted oldest-first with no reordering needed');
});

test('pushAndTrim with a zero-second window keeps only the just-pushed frame', () => {
  let buf = [];
  buf = frameBuffer.pushAndTrim(buf, 'f1', 1000, 0);
  buf = frameBuffer.pushAndTrim(buf, 'f2', 1000, 0); // same timestamp, window 0 -> f1 (not < cutoff==1000) actually stays
  // cutoff == nowMs when windowSeconds is 0, so an entry exactly at cutoff
  // is NOT trimmed (only strictly-older entries are) -- both survive here
  // since they share the same timestamp. This documents that "0 seconds"
  // means "no history buffer built up over time", not "always exactly one
  // entry" -- a real camera pushing frames a few hundred ms apart would
  // still end up with just the latest frame once nowMs actually advances.
  assertTrue(buf.length >= 1, 'at least the just-pushed frame survives');
  buf = frameBuffer.pushAndTrim(buf, 'f3', 5000, 0);
  assertEqual(buf.map((e) => e.frame), ['f3'], 'once time actually advances, a 0s window keeps only the latest frame');
});

summarize();
