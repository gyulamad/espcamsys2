'use strict';

const { test, assertEqual, summarize } = require('./framework');
const { buildCameraStatusView } = require('../../nodejs/camera-relay/lib/statusView');

test('buildCameraStatusView: idle camera that has never recorded', () => {
  const cam = {
    lastSeen: null, enabled: true, enabledUntil: null, recording: null,
    aiCommand: { ai_enabled: true, live_peek_until_epoch: 0 },
  };
  assertEqual(buildCameraStatusView(cam), {
    lastSeen: null,
    enabled: true,
    enabledUntil: null,
    recording: false,
    recordingStartedAt: null,
    recordingEndAt: null,
    aiEnabled: true,
    livePeekUntilEpoch: 0,
  });
});

test('buildCameraStatusView: currently recording', () => {
  const startedAt = new Date(1000);
  const endAt = new Date(2000);
  const cam = {
    lastSeen: new Date(500), enabled: true, enabledUntil: null, recording: { startedAt, endAt },
    aiCommand: { ai_enabled: false, live_peek_until_epoch: 0 },
  };
  const view = buildCameraStatusView(cam);
  assertEqual(view.recording, true);
  assertEqual(view.recordingStartedAt, startedAt);
  assertEqual(view.recordingEndAt, endAt);
});

test('buildCameraStatusView: powered on with an auto-off timer', () => {
  const enabledUntil = new Date(9000);
  const cam = {
    lastSeen: new Date(1), enabled: true, enabledUntil, recording: null,
    aiCommand: { ai_enabled: false, live_peek_until_epoch: 0 },
  };
  assertEqual(buildCameraStatusView(cam).enabledUntil, enabledUntil);
});

// AI-alarm plan §7 step 2 — the status view now mirrors cam.aiCommand so
// the dashboard can poll and display the AI-alarm toggle's live state.
test('buildCameraStatusView: AI-alarm enabled with an active live-peek epoch', () => {
  const cam = {
    lastSeen: new Date(1), enabled: true, enabledUntil: null, recording: null,
    aiCommand: { ai_enabled: true, live_peek_until_epoch: 1699999999 },
  };
  const view = buildCameraStatusView(cam);
  assertEqual(view.aiEnabled, true);
  assertEqual(view.livePeekUntilEpoch, 1699999999);
});

test('buildCameraStatusView: missing aiCommand falls back to disabled/no-peek', () => {
  const cam = { lastSeen: null, enabled: true, enabledUntil: null, recording: null };
  const view = buildCameraStatusView(cam);
  assertEqual(view.aiEnabled, false);
  assertEqual(view.livePeekUntilEpoch, 0);
});

summarize();
