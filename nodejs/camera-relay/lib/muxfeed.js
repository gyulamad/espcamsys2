'use strict';

// muxfeed.js — what GET /mux does for ONE viewer, kept out of server.js so it can be tested without sockets:
//   parseCameraIds(raw, rules)  the ?cams=a,b,c list, checked
//   createFeed(write)           delivery that never queues: a viewer on a slow link (Tor) gets the NEWEST
//                               picture of each camera, so its delay stays small and the relay's memory
//                               never grows with a slow viewer (the same rule as the per-camera MJPEG stream)
//   openSession(...)            connects a feed to the cameras' 'frame' events, and undoes it
// The bytes themselves are made by lib/muxcodec.js.

const codec = require('./muxcodec');

const MAX_VIEWERS = 16;       // a dashboard holds one /mux per open browser tab
const HEARTBEAT_MS = 5000;    // well under the 15 s the PHP proxy and the browser wait for any byte before giving up

const HEADERS = Object.freeze({
  'Content-Type': codec.CONTENT_TYPE,
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});

// raw: req.query.cams (a string, or an array when the parameter was repeated). rules: { idPattern, max }.
// -> { ids } (each once, in the order given) or { error } saying what is wrong.
function parseCameraIds(raw, { idPattern, max }) {
  if (typeof raw !== 'string') return { error: 'cams must be one comma-separated list of camera ids' };
  const ids = [...new Set(raw.split(','))];
  if (ids.some((id) => !idPattern.test(id))) return { error: 'cams contains an invalid camera id' };
  if (ids.length > max) return { error: `cams lists more than ${max} cameras` };
  return { ids };
}

// write(buffer) -> false when the connection's buffer is full (Node's stream convention).
// offer(source, jpeg) = "a new picture", drain() = "the connection can take more", heartbeat() = "still here".
function createFeed(write) {
  let ready = true;
  const waiting = new Map();   // source -> its newest picture, while the connection is not keeping up

  const flush = () => {
    for (const [source, jpeg] of waiting) {
      waiting.delete(source);
      ready = write(codec.encodeFrame(source, jpeg)) !== false;
      if (!ready) return;
    }
  };

  return {
    offer(source, jpeg) {
      waiting.set(source, jpeg);   // replaces an older picture of the same camera that was never sent
      if (ready) flush();
    },
    drain() {
      ready = true;
      flush();
    },
    heartbeat() {
      if (!ready) return;          // the connection is busy: it is clearly alive
      ready = write(codec.encodeHeartbeat()) !== false;
    },
  };
}

// cameras: [{ id, cam }] where cam has `emitter` ('frame' events) and `frame` (the last picture, or null).
// -> { drain(), close() }. Nothing is left subscribed after close().
function openSession({ write, cameras, heartbeatMs = HEARTBEAT_MS, setTimer = setInterval, clearTimer = clearInterval }) {
  const feed = createFeed(write);
  feed.heartbeat();   // the first bytes at once: the viewer learns the stream works before any camera has a picture

  const unsubscribers = cameras.map(({ id, cam }) => {
    const source = codec.cameraSource(id);
    const onFrame = (frame) => feed.offer(source, frame);
    cam.emitter.on('frame', onFrame);
    if (cam.frame) onFrame(cam.frame);   // the last known picture at once
    return () => cam.emitter.off('frame', onFrame);
  });
  const timer = setTimer(feed.heartbeat, heartbeatMs);

  return {
    drain: feed.drain,
    close() {
      clearTimer(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
  };
}

module.exports = { parseCameraIds, createFeed, openSession, MAX_VIEWERS, HEARTBEAT_MS, HEADERS };
