const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config'); // gitignored — see example.config.js

const app = express();
const PORT = process.env.PORT || config.port;
const PUSH_PORT = process.env.PUSH_PORT || config.pushPort; // raw TCP, continuous frame push
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const MAX_RECORD_SECONDS = 3600; // 1 hour cap per recording, sanity limit
const SAFE_FILENAME = /^[A-Za-z0-9_.-]+\.mjpeg$/; // only ever matches names we generate ourselves

// Raw binary body for camera uploads (JPEG bytes, not JSON/form)
app.use('/upload/:id', express.raw({ type: '*/*', limit: '2mb' }));

const cameras = {}; // id -> { frame, emitter, lastSeen, enabled, socket, recording }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      enabled: true,   // dashboard-controlled: whether this camera should be capturing/pushing
      socket: null,    // the camera's live push-connection socket, if connected right now
      recording: null, // in-progress recording, if any — see startRecording()
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

// ── Recording ──
// Recording happens entirely here on the relay, not on the camera: while a
// recording is active we just also write every incoming frame straight to a
// file, alongside relaying it to live viewers as usual. JPEGs have their own
// start/end markers, so a plain concatenation of raw frame bytes is already
// a valid motion-JPEG stream — no container/framing needed. The result
// (a .mjpeg file) plays directly in VLC/ffplay, and converts with e.g.
// `ffmpeg -i recording.mjpeg -c:v libx264 out.mp4` if you want a smaller format.
//
// Recordings track an `endAt` timestamp rather than a fixed duration, so
// that a repeat request while already recording can extend it: pressing
// record with 60s at 11:20:05 ends at 11:21:05; pressing it again with 60s
// at 11:20:30 pushes endAt to 11:21:30 (now + 60s), not to 11:21:35 — same
// file, timer just restarted from the moment of the second press.
function startRecording(cam, id, seconds) {
  if (cam.recording) return null; // caller should call extendRecording() instead

  const dir = path.join(RECORDINGS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${id}_${stamp}.mjpeg`;
  const filePath = path.join(dir, filename);
  const stream = fs.createWriteStream(filePath);

  const onFrame = (frame) => stream.write(frame);
  cam.emitter.on('frame', onFrame);

  const startedAt = new Date();
  const rec = {
    startedAt,
    endAt: new Date(startedAt.getTime() + seconds * 1000),
    filename,
    filePath,
    stream,
    onFrame,
    timer: null,
  };
  rec.timer = setTimeout(() => stopRecording(cam), seconds * 1000);
  cam.recording = rec;
  return rec;
}

// Restarts the countdown on an in-progress recording — same file, same
// listener, just a new end time `seconds` from now.
function extendRecording(cam, seconds) {
  const rec = cam.recording;
  if (!rec) return null;
  clearTimeout(rec.timer);
  rec.endAt = new Date(Date.now() + seconds * 1000);
  rec.timer = setTimeout(() => stopRecording(cam), seconds * 1000);
  return rec;
}

function stopRecording(cam) {
  const rec = cam.recording;
  if (!rec) return null;
  clearTimeout(rec.timer);
  cam.emitter.off('frame', rec.onFrame);
  rec.stream.end();
  cam.recording = null;
  return rec;
}

// Camera pushes a frame here
app.post('/upload/:id', (req, res) => {
  if (req.query.key !== API_KEY) return res.sendStatus(403);
  const cam = getCamera(req.params.id);
  cam.frame = req.body;
  cam.lastSeen = new Date();
  cam.emitter.emit('frame', cam.frame); // push instantly to any watching browsers (and any active recording)
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
  for (const id in cameras) {
    out[id] = {
      lastSeen: cameras[id].lastSeen,
      enabled: cameras[id].enabled,
      recording: !!cameras[id].recording,
    };
  }
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

// Start recording this camera's incoming frames to a file for `seconds`.
// If it's already recording, this extends it instead — see extendRecording().
// Same trust boundary as /control — no key, PHP layer only.
app.post('/record/:id', (req, res) => {
  const seconds = parseInt(req.query.seconds, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RECORD_SECONDS) {
    return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}` });
  }
  const cam = getCamera(req.params.id);

  if (cam.recording) {
    const rec = extendRecording(cam, seconds);
    return res.json({
      id: req.params.id,
      recording: true,
      extended: true,
      startedAt: rec.startedAt,
      endAt: rec.endAt,
    });
  }

  const rec = startRecording(cam, req.params.id, seconds);
  res.json({ id: req.params.id, recording: true, extended: false, startedAt: rec.startedAt, endAt: rec.endAt });
});

// Stop a recording early.
app.post('/record/:id/stop', (req, res) => {
  const cam = getCamera(req.params.id);
  const rec = stopRecording(cam);
  if (!rec) return res.status(409).json({ error: 'not recording' });
  res.json({ id: req.params.id, recording: false, filename: rec.filename });
});

// Current recording status/progress for one camera.
app.get('/record/:id', (req, res) => {
  const cam = getCamera(req.params.id);
  if (!cam.recording) return res.json({ recording: false });
  const now = Date.now();
  const remaining = Math.max(0, (cam.recording.endAt.getTime() - now) / 1000);
  const elapsed = Math.max(0, (now - cam.recording.startedAt.getTime()) / 1000);
  res.json({
    recording: true,
    startedAt: cam.recording.startedAt,
    endAt: cam.recording.endAt,
    elapsed,
    remaining,
  });
});

// List saved recordings for a camera, newest first.
app.get('/recordings/:id', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir)
    .filter((f) => SAFE_FILENAME.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, sizeBytes: stat.size, createdAt: stat.birthtime };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(files);
});

// Download one recording.
app.get('/recordings/:id/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (!SAFE_FILENAME.test(filename)) return res.sendStatus(400); // rules out any path traversal too
  const filePath = path.join(RECORDINGS_DIR, id, filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.download(filePath);
});

// Delete one recording.
app.delete('/recordings/:id/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (!SAFE_FILENAME.test(filename)) return res.sendStatus(400);
  const filePath = path.join(RECORDINGS_DIR, id, filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  fs.unlinkSync(filePath);
  res.json({ deleted: filename });
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
      cam.emitter.emit('frame', cam.frame); // also feeds any active recording, via startRecording()'s listener
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
