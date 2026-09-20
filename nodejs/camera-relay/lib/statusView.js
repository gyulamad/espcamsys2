'use strict';

// statusView.js — builds the per-camera JSON shape returned by GET
// /status, extracted out of server.js so the shape can be pinned down
// with a test independent of Express or the in-memory `cameras` store.

function buildCameraStatusView(cam) {
  return {
    lastSeen: cam.lastSeen,
    enabled: cam.enabled,
    enabledUntil: cam.enabledUntil,
    recording: !!cam.recording,
    recordingStartedAt: cam.recording ? cam.recording.startedAt : null,
    recordingEndAt: cam.recording ? cam.recording.endAt : null,
  };
}

module.exports = { buildCameraStatusView };
