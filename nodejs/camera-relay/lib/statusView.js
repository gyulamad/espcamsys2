'use strict';

// statusView.js — builds the per-camera JSON shape returned by GET
// /status, extracted out of server.js so the shape can be pinned down
// with a test independent of Express or the in-memory `cameras` store.
// `preRoll` is the camera's rolling-buffer fill (see lib/preroll.js) —
// bufferedSeconds close to windowSeconds means a recording started right
// now would get a full lead-in.

function buildCameraStatusView(cam) {
  return {
    lastSeen: cam.lastSeen,
    recording: !!cam.recording,
    recordingStartedAt: cam.recording ? cam.recording.startedAt : null,
    recordingEndAt: cam.recording ? cam.recording.endAt : null,
    preRoll: cam.preRoll ? cam.preRoll.stats : { frames: 0, bytes: 0, bufferedSeconds: 0, windowSeconds: 0 },
  };
}

module.exports = { buildCameraStatusView };
