'use strict';

// framequeue.js — the live frames of a running recording, written to disk ONE AT A TIME
// without ever blocking the event loop, kept out of server.js so it can be tested with a
// fake writeFile (tests/node/test_framequeue.js).
//
// WHY THIS EXISTS. While a recording runs, every incoming frame of the recording camera
// used to be written with fs.writeFileSync: one synchronous SD-card write per frame, inside
// the camera's socket 'data' handler. A single ~30 KB write can take 5-50 ms on a Pi, so
// three cameras recording at 5 fps each kept the event loop blocked for hundreds of
// milliseconds out of every second — and everything the relay does for EVERY camera stops
// with it: no frame is ingested, no /mux or /stream viewer gets a picture, /status answers
// late, detector uplinks are not read. The pre-roll frames were already written
// asynchronously for exactly this reason (see writePreRollFrames in server.js); this module
// gives the live frames the same treatment, with the same "never rejects" rule.
//
// Behaviour:
//   * FIFO — frames land on disk in the order they arrived (the clip's frame_NNNNNN.jpg
//     numbering must stay gap-free for ffmpeg's frame_%06d.jpg pattern, which stops at the
//     first missing number).
//   * One write in flight at a time — a stalled disk slows the recording, never the relay.
//   * A failed write is reported through onError and the queue moves on, exactly like the
//     old synchronous try/catch: the clip just has a missing frame from that point.
//   * If the disk falls so far behind that more than maxPending frames are waiting, the
//     OLDEST queued frames are dropped (and reported through onDrop) so memory stays
//     bounded — a frame dropped there leaves the same gap a failed write would, and the
//     log says so. In normal operation the queue length hovers around one.
//   * write() never throws, and a broken onError/onDrop never stops the queue: a recording
//     must not take the relay down with it.
//   * The bytes are copied when handed in: frames off the push socket are slices of a
//     larger receive buffer (see protocol.js drainFrames), and holding the slice would pin
//     that whole buffer until the write finishes — the same reason lib/preroll.js copies.
//
//   createFrameWriter({ writeFile, maxPending?, copy?, onError?, onDrop? })
//     -> { write(path, data), pending(), dropped(), idle() }
//   idle() resolves when everything enqueued so far has settled (written, failed or
//   dropped) — server.js awaits it before handing the frames to ffmpeg, so a recording
//   stopped in a hurry still encodes every frame it captured. A relay killed outright
//   (SIGKILL, crash) loses at most the frames still in the queue; the normal stop path
//   drains first.

const DEFAULT_MAX_PENDING = 512;   // ≈ 15 MB of frames; minutes of backlog — a disk this
// far behind during a recording is failing anyway, and the clip is truncated where the
// first drop was (logged), like a disk-full write error.

// A reporting callback that can never throw: a broken reporter must not reject the write
// chain (a rejected link would silently skip every step after it).
function guarded(fn) {
  return (...args) => {
    if (!fn) return;
    try { fn(...args); } catch (err) { /* the reporter itself is broken; nothing to do */ }
  };
}

function createFrameWriter({ writeFile, maxPending = DEFAULT_MAX_PENDING, copy = (data) => Buffer.from(data), onError, onDrop }) {
  if (typeof writeFile !== 'function') throw new TypeError('writeFile must be a function');
  const limit = Number.isFinite(maxPending) && maxPending >= 1 ? Math.floor(maxPending) : DEFAULT_MAX_PENDING;
  const reportError = guarded(onError);
  const reportDrop = guarded(onDrop);

  const queue = [];          // { path, data } — the frames waiting for their turn
  let droppedTotal = 0;
  let chain = Promise.resolve();   // one link per enqueued frame; settles when all have

  // Writes the next waiting frame, if any. Never rejects: a failure is onError's business.
  const step = () => {
    const next = queue.shift();
    if (!next) return undefined;
    try {
      return writeFile(next.path, next.data).catch(reportError);
    } catch (err) {   // a writeFile that throws instead of rejecting
      reportError(err);
      return undefined;
    }
  };

  return {
    // Hands one frame in. Never throws: whatever goes wrong with the copy is reported,
    // the frame is skipped, and the caller (the camera's socket handler) goes on.
    write(path, data) {
      let stored;
      try {
        stored = copy(data);
      } catch (err) {
        reportError(err);
        return;
      }
      while (queue.length >= limit) {
        queue.shift();
        droppedTotal += 1;
        reportDrop(droppedTotal, queue.length);
      }
      queue.push({ path, data: stored });
      chain = chain.then(step, step);   // the second step: a link never skips the next
    },
    pending: () => queue.length,
    dropped: () => droppedTotal,
    idle: () => chain.then(() => undefined),
  };
}

module.exports = { createFrameWriter, DEFAULT_MAX_PENDING };
