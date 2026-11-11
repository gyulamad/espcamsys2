'use strict';

// muxfeed.js — what GET /mux does for ONE viewer, kept out of server.js so it can be tested without sockets:
//   parseRequest(query, rules)  the ?cams= ?dets= ?status= ?rec= of the request, checked
//   createFeed(write)           delivery that never queues: a viewer on a slow link (Tor) gets the NEWEST
//                               picture of each camera and detector and the newest readings, so its delay stays
//                               small and the relay's memory never grows with a slow viewer
//   openSession(...)            connects a feed to the cameras', detectors' and readings' events, and undoes it
// The bytes themselves are made by lib/muxcodec.js.

const codec = require('./muxcodec');

const MAX_VIEWERS = 16;       // a dashboard holds one /mux per open browser tab
const HEARTBEAT_MS = 5000;    // well under the 15 s the PHP proxy and the browser wait for any byte before giving up
const STATUS_REFRESH_MS = 1000;   // the readings carry ages ("last heard 4 s ago"): they are sent once a second even if nothing changed

const HEADERS = Object.freeze({
  'Content-Type': codec.CONTENT_TYPE,
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});

// raw: one query parameter (a string, or an array when the parameter was repeated). -> { ids } (each once, in the
// order given) or { error }. A parameter that is not there is an empty list when `optional`, else an error.
function parseIdList(name, raw, { idPattern, max, optional }) {
  if (raw === undefined && optional) return { ids: [] };
  if (typeof raw !== 'string') return { error: `${name} must be one comma-separated list of ids` };
  const ids = [...new Set(raw.split(','))];
  if (ids.some((id) => !idPattern.test(id))) return { error: `${name} contains an invalid id` };
  if (ids.length > max) return { error: `${name} lists more than ${max} ids` };
  return { ids };
}

// query: req.query. rules: { idPattern, maxCameras, maxDetectors }.
//   cams    the cameras whose pictures are wanted (none by default)
//   dets    the detectors whose pictures are wanted (none by default)
//   status  "1": the readings of every detector are wanted
//   rec     "1": the recording state of every camera (what GET /status answers) is wanted
// At least one of the four must ask for something: a page that shows no picture (every camera hidden) still needs its
// readings and recording state pushed, but a request for nothing is a mistake, not a connection worth holding open.
// -> { cams, dets, status, rec } or { error } saying what is wrong.
function parseRequest(query, { idPattern, maxCameras, maxDetectors }) {
  const cams = parseIdList('cams', query.cams, { idPattern, max: maxCameras, optional: true });
  if (cams.error) return cams;
  const dets = parseIdList('dets', query.dets, { idPattern, max: maxDetectors, optional: true });
  if (dets.error) return dets;
  const request = { cams: cams.ids, dets: dets.ids, status: query.status === '1', rec: query.rec === '1' };
  if (!request.cams.length && !request.dets.length && !request.status && !request.rec) {
    return { error: 'ask for at least one of cams, dets, status=1, rec=1' };
  }
  return request;
}

// write(buffer) -> false when the connection's buffer is full (Node's stream convention).
//   offer(source, jpeg)           = "a new picture"
//   offerState(source, snapshot)  = "the readings changed"; snapshot() makes them (an object, or JSON text; called
//                                   when they are sent, so a viewer that is behind never makes the relay build what
//                                   it will not get)
//   drain() = "the connection can take more", heartbeat() = "still here".
function createFeed(write) {
  let ready = true;
  const waiting = new Map();   // source -> its newest message, while the connection is not keeping up

  const encodeEntry = (source, entry) => {
    if (!entry.snapshot) return codec.encodeFrame(source, entry.jpeg);
    const value = entry.snapshot();
    return codec.encodeState(source, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  };

  const flush = () => {
    for (const [source, entry] of waiting) {
      waiting.delete(source);
      ready = write(encodeEntry(source, entry)) !== false;
      if (!ready) return;
    }
  };

  const put = (source, entry) => {
    waiting.set(source, entry);   // replaces an older message of the same source that was never sent
    if (ready) flush();
  };

  return {
    offer: (source, jpeg) => put(source, { jpeg }),
    offerState: (source, snapshot) => put(source, { snapshot }),
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

// Sends `record`'s pictures under `source`: the last one at once, then every new one. record: { emitter, frame }.
function followPictures(feed, source, record) {
  const onFrame = (frame) => feed.offer(source, frame);
  record.emitter.on('frame', onFrame);
  if (record.frame) onFrame(record.frame);
  return () => record.emitter.off('frame', onFrame);
}

// A detector that has not connected yet has no record to follow. The bus says "something changed" whenever a
// detector reports (and its record exists by then), so each is picked up the moment it is there.
// detectors: { ids, lookup(id) -> record | undefined, bus }.
function followDetectorPictures(feed, { ids, lookup, bus }) {
  const followed = new Map();   // id -> the function that stops following
  const pickUp = () => {
    for (const id of ids) {
      if (followed.has(id)) continue;
      const record = lookup(id);
      if (record) followed.set(id, followPictures(feed, codec.detectorSource(id), record));
    }
  };
  pickUp();
  bus.on('change', pickUp);
  return () => {
    bus.off('change', pickUp);
    followed.forEach((stop) => stop());
    followed.clear();
  };
}

// status: { snapshot() -> the readings of every detector, bus, refreshMs (default STATUS_REFRESH_MS) }.
function followStatus(feed, { snapshot, bus, refreshMs = STATUS_REFRESH_MS }, setTimer, clearTimer) {
  const send = () => feed.offerState(codec.STATE_DETECTORS, snapshot);
  send();
  bus.on('change', send);
  const timer = setTimer(send, refreshMs);
  return () => {
    bus.off('change', send);
    clearTimer(timer);
  };
}

// The recording state of every camera, worked out once for all viewers (lib/sharedsnapshot.js).
// cameraStatus: { subscribe(listener(jsonText)) -> unsubscribe }.
function followCameraStatus(feed, { subscribe }) {
  return subscribe((text) => feed.offerState(codec.STATE_CAMERAS, () => text));
}

// cameras: [{ id, cam }] where cam has `emitter` ('frame' events) and `frame` (the last picture, or null).
// detectors, status, cameraStatus: as above, or null for "not asked for". -> { drain(), close() }. Nothing is left
// subscribed after close().
function openSession({
  write, cameras, detectors = null, status = null, cameraStatus = null,
  heartbeatMs = HEARTBEAT_MS, setTimer = setInterval, clearTimer = clearInterval,
}) {
  const feed = createFeed(write);
  feed.heartbeat();   // the first bytes at once: the viewer learns the stream works before any camera has a picture

  const stops = cameras.map(({ id, cam }) => followPictures(feed, codec.cameraSource(id), cam));
  if (detectors) stops.push(followDetectorPictures(feed, detectors));
  if (status) stops.push(followStatus(feed, status, setTimer, clearTimer));
  if (cameraStatus) stops.push(followCameraStatus(feed, cameraStatus));
  const heartbeat = setTimer(feed.heartbeat, heartbeatMs);

  return {
    drain: feed.drain,
    close() {
      clearTimer(heartbeat);
      stops.forEach((stop) => stop());
    },
  };
}

module.exports = { parseRequest, createFeed, openSession, MAX_VIEWERS, HEARTBEAT_MS, STATUS_REFRESH_MS, HEADERS };
