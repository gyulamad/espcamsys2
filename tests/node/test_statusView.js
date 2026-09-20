'use strict';

const { test, assertEqual, summarize } = require('./framework');
const { buildCameraStatusView } = require('../../nodejs/camera-relay/lib/statusView');

test('buildCameraStatusView: idle camera that has never recorded', () => {
  const cam = { lastSeen: null, enabled: true, enabledUntil: null, recording: null };
  assertEqual(buildCameraStatusView(cam), {
    lastSeen: null,
    enabled: true,
    enabledUntil: null,
    recording: false,
    recordingStartedAt: null,
    recordingEndAt: null,
  });
});

test('buildCameraStatusView: currently recording', () => {
  const startedAt = new Date(1000);
  const endAt = new Date(2000);
  const cam = { lastSeen: new Date(500), enabled: true, enabledUntil: null, recording: { startedAt, endAt } };
  const view = buildCameraStatusView(cam);
  assertEqual(view.recording, true);
  assertEqual(view.recordingStartedAt, startedAt);
  assertEqual(view.recordingEndAt, endAt);
});

test('buildCameraStatusView: powered on with an auto-off timer', () => {
  const enabledUntil = new Date(9000);
  const cam = { lastSeen: new Date(1), enabled: true, enabledUntil, recording: null };
  assertEqual(buildCameraStatusView(cam).enabledUntil, enabledUntil);
});

summarize();
