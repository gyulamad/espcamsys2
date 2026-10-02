'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { buildCameraStatusView } = require('../../nodejs/camera-relay/lib/statusView');
const { PreRollBuffer } = require('../../nodejs/camera-relay/lib/preroll');

const EMPTY_PREROLL = { frames: 0, bytes: 0, bufferedSeconds: 0, windowSeconds: 0 };

test('buildCameraStatusView: idle camera that has never recorded', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam), {
    lastSeen: null,
    recording: false,
    recordingStartedAt: null,
    recordingEndAt: null,
    preRoll: EMPTY_PREROLL,
  });
});

test('buildCameraStatusView: currently recording', () => {
  const startedAt = new Date(1000);
  const endAt = new Date(2000);
  const cam = { lastSeen: new Date(500), recording: { startedAt, endAt } };
  const view = buildCameraStatusView(cam);
  assertEqual(view.recording, true);
  assertEqual(view.recordingStartedAt, startedAt);
  assertEqual(view.recordingEndAt, endAt);
});

test('buildCameraStatusView: no longer reports any power state (cameras always stream)', () => {
  const view = buildCameraStatusView({ lastSeen: null, recording: null });
  assertTrue(!('enabled' in view) && !('enabledUntil' in view), 'power fields must be gone');
});

test('buildCameraStatusView: reports the pre-roll buffer fill', () => {
  const preRoll = new PreRollBuffer({ seconds: 5 });
  preRoll.push(Buffer.alloc(10), 1000);
  preRoll.push(Buffer.alloc(10), 3000);
  const view = buildCameraStatusView({ lastSeen: new Date(3000), recording: null, preRoll });
  assertEqual(view.preRoll, { frames: 2, bytes: 20, bufferedSeconds: 2, windowSeconds: 5 });
});

summarize();
