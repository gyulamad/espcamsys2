'use strict';

// detectorevents.js — pushing the detectors' readings to a viewer the moment they arrive
// (GET /detectors/events, Server-Sent Events) instead of waiting for the viewer to ask.
//
// Two small, pure pieces, kept out of server.js so they can be tested without sockets:
//   encodeEvent(name, data)       one SSE message
//   createFeed(write, snapshot)   "latest wins" delivery to ONE viewer: while the viewer's connection is
//                                 not keeping up, updates are not queued — they collapse into a single
//                                 pending one, so a slow link (Tor) always gets the newest numbers next
//                                 and the relay's memory never grows with a slow viewer.

const EVENT_NAME = 'detectors';
// How often every viewer gets the picture of all detectors even if nothing arrived: the numbers carry
// ages ("last heard 4 s ago"), and a detector that went silent must turn offline on screen too.
const REFRESH_MS = 1000;
// At most this many viewers at once (a dashboard holds one stream per open browser tab).
const MAX_VIEWERS = 16;

const HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

// One SSE message: `event: <name>` + the JSON on a single `data:` line + a blank line.
function encodeEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// write(text) -> false when the connection's buffer is full (Node's stream convention); snapshot() -> the
// current value to send. notify() = "something changed", drain() = "the connection can take more".
function createFeed(write, snapshot) {
  let ready = true;
  let dirty = false;
  const send = () => {
    ready = write(encodeEvent(EVENT_NAME, snapshot())) !== false;
  };
  return {
    notify() {
      if (!ready) {
        dirty = true;
        return;
      }
      send();
    },
    drain() {
      ready = true;
      if (!dirty) return;
      dirty = false;
      send();
    },
  };
}

module.exports = { encodeEvent, createFeed, EVENT_NAME, REFRESH_MS, MAX_VIEWERS, HEADERS };
