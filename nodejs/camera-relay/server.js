const express = require('express');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('./config'); // gitignored — see example.config.js

// All the relay's actual decision-making (validation, timing math, frame
// protocol parsing, response shapes) lives in lib/ as plain, side-effect-free
// functions so it can be unit tested with plain `node` — see tests/node/.
// This file wires that logic up to Express/net/fs/ffmpeg.
const validation = require('./lib/validation');
const timing = require('./lib/timing');
const video = require('./lib/video');
const protocol = require('./lib/protocol');
const statusView = require('./lib/statusView');
const settingsLogic = require('./lib/settings');
const preroll = require('./lib/preroll');

const app = express();
const PORT = process.env.PORT || config.port;
const PUSH_PORT = process.env.PUSH_PORT || config.pushPort; // raw TCP, continuous frame push
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
const MAX_RECORD_SECONDS = 3600; // 1 hour cap per recording, sanity limit
const DEFAULT_FPS = 5; // fallback if we somehow can't measure real capture timing

// ── Pre-roll ("black box") ──
// Cameras now stream continuously (there is no power on/off any more), and
// the relay keeps the last `preRollSeconds` of every camera's frames in RAM.
// When a recording starts — alarm, person detector, or the dashboard's
// RECORD button — those buffered frames are written first, so the clip begins
// BEFORE the trigger instead of whenever the (possibly slow) request got here.
// Set in config.js (preRollSeconds, default 5; 0 disables). The PREROLL_*
// env vars override it, the same way PORT / CAM_KEY / SETTINGS_FILE do.
const preRollCfg = preroll.resolvePreRollConfig({
  seconds: process.env.PREROLL_SECONDS !== undefined ? process.env.PREROLL_SECONDS : config.preRollSeconds,
  maxBytes: process.env.PREROLL_MAX_BYTES !== undefined ? process.env.PREROLL_MAX_BYTES : config.preRollMaxBytes,
});
for (const w of preRollCfg.warnings) console.warn(`[config] ${w}`);

// ── Persistent settings ──
// Dashboard-editable values that must survive relay restarts and apply to
// the cameras without reflashing them (currently the alarm recording length
// — see POST /alarm/:id). Stored as a small JSON file next to server.js; the
// validation/defaulting rules live in lib/settings.js.
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json'); // env override lets the e2e test use a throwaway file

function loadSettings() {
  try {
    return settingsLogic.parseStoredSettings(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    return { ...settingsLogic.DEFAULT_SETTINGS }; // no file yet (first run) or unreadable
  }
}

function saveSettings(next) {
  // Write to a temp file then rename, so a crash/power loss mid-write can
  // never leave a half-written settings.json behind.
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

let settings = loadSettings();

// What GET/POST /settings return: the stored, editable settings plus the
// read-only pre-roll length (it comes from config.js, so the dashboard can
// show how much lead-in each recording will include).
function settingsView() {
  return { ...settings, preRollSeconds: preRollCfg.seconds };
}

// Raw binary body for camera uploads (JPEG bytes, not JSON/form)
app.use('/upload/:id', express.raw({ type: '*/*', limit: '2mb' }));

const cameras = {}; // id -> { frame, emitter, lastSeen, socket, recording, preRoll, lastRecordedUntil }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      socket: null,             // the camera's live push-connection socket, if connected right now
      recording: null,          // in-progress recording, if any — see startRecording()
      preRoll: new preroll.PreRollBuffer({ seconds: preRollCfg.seconds, maxBytes: preRollCfg.maxBytes }),
      lastRecordedUntil: null,  // timestamp of the last frame the previous recording contained — see startRecording()
    };
    cameras[id].emitter.setMaxListeners(50); // allow many simultaneous viewers
  }
  return cameras[id];
}

// Every frame from every transport (the raw TCP push connection and the
// legacy HTTP /upload) goes through here, so they can't drift apart:
//   1. file it in the camera's pre-roll buffer (which returns the timestamp
//      it used, so a recording and the buffer always agree on frame times)
//   2. make it the latest frame (/snapshot, new stream viewers)
//   3. emit it to live viewers and to any active recording
function ingestFrame(cam, frame) {
  const ts = cam.preRoll.push(frame, Date.now());
  cam.frame = frame;
  cam.lastSeen = new Date(ts);
  cam.emitter.emit('frame', frame, ts);
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
// PRE-ROLL: a recording does not begin at the moment it was requested. The
// frames the camera sent in the `preRollSeconds` BEFORE the request are
// already sitting in the camera's pre-roll buffer (see ingestFrame()), and
// startRecording() writes them out as the first frames of the clip. That is
// what makes the footage start before the trigger even when the trigger
// itself was slow to arrive (person detector -> alarm GPIO -> HTTP request
// over weak Wi-Fi). Only a NEW recording gets pre-roll; extending one that
// is already running just moves its end time, because it already holds
// everything since it started.
//
// Recordings track an `endAt` timestamp rather than a fixed duration, so
// that a repeat request while already recording can extend it: pressing
// record with 60s at 11:20:05 ends at 11:21:05; pressing it again with 60s
// at 11:20:30 pushes endAt to 11:21:30 (now + 60s), not to 11:21:35 — same
// in-progress capture, timer just restarted from the moment of the second press.
// `startedAt`/`endAt` are always trigger-relative: the clip itself is
// `preRollSeconds` longer than `endAt - startedAt`.
function frameFileName(index) {
  return `frame_${String(index).padStart(6, '0')}.jpg`;
}

// Writes the pre-roll frames as frame_000001.jpg, frame_000002.jpg, ... in
// order. Done asynchronously, one file at a time: a few hundred synchronous
// writes on a Pi's SD card would stall the event loop (and every live
// stream with it) at the exact moment an alarm fires, and opening them all
// at once could run into the open-file limit. Never rejects — a failed
// write is logged and the clip just has a missing frame, like a live one.
async function writePreRollFrames(rec, frames) {
  for (let i = 0; i < frames.length; i++) {
    try {
      await fsp.writeFile(path.join(rec.tempDir, frameFileName(i + 1)), frames[i].jpeg);
    } catch (err) {
      console.error(`[${rec.id}] failed writing pre-roll frame:`, err.message);
    }
  }
}

function startRecording(cam, id, seconds) {
  if (cam.recording) return null; // caller should call extendRecording() instead

  const triggerTs = Date.now();

  const dir = path.join(RECORDINGS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(triggerTs).toISOString().replace(/[:.]/g, '-');
  const tempDir = path.join(dir, `.tmp_${stamp}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Snapshot the pre-roll and attach the live-frame listener in the same
  // synchronous step. JavaScript can't deliver a frame in between, so no
  // frame is ever missed or written twice. Frames the PREVIOUS recording
  // already contains (lastRecordedUntil) are skipped, so two clips close
  // together are contiguous rather than overlapping.
  const preFrames = cam.preRoll.preRollFor(triggerTs, cam.lastRecordedUntil == null ? -Infinity : cam.lastRecordedUntil);

  const { startedAt, endAt } = timing.computeRecordingWindow(triggerTs, seconds);
  const rec = {
    id,
    stamp,
    dir,
    tempDir,
    startedAt,
    endAt,
    preRollFrames: preFrames.length,
    preRollWritten: null,
    frameCount: preFrames.length, // live frames are numbered after the pre-roll ones
    firstFrameAt: preFrames.length ? preFrames[0].ts : null,
    lastFrameAt: preFrames.length ? preFrames[preFrames.length - 1].ts : null,
    onFrame: null,
    timer: null,
  };

  rec.preRollWritten = writePreRollFrames(rec, preFrames);

  rec.onFrame = (frame, ts = Date.now()) => {
    rec.frameCount += 1;
    if (!rec.firstFrameAt) rec.firstFrameAt = ts;
    rec.lastFrameAt = ts;
    const framePath = path.join(tempDir, frameFileName(rec.frameCount));
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
  clearTimeout(rec.timer);
  rec.endAt = timing.computeRecordingEndAt(Date.now(), seconds);
  rec.timer = setTimeout(() => stopRecording(cam), seconds * 1000);
  return rec;
}

// Starts a recording of `seconds`, or — if one is already running —
// extends it to `seconds` from now. The one place the alarm, "record all"
// and per-camera record routes get that behaviour, so they can't diverge.
// Returns the JSON-ready summary those routes respond with.
function startOrExtendRecording(cam, id, seconds) {
  const extended = !!cam.recording;
  const rec = extended ? extendRecording(cam, seconds) : startRecording(cam, id, seconds);
  return {
    id,
    recording: true,
    extended,
    startedAt: rec.startedAt,
    endAt: rec.endAt,
    preRollFrames: extended ? 0 : rec.preRollFrames, // frames of lead-in this call added to the clip
  };
}

function stopRecording(cam) {
  const rec = cam.recording;
  if (!rec) return null;
  clearTimeout(rec.timer);
  cam.emitter.off('frame', rec.onFrame);
  cam.recording = null;
  if (rec.lastFrameAt != null) cam.lastRecordedUntil = rec.lastFrameAt; // so the next clip's pre-roll doesn't repeat this footage
  finalizeRecording(rec); // encodes the captured frames into an .mp4, async — doesn't block the response
  return rec;
}

// Runs ffmpeg over the captured frames using their real measured frame
// rate, writes `<dir>/<id>_<stamp>.mp4`, and cleans up the temp frames.
// Waits for the (asynchronous) pre-roll files to finish landing on disk
// first, so a recording stopped immediately still encodes its full lead-in.
function finalizeRecording(rec) {
  if (rec.frameCount === 0) {
    // Camera was offline for this whole recording and had nothing buffered — nothing to encode.
    fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
    return;
  }

  rec.preRollWritten.then(() => {
    const fps = video.computeFps(rec.frameCount, rec.firstFrameAt, rec.lastFrameAt, DEFAULT_FPS);

    const outputPath = path.join(rec.dir, `${rec.id}_${rec.stamp}.mp4`);
    const framePattern = path.join(rec.tempDir, 'frame_%06d.jpg');

    const ffmpeg = spawn('ffmpeg', video.buildFfmpegArgs(fps, framePattern, outputPath));

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
  });
}

// Camera pushes a frame here
app.post('/upload/:id', (req, res) => {
  if (req.query.key !== API_KEY) return res.sendStatus(403);
  ingestFrame(getCamera(req.params.id), req.body); // pre-roll buffer, latest frame, live viewers and any active recording
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
// or a camera's alarm-trigger GPIO calling /alarm directly. Includes each
// camera's pre-roll buffer fill, handy for checking the feature is working.
app.get('/status', (req, res) => {
  const out = {};
  for (const id in cameras) {
    out[id] = statusView.buildCameraStatusView(cameras[id]);
  }
  res.json(out);
});

// ── Settings ──
// GET  /settings                         -> { alarmRecordSeconds, preRollSeconds }
// POST /settings?alarmRecordSeconds=N    -> save it, returns the new settings
// preRollSeconds is read-only here: it comes from config.js.
// Same trust boundary as /record (only the PHP layer should
// reach this port). Changes take effect on the next alarm; an alarm
// recording that's already running keeps the length it was started with.
app.get('/settings', (req, res) => {
  res.json(settingsView());
});

app.post('/settings', (req, res) => {
  const result = settingsLogic.applySettingsUpdate(settings, req.query);
  if (result.error) return res.status(400).json({ error: result.error });
  try {
    saveSettings(result.settings);
  } catch (err) {
    console.error('failed saving settings:', err.message);
    return res.status(500).json({ error: 'could not save settings' });
  }
  settings = result.settings;
  res.json(settingsView());
});

// ── Alarm ──
// What a camera's alarm-trigger GPIO ends up calling. Normally the camera
// sends it IN-BAND — a 6-byte control message down its push connection (see
// lib/protocol.js and the push server below), which doesn't stall the
// camera's frame stream. The HTTP routes below are the fallback for when the
// push connection happens to be down, and for anything else that wants to
// trigger an alarm (a script, curl). Either way the camera doesn't say how
// long to record — the duration comes from the stored settings above, so
// it can be changed from the dashboard without touching the boards.
// A recording of alarmRecordSeconds is started — beginning with the last
// preRollSeconds of footage the camera sent BEFORE this request arrived —
// or, if one is already running, extended to alarmRecordSeconds from now.
// Cameras are always streaming, so there is nothing to "wake up": the
// footage that matters is already in the pre-roll buffer by the time the
// alarm request gets here, however slow that request was.
function triggerAlarm(id) {
  return startOrExtendRecording(getCamera(id), id, settings.alarmRecordSeconds);
}

// Every camera the relay knows about — what ALARM_RECORD_ALL_CAMERAS in the
// sketch uses. Each camera contributes its own pre-roll.
function triggerAlarmAll() {
  return Object.keys(cameras).map(triggerAlarm);
}

// Registered before /alarm/:id so "all" isn't taken as a literal camera id.
app.post('/alarm/all', (req, res) => {
  res.json({ cameras: triggerAlarmAll() });
});

app.post('/alarm/:id', (req, res) => {
  res.json(triggerAlarm(req.params.id));
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
  const seconds = validation.parseIntInRange(req.query.seconds, 1, MAX_RECORD_SECONDS);
  if (seconds === null) {
    return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}` });
  }

  const results = Object.keys(cameras).map((id) => startOrExtendRecording(cameras[id], id, seconds));

  res.json({ cameras: results });
});

// Start recording this camera's incoming frames to a file for `seconds`
// (plus the pre-roll lead-in — see the Recording notes above). If it's
// already recording, this extends it instead — see extendRecording().
// Same trust boundary as /status and /settings — no key. Called by the PHP layer (the
// dashboard's RECORD button) and now also directly by camera boards
// themselves, over the LAN, when their alarm-trigger GPIO fires — see the
// ESP32 sketch's ALARM_* constants and sendRecordRequest().
app.post('/record/:id', (req, res) => {
  const seconds = validation.parseIntInRange(req.query.seconds, 1, MAX_RECORD_SECONDS);
  if (seconds === null) {
    return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}` });
  }
  res.json(startOrExtendRecording(getCamera(req.params.id), req.params.id, seconds));
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
  const { elapsed, remaining } = timing.computeElapsedRemaining(
    Date.now(), cam.recording.startedAt.getTime(), cam.recording.endAt.getTime()
  );
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
    .filter((f) => validation.isSafeFilename(f))
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
    .filter((f) => validation.isSafeFilename(f))
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
  if (!validation.isSafeFilename(filename)) return res.sendStatus(400); // rules out any path traversal too
  const filePath = path.join(RECORDINGS_DIR, id, filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.download(filePath);
});

// Delete one recording.
app.delete('/recordings/:id/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (!validation.isSafeFilename(filename)) return res.sendStatus(400);
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
// Besides frames, a camera can send small control messages in the same
// framing — currently just the in-band alarm (see lib/protocol.js).
// Relay -> camera, the only thing ever written is a single legacy byte right
// after a camera authenticates — see the comment where it's sent below.
const pushServer = net.createServer((socket) => {
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let authed = false;
  let camId = null;

  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    if (!authed) {
      const nl = protocol.findAuthLineEnd(buf);
      if (nl === -1) {
        if (protocol.isAuthLineTooLong(buf.length)) socket.destroy(); // malformed/oversized auth line
        return;
      }
      const parsed = protocol.parseAuthLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (!parsed || parsed.key !== API_KEY) {
        socket.destroy();
        return;
      }
      camId = parsed.id;
      authed = true;

      const cam = getCamera(camId);
      cam.socket = socket;
      // COMPATIBILITY SHIM: cameras can no longer be paused (pre-roll needs
      // them streaming all the time), but a board still running the OLD
      // firmware that was paused when this relay was upgraded would stay
      // paused until power-cycled. Telling it "resume" (0x01) on every
      // connect un-sticks it; firmware without a pause feature just
      // discards the byte. Safe to delete once every camera is reflashed.
      socket.write(protocol.encodeControlByte(true));
    }

    // Drain as many complete [length][payload] frames as are buffered
    let drained;
    try {
      drained = protocol.drainFrames(buf);
    } catch (err) {
      socket.destroy(); // malformed/oversized length prefix — same guard the inline loop used
      return;
    }
    buf = drained.rest;

    for (const payload of drained.frames) {
      const msg = protocol.classifyPayload(payload);
      if (msg.kind === 'frame') {
        ingestFrame(getCamera(camId), payload); // pre-roll buffer, latest frame, live viewers and any active recording
      } else if (msg.kind === 'alarm') {
        // Handled right here, in order with the frames: every frame the camera
        // sent before this message is already in its pre-roll buffer, and
        // nothing it sends afterwards can be missed. The camera is
        // authenticated (this socket passed the key check), so unlike the
        // keyless HTTP route this can only be triggered by a real camera.
        if (msg.all) {
          const started = triggerAlarmAll();
          console.log(`[${camId}] in-band alarm -> recording on ${started.length} camera(s)`);
        } else {
          const r = triggerAlarm(camId);
          console.log(`[${camId}] in-band alarm -> ${r.extended ? 'extended' : 'started'} recording (${r.preRollFrames} pre-roll frames)`);
        }
      }
      // msg.kind === 'unknown': a control message from newer firmware than this
      // relay — ignore it rather than mistake it for a frame or drop the camera.
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
