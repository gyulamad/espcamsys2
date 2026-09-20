'use strict';

const { test, assertEqual, summarize } = require('./framework');
const timing = require('../../nodejs/camera-relay/lib/timing');

test('computeEnabledUntil returns null for indefinite (null seconds)', () => {
  assertEqual(timing.computeEnabledUntil(1000, null), null);
});

test('computeEnabledUntil adds seconds*1000 ms to now', () => {
  assertEqual(timing.computeEnabledUntil(1000, 5).getTime(), 6000);
});

test('computePoweredThroughDecision: already covered by the current timer', () => {
  const decision = timing.computePoweredThroughDecision(true, new Date(20000), 15000, 5000);
  assertEqual(decision, { alreadyCovered: true, powerSeconds: null });
});

test('computePoweredThroughDecision: camera currently off needs arming', () => {
  const decision = timing.computePoweredThroughDecision(false, null, 15000, 5000);
  assertEqual(decision.alreadyCovered, false);
  assertEqual(decision.powerSeconds, 10);
});

test('computePoweredThroughDecision: current timer ends before the recording does', () => {
  const decision = timing.computePoweredThroughDecision(true, new Date(9000), 15000, 5000);
  assertEqual(decision.alreadyCovered, false);
  assertEqual(decision.powerSeconds, 10);
});

test('computePoweredThroughDecision: rounds partial seconds up', () => {
  const decision = timing.computePoweredThroughDecision(false, null, 5500, 0);
  assertEqual(decision.powerSeconds, 6);
});

test('computePoweredThroughDecision: never returns less than 1 second', () => {
  const decision = timing.computePoweredThroughDecision(false, null, 100, 0);
  assertEqual(decision.powerSeconds, 1);
});

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
