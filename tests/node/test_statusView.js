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
    recordingCount: null, // not known unless the caller says
    recordingOff: null,   // may record, unless the caller says it is switched OFF
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

test('buildCameraStatusView: reports how many recordings the camera has (for the dashboard FILES button)', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam, 7).recordingCount, 7);
  assertEqual(buildCameraStatusView(cam, 0).recordingCount, 0, '0 is a real count, not "unknown"');
  assertEqual(buildCameraStatusView(cam, null).recordingCount, null, 'null = the folder could not be read');
});

test('buildCameraStatusView: a camera that only exists as a folder of footage (never seen) still builds', () => {
  const view = buildCameraStatusView({ lastSeen: null, recording: null, preRoll: null }, 3);
  assertEqual(view.recording, false);
  assertEqual(view.preRoll, EMPTY_PREROLL);
  assertEqual(view.recordingCount, 3);
});

test('buildCameraStatusView: reports whether the camera is switched OFF (for the dashboard)', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam, 0, null).recordingOff, null);
  const off = { forever: false, until: '2026-10-03T13:00:00.000Z', remainingMs: 1800000 };
  assertEqual(buildCameraStatusView(cam, 0, off).recordingOff, off);
  assertEqual(buildCameraStatusView(cam, 0, { forever: true, until: null, remainingMs: null }).recordingOff.forever, true);
});

summarize();
