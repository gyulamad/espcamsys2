'use strict';

const { test, assertEqual, summarize } = require('./framework');
const timing = require('../../nodejs/camera-relay/lib/timing');

test('computeRecordingWindow builds start/end from now + seconds', () => {
  const { startedAt, endAt } = timing.computeRecordingWindow(1000, 10);
  assertEqual(startedAt.getTime(), 1000);
  assertEqual(endAt.getTime(), 11000);
});

test('computeRecordingEndAt', () => {
  assertEqual(timing.computeRecordingEndAt(1000, 10).getTime(), 11000);
});

test('computeElapsedRemaining mid-recording', () => {
  const { elapsed, remaining } = timing.computeElapsedRemaining(5000, 0, 10000);
  assertEqual(elapsed, 5);
  assertEqual(remaining, 5);
});

test('computeElapsedRemaining clamps to zero before start / after end', () => {
  assertEqual(timing.computeElapsedRemaining(-1000, 0, 10000).elapsed, 0);
  assertEqual(timing.computeElapsedRemaining(20000, 0, 10000).remaining, 0);
});

summarize();
