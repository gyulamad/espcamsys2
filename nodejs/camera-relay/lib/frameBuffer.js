'use strict';

// frameBuffer.js — pure logic for the AI-alarm rolling pre-buffer
// (plans/AI_ALARM_IMPLEMENTATION_PLAN.md §5.3), extracted the same way
// video.js/timing.js already are so it's testable with plain arrays and
// fake timestamps — no real JPEGs, no real clock, no server.
//
// IMPORTANT DEVIATION FROM THE PLAN AS WRITTEN, recorded here per
// AI_ALARM_IMPLEMENTATION_PLAN.md §8's "read the existing recording code
// before implementing §5.3 — do not assume" instruction: §5.3 originally
// sketched this as a device-side RAM ring buffer of *96×96 grayscale
// monitoring frames*. Reading server.js's actual recording pipeline first
// (as instructed) shows that's the wrong home for it. Recording already
// happens entirely on the relay, built from whatever JPEG frames the
// camera is already continuously pushing for live view — see
// startRecording()'s big comment in server.js. Every one of those frames
// already flows through `cam.emitter.emit('frame', ...)` on the relay
// *right now*, recording or not; the relay just never kept any of them
// once a viewer had seen them. So the actual lowest-risk, most useful
// place to keep a short pre-roll is here: a plain array on the relay of
// the last ROLLING_BUFFER_SECONDS worth of those *already-arriving,
// full-resolution* frames, seeded into a fresh recording's frame sequence
// before the live listener starts appending to it (see startRecording()).
// This delivers §5.3's actual goal — the clip doesn't miss the moment
// right before the trigger — without needing any new bandwidth, any new
// device-side buffer, or any device-side RAM budget at all, and without
// the low-resolution tradeoff §5.3 explicitly accepted as a downside (the
// plan's warning against buffering *high-res* frames was about the
// *device's* limited RAM specifically — "defeats the purpose of the cheap
// monitoring mode" — which doesn't apply to a Node process on the relay
// holding a few hundred KB of JPEGs it was about to see anyway).

// Appends one frame arriving "now" to `buffer`, then drops everything
// older than `windowSeconds` relative to `nowMs` — a rolling time window,
// not a fixed slot count, so however many frames actually arrived in the
// last `windowSeconds` (at whatever the camera's real push rate happens
// to be) is exactly how many stay. Mutates and returns `buffer` for
// convenience/chaining; `buffer` is expected to already be in arrival
// order (oldest first) — pushAndTrim preserves that invariant, it never
// reorders.
function pushAndTrim(buffer, frame, nowMs, windowSeconds) {
  buffer.push({ frame, atMs: nowMs });
  const cutoff = nowMs - windowSeconds * 1000;
  while (buffer.length && buffer[0].atMs < cutoff) buffer.shift();
  return buffer;
}

module.exports = { pushAndTrim };
