'use strict';

// deviceinfo.js — what the relay knows about a CAMERA's board besides its Wi-Fi: the address it connects from, how long
// that connection has been up, which firmware it runs, how long the board has been running and how much memory it has
// free. The dashboard shows it on the camera's card, the way it shows a detector's report on the detector's.
//
// A detector sends all of that itself, in its report. A camera does not report it in the push connection, so the relay
// takes it from what it already receives:
//   * the address and the time of the connection: the relay's own observation of the push socket (trusted);
//   * the firmware, the uptime and the free memory: the log entries the camera POSTs to /log (every entry carries its
//     uptime and free heap, and the batch carries the firmware). They are untrusted text from the network: they were
//     already checked by logentry.parseLogBatch(), and describe() shapes them again before they leave.
// A camera that has not logged yet (or logs nothing: LOG_ENABLED=0) simply has no firmware/uptime/memory here — the
// view says so by leaving them null, never by guessing.
//
// Pure functions, no clock and no sockets, so they are unit tested (tests/node/test_deviceinfo.js).
//
//   sample   { fw, uptimeMs, heap }               what one /log batch says (any part may be null)
//   stored   { fw, uptimeMs, heap, at }           what is kept on the camera record (uptimeMs/heap as of `at`)
//   view     { ip, connectedForMs, fw, uptimeMs, heapBytes }   what the dashboard reads, or null

const net = require('net');

// Free memory and uptime of a board are only "now" for a while after they were reported; an hour is several
// heartbeats at the slowest sensible LOG_HEARTBEAT. The firmware name is not a measurement and stays.
const STALE_MS = 60 * 60 * 1000;

// The newest entry of a batch that carries `field` (the one that happened last = the smallest ageMs).
function newestWith(entries, field) {
  let best = null;
  for (const e of entries) {
    if (e[field] === null || e[field] === undefined) continue;
    if (best === null || e.ageMs < best.ageMs) best = e;
  }
  return best;
}

// What a checked /log batch (logentry.parseLogBatch().batch) tells about the board, as of the moment the batch
// arrived. The uptime is the one of the newest entry plus the time since that entry happened (a camera queues entries
// while the relay is unreachable and says how long ago each one was).
function fromLogBatch(batch) {
  const entries = batch && Array.isArray(batch.entries) ? batch.entries : [];
  const upEntry = newestWith(entries, 'uptimeMs');
  const heapEntry = newestWith(entries, 'heap');
  return {
    fw: batch && typeof batch.fw === 'string' && batch.fw !== '' ? batch.fw : null,
    uptimeMs: upEntry ? upEntry.uptimeMs + upEntry.ageMs : null,
    heap: heapEntry && heapEntry.heap >= 0 ? heapEntry.heap : null,
  };
}

// The reading to keep: what `sample` says, stamped with the time it arrived. A part the sample lacks keeps what was
// known before, except that uptime and heap are measured together: a sample with a new uptime but no heap must not
// leave an old heap standing as if it were current.
function remember(previous, sample, now) {
  if (!sample) return previous || null;
  const fresh = sample.uptimeMs !== null || sample.heap !== null;
  return {
    fw: sample.fw !== null ? sample.fw : (previous ? previous.fw : null),
    uptimeMs: fresh ? sample.uptimeMs : (previous ? previous.uptimeMs : null),
    heap: fresh ? sample.heap : (previous ? previous.heap : null),
    at: fresh || !previous ? now : previous.at,
  };
}

// What the dashboard reads about the camera record `cam` ({ ip, connectedAt, socket, device }) at time `now`.
// `online` is the relay's verdict on the camera (statusView.isOnline): a board that is not sending has no uptime
// "now", and its old memory figure is no reading of anything.
// Returns null when nothing is known.
function describe(cam, online, now) {
  const stored = cam.device || null;
  const connected = !!cam.socket && !cam.socket.destroyed && cam.connectedAt > 0;
  const fresh = !!stored && now - stored.at <= STALE_MS;
  const view = {
    ip: typeof cam.ip === 'string' && net.isIP(cam.ip) !== 0 ? cam.ip : null,
    connectedForMs: connected ? Math.max(0, now - cam.connectedAt) : null,
    fw: stored ? stored.fw : null,
    uptimeMs: online && fresh && stored.uptimeMs !== null ? stored.uptimeMs + Math.max(0, now - stored.at) : null,
    heapBytes: online && fresh ? stored.heap : null,
  };
  const known = view.ip !== null || view.connectedForMs !== null || view.fw !== null || view.uptimeMs !== null || view.heapBytes !== null;
  return known ? view : null;
}

module.exports = { STALE_MS, fromLogBatch, remember, describe };
