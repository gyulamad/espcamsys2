'use strict';

// connection.js — the rules for judging a camera's push connection that don't
// need a socket to decide, so they can be tested on their own.

// How long a connection can have been quiet and still count as "live". A
// camera that gave up on a stalled connection and reconnected has, by
// definition, been silent for longer than its own write-stall timeout (4 s+),
// so anything quieter than this is a second sender, not a stale leftover.
const LIVE_WINDOW_MS = 2000;

// A camera authenticated while an older connection for the same camera id was
// still registered. Which is the older one?
//   'conflict' — it delivered data a moment ago: two senders are active at once
//                (two boards sharing a CAMERA_ID, or one board behind a NAT
//                repeater and another — the address alone can't tell).
//   'stale'    — it has gone quiet: the same board reconnected after its old
//                connection died without a goodbye (a half-open TCP connection,
//                typical on a weak WiFi link). Nothing wrong with the camera.
function classifyPreviousConnection(silentMs, liveWindowMs = LIVE_WINDOW_MS) {
  return silentMs < liveWindowMs ? 'conflict' : 'stale';
}

// A timeout in milliseconds from an environment variable: the value if it is a
// positive number, otherwise the default.
function parseTimeoutMs(value, fallback) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

module.exports = { LIVE_WINDOW_MS, classifyPreviousConnection, parseTimeoutMs };
