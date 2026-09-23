'use strict';

// statusView.js — builds the per-camera JSON shape returned by GET
// /status, extracted out of server.js so the shape can be pinned down
// with a test independent of Express or the in-memory `cameras` store.

// AI-alarm plan §7 step 2 adds `aiEnabled`/`livePeekUntilEpoch`, mirroring
// `cam.aiCommand` — the same state sendAiAlarmCommand() pushes down the
// camera's push socket — so the dashboard can show/poll the AI-alarm
// toggle's current state the same way it already does for `enabled`
// (power) and `recording`. Falls back to the command channel's own
// no-override default if `cam.aiCommand` is somehow missing, so this stays
// safe to call on a plain object built by hand (e.g. in a test) without
// every caller having to know about the AI-alarm feature.
const AI_COMMAND_FALLBACK = { ai_enabled: false, live_peek_until_epoch: 0 };

function buildCameraStatusView(cam) {
  const aiCommand = cam.aiCommand || AI_COMMAND_FALLBACK;
  return {
    lastSeen: cam.lastSeen,
    enabled: cam.enabled,
    enabledUntil: cam.enabledUntil,
    recording: !!cam.recording,
    recordingStartedAt: cam.recording ? cam.recording.startedAt : null,
    recordingEndAt: cam.recording ? cam.recording.endAt : null,
    aiEnabled: aiCommand.ai_enabled,
    livePeekUntilEpoch: aiCommand.live_peek_until_epoch,
  };
}

module.exports = { buildCameraStatusView };
