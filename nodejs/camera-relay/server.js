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
const devicesettings = require('./lib/devicesettings');
const firmware = require('./lib/firmware');
const { LogWriter } = require('./lib/logwriter');
const { Throttle } = require('./lib/throttle');
const connection = require('./lib/connection');
const { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic } = require('./lib/util');
const { RecordingSwitch, describeOff, parseMinutes, DEFAULT_OFF_MINUTES } = require('./lib/recswitch');

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
const fromEnv = (name, fallback) => envOr(process.env, name, fallback);
const preRollCfg = preroll.resolvePreRollConfig({
  seconds: fromEnv('PREROLL_SECONDS', config.preRollSeconds),
  maxBytes: fromEnv('PREROLL_MAX_BYTES', config.preRollMaxBytes),
});
for (const w of preRollCfg.warnings) console.warn(`[config] ${w}`);
console.log(preRollCfg.seconds > 0
  ? `Pre-roll: every recording starts with the last ${preRollCfg.seconds}s of footage (up to ${Math.round(preRollCfg.maxBytes / 1048576)} MiB per camera)`
  : 'Pre-roll: disabled (preRollSeconds = 0)');

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
  file: fromEnv('LOG_FILE', config.logFile),
  maxBytes: fromEnv('LOG_MAX_BYTES', config.logMaxBytes),
  keep: fromEnv('LOG_KEEP_FILES', config.logKeepFiles),
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
  console[consoleMethodFor(level)](trace ? `[${sender}] ${message}\n${trace}` : `[${sender}] ${message}`);
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
const suppressedThrottle = new Throttle(60 * 1000); // "ignored a recording request while OFF": once a minute per camera
const switchAuthThrottle = new Throttle(60 * 1000); // recording on/off requests with a missing or wrong control key
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
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
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

// ── Recording ON/OFF switch ──
// Each camera can be switched OFF, so that nothing records while people are at
// the surveilled place (otherwise every movement is recorded and somebody has
// to sort the footage by hand later). OFF is either for N minutes — it
// switches itself back ON — or until someone switches it ON. The "all cameras"
// button just sets every camera the relay knows at that moment, one by one;
// afterwards each can be changed on its own, and a camera the relay hasn't
// seen is unaffected. See lib/recswitch.js for the rules.
//
// OFF means no recording can START by any route — an alarm (in-band or HTTP),
// the person detector, the dashboard's RECORD button — and a recording that is
// running is stopped (what it captured so far is saved, not thrown away).
// Live viewing is unaffected. When recording is switched back ON, footage the
// camera streamed while it was OFF is never part of a clip (see resumeCamera).
//
// The state is saved to a small file, so it survives a relay restart: a timed
// OFF is stored as the absolute time it ends, so it keeps counting while the
// relay is down. A damaged file means every camera records.
//
// Changing it needs the CONTROL key (`controlKey` in config.js, sent as an
// X-Control-Key header) — deliberately NOT the camera key: that one is flashed
// into every camera board, and anyone who got hold of a board could otherwise
// switch the whole system off. With no controlKey configured the switch is
// refused (not left open). Reading the state needs nothing.
const SWITCH_FILE = process.env.SWITCH_FILE || path.resolve(__dirname, config.switchFile || 'recording-switch.json');
const CONTROL_KEY = fromEnv('CONTROL_KEY', config.controlKey || '');

// How long a push connection may stay completely silent before the relay
// decides it is dead and drops it: before the camera has said who it is, and
// once it is streaming. A camera on a very weak WiFi link can take many seconds
// per frame, but bytes still trickle in; a full minute of nothing means the
// connection is gone (a half-open TCP connection never tells us by itself).
const PUSH_AUTH_TIMEOUT_MS = connection.parseTimeoutMs(fromEnv('PUSH_AUTH_TIMEOUT_MS'), 10 * 1000);
const PUSH_IDLE_TIMEOUT_MS = connection.parseTimeoutMs(fromEnv('PUSH_IDLE_TIMEOUT_MS'), 60 * 1000);
const PUSH_KEEPALIVE_MS = 20 * 1000;

function offText(state) {
  return state.until === null ? 'until it is switched back ON' : `until ${new Date(state.until).toISOString()}`;
}

function loadSwitch() {
  let text;
  try {
    text = fs.readFileSync(SWITCH_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') relayLog('WARN', `could not read the recording-switch file ${SWITCH_FILE}: ${err.message} — every camera records`);
    return new RecordingSwitch();
  }
  const r = RecordingSwitch.parse(text, Date.now());
  for (const w of r.warnings) relayLog('WARN', w);
  for (const id of r.expired) relayLog('INFO', `recording for ${id} was switched OFF for a limited time, which ran out while the relay was stopped — it records again`, { sender: id });
  const off = r.sw.offIds(Date.now());
  if (off.length) relayLog('INFO', `recording is switched OFF (restored from ${SWITCH_FILE}) for: ${off.map((id) => `${id} ${offText(r.sw.offState(id, Date.now()))}`).join('; ')}`);
  return r.sw;
}
const recSwitch = loadSwitch();

// Written atomically, like settings.json: a half-written file would silently
// turn every OFF back ON.
function saveSwitch() {
  try {
    writeFileAtomic(SWITCH_FILE, recSwitch.serialize());
    return true;
  } catch (err) {
    relayLog('ERROR', `could not save the recording switch to ${SWITCH_FILE}: ${err.message} — the change applies now but will be forgotten if the relay restarts`);
    return false;
  }
}

// The camera may record again from `atMs`. Everything it streamed before that
// is marked as "already dealt with", so the pre-roll of the next recording can
// only contain footage from after recording was allowed again — nothing from
// the OFF period can leak into a clip through the rolling buffer.
function resumeCamera(id, atMs) {
  const cam = cameras[id];
  if (cam) cam.lastRecordedUntil = Math.max(cam.lastRecordedUntil || 0, atMs);
}

// Ends timed OFFs whose time is up. Run on a timer AND at the start of every
// decision that depends on it (so the answer is exact, not up to a few
// seconds late), it is cheap and does nothing when nothing expired.
function refreshSwitch(now = Date.now()) {
  const ended = recSwitch.expire(now);
  if (ended.length === 0) return;
  for (const e of ended) {
    resumeCamera(e.id, e.until);
    camLog('INFO', e.id, 'recording switched back ON automatically (the OFF timer ran out)');
  }
  saveSwitch();
}
setInterval(refreshSwitch, 5000).unref();

// Starts a recording of `seconds`, or — if one is already running —
// extends it to `seconds` from now. The one place the alarm, "record all"
// and per-camera record routes get that behaviour, so they can't diverge.
// Returns the JSON-ready summary those routes respond with.
function startOrExtendRecording(cam, id, seconds) {
  // The switch comes first: while a camera is OFF nothing can start a recording.
  refreshSwitch();
  const off = recSwitch.offState(id, Date.now());
  if (off) {
    const t = suppressedThrottle.check(id, Date.now());
    if (t.allow) camLog('INFO', id, `recording request ignored — recording is switched OFF for this camera ${offText(off)}${suppressedNote(t.suppressed)}`);
    return { id, recording: false, suppressed: true, reason: 'off', off: describeOff(off, Date.now()) };
  }
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
    removeTempDir(rec);
    return;
  }
  rec.preRollWritten.then(() => encodeRecording(rec));
}

function removeTempDir(rec) {
  fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
}

function encodeRecording(rec) {
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
    if (code !== 0) {
      camLog('ERROR', rec.id, `ffmpeg exited with code ${code} — raw frames kept at ${rec.tempDir}`);
      return;
    }
    camLog('INFO', rec.id, `recording saved as ${path.basename(outputPath)}`);
    removeTempDir(rec);
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

// Quick health check across all cameras — also what the dashboard polls on
// an interval (via status.php) to pick up state changes that didn't
// originate from a click in that browser tab: another tab, another user,
// or a camera's alarm-trigger GPIO calling /alarm directly. Includes each
// camera's pre-roll buffer fill, handy for checking the feature is working.
app.get('/status', async (req, res) => {
  try {
    const ids = [...new Set([...Object.keys(cameras), ...(await recordingFolderIds())])].sort();
    refreshSwitch();
    const now = Date.now();
    const views = await Promise.all(ids.map(async (id) =>
      statusView.buildCameraStatusView(cameras[id] || NEVER_SEEN, await countRecordings(id), describeOff(recSwitch.offState(id, now), now))));
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

// ── Recording switch: changing it (authenticated) and reading it ──
//   POST /recording/camera/:id/off?minutes=N   switch ONE camera OFF for N minutes (default 60; 0 or negative = until ON)
//   POST /recording/camera/:id/on
//   POST /recording/all/off?minutes=N          the same for every camera the relay knows right now
//   POST /recording/all/on
//   GET  /recording/state                      who is OFF (no key needed)
// The four POSTs need `X-Control-Key: <controlKey>`; see the notes at the switch above.
function requireControlKey(req, res, next) {
  if (!CONTROL_KEY) {
    return res.status(503).json({ error: 'switching is disabled: controlKey is not set in the relay config' });
  }
  const provided = req.headers['x-control-key'];
  if (typeof provided === 'string' && auth.safeEqual(provided, CONTROL_KEY)) return next();
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = switchAuthThrottle.check(ip || 'unknown', Date.now());
  if (t.allow) relayLog('WARN', `REJECTED a recording on/off request from ${ip || 'unknown address'} (${req.method} ${req.path}): missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}

// Who is doing this, for the log: the dashboard passes the logged-in user's
// name in X-Actor (the relay only sees the web server's own address).
function actorOf(req) {
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const raw = req.headers['x-actor'];
  return typeof raw === 'string' && raw.trim() !== '' ? `${logfile.safeToken(raw.trim())} (via ${ip || 'unknown address'})` : (ip || 'unknown address');
}

// { id: description-or-null } for each of `ids`, in the shape the API returns.
function describeOffStates(ids) {
  const now = Date.now();
  const off = {};
  for (const id of ids) off[id] = describeOff(recSwitch.offState(id, now), now);
  return off;
}

function switchOffCameras(ids, minutes, actor) {
  const now = Date.now();
  for (const id of ids) {
    const entry = recSwitch.turnOff(id, minutes, now);
    camLog('INFO', id, `recording switched OFF ${offText(entry)} by ${actor}`);
    const cam = cameras[id];
    if (cam && cam.recording) stopRecording(cam); // what it captured so far is saved; stopRecording logs it
  }
  saveSwitch();
}

function switchOnCameras(ids, actor) {
  const now = Date.now();
  for (const id of ids) {
    if (!recSwitch.turnOn(id)) continue; // it was not OFF: nothing to do
    resumeCamera(id, now);
    camLog('INFO', id, `recording switched ON by ${actor}`);
  }
  saveSwitch();
}

// Builds the handler for the four POST routes. `target` returns the camera
// ids to act on, or null after having answered with an error.
function switchHandler(action, target) {
  return (req, res) => {
    refreshSwitch();
    const ids = target(req, res);
    if (ids === null) return undefined;
    let minutes = null;
    if (action === 'off') {
      const m = parseMinutes(req.query.minutes);
      if (!m.ok) return res.status(400).json({ error: m.error });
      minutes = m.minutes;
      switchOffCameras(ids, minutes, actorOf(req));
    } else {
      switchOnCameras(ids, actorOf(req));
    }
    return res.json({ ok: true, action, minutes, forever: action === 'off' ? minutes === 0 : null, affected: ids, off: describeOffStates(ids) });
  };
}
const oneCamera = (req, res) => {
  if (!logentry.CAMERA_ID_RE.test(req.params.id)) { res.status(400).json({ error: 'invalid camera id' }); return null; }
  return [req.params.id];
};
const everyKnownCamera = () => Object.keys(cameras).sort();

app.post('/recording/camera/:id/off', requireControlKey, switchHandler('off', oneCamera));
app.post('/recording/camera/:id/on', requireControlKey, switchHandler('on', oneCamera));
app.post('/recording/all/off', requireControlKey, switchHandler('off', everyKnownCamera));
app.post('/recording/all/on', requireControlKey, switchHandler('on', everyKnownCamera));

app.get('/recording/state', (req, res) => {
  refreshSwitch();
  res.json({ off: describeOffStates(recSwitch.offIds(Date.now())), controlEnabled: CONTROL_KEY !== '', defaultMinutes: DEFAULT_OFF_MINUTES });
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
// The log-file text for one batch from a camera: a note if the camera lost
// entries or some were unusable, then each entry filed under the time it
// actually happened.
function formatCameraLogBatch(batch, rejected, ip, receivedAt) {
  const first = logfile.eventTime(receivedAt, Math.max(...batch.entries.map((e) => e.ageMs)));
  const note = (message) => logfile.formatEntry({ time: first, level: 'WARN', sender: batch.camera, ip, via: 'relay', message });

  let text = '';
  if (batch.dropped > 0) {
    text += note(`the camera reports ${batch.dropped} log entries were lost before they could be delivered (its memory queue overflowed, or the relay was unreachable for too long)`);
  }
  if (rejected > 0) text += note(`${rejected} unusable entries in a log request were skipped`);
  for (const e of batch.entries) {
    text += logfile.formatEntry({
      time: logfile.eventTime(receivedAt, e.ageMs), level: e.level, sender: batch.camera, ip,
      extras: { uptimeMs: e.uptimeMs, heap: e.heap, rssi: e.rssi, seq: e.seq, attempt: batch.attempt, lateMs: e.ageMs, fw: batch.fw },
      message: e.message, trace: e.trace,
    });
  }
  return text;
}

// Echo to the console too (journalctl / pm2 logs), one short line each.
function echoCameraLogBatch(batch) {
  for (const e of batch.entries) {
    console[consoleMethodFor(e.level)](`[${batch.camera}] ${e.level} ${e.message.split('\n')[0]}`);
  }
}

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
    try {
      await logWriter.append(formatCameraLogBatch(batch, parsed.rejected, logfile.normalizeIp(req.socket.remoteAddress), Date.now()));
    } catch (err) {
      reportLogWriteFailure(err);
      return res.status(500).json({ error: 'could not write the log file' });
    }
    echoCameraLogBatch(batch);
    return res.json({ ok: true, accepted: batch.entries.length, rejected: parsed.rejected });
  });

// A malformed or oversized /log body should be answered clearly, not with Express's HTML error page.
app.use('/log', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large (limit 32 KB)' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body is not valid JSON' });
  return next(err);
});

// ── Settings staged for boards that are missing some ──
// A board keeps its settings in its own flash and has no defaults, so a new
// firmware that needs one more setting would leave the board waiting for a USB
// cable. Instead, a board whose Wi-Fi and relay settings are fine asks here for
// the ones it lacks. The relay only stores and hands out ONE line of text in the
// serial console's KEY=value;KEY=value form — the board validates it, and uses
// only the settings it is actually missing (see lib/devicesettings.js and
// RemoteFill in the sketches' settings_logic.h).
//   GET /device-settings/:type/:id   camera key: the line staged for that device,
//                                    else for the whole type; 404 if none
//   PUT /device-settings/:type/:id   control key: stage a line for one device
//   PUT /device-settings/:type       control key: stage a line for every device of the type
// (an empty PUT body removes what was staged). :type is recorder or detector.
// Files live in config.deviceSettingsDir (default device-settings/ next to server.js;
// DEVICE_SETTINGS_DIR overrides it).
const DEVICE_SETTINGS_DIR = path.resolve(__dirname, fromEnv('DEVICE_SETTINGS_DIR', config.deviceSettingsDir || 'device-settings'));
const deviceSettingsAuthThrottle = new Throttle(60 * 1000);
const deviceSettingsLogGate = new devicesettings.FetchLogGate(10 * 60 * 1000);

function readStagedFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

app.get('/device-settings/:type/:id',
  (req, res, next) => {
    if (auth.safeEqual(auth.extractKey(req), API_KEY)) return next();
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    const t = deviceSettingsAuthThrottle.check(`get:${ip}`, Date.now());
    if (t.allow) relayLog('WARN', `rejected a GET ${req.path} from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
    return res.status(401).json({ error: 'missing or wrong key' });
  },
  (req, res) => {
    const { type, id } = req.params;
    if (!devicesettings.isType(type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
    if (!devicesettings.isId(id)) return res.status(400).json({ error: 'not a valid device id' });
    const need = devicesettings.parseNeed(req.query.need);
    let staged;
    try {
      staged = devicesettings.pickStaged(
        readStagedFile(devicesettings.fileFor(DEVICE_SETTINGS_DIR, type, id)),
        readStagedFile(devicesettings.fileFor(DEVICE_SETTINGS_DIR, type, null)));
    } catch (err) {
      relayLog('ERROR', `could not read the staged settings for ${id}: ${errorMessage(err)}`, { sender: id });
      return res.status(500).json({ error: 'could not read the staged settings' });
    }
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    const needText = need.length ? need.join(', ') : '(not stated)';
    if (deviceSettingsLogGate.check(id, `${staged ? staged.source : 'none'}|${need.join(',')}`, Date.now())) {
      relayLog(staged ? 'INFO' : 'WARN',
        staged
          ? `${id} (${type}) is missing settings (${needText}) and was sent the ${staged.source} line staged for it (${devicesettings.keyNames(staged.line).join(', ') || 'no settings'})`
          : `${id} (${type}) is missing settings (${needText}) and nothing is staged for it - PUT /device-settings/${type}/${id} (or /device-settings/${type} for all of them)`,
        { sender: id, ip, via: 'relay' });
    }
    if (!staged) return res.status(404).type('text/plain').send('nothing staged');
    return res.type('text/plain').send(staged.line);
  });

app.put(['/device-settings/:type', '/device-settings/:type/:id'],
  (req, res, next) => {
    if (!CONTROL_KEY) return res.status(503).json({ error: 'staging settings is disabled: controlKey is not set in the relay config' });
    const provided = req.headers['x-control-key'];
    if (typeof provided === 'string' && auth.safeEqual(provided, CONTROL_KEY)) return next();
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    const t = deviceSettingsAuthThrottle.check(`put:${ip}`, Date.now());
    if (t.allow) relayLog('WARN', `REJECTED a PUT ${req.path} from ${ip || 'unknown address'}: missing or wrong control key${suppressedNote(t.suppressed)}`);
    return res.status(401).json({ error: 'missing or wrong control key' });
  },
  express.text({ type: '*/*', limit: '4kb' }),
  (req, res) => {
    const { type } = req.params;
    const id = req.params.id === undefined ? null : req.params.id;
    if (!devicesettings.isType(type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
    if (id !== null && !devicesettings.isId(id)) return res.status(400).json({ error: 'not a valid device id' });
    const checked = devicesettings.checkStagedLine(typeof req.body === 'string' ? req.body : '');
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const file = devicesettings.fileFor(DEVICE_SETTINGS_DIR, type, id);
    const scope = id === null ? `every ${type}` : `${type} ${id}`;
    try {
      if (checked.line === '') {
        fs.rmSync(file, { force: true });
        relayLog('INFO', `${actorOf(req)} removed the settings staged for ${scope}`);
        return res.json({ ok: true, removed: true });
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, `${checked.line}\n`);
    } catch (err) {
      relayLog('ERROR', `could not stage settings for ${scope}: ${errorMessage(err)}`);
      return res.status(500).json({ error: 'could not write the staged settings' });
    }
    // Names only: the values can be Wi-Fi passwords and API keys.
    relayLog('INFO', `${actorOf(req)} staged settings for ${scope}: ${devicesettings.keyNames(checked.line).join(', ') || 'none'}`);
    return res.json({ ok: true, scope, settings: devicesettings.keyNames(checked.line) });
  });

// An oversized or unreadable staging body gets a clear answer, not Express's HTML error page.
app.use('/device-settings', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large (limit 4 KB)' });
  return next(err);
});

// ── Firmware for the boards (server-driven OTA update) ──
// The central machine publishes one image per sketch type; boards poll for it, and when
// the version they run differs from the published one they download it, flash it and
// reboot (see lib/firmware.js and ota_logic.h / ota.h in the sketches).
//   PUT /ota/:type?version=V          control key: publish the raw .bin as the current firmware
//   GET /ota/:type/version?id=&fw=    camera key: "<version>\n<md5>\n"; 404 if nothing published
//                                     (&err=<token> reports why the board's last update failed)
//   GET /ota/:type/firmware.bin?id=   camera key: the image, with Content-Length
//   GET /ota/status                   control key: one tab-separated line per device seen
//                                     since the relay started (id type target running state ago error)
// Files live in config.firmwareDir (default firmware/ next to server.js; FIRMWARE_DIR overrides it).
const FIRMWARE_DIR = path.resolve(__dirname, fromEnv('FIRMWARE_DIR', config.firmwareDir || 'firmware'));
const firmwareAuthThrottle = new Throttle(60 * 1000);
const firmwareDevices = new firmware.DeviceTable();

function readPublished(type) {
  try {
    return firmware.parseMeta(fs.readFileSync(firmware.metaFile(FIRMWARE_DIR, type), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function requireCameraKeyForOta(req, res, next) {
  if (auth.safeEqual(auth.extractKey(req), API_KEY)) return next();
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = firmwareAuthThrottle.check(`get:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `rejected a GET ${req.path} from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong key' });
}

function requireControlKeyForOta(req, res, next) {
  if (!CONTROL_KEY) return res.status(503).json({ error: 'firmware publishing is disabled: controlKey is not set in the relay config' });
  const provided = req.headers['x-control-key'];
  if (typeof provided === 'string' && auth.safeEqual(provided, CONTROL_KEY)) return next();
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = firmwareAuthThrottle.check(`ctl:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `REJECTED a ${req.method} ${req.path} from ${ip || 'unknown address'}: missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}

// /ota/status must be declared before the /ota/:type routes below it.
app.get('/ota/status', requireControlKeyForOta, (req, res) => {
  let targets;
  try {
    targets = { recorder: readPublished('recorder'), detector: readPublished('detector') };
  } catch (err) {
    relayLog('ERROR', `could not read the published firmware info: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not read the published firmware info' });
  }
  return res.type('text/plain').send(firmwareDevices.statusText(targets, Date.now()));
});

app.put('/ota/:type',
  requireControlKeyForOta,
  express.raw({ type: '*/*', limit: '3mb' }),
  (req, res) => {
    const { type } = req.params;
    const version = req.query.version;
    if (!firmware.isType(type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
    if (!firmware.isVersion(version)) return res.status(400).json({ error: 'version=... is required: 1-64 characters from A-Z a-z 0-9 . _ -' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const checked = firmware.checkImage(body);
    if (!checked.ok) {
      relayLog('WARN', `${actorOf(req)} tried to publish a ${type} firmware ${version} that was refused: ${checked.error}`);
      return res.status(400).json({ error: checked.error });
    }
    const meta = firmware.makeMeta(version, body, Date.now());
    try {
      fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
      // The image first, then the info file: a board only learns of a version once its image is in place.
      writeFileAtomic(firmware.binFile(FIRMWARE_DIR, type), body);
      writeFileAtomic(firmware.metaFile(FIRMWARE_DIR, type), JSON.stringify(meta));
    } catch (err) {
      relayLog('ERROR', `could not store the ${type} firmware ${version}: ${errorMessage(err)}`);
      return res.status(500).json({ error: 'could not store the firmware' });
    }
    relayLog('INFO', `${actorOf(req)} published ${type} firmware ${meta.version} (${meta.size} bytes, md5 ${meta.md5})`);
    return res.json(Object.assign({ ok: true, type }, meta));
  });

app.get('/ota/:type/version', requireCameraKeyForOta, (req, res) => {
  const { type } = req.params;
  const id = req.query.id;
  if (!firmware.isType(type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
  if (!firmware.isId(id)) return res.status(400).json({ error: 'id=... is required and must be a valid device id' });
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const running = firmware.cleanToken(req.query.fw, 64);
  const err = firmware.cleanToken(req.query.err, 40);
  for (const e of firmwareDevices.report(type, id, running, err, Date.now())) {
    relayLog(e.level, e.message, { sender: id, ip, via: 'relay' });
  }
  let meta;
  try {
    meta = readPublished(type);
  } catch (readErr) {
    relayLog('ERROR', `could not read the published ${type} firmware info: ${errorMessage(readErr)}`);
    return res.status(500).json({ error: 'could not read the published firmware info' });
  }
  if (!meta) return res.status(404).type('text/plain').send('no firmware published');
  return res.type('text/plain').send(firmware.versionReply(meta));
});

app.get('/ota/:type/firmware.bin', requireCameraKeyForOta, (req, res) => {
  const { type } = req.params;
  if (!firmware.isType(type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
  // The id only labels the log line; a missing or bad one is not a reason to refuse the download.
  const id = firmware.isId(req.query.id) ? req.query.id : 'an unidentified device';
  let meta;
  let image;
  try {
    meta = readPublished(type);
    image = meta ? fs.readFileSync(firmware.binFile(FIRMWARE_DIR, type)) : null;
  } catch (err) {
    relayLog('ERROR', `could not read the published ${type} firmware: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not read the published firmware' });
  }
  if (!meta || !image) return res.status(404).type('text/plain').send('no firmware published');
  // The bytes sent must be the ones the version reply promised (an upload can land between the two reads).
  if (image.length !== meta.size || firmware.md5Hex(image) !== meta.md5) {
    return res.status(409).type('text/plain').send('firmware changed while reading, try again');
  }
  relayLog('INFO', `${id} is downloading ${type} firmware ${meta.version} (${meta.size} bytes)`, { sender: firmware.isId(req.query.id) ? id : 'relay', ip: logfile.normalizeIp(req.socket.remoteAddress), via: 'relay' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(image.length));
  return res.end(image);
});

// An oversized upload gets a clear answer, not Express's HTML error page.
app.use('/ota', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large (limit 3 MB)' });
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

// Reads ?seconds=N for the two record routes into req.recordSeconds, or
// answers 400 when it is missing or out of range.
function requireRecordSeconds(req, res, next) {
  const seconds = validation.parseIntInRange(req.query.seconds, 1, MAX_RECORD_SECONDS);
  if (seconds === null) {
    return res.status(400).json({ error: `seconds must be an integer between 1 and ${MAX_RECORD_SECONDS}` });
  }
  req.recordSeconds = seconds;
  return next();
}

// Start/extend a recording on every camera the relay currently knows about
// at once — same start/extend semantics as /record/:id below, just looped
// over every registered camera id. This is what ALARM_RECORD_ALL_CAMERAS in
// the ESP32 sketch calls when one camera's alarm input should kick off
// footage from the whole fleet, not just itself. ("Knows about" means any
// camera that has connected/registered at least once since this process
// started — same set /status reports on.) Registered before /record/:id so
// Express doesn't try to match "all" as a literal camera id.
app.post('/record/all', requireRecordSeconds, (req, res) => {
  const results = Object.keys(cameras).map((id) => startOrExtendRecording(cameras[id], id, req.recordSeconds));
  res.json({ cameras: results });
});

// Start recording this camera's incoming frames to a file for `seconds`
// (plus the pre-roll lead-in — see the Recording notes above). If it's
// already recording, this extends it instead — see extendRecording().
// Same trust boundary as /status and /settings — no key. Called by the PHP layer (the
// dashboard's RECORD button) and now also directly by camera boards
// themselves, over the LAN, when their alarm-trigger GPIO fires — see the
// ESP32 sketch's ALARM_* constants and sendRecordRequest().
app.post('/record/:id', requireRecordSeconds, (req, res) => {
  const result = startOrExtendRecording(getCamera(req.params.id), req.params.id, req.recordSeconds);
  // A person pressing RECORD must be told it did not happen; a camera's alarm (below) just gets the summary.
  if (result.suppressed) return res.status(409).json(Object.assign({ error: 'recording is switched OFF for this camera' }, result));
  res.json(result);
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

// Names of the saved recordings in a camera's folder (none if it has no folder yet).
function recordingFileNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => validation.isSafeFilename(f));
}

// Resolves /recordings/:id/:filename to req.recordingPath, or answers 400 (not a
// name the relay would have generated — which rules out path traversal too)
// or 404 (no such file).
function requireExistingRecording(req, res, next) {
  const { id, filename } = req.params;
  if (!validation.isSafeFilename(filename)) return res.sendStatus(400);
  const filePath = path.join(RECORDINGS_DIR, id, filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  req.recordingPath = filePath;
  return next();
}

// List saved recordings for a camera, newest first.
app.get('/recordings/:id', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.id);
  const files = recordingFileNames(dir)
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
  const deleted = recordingFileNames(dir);
  for (const f of deleted) fs.unlinkSync(path.join(dir, f));
  res.json({ deleted });
});

// Download one recording (recordings.php decides whether the browser sees
// it as an attachment or inline/playable — see that file's play vs
// download handling). Range requests are handled automatically by
// Express's res.download()/sendFile() — that's what lets the dashboard's
// inline <video> player seek/scrub instead of only ever playing from the
// start, as long as recordings.php forwards the Range header through.
app.get('/recordings/:id/:filename', requireExistingRecording, (req, res) => {
  res.download(req.recordingPath);
});

// Delete one recording.
app.delete('/recordings/:id/:filename', requireExistingRecording, (req, res) => {
  fs.unlinkSync(req.recordingPath);
  res.json({ deleted: req.params.filename });
});

// Any error a route doesn't handle itself ends up here: recorded with its stack
// trace (Express's default handler would only print it to the console), and
// answered with a plain 500.
app.use((err, req, res, next) => {
  relayLog('ERROR', `unhandled error in ${req.method} ${req.path}: ${errorMessage(err)}`, { trace: err && err.stack });
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
  camLog('ERROR', camId, `error handling a ${what} from the push connection (camera stays connected): ${errorMessage(err)}${suppressedNote(t.suppressed)}`,
    { trace: errorTrace(err) });
}

// When each push socket last delivered bytes, and the sockets the relay closed
// on purpose (so closing them is not reported as a camera disconnecting).
const lastPushData = new WeakMap();
const retiredSockets = new WeakSet();

// A camera authenticated while an older connection for the same camera id is
// still registered. Either it is still sending — two boards share an id, and
// both stay connected exactly as before — or it has gone quiet: the same board
// reconnecting after its old connection died silently (typical on weak WiFi).
// That leftover would otherwise stay open for ever, so close it.
function handlePreviousConnection(previous, camId, now) {
  const silentMs = now - (lastPushData.get(previous) || now);
  const silentSeconds = (silentMs / 1000).toFixed(1);
  const from = logfile.normalizeIp(previous.remoteAddress);

  if (connection.classifyPreviousConnection(silentMs) === 'conflict') {
    const t = eventThrottle.check(`${camId}:conflict`, now);
    if (t.allow) {
      camLog('WARN', camId, `another connection with the SAME camera id is still sending frames (from ${from}, last data ${silentSeconds}s ago) — is CAMERA_ID unique per board? Two boards sharing an id corrupt each other's stream${suppressedNote(t.suppressed)}`);
    }
    return;
  }

  retiredSockets.add(previous);
  previous.destroy();
  const t = eventThrottle.check(`${camId}:replaced`, now);
  if (t.allow) {
    camLog('INFO', camId, `the camera reconnected — closed its previous connection (from ${from}), which had been silent for ${silentSeconds}s${suppressedNote(t.suppressed)}`);
  }
}

// Registers an authenticated camera's connection and greets it.
function acceptPushCamera(socket, camId, peerIp) {
  const cam = getCamera(camId);
  const previous = cam.socket && cam.socket !== socket && !cam.socket.destroyed ? cam.socket : null;
  cam.socket = socket;
  cam.ip = peerIp;
  const now = Date.now();
  const t = eventThrottle.check(`${camId}:connect`, now);
  if (t.allow) camLog('INFO', camId, `camera connected${suppressedNote(t.suppressed)}`);
  if (previous) handlePreviousConnection(previous, camId, now);
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

// Handles one [length][payload] message from an authenticated camera. A failure
// here is logged and swallowed: it must never take the relay down (see above).
function handlePushPayload(camId, payload) {
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

const pushServer = net.createServer((socket) => {
  socket.setNoDelay(true);
  // Notice a connection that died without a goodbye instead of holding it for ever.
  socket.setKeepAlive(true, PUSH_KEEPALIVE_MS);
  socket.setTimeout(PUSH_AUTH_TIMEOUT_MS);
  lastPushData.set(socket, Date.now());

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
    return false;
  };

  // Reads the one-time auth line from the buffer. True once the camera is
  // authenticated; false while the line is incomplete or the connection was refused.
  const authenticate = () => {
    const nl = protocol.findAuthLineEnd(buf);
    if (nl === -1) {
      if (protocol.isAuthLineTooLong(buf.length)) return reject(null, 'oversized or malformed first line');
      return false; // the line has not fully arrived yet
    }
    const parsed = protocol.parseAuthLine(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (!parsed) return reject(null, 'malformed first line');
    if (!auth.safeEqual(parsed.key, API_KEY)) return reject(parsed.id, 'wrong key');
    camId = parsed.id;
    authed = true;
    connectedAt = Date.now();
    socket.setTimeout(PUSH_IDLE_TIMEOUT_MS);
    acceptPushCamera(socket, camId, peerIp);
    return true;
  };

  // Handles as many complete [length][payload] messages as are buffered.
  const drainMessages = () => {
    let drained;
    try {
      drained = protocol.drainFrames(buf);
    } catch (err) {
      camLog('WARN', camId, `dropped the connection: ${err.message} (a corrupt or out-of-step video stream)`);
      socket.destroy(); // malformed/oversized length prefix
      return;
    }
    buf = drained.rest;
    for (const payload of drained.frames) handlePushPayload(camId, payload);
  };

  socket.on('data', (chunk) => {
    lastPushData.set(socket, Date.now());
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!authed && !authenticate()) return;
    drainMessages();
  });

  // No bytes at all for too long: the other end is gone. (An authenticated
  // camera's close is then reported with this as the reason.)
  socket.on('timeout', () => {
    if (!authed) {
      reject(null, `no first line within ${Math.round(PUSH_AUTH_TIMEOUT_MS / 1000)}s`);
      return;
    }
    lastSocketError = `no data for ${Math.round(PUSH_IDLE_TIMEOUT_MS / 1000)}s`;
    socket.destroy();
  });

  socket.on('close', (hadError) => {
    const wasCurrent = camId && cameras[camId] && cameras[camId].socket === socket;
    if (wasCurrent) cameras[camId].socket = null;
    if (!authed || retiredSockets.has(socket)) return;
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
relayLog('INFO', `relay started (pid ${process.pid}, node ${process.version}; HTTP :${PORT}, push :${PUSH_PORT}; pre-roll ${preRollCfg.seconds}s; log file ${logCfg.file}; recording on/off switch ${CONTROL_KEY ? 'enabled' : 'DISABLED (no controlKey in config.js)'})`);

process.on('uncaughtException', (err) => {
  relayLogSync('ERROR', `FATAL: uncaught exception — the relay is stopping: ${errorMessage(err)}`, { trace: err && err.stack });
  console.error(err);
  process.exit(1);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    relayLogSync('INFO', `relay stopping (${sig})`);
    process.exit(0);
  });
}
