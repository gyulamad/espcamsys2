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
const auth = require('./lib/auth');
const logentry = require('./lib/logentry');
const logfile = require('./lib/logfile');
const { LogWriter } = require('./lib/logwriter');
const { Throttle } = require('./lib/throttle');

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
console.log(preRollCfg.seconds > 0
  ? `Pre-roll: every recording starts with the last ${preRollCfg.seconds}s of footage (up to ${Math.round(preRollCfg.maxBytes / 1048576)} MiB per camera)`
  : 'Pre-roll: disabled (preRollSeconds = 0)');

// ── Persistent settings ──
// ── Logging ──
// One plain-text log file (see lib/logfile.js for the format) that collects:
//   - what the CAMERAS report, sent to POST /log (their serial output, moved
//     here because assembled cameras have no serial monitor attached), and
//   - what the RELAY itself observes: cameras connecting and dropping (with
//     their IP address), rejected connections, recording start/stop/save,
//     errors with stack traces, and the stack trace of a crash that kills the
//     relay — so "no idea what went wrong" has an answer in one place.
// Settings in config.js: logFile, logMaxBytes, logKeepFiles (the LOG_FILE /
// LOG_MAX_BYTES / LOG_KEEP_FILES env vars override them). The file rotates, so
// it can never fill the SD card (see lib/logwriter.js).
const logCfg = logfile.resolveLogConfig({
  file: process.env.LOG_FILE !== undefined ? process.env.LOG_FILE : config.logFile,
  maxBytes: process.env.LOG_MAX_BYTES !== undefined ? process.env.LOG_MAX_BYTES : config.logMaxBytes,
  keep: process.env.LOG_KEEP_FILES !== undefined ? process.env.LOG_KEEP_FILES : config.logKeepFiles,
}, __dirname);
for (const w of logCfg.warnings) console.warn(`[config] ${w}`);

let logWriter = null;
try {
  logWriter = new LogWriter({ file: logCfg.file, maxBytes: logCfg.maxBytes, keep: logCfg.keep });
} catch (err) {
  // Logging must never stop the relay from running — it just goes to the console only.
  console.error(`[log] cannot use the log file ${logCfg.file}: ${err.message} — file logging is OFF`);
}

const logFailureThrottle = new Throttle(60 * 1000);
function reportLogWriteFailure(err) {
  if (logFailureThrottle.check('write', Date.now()).allow) console.error(`[log] could not write to ${logCfg.file}: ${err.message}`);
}

// Records an event in the log file (and echoes it to the console, which is
// what `journalctl` / `pm2 logs` show).
//   sender  who it is about ('relay', or a camera id)
//   ip      that sender's address, when known
//   via     'relay' = observed by the relay rather than reported by the camera
//   trace   extra detail on indented lines (a stack trace, usually)
function relayLog(level, message, { sender = 'relay', ip, via, trace, extras, time } = {}) {
  const echo = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  if (trace) echo(`[${sender}] ${message}\n${trace}`);
  else echo(`[${sender}] ${message}`);
  if (!logWriter) return;
  const text = logfile.formatEntry({ time: time || new Date(), level, sender, ip, via, extras, message, trace });
  logWriter.append(text).catch(reportLogWriteFailure);
}

// Same, but synchronous: for the moment the process is about to die, when
// there is no time to wait for the write queue.
function relayLogSync(level, message, { sender = 'relay', trace } = {}) {
  if (!logWriter) return;
  try {
    logWriter.appendSync(logfile.formatEntry({ time: new Date(), level, sender, message, trace }));
  } catch (err) {
    reportLogWriteFailure(err);
  }
}

// An event about a camera, as seen by the relay (carries the camera's address).
function camLog(level, camId, message, opts = {}) {
  const cam = cameras[camId];
  relayLog(level, message, Object.assign({ sender: camId, ip: cam && cam.ip, via: 'relay' }, opts));
}

// Things that can repeat very fast get a window: at most one line per
// window per camera/address, then a count of how many were skipped.
const eventThrottle = new Throttle(10 * 1000);   // connect / disconnect of a camera
const authFailThrottle = new Throttle(60 * 1000); // rejected connections / requests
const pushErrThrottle = new Throttle(5 * 1000);   // errors while handling a camera's messages
const writeErrThrottle = new Throttle(10 * 1000); // failing to write recording files
function suppressedNote(n) {
  return n > 0 ? ` (${n} similar event${n === 1 ? '' : 's'} not logged since the last one)` : '';
}

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

const cameras = {}; // id -> { frame, emitter, lastSeen, socket, ip, recording, preRoll, lastRecordedUntil }

function getCamera(id) {
  if (!cameras[id]) {
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      socket: null,             // the camera's live push-connection socket, if connected right now
      ip: null,                 // that camera's address, as of its last push connection
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
// Failing to write a recording's files (disk full, permissions) can repeat on
// every single frame — log it once per window with a count, not 10 times a second.
function logRecordingWriteError(id, what, err) {
  const t = writeErrThrottle.check(`${id}:${what}`, Date.now());
  if (t.allow) camLog('ERROR', id, `failed writing a ${what}: ${err.message}${suppressedNote(t.suppressed)}`);
}

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
      logRecordingWriteError(rec.id, 'pre-roll frame', err);
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
      logRecordingWriteError(id, 'recording frame', err);
    }
  };
  cam.emitter.on('frame', rec.onFrame);

  rec.timer = setTimeout(() => stopRecording(cam), seconds * 1000);
  cam.recording = rec;
  camLog('INFO', id, `recording started (${seconds}s, with ${preFrames.length} pre-roll frames)`);
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
  camLog('INFO', rec.id, `recording extended — now ends in ${seconds}s`);
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
  const spanS = rec.firstFrameAt != null ? ((rec.lastFrameAt - rec.firstFrameAt) / 1000).toFixed(1) : '0';
  camLog('INFO', rec.id, `recording stopped (${rec.frameCount} frames over ${spanS}s) — encoding`);
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
    camLog('WARN', rec.id, 'recording had no frames (the camera sent nothing during it, and nothing was buffered) — nothing saved');
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
      camLog('ERROR', rec.id, `ffmpeg failed to start (is it installed?): ${err.message} — raw frames kept at ${rec.tempDir}`);
    });

    ffmpeg.on('exit', (code) => {
      if (code === 0) {
        camLog('INFO', rec.id, `recording saved as ${path.basename(outputPath)}`);
        fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
      } else {
        camLog('ERROR', rec.id, `ffmpeg exited with code ${code} — raw frames kept at ${rec.tempDir}`);
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
// How many saved recordings a camera has — the same rule the file list uses
// (see validation.countRecordingFiles). 0 if it has no folder yet; null if the
// folder exists but couldn't be read, so one bad folder shows up as "unknown"
// for that camera instead of failing the whole status response.
async function countRecordings(id) {
  try {
    return validation.countRecordingFiles(await fsp.readdir(path.join(RECORDINGS_DIR, id)));
  } catch (err) {
    return err.code === 'ENOENT' ? 0 : null;
  }
}

// Ids of every camera that has a recordings folder, whether or not the relay
// has seen that camera since it last started — footage on disk is still
// footage you want to see counted after a restart, before the camera has
// reconnected.
async function recordingFolderIds() {
  try {
    const entries = await fsp.readdir(RECORDINGS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    return [];
  }
}

// Cameras that only exist as a folder of footage have never been seen by this
// relay run, so they get a quiet "never seen, not recording" entry.
const NEVER_SEEN = { lastSeen: null, recording: null, preRoll: null };

app.get('/status', async (req, res) => {
  try {
    const ids = [...new Set([...Object.keys(cameras), ...(await recordingFolderIds())])].sort();
    const views = await Promise.all(ids.map(async (id) =>
      statusView.buildCameraStatusView(cameras[id] || NEVER_SEEN, await countRecordings(id))));
    const out = {};
    ids.forEach((id, i) => { out[id] = views[i]; });
    res.json(out);
  } catch (err) {
    relayLog('ERROR', `GET /status failed: ${err.message}`, { trace: err && err.stack });
    res.sendStatus(500);
  }
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
    relayLog('ERROR', `failed saving settings: ${err.message}`);
    return res.status(500).json({ error: 'could not save settings' });
  }
  settings = result.settings;
  res.json(settingsView());
});

// ── Camera logs ──
// POST /log — where a camera sends what used to go only to its serial port:
// errors, warnings and notable events, each with a trace (where in the
// firmware it came from, and the events just before it).
//
//   Authenticated with the camera key (camKey in config.js) in an
//   X-Api-Key header (or ?key=): unlike the dashboard-facing routes, anyone
//   on the network could otherwise write into this file and fill the SD card.
//   Checked BEFORE the body is parsed, so an unauthenticated client can't make
//   the relay work on its data at all.
//
//   Body (JSON): { camera, fw?, attempt?, dropped?, entries: [ { seq?, level, ageMs?, uptimeMs?, heap?, rssi?, message, trace? } ] }
//   Cameras have no clock, so each entry says how long AGO it happened (ageMs):
//   the relay files it under the time it actually happened, even when it sat
//   in the camera's memory for minutes while the relay was unreachable.
//
//   200 { ok, accepted, rejected } once the entries are in the file — the
//   camera deletes them from its memory only then. Anything else (401 wrong
//   key, 400 bad body, 413 too big, 500/503 the relay can't write the file)
//   makes the camera keep them and retry later.
app.post('/log',
  (req, res, next) => {
    if (auth.safeEqual(auth.extractKey(req), API_KEY)) return next();
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    const t = authFailThrottle.check(`log:${ip}`, Date.now());
    if (t.allow) relayLog('WARN', `rejected a POST /log from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
    return res.status(401).json({ error: 'missing or wrong key' });
  },
  express.json({ limit: '32kb' }),
  async (req, res) => {
    const parsed = logentry.parseLogBatch(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (!logWriter) return res.status(503).json({ error: 'the relay cannot write its log file' });

    const { batch } = parsed;
    const receivedAt = Date.now();
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    const first = logfile.eventTime(receivedAt, Math.max(...batch.entries.map((e) => e.ageMs)));
    let text = '';
    if (batch.dropped > 0) {
      text += logfile.formatEntry({
        time: first, level: 'WARN', sender: batch.camera, ip, via: 'relay',
        message: `the camera reports ${batch.dropped} log entries were lost before they could be delivered (its memory queue overflowed, or the relay was unreachable for too long)`,
      });
    }
    if (parsed.rejected > 0) {
      text += logfile.formatEntry({
        time: first, level: 'WARN', sender: batch.camera, ip, via: 'relay',
        message: `${parsed.rejected} unusable entries in a log request were skipped`,
      });
    }
    for (const e of batch.entries) {
      text += logfile.formatEntry({
        time: logfile.eventTime(receivedAt, e.ageMs), level: e.level, sender: batch.camera, ip,
        extras: { uptimeMs: e.uptimeMs, heap: e.heap, rssi: e.rssi, seq: e.seq, attempt: batch.attempt, lateMs: e.ageMs, fw: batch.fw },
        message: e.message, trace: e.trace,
      });
    }
    try {
      await logWriter.append(text);
    } catch (err) {
      reportLogWriteFailure(err);
      return res.status(500).json({ error: 'could not write the log file' });
    }
    // Echo to the console too (journalctl / pm2 logs), one short line each.
    for (const e of batch.entries) {
      const echo = e.level === 'ERROR' ? console.error : e.level === 'WARN' ? console.warn : console.log;
      echo(`[${batch.camera}] ${e.level} ${e.message.split('\n')[0]}`);
    }
    return res.json({ ok: true, accepted: batch.entries.length, rejected: parsed.rejected });
  });

// A malformed or oversized /log body should be answered clearly, not with Express's HTML error page.
app.use('/log', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large (limit 32 KB)' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body is not valid JSON' });
  return next(err);
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
function triggerAlarm(id, source = 'HTTP') {
  camLog('INFO', id, `alarm received (${source})`);
  return startOrExtendRecording(getCamera(id), id, settings.alarmRecordSeconds);
}

// Every camera the relay knows about — what ALARM_RECORD_ALL_CAMERAS in the
// sketch uses. Each camera contributes its own pre-roll.
function triggerAlarmAll(source = 'HTTP') {
  return Object.keys(cameras).map((id) => triggerAlarm(id, source));
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

// Any error a route doesn't handle itself ends up here: recorded with its stack
// trace (Express's default handler would only print it to the console), and
// answered with a plain 500.
app.use((err, req, res, next) => {
  relayLog('ERROR', `unhandled error in ${req.method} ${req.path}: ${err && err.message ? err.message : err}`, { trace: err && err.stack });
  if (res.headersSent) return next(err);
  return res.sendStatus(500);
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
// Anything that goes wrong while handling a message from a camera (starting
// a recording on a full disk, a bad folder permission, a bug) must never be
// able to take the relay down: this code runs inside the raw socket's 'data'
// event, where — unlike an Express route, which turns a thrown error into a
// 500 — an uncaught exception ends the whole process and every camera's live
// stream with it. So each message is handled in a try/catch, the error is
// logged with its stack trace, and the camera stays connected and streaming.
// Logged at most once per 5s per camera+kind, so a persistent fault can't
// flood the log at 10 frames a second.
function logPushError(camId, what, err) {
  const t = pushErrThrottle.check(`${camId}:${what}`, Date.now());
  if (!t.allow) return;
  camLog('ERROR', camId, `error handling a ${what} from the push connection (camera stays connected): ${err && err.message ? err.message : err}${suppressedNote(t.suppressed)}`,
    { trace: err && err.stack ? err.stack : String(err) });
}

const pushServer = net.createServer((socket) => {
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let authed = false;
  let camId = null;
  let connectedAt = 0;
  let lastSocketError = null; // why the connection ended, if the OS told us
  const peerIp = logfile.normalizeIp(socket.remoteAddress);

  // A connection we refuse: one line per address per minute (a scanner or a
  // misconfigured camera retrying every second must not flood the log).
  const reject = (who, why) => {
    const t = authFailThrottle.check(`push:${peerIp}`, Date.now());
    if (t.allow) relayLog('WARN', `rejected a push connection from ${peerIp || 'unknown address'}: ${why}${suppressedNote(t.suppressed)}`, { sender: who || 'unknown' });
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    if (!authed) {
      const nl = protocol.findAuthLineEnd(buf);
      if (nl === -1) {
        if (protocol.isAuthLineTooLong(buf.length)) reject(null, 'oversized or malformed first line'); // malformed/oversized auth line
        return;
      }
      const parsed = protocol.parseAuthLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (!parsed) return reject(null, 'malformed first line');
      if (!auth.safeEqual(parsed.key, API_KEY)) return reject(parsed.id, 'wrong key');
      camId = parsed.id;
      authed = true;
      connectedAt = Date.now();

      const cam = getCamera(camId);
      // Two boards flashed with the same CAMERA_ID fight over one stream: frames from both
      // interleave and each reconnect kicks the other. Say so — it is easy to do and hard to spot.
      const other = cam.socket && cam.socket !== socket && !cam.socket.destroyed ? cam.socket : null;
      cam.socket = socket;
      cam.ip = peerIp;
      const t = eventThrottle.check(`${camId}:connect`, connectedAt);
      if (t.allow) camLog('INFO', camId, `camera connected${suppressedNote(t.suppressed)}`);
      if (other) {
        camLog('WARN', camId, `another connection with the SAME camera id is still open (from ${logfile.normalizeIp(other.remoteAddress)}) — is CAMERA_ID unique per board? Two boards sharing an id corrupt each other's stream`);
      }
      // Greet the camera with two single bytes (see lib/protocol.js):
      //  1. COMPATIBILITY SHIM — cameras can no longer be paused (pre-roll needs
      //     them streaming all the time), but a board still running the OLD
      //     firmware that was paused when this relay was upgraded would stay
      //     paused until power-cycled. "Resume" (0x01) un-sticks it; firmware
      //     without a pause feature just discards it. Safe to delete once
      //     every camera is reflashed.
      //  2. CAPABILITY — "I understand in-band alarm messages". Firmware only
      //     sends those after seeing this on the current connection, so a
      //     camera can never feed an alarm message to a relay that would
      //     mistake it for a video frame.
      socket.write(protocol.encodeRelayGreeting());
    }

    // Drain as many complete [length][payload] frames as are buffered
    let drained;
    try {
      drained = protocol.drainFrames(buf);
    } catch (err) {
      camLog('WARN', camId, `dropped the connection: ${err.message} (a corrupt or out-of-step video stream)`);
      socket.destroy(); // malformed/oversized length prefix — same guard the inline loop used
      return;
    }
    buf = drained.rest;

    for (const payload of drained.frames) {
      let kind = 'message';
      try {
        const msg = protocol.classifyPayload(payload);
        kind = msg.kind;
        if (msg.kind === 'frame') {
          ingestFrame(getCamera(camId), payload); // pre-roll buffer, latest frame, live viewers and any active recording
        } else if (msg.kind === 'alarm') {
          // Handled right here, in order with the frames: every frame the camera
          // sent before this message is already in its pre-roll buffer, and
          // nothing it sends afterwards can be missed. The camera is
          // authenticated (this socket passed the key check), so unlike the
          // keyless HTTP route this can only be triggered by a real camera.
          // (Each camera's own "alarm received" / "recording started|extended" lines
          // are written by triggerAlarm() and the recording code.)
          if (msg.all) triggerAlarmAll('in-band, all cameras');
          else triggerAlarm(camId, 'in-band');
        }
        // msg.kind === 'unknown': a control message from newer firmware than this
        // relay — ignore it rather than mistake it for a frame or drop the camera.
      } catch (err) {
        logPushError(camId, kind === 'frame' ? 'video frame' : kind === 'alarm' ? 'alarm' : 'message', err);
      }
    }
  });

  socket.on('close', (hadError) => {
    const wasCurrent = camId && cameras[camId] && cameras[camId].socket === socket;
    if (wasCurrent) cameras[camId].socket = null;
    if (!authed) return;
    const t = eventThrottle.check(`${camId}:disconnect`, Date.now());
    if (!t.allow) return;
    const secs = Math.round((Date.now() - connectedAt) / 1000);
    const why = lastSocketError ? ` (${lastSocketError})` : '';
    camLog(hadError || lastSocketError ? 'WARN' : 'INFO', camId,
      `camera disconnected after ${secs}s${why}${wasCurrent ? '' : ' [a newer connection had already replaced it]'}${suppressedNote(t.suppressed)}`);
  });

  socket.on('error', (err) => { lastSocketError = err && err.code ? err.code : String(err); }); // camera dropped/reset — reported when the socket closes; the next reconnect just starts a new session
});

pushServer.listen(PUSH_PORT, () => console.log(`Camera relay (raw push) listening on :${PUSH_PORT}`));

// ── Process lifecycle, for the log ──
// A relay that restarted is the first thing to rule in or out when a camera
// "dropped", and a crash is useless without its stack trace — so both leave a
// line (written synchronously: the process may be about to die).
relayLog('INFO', `relay started (pid ${process.pid}, node ${process.version}; HTTP :${PORT}, push :${PUSH_PORT}; pre-roll ${preRollCfg.seconds}s; log file ${logCfg.file})`);

process.on('uncaughtException', (err) => {
  relayLogSync('ERROR', `FATAL: uncaught exception — the relay is stopping: ${err && err.message ? err.message : err}`, { trace: err && err.stack });
  console.error(err);
  process.exit(1);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    relayLogSync('INFO', `relay stopping (${sig})`);
    process.exit(0);
  });
}
