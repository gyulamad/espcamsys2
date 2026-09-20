'use strict';

// timing.js — pure date/duration arithmetic extracted out of server.js's
// power and recording logic. Every function here takes the current time
// as an explicit argument instead of calling Date.now() itself, so tests
// can pick any "now" they like without waiting on a real clock or a timer.

// When `enabled` should auto-flip back to false, given it's being
// (re)armed for `seconds` starting at nowMs. Returns null when seconds is
// null (armed indefinitely, no auto-off).
function computeEnabledUntil(nowMs, seconds) {
  if (seconds == null) return null;
  return new Date(nowMs + seconds * 1000);
}

// Decides whether a camera is already powered through a recording that
// would end at recordingEndsAtMs, and if not, how many seconds its
// auto-off timer needs to be (re)armed for. Mirrors
// ensurePoweredThrough()'s own math exactly: this only ever extends
// power, never shortens it.
function computePoweredThroughDecision(enabled, enabledUntil, recordingEndsAtMs, nowMs) {
  const alreadyCovered = !!(enabled && enabledUntil && enabledUntil.getTime() >= recordingEndsAtMs);
  if (alreadyCovered) {
    return { alreadyCovered: true, powerSeconds: null };
  }
  const powerSeconds = Math.max(1, Math.ceil((recordingEndsAtMs - nowMs) / 1000));
  return { alreadyCovered: false, powerSeconds };
}

// Start/end timestamps for a fresh recording of `seconds` starting now.
function computeRecordingWindow(nowMs, seconds) {
  return { startedAt: new Date(nowMs), endAt: new Date(nowMs + seconds * 1000) };
}

// New end timestamp for a recording being extended by `seconds` measured
// from now (restarts the countdown rather than adding on top of what was
// left).
function computeRecordingEndAt(nowMs, seconds) {
  return new Date(nowMs + seconds * 1000);
}

// Elapsed/remaining seconds for a recording currently in progress, each
// clamped to zero rather than going negative before it starts or after it
// ends.
function computeElapsedRemaining(nowMs, startedAtMs, endAtMs) {
  const remaining = Math.max(0, (endAtMs - nowMs) / 1000);
  const elapsed = Math.max(0, (nowMs - startedAtMs) / 1000);
  return { elapsed, remaining };
}

module.exports = {
  computeEnabledUntil,
  computePoweredThroughDecision,
  computeRecordingWindow,
  computeRecordingEndAt,
  computeElapsedRemaining,
};
