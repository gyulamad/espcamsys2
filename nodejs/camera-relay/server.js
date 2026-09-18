const express = require('express');
const net = require('net');
const { EventEmitter } = require('events');
const config = require('./config'); // gitignored — see example.config.js

const app = express();
const PORT = process.env.PORT || config.port;
const PUSH_PORT = process.env.PUSH_PORT || config.pushPort; // raw TCP, continuous frame push
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

// Raw binary body for camera uploads (JPEG bytes, not JSON/form)
app.use('/upload/:id', express.raw({ type: '*/*', limit: '2mb' }));

const cameras = {}; // id -> { frame, emitter, lastSeen, enabled, socket }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      enabled: true,  // dashboard-controlled: whether this camera should be capturing/pushing
      socket: null,   // the camera's live push-connection socket, if connected right now
    };
    cameras[id].emitter.setMaxListeners(50); // allow many simultaneous viewers
  }
  return cameras[id];
}

// Tells a connected camera whether it should be capturing, over its own
// persistent push socket. Single raw byte, no framing needed since this is
// a totally separate direction of traffic from the camera's [len][jpeg]
// frames: 0x00 = pause, 0x01 = resume. No-op if the camera isn't connected
// right now — its `enabled` flag is still saved and gets sent the moment it
// (re)connects, in sendControlByte() below.
function sendControlByte(cam) {
  if (cam.socket && cam.socket.writable) {
    cam.socket.write(Buffer.from([cam.enabled ? 1 : 0]));
  }
}

// Camera pushes a frame here
app.post('/upload/:id', (req, res) => {
  if (req.query.key !== API_KEY) return res.sendStatus(403);
  const cam = getCamera(req.params.id);
  cam.frame = req.body;
  cam.lastSeen = new Date();
  cam.emitter.emit('frame', cam.frame); // push instantly to any watching browsers
  res.sendStatus(200);
});

// Browser opens this to watch the live stream (works as an <img src="...">)
app.get('/stream/:id', (req, res) => {
  const cam = getCamera(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });

  let ready = true; // false while this viewer (e.g. over a slow Tor circuit)
                     // hasn't finished receiving the last frame yet
  res.on('drain', () => { ready = true; });

  const onFrame = (frame) => {
    if (!ready) return; // viewer can't keep up — drop this frame instead of
                         // queueing it, so the stream stays close to
                         // real-time instead of lagging further and further
    ready = res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    ready = res.write(frame) && ready;
    ready = res.write('\r\n') && ready;
  };

  if (cam.frame) onFrame(cam.frame); // show last known frame immediately on connect
  cam.emitter.on('frame', onFrame);

  req.on('close', () => cam.emitter.off('frame', onFrame));
});

// Single still image, handy for thumbnails/testing
app.get('/snapshot/:id', (req, res) => {
  const cam = cameras[req.params.id];
  if (!cam || !cam.frame) return res.sendStatus(404);
  res.set('Content-Type', 'image/jpeg');
  res.send(cam.frame);
});

// Quick health check across all cameras
app.get('/status', (req, res) => {
  const out = {};
  for (const id in cameras) out[id] = { lastSeen: cameras[id].lastSeen, enabled: cameras[id].enabled };
  res.json(out);
});

// Dashboard reads/sets whether a camera should be capturing right now.
// Used for the per-camera power button (power + bandwidth saving) — the
// camera itself decides to skip capture/push while paused, this just carries
// the on/off signal to it. No key required, same trust boundary as
// /stream, /snapshot, /status: only the PHP layer (behind Tor Basic Auth)
// is expected to be able to reach this port at all (see INSTALL.md 2.6).
app.get('/control/:id', (req, res) => {
  const cam = getCamera(req.params.id);
  res.json({ id: req.params.id, enabled: cam.enabled });
});

app.post('/control/:id', (req, res) => {
  const enabled = req.query.enabled;
  if (enabled !== '0' && enabled !== '1') return res.sendStatus(400);
  const cam = getCamera(req.params.id);
  cam.enabled = enabled === '1';
  sendControlByte(cam);
  res.json({ id: req.params.id, enabled: cam.enabled });
});

app.listen(PORT, () => console.log(`Camera relay (HTTP) listening on :${PORT}`));

// ── Raw TCP push listener ──
// Cameras open ONE connection here and keep it open, instead of a fresh
// HTTP request per frame. Protocol, per connection:
//   1. one line:  "<cameraId>\t<apiKey>\n"          (auth, sent once)
//   2. repeated:  [4-byte big-endian length][that many bytes of JPEG]
// No response is sent back for each frame — this is intentionally
// fire-and-forget so the camera never waits on a round trip between frames.
//
// The one exception is the control channel above: whenever the dashboard
// changes a camera's enabled state, or right after a camera authenticates,
// we write a single 0x00/0x01 byte down this same socket (see
// sendControlByte()). The camera reads it opportunistically between frames.
const pushServer = net.createServer((socket) => {
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let authed = false;
  let camId = null;

  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    if (!authed) {
      const nl = buf.indexOf(0x0a); // '\n'
      if (nl === -1) {
        if (buf.length > 256) socket.destroy(); // malformed/oversized auth line
        return;
      }
      const line = buf.slice(0, nl).toString('utf8').replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const [id, key] = line.split('\t');
      if (!id || key !== API_KEY) {
        socket.destroy();
        return;
      }
      camId = id;
      authed = true;

      const cam = getCamera(camId);
      cam.socket = socket;
      // Sync this camera to whatever state the dashboard last set, in case
      // it changed while this camera was offline or mid-reconnect.
      sendControlByte(cam);
    }

    // Drain as many complete [length][payload] frames as are buffered
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32BE(0);
      if (len === 0 || len > 5 * 1024 * 1024) { // sanity cap, matches the 2mb HTTP upload limit with headroom
        socket.destroy();
        return;
      }
      if (buf.length < 4 + len) break; // frame not fully arrived yet

      const frame = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);

      const cam = getCamera(camId);
      cam.frame = frame;
      cam.lastSeen = new Date();
      cam.emitter.emit('frame', cam.frame);
    }
  });

  socket.on('close', () => {
    if (camId && cameras[camId] && cameras[camId].socket === socket) {
      cameras[camId].socket = null;
    }
  });

  socket.on('error', () => {}); // camera dropped/reset — next reconnect just starts a new session
});

pushServer.listen(PUSH_PORT, () => console.log(`Camera relay (raw push) listening on :${PUSH_PORT}`));
