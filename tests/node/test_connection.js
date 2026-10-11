'use strict';

const { test, assertEqual, summarize } = require('./framework');
const { LIVE_WINDOW_MS, classifyPreviousConnection, parseTimeoutMs } = require('../../nodejs/camera-relay/lib/connection');

test('a previous connection that sent data a moment ago is a second live sender', () => {
  assertEqual(classifyPreviousConnection(0), 'conflict');
  assertEqual(classifyPreviousConnection(LIVE_WINDOW_MS - 1), 'conflict');
});

test('a previous connection that has gone quiet is a stale leftover of the same board', () => {
  assertEqual(classifyPreviousConnection(LIVE_WINDOW_MS), 'stale');
  assertEqual(classifyPreviousConnection(817 * 1000), 'stale'); // the 817 s ghost from a real log
});

test('the live window is longer than the camera takes to give up on a stalled write', () => {
  // The firmware abandons a connection only after several seconds without progress
  // (PUSH_WRITE_TIMEOUT_MS: 4 s in older builds, 8 s now); the window must be shorter than
  // the older figure, or a plain reconnect would look like a conflict.
  assertEqual(LIVE_WINDOW_MS < 4000, true);
});

test('the live window can be overridden', () => {
  assertEqual(classifyPreviousConnection(500, 100), 'stale');
  assertEqual(classifyPreviousConnection(50, 100), 'conflict');
});

test('parseTimeoutMs: a positive number is used, anything else falls back', () => {
  assertEqual(parseTimeoutMs('1500', 60000), 1500);
  assertEqual(parseTimeoutMs(2500, 60000), 2500);
  assertEqual(parseTimeoutMs(undefined, 60000), 60000);
  assertEqual(parseTimeoutMs('', 60000), 60000);
  assertEqual(parseTimeoutMs('0', 60000), 60000);
  assertEqual(parseTimeoutMs('-5', 60000), 60000);
  assertEqual(parseTimeoutMs('soon', 60000), 60000);
});

summarize();
