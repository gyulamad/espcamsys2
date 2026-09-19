const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('./config'); // gitignored — see example.config.js

const app = express();
const PORT = process.env.PORT || config.port;
const PUSH_PORT = process.env.PUSH_PORT || config.pushPort; // raw TCP, continuous frame push
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const MAX_RECORD_SECONDS = 3600; // 1 hour cap per recording, sanity limit
const SAFE_FILENAME = /^[A-Za-z0-9_.-]+\.mp4$/; // only ever matches names we generate ourselves
const DEFAULT_FPS = 5; // fallback if we somehow can't measure real capture timing

const DEFAULT_POWER_SECONDS = 300; // "ON" with no explicit duration runs for 5 minutes before auto power-off
const MAX_POWER_SECONDS = 3600; // 1 hour cap per power-on, same sanity limit as recording

// Raw binary body for camera uploads (JPEG bytes, not JSON/form)
app.use('/upload/:id', express.raw({ type: '*/*', limit: '2mb' }));

const cameras = {}; // id -> { frame, emitter, lastSeen, enabled, enabledUntil, powerTimer, socket, recording }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      enabled: true,      // dashboard-controlled: whether this camera should be capturing/pushing
      enabledUntil: null, // when `enabled` will auto-flip back to false, or null while off / on indefinitely
      powerTimer: null,   // pending auto power-off timeout, if any — see scheduleAutoOff()
      socket: null,       // the camera's live push-connection socket, if connected right now
      recording: null,    // in-progress recording, if any — see startRecording()
    };
    cameras[id].emitter.setMaxListeners(50); // allow many simultaneous viewers
  }
  return cameras[id];
}

// Turns a camera on for `seconds` (or leaves it off, with the timer
// cancelled, when seconds is null) — the same "start/extend from now"
// pattern as recording: calling this again while already on resets the
// countdown to `seconds` measured from this call, it doesn't add on top of
// whatever was left. Only schedules the flip-back-to-false; actually
// notifying the camera device is still sendControlByte()'s job, called
// separately by the route handlers below.
function scheduleAutoOff(cam, seconds) {
  if (cam.powerTimer) {
    clearTimeout(cam.powerTimer);
    cam.powerTimer = null;
  }
  if (seconds == null) {
    cam.enabledUntil = null;
    return;
  }
  cam.enabledUntil = new Date(Date.now() + seconds * 1000);
  cam.powerTimer = setTimeout(() => {
    cam.enabled = false;
    cam.enabledUntil = null;
    cam.powerTimer = null;
    sendControlByte(cam);
  }, seconds * 1000);
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

// Recording needs the camera actually capturing, so starting or extending a
// recording also guarantees the camera is powered on for at least as long
// as the recording will run. This only ever extends power — never
// shortens it: if the camera is already on with a timer that runs past
// when this recording will end, it's left alone; if it's off, or its
// auto-off would fire before the recording finishes, it's (re)armed for
// exactly as long as the recording needs.
function ensurePoweredThrough(cam, seconds) {
  const recordingEndsAt = Date.now() + seconds * 1000;
  const alreadyCovered = cam.enabled && cam.enabledUntil && cam.enabledUntil.getTime() >= recordingEndsAt;
  if (alreadyCovered) return;

  const powerSeconds = Math.max(1, Math.ceil((recordingEndsAt - Date.now()) / 1000));
  cam.enabled = true;
  scheduleAutoOff(cam, powerSeconds);
  sendControlByte(cam);
}

// ── Recording ──
// Recording happens entirely here on the relay, not on the camera. While a
// recording is active, every incoming frame gets saved as its own numbered
// .jpg in a temp folder (alongside being relayed to live viewers as usual).
// When the recording stops, we hand those frames to ffmpeg with a frame
// rate computed from how much real wall-clock time they actually spanned,
// so the resulting .mp4 plays back at the right speed — not a guessed fixed
// rate. This also produces an actual standard video file: a raw
// concatenation of JPEGs plays as a real video only in a few
// timing-agnostic tools (ffplay, VLC in some cases); most players either
// guess a default frame rate or just show the first embedded image and
// stop, which is why footage recorded that way looked like a single still.
//
// Recordings track an `endAt` timestamp rather than a fixed duration, so
// that a repeat request while already recording can extend it: pressing
// record with 60s at 11:20:05 ends at 11:21:05; pressing it again with 60s
// at 11:20:30 pushes endAt to 11:21:30 (now + 60s), not to 11:21:35 — same
// in-progress capture, timer just restarted from the moment of the second press.
function startRecording(cam, id, seconds) {
  if (cam.recording) return null; // caller should call extendRecording() instead

  ensurePoweredThrough(cam, seconds); // camera must be on for the whole recording

  const dir = path.join(RECORDINGS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempDir = path.join(dir, `.tmp_${stamp}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const startedAt = new Date();
  const rec = {
    id,
    stamp,
    dir,
    tempDir,
    startedAt,
    endAt: new Date(startedAt.getTime() + seconds * 1000),
    frameCount: 0,
    firstFrameAt: null,
    lastFrameAt: null,
    onFrame: null,
    timer: null,
  };

  rec.onFrame = (frame) => {
    rec.frameCount += 1;
    const now = Date.now();
    if (!rec.firstFrameAt) rec.firstFrameAt = now;
    rec.lastFrameAt = now;
    const framePath = path.join(tempDir, `frame_${String(rec.frameCount).padStart(6, '0')}.jpg`);
    try {
      fs.writeFileSync(framePath, frame);
    } catch (err) {
      console.error(`[${id}] failed writing recording frame:`, err.message);
    }
  };
  cam.emitter.on('frame', rec.onFrame);

  rec.timer = setTimeout(() => stopRecording(cam), seconds * 1000);
  cam.recording = rec;
  return rec;
}

// Restarts the countdown on an in-progress recording — same capture in
// progress, just a new end time `seconds` from now.
function extendRecording(cam, seconds) {
  const rec = cam.recording;
  if (!rec) return null;
  ensurePoweredThrough(cam, seconds); // keep the camera on through the new end time too
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
  cam.recording = null;
  finalizeRecording(rec); // encodes the captured frames into an .mp4, async — doesn't block the response
  return rec;
}

// Runs ffmpeg over the captured frames using their real measured frame
// rate, writes `<dir>/<id>_<stamp>.mp4`, and cleans up the temp frames.
function finalizeRecording(rec) {
  if (rec.frameCount === 0) {
    // Camera was paused/offline for this whole recording — nothing to encode.
    fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
    return;
  }

  const spanSeconds = rec.lastFrameAt > rec.firstFrameAt ? (rec.lastFrameAt - rec.firstFrameAt) / 1000 : 0;
  const fps = spanSeconds > 0 ? Math.min(30, Math.max(1, rec.frameCount / spanSeconds)) : DEFAULT_FPS;

  const outputPath = path.join(rec.dir, `${rec.id}_${rec.stamp}.mp4`);
  const framePattern = path.join(rec.tempDir, 'frame_%06d.jpg');

  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-framerate', fps.toFixed(2),
    '-i', framePattern,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ]);

  ffmpeg.on('error', (err) => {
    // Most likely ffmpeg isn't installed — see INSTALL.md. Leave the raw
    // frames in place rather than deleting footage we can't otherwise recover.
    console.error(`[${rec.id}] ffmpeg failed to start (is it installed?):`, err.message);
    console.error(`[${rec.id}] raw frames kept at ${rec.tempDir}`);
  });

  ffmpeg.on('exit', (code) => {
    if (code === 0) {
      fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
    } else {
      console.error(`[${rec.id}] ffmpeg exited with code ${code}, raw frames kept at ${rec.tempDir}`);
    }
  });
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

// Quick health check across all cameras — also what the dashboard polls on
// an interval (via status.php) to pick up state changes that didn't
// originate from a click in that browser tab: another tab, another user,
// or a camera's alarm-trigger GPIO calling /record directly.
app.get('/status', (req, res) => {
  const out = {};
  for (const id in cameras) {
    const cam = cameras[id];
    out[id] = {
      lastSeen: cam.lastSeen,
      enabled: cam.enabled,
      enabledUntil: cam.enabledUntil,
      recording: !!cam.recording,
      recordingStartedAt: cam.recording ? cam.recording.startedAt : null,
      recordingEndAt: cam.recording ? cam.recording.endAt : null,
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
//
// Turning a camera on works the same way recording does: it runs for a
// given number of seconds (300 by default) and then switches itself back
// off, so a camera nobody remembered to turn off doesn't keep drawing power
// and bandwidth indefinitely. Turning one on again while it's already on
// extends it — resets the countdown to the new `seconds` value measured
// from that request, same as extendRecording(). Turning off is immediate
// and cancels any pending auto-off.
//
// GET  /control/:id                    -> current { id, enabled, enabledUntil }
// POST /control/:id?enabled=1&seconds=N -> turn on for N seconds (default 300)
// POST /control/:id?enabled=0           -> turn off now, cancel any auto-off
app.get('/control/:id', (req, res) => {
  const cam = getCamera(req.params.id);
  res.json({ id: req.params.id, enabled: cam.enabled, enabledUntil: cam.enabledUntil });
});

app.post('/control/:id', (req, res) => {
  const enabled = req.query.enabled;
  if (enabled !== '0' && enabled !== '1') return res.sendStatus(400);
  const cam = getCamera(req.params.id);

  if (enabled === '1') {
    const seconds = req.query.seconds !== undefined ? parseInt(req.query.seconds, 10) : DEFAULT_POWER_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_POWER_SECONDS) {
      return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_POWER_SECONDS}` });
    }
    cam.enabled = true;
    scheduleAutoOff(cam, seconds);
  } else {
    cam.enabled = false;
    scheduleAutoOff(cam, null); // cancel any pending auto-off
  }

  sendControlByte(cam);
  res.json({ id: req.params.id, enabled: cam.enabled, enabledUntil: cam.enabledUntil });
});

// Start/extend a recording on every camera the relay currently knows about
// at once — same start/extend semantics as /record/:id below, just looped
// over every registered camera id. This is what ALARM_RECORD_ALL_CAMERAS in
// the ESP32 sketch calls when one camera's alarm input should kick off
// footage from the whole fleet, not just itself. ("Knows about" means any
// camera that has connected/registered at least once since this process
// started — same set /status reports on.) Registered before /record/:id so
// Express doesn't try to match "all" as a literal camera id.
app.post('/record/all', (req, res) => {
  const seconds = parseInt(req.query.seconds, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RECORD_SECONDS) {
    return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}` });
  }

  const results = Object.keys(cameras).map((id) => {
    const cam = cameras[id];
    if (cam.recording) {
      const rec = extendRecording(cam, seconds);
      return { id, recording: true, extended: true, startedAt: rec.startedAt, endAt: rec.endAt };
    }
    const rec = startRecording(cam, id, seconds);
    return { id, recording: true, extended: false, startedAt: rec.startedAt, endAt: rec.endAt };
  });

  res.json({ cameras: results });
});

// Start recording this camera's incoming frames to a file for `seconds`.
// If it's already recording, this extends it instead — see extendRecording().
// Same trust boundary as /control — no key. Called by the PHP layer (the
// dashboard's RECORD button) and now also directly by camera boards
// themselves, over the LAN, when their alarm-trigger GPIO fires — see the
// ESP32 sketch's ALARM_* constants and sendRecordRequest().
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
      enabled: cam.enabled,
      enabledUntil: cam.enabledUntil,
    });
  }

  const rec = startRecording(cam, req.params.id, seconds);
  res.json({
    id: req.params.id,
    recording: true,
    extended: false,
    startedAt: rec.startedAt,
    endAt: rec.endAt,
    enabled: cam.enabled,
    enabledUntil: cam.enabledUntil,
  });
});

// Stop a recording early. Encoding into the final .mp4 happens in the
// background — it won't show up in /recordings/:id until ffmpeg finishes.
app.post('/record/:id/stop', (req, res) => {
  const cam = getCamera(req.params.id);
  const rec = stopRecording(cam);
  if (!rec) return res.status(409).json({ error: 'not recording' });
  res.json({ id: req.params.id, recording: false, encoding: rec.frameCount > 0 });
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

// Delete every saved recording for a camera at once (the per-camera
// "DELETE ALL" button). Same path as the list route above, distinguished
// by method — no filename segment, so it can't collide with the
// single-file delete route below.
app.delete('/recordings/:id', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json({ deleted: [] });
  const deleted = fs.readdirSync(dir)
    .filter((f) => SAFE_FILENAME.test(f))
    .map((f) => {
      fs.unlinkSync(path.join(dir, f));
      return f;
    });
  res.json({ deleted });
});

// Download one recording (recordings.php decides whether the browser sees
// it as an attachment or inline/playable — see that file's play vs
// download handling). Range requests are handled automatically by
// Express's res.download()/sendFile() — that's what lets the dashboard's
// inline <video> player seek/scrub instead of only ever playing from the
// start, as long as recordings.php forwards the Range header through.
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
