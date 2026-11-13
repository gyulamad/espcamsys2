const express = require('express');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const baseConfig = require('./config'); // gitignored — see example.config.js

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
const detectorstate = require('./lib/detectorstate');
const detectorlink = require('./lib/detectorlink');
const detectorview = require('./lib/detectorview');
const wifiinfo = require('./lib/wifiinfo');
const deviceinfo = require('./lib/deviceinfo');
const muxfeed = require('./lib/muxfeed');
const { createFrameWriter } = require('./lib/framequeue');
const { createLoopWatch } = require('./lib/loopwatch');
const sharedsnapshot = require('./lib/sharedsnapshot');
const discovery = require('./lib/discovery');
const { LogWriter } = require('./lib/logwriter');
const { Throttle } = require('./lib/throttle');
const { Lockout } = require('./lib/lockout');
const connection = require('./lib/connection');
const { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic, isJpeg, jpegDimensions } = require('./lib/util');
const { RecordingSwitch, describeOff, parseMinutes, DEFAULT_OFF_MINUTES } = require('./lib/recswitch');
const sysconfig = require('./lib/sysconfig');
const diskspace = require('./lib/diskspace');
const keypolicy = require('./lib/keypolicy');
const personscan = require('./lib/personscan');
const { createSorter } = require('./lib/sorter');
const { createArchive } = require('./lib/archive');
const { ScanQueue } = require('./lib/scanqueue');
const { runProcess } = require('./lib/runprocess');
const { createNotifier } = require('./lib/notify');
const { postRequest } = require('./lib/notify/httpspost');
const detectionnotice = require('./lib/detectionnotice');
const storagenotice = require('./lib/storagenotice');

// What the dashboard's settings page saved (ports, keys, pre-roll, log, folders) is laid
// over config.js, so config.js itself never has to be rewritten. See lib/sysconfig.js.
const SYSTEM_SETTINGS_FILE = process.env.SYSTEM_SETTINGS_FILE || path.join(__dirname, 'system-settings.json');
const loadedOverrides = (() => {
  try {
    return sysconfig.parseOverrides(fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf8'));
  } catch (e) {
    return { overrides: {}, warnings: e.code === 'ENOENT' ? [] : [`could not read ${SYSTEM_SETTINGS_FILE}: ${e.message} — config.js is used`] };
  }
})();
let systemOverrides = loadedOverrides.overrides;
for (const w of loadedOverrides.warnings) console.warn(`[config] ${w}`);
const config = sysconfig.mergeConfig(baseConfig, systemOverrides);

const app = express();
const PORT = process.env.PORT || config.port;
const PUSH_PORT = process.env.PUSH_PORT || config.pushPort; // raw TCP, continuous frame push
const API_KEY = process.env.CAM_KEY || config.camKey; // must match API_KEY in each camera's sketch

// (review NODE-006) baseline security headers on every response. The relay
// mostly serves non-HTML (JPEG/mux stream/JSON/firmware binaries), so CSP and
// X-Frame-Options are less critical than for a browser app, but MIME-sniffing
// a firmware download as HTML and rendering it is still a real risk on old
// browsers. nosniff must be universal. HSTS is set only when the operator
// explicitly opts in (RELAY_HSTS=1) AND the relay is reachable over TLS — the
// default plain-HTTP deployment must NOT advertise HSTS, otherwise a later
// move to plain HTTP would break every cached client.
const RELAY_HSTS = process.env.RELAY_HSTS === '1';
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  if (RELAY_HSTS) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
// ── Sorting out footage without a person (see lib/personscan.js, INSTALL.md) ──
const scanCfg = personscan.resolveScanConfig(config.personScan, __dirname);
for (const w of scanCfg.warnings) console.warn(`[config] ${w}`);

// ── Notifications (see lib/notify/README.md): one strategy per configured channel behind one interface ──
const { notifier, warnings: notifyWarnings } = createNotifier(config.notifications, process.env, { post: postRequest });
for (const w of notifyWarnings) console.warn(`[config] ${w}`);
const noticeCfg = detectionnotice.resolveNoticeConfig(config.notifications);
for (const w of noticeCfg.warnings) console.warn(`[config] ${w}`);
const storageNoticeCfg = storagenotice.resolveStorageNoticeConfig(config.notifications);
for (const w of storageNoticeCfg.warnings) console.warn(`[config] ${w}`);
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

// Keeps the Wi-Fi network a device (a camera or a detector record) reported. `reading` is already checked
// (wifiinfo.parseReading), or null when the device sent nothing usable: then what was kept stays. Said in the log
// when the device is on another network than before (and the first time), never for a mere change of signal.
function noteWifi(device, reading, now, announce) {
  const before = device.wifi;
  device.wifi = wifiinfo.remember(before, reading, now);
  if (reading && (!before || before.ssid !== reading.ssid)) announce(reading.ssid);
}

// Things that can repeat very fast get a window: at most one line per
// window per camera/address, then a count of how many were skipped.
const eventThrottle = new Throttle(10 * 1000);   // connect / disconnect of a camera
const authFailThrottle = new Throttle(60 * 1000); // rejected connections / requests
const pushErrThrottle = new Throttle(5 * 1000);   // errors while handling a camera's messages
const writeErrThrottle = new Throttle(10 * 1000); // failing to write recording files
const suppressedThrottle = new Throttle(60 * 1000); // "ignored a recording request while OFF": once a minute per camera
const switchAuthThrottle = new Throttle(60 * 1000); // recording on/off requests with a missing or wrong control key
const dashboardAuthThrottle = new Throttle(60 * 1000); // dashboard-only requests (see requireDashboardKey) with a missing or wrong control key
const readAuthThrottle = new Throttle(60 * 1000); // reads (see requireReadKey) with a missing or wrong control key

// ── Making key guessing slow (review R-04) ──
// The throttles above only keep the LOG quiet. These refuse: AUTH_MAX_FAILURES wrong keys (default 10) from one
// address within a minute lock that address out for AUTH_LOCK_SECONDS (60), doubling at every repeat up to
// AUTH_LOCK_MAX_SECONDS (900); while locked out even the right key is refused (HTTP 429 + Retry-After; a push
// connection is dropped). The camera key and the control key count separately, so a camera with a stale key
// cannot lock the dashboard out. A request with NO key at all is not a guess and is not counted. Per address
// (req.socket.remoteAddress — never a header the sender controls). The environment variables exist for the tests.
const authEnvInt = (name, fallback) => { const v = parseInt(process.env[name], 10); return Number.isSafeInteger(v) && v > 0 ? v : fallback; };
const lockoutOptions = () => ({ maxFailures: authEnvInt('AUTH_MAX_FAILURES', 10), baseLockMs: authEnvInt('AUTH_LOCK_SECONDS', 60) * 1000, maxLockMs: authEnvInt('AUTH_LOCK_MAX_SECONDS', 900) * 1000 });
const AUTH_LOCKS = { camera: new Lockout(lockoutOptions()), control: new Lockout(lockoutOptions()) };

// One key check, with the books kept. -> { state: 'ok' | 'bad' | 'locked', retryAfterSec? }
function keyCheck(kind, ip, presented, expected) {
  const lock = AUTH_LOCKS[kind];
  const source = ip || 'unknown';
  const now = Date.now();
  const blocked = lock.check(source, now);
  if (blocked.blocked) return { state: 'locked', retryAfterSec: blocked.retryAfterSec };
  if (typeof presented !== 'string' || presented === '') return { state: 'bad' };
  if (auth.safeEqual(presented, expected)) { lock.success(source, now); return { state: 'ok' }; }
  const f = lock.fail(source, now);
  if (f.locked) relayLog('WARN', `LOCKED OUT ${source} for ${f.lockSec} s after ${f.failures} wrong ${kind} keys${f.level > 1 ? ` (lock number ${f.level} in a row)` : ''}`, { via: 'relay' });
  return { state: 'bad' };
}

// The same for an HTTP request: 'ok' (carry on), 'bad' (the caller refuses in its own way) or 'locked' (answered
// here with 429, the caller just stops).
function checkKey(kind, req, res, presented, expected) {
  const r = keyCheck(kind, logfile.normalizeIp(req.socket.remoteAddress), presented, expected);
  if (r.state === 'locked') {
    res.set('Retry-After', String(r.retryAfterSec));
    res.set('Connection', 'close');
    res.status(429).json({ error: `too many wrong keys from this address: locked out, try again in ${r.retryAfterSec} s` });
  }
  return r.state;
}
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

// Every route with an :id segment gets the id checked first. Express percent-decodes a segment AFTER it has
// matched the route, so %2F..%2F arrives here as a real "../" — this is the single place that refuses it.
app.param('id', (req, res, next, id) => {
  if (!logentry.CAMERA_ID_RE.test(id)) return res.status(400).json({ error: 'invalid camera id' });
  return next();
});


const cameras = Object.create(null); // id -> { frame, emitter, lastSeen, socket, ip, recording, preRoll, lastRecordedUntil }
const MAX_CAMERAS = 64; // a wrong or hostile id must not grow memory without bound (same idea as MAX_DETECTORS)

class CameraIdError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function getCamera(id) {
  if (typeof id !== 'string' || !logentry.CAMERA_ID_RE.test(id)) {
    throw new CameraIdError('invalid camera id', 400);
  }
  if (!cameras[id]) {
    if (Object.keys(cameras).length >= MAX_CAMERAS) {
      throw new CameraIdError(`the relay already knows ${MAX_CAMERAS} cameras and accepts no more`, 503);
    }
    cameras[id] = {
      frame: null,
      emitter: new EventEmitter(),
      lastSeen: null,
      socket: null,             // the camera's live push-connection socket, if connected right now
      ip: null,                 // that camera's address, as of its last push connection
      connectedAt: 0,           // when that push connection was accepted (ms since the epoch; 0 = never)
      device: null,             // { fw, uptimeMs, heap, at }: what the camera's /log batches said about its board (lib/deviceinfo.js)
      recording: null,          // in-progress recording, if any — see startRecording()
      preRoll: new preroll.PreRollBuffer({ seconds: preRollCfg.seconds, maxBytes: preRollCfg.maxBytes }),
      lastRecordedUntil: null,  // timestamp of the last frame the previous recording contained — see startRecording()
      wifi: null,               // { ssid, rssi, at }: the Wi-Fi network the camera last reported (lib/wifiinfo.js)
    };
    cameras[id].emitter.setMaxListeners(50); // one listener per /mux viewer (at most muxfeed.MAX_VIEWERS) and per recording
  }
  return cameras[id];
}

// Every frame from every transport (the raw TCP push connection and the
// legacy HTTP /upload) goes through here, so they can't drift apart:
//   1. file it in the camera's pre-roll buffer (which returns the timestamp
//      it used, so a recording and the buffer always agree on frame times)
//   2. make it the latest frame (/snapshot, a /mux viewer that connects later)
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

// The folder holding one camera's recordings. The id is validated again here and the result is checked to
// sit directly inside RECORDINGS_DIR, so no route can reach outside it even if a caller forgets to validate.
function cameraDir(id) {
  if (typeof id !== 'string' || !logentry.CAMERA_ID_RE.test(id)) throw new CameraIdError('invalid camera id', 400);
  const root = path.resolve(RECORDINGS_DIR);
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) throw new CameraIdError('invalid camera id', 400);
  return dir;
}

function startRecording(cam, id, seconds) {
  if (cam.recording) return null; // caller should call extendRecording() instead

  const triggerTs = Date.now();

  const dir = cameraDir(id);
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
    frameWriter: null,
    onFrame: null,
    timer: null,
  };

  rec.preRollWritten = writePreRollFrames(rec, preFrames);

  // The live frames are written the same way as the pre-roll ones (see lib/framequeue.js): one
  // write in flight at a time, never a synchronous one. fs.writeFileSync here meant one event-
  // loop stall per frame — on a Pi's SD card tens of milliseconds each — and while the relay
  // wrote one camera's frames, every camera's stream, /status answer and detector reading
  // waited. A failed or dropped frame is logged; the clip is truncated where it was, like a
  // disk-full write always was.
  rec.frameWriter = createFrameWriter({
    writeFile: (p, data) => fsp.writeFile(p, data),
    onError: (err) => logRecordingWriteError(id, 'recording frame', err),
    onDrop: (dropped, waiting) => logRecordingWriteError(id, 'recording frame', new Error(`the disk fell ${dropped} frame(s) behind (still ${waiting} waiting) — dropping the oldest ones so the relay keeps up; the clip is truncated where the first one was dropped`)),
  });

  rec.onFrame = (frame, ts = Date.now()) => {
    rec.frameCount += 1;
    if (!rec.firstFrameAt) rec.firstFrameAt = ts;
    rec.lastFrameAt = ts;
    rec.frameWriter.write(path.join(tempDir, frameFileName(rec.frameCount)), frame);
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
// Waits for the (asynchronous) pre-roll files AND the live frames to finish landing on
// disk first, so a recording stopped immediately still encodes its full lead-in and every
// frame it captured (the listener is off by now, so nothing new can arrive behind the
// writer's back).
function finalizeRecording(rec) {
  if (rec.frameCount === 0) {
    // Camera was offline for this whole recording and had nothing buffered — nothing to encode.
    camLog('WARN', rec.id, 'recording had no frames (the camera sent nothing during it, and nothing was buffered) — nothing saved');
    removeTempDir(rec);
    return;
  }
  Promise.all([rec.preRollWritten, rec.frameWriter.idle()]).then(() => encodeRecording(rec));
}

function removeTempDir(rec) {
  fs.rm(rec.tempDir, { recursive: true, force: true }, () => {});
}

// Clips ffmpeg is writing right now (the file has its final name from the start, so it already shows in the
// list): the person check must not read them.
const clipsBeingEncoded = new Set();

// The pixel sizes of a recording's frames, in frame order, read from their
// JPEG headers (the size sits near the start of the file, so only the head of
// each frame is read, not the whole picture). Needed because a camera walks
// its frame-size ladder on a very slow link, so one recording can mix sizes;
// video.scaleArgsForFrameSizes() decides from this list whether the encode
// needs a scale filter. Frames whose header cannot be parsed count as null.
const FRAME_HEADER_BYTES = 4096;

async function readFrameSizes(tempDir) {
  const names = (await fsp.readdir(tempDir)).filter((n) => n.endsWith('.jpg')).sort();
  const sizes = [];
  for (const name of names) {
    const handle = await fsp.open(path.join(tempDir, name), 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(FRAME_HEADER_BYTES), 0, FRAME_HEADER_BYTES, 0);
      sizes.push(jpegDimensions(buffer.subarray(0, bytesRead)));
    } finally {
      await handle.close();
    }
  }
  return sizes;
}

async function encodeRecording(rec) {
  const fps = video.computeFps(rec.frameCount, rec.firstFrameAt, rec.lastFrameAt, DEFAULT_FPS);
  const outputPath = path.join(rec.dir, `${rec.id}_${rec.stamp}.mp4`);
  const framePattern = path.join(rec.tempDir, 'frame_%06d.jpg');

  // Claimed before anything async runs, so no gap opens between "encoding"
  // being logged and the guard set knowing about the clip.
  clipsBeingEncoded.add(outputPath);

  // A camera adapting to a slow link may have changed its frame size mid-clip;
  // scale such a recording back to the size it started with. Failing to read
  // the sizes must never lose footage: encode without the filter, as before.
  let scaleArgs = [];
  try {
    scaleArgs = video.scaleArgsForFrameSizes(await readFrameSizes(rec.tempDir));
  } catch (err) {
    camLog('WARN', rec.id, `could not read the recording's frame sizes (${errorMessage(err)}) — encoding without normalising them`);
  }

  const ffmpeg = spawn('ffmpeg', video.buildFfmpegArgs(fps, framePattern, outputPath, scaleArgs));

  ffmpeg.on('error', (err) => {
    clipsBeingEncoded.delete(outputPath);
    // Most likely ffmpeg isn't installed — see INSTALL.md. Leave the raw
    // frames in place rather than deleting footage we can't otherwise recover.
    camLog('ERROR', rec.id, `ffmpeg failed to start (is it installed?): ${err.message} — raw frames kept at ${rec.tempDir}`);
  });

  ffmpeg.on('exit', (code) => {
    clipsBeingEncoded.delete(outputPath);
    if (code !== 0) {
      camLog('ERROR', rec.id, `ffmpeg exited with code ${code} — raw frames kept at ${rec.tempDir}`);
      return;
    }
    camLog('INFO', rec.id, `recording saved as ${path.basename(outputPath)}`);
    removeTempDir(rec);
    if (scanCfg.enabled && scanCfg.auto) queueScan(rec.id, path.basename(outputPath), { notify: true });   // a fresh clip: a person in it is announced
  });
}

// Camera pushes a frame here
// The camera key is checked BEFORE the body is read, like every other keyed route (/log, /ota, /device-settings):
// an unauthenticated client must not make the relay buffer and parse a request (review R-05/R-06), and a wrong
// key must be a 403 in the log's WARN line, not a 500 with a stack trace. Constant-time compare; the key may come
// as ?key= (what the legacy sketches send) or as X-Api-Key. 'Connection: close' so the unread body is dropped.
function requireCameraKeyForUpload(req, res, next) {
  const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = authFailThrottle.check(`upload:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `rejected a POST /upload from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
  res.set('Connection', 'close');
  return res.sendStatus(403);
}

// Raw binary body (JPEG bytes, not JSON/form), read only after the key is accepted.
app.post('/upload/:id', requireCameraKeyForUpload, express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  // No body (or no usable one) is not a picture: refuse it rather than store `undefined` as the camera's frame.
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'the request body must be the JPEG frame' });
  // (review NODE-011) the magic bytes (FF D8 FF) are the cheapest possible MIME
  // check: anything that is not a JPEG (HTML, SVG, an MP4 chunk, a misrouted
  // JSON body) is refused before it reaches the pre-roll buffer or any viewer.
  if (!isJpeg(req.body)) return res.status(400).json({ error: 'the request body must be a JPEG (start with FF D8 FF)' });
  ingestFrame(getCamera(req.params.id), req.body); // pre-roll buffer, latest frame, live viewers and any active recording
  res.sendStatus(200);
});

// EVERYTHING live on ONE connection (see lib/muxcodec.js for the format): a browser allows only about 6
// connections per address over HTTP/1.1, so a connection per camera, per detector or per kind of data left no room
// for the dashboard's other requests. ?cams=cam1,cam2 names the cameras whose pictures are wanted (the dashboard leaves
// out the ones its user hid), ?dets=det1,det2 the detectors whose pictures are wanted, ?status=1 the readings of every
// detector (what GET /detectors answers), ?rec=1 the recording state of every camera (what GET /status answers). Every
// one of them is optional but at least one must be there (400 otherwise): a page whose cameras are all hidden still
// wants its readings and recording state. A viewer that cannot keep up gets the newest picture of each camera and
// detector and the newest readings instead of a backlog.
// Reading needs the read key — only the PHP layer should reach this port.
let muxViewers = 0;
app.get('/mux', requireReadKey, (req, res) => {
  const request = muxfeed.parseRequest(req.query, { idPattern: logentry.CAMERA_ID_RE, maxCameras: MAX_CAMERAS, maxDetectors: MAX_DETECTORS });
  if (request.error) return res.status(400).set('Cache-Control', 'no-store').json({ error: request.error });
  if (muxViewers >= muxfeed.MAX_VIEWERS) {
    return res.status(503).set('Cache-Control', 'no-store').json({ error: `already ${muxfeed.MAX_VIEWERS} viewers of the live pictures` });
  }
  const cameraList = request.cams.map((id) => ({ id, cam: getCamera(id) }));
  request.dets.forEach(warnIfNoDetectorPicture);
  muxViewers += 1;
  res.writeHead(200, muxfeed.HEADERS);
  res.flushHeaders();
  req.socket.setNoDelay(true);
  const session = muxfeed.openSession({
    write: (bytes) => res.write(bytes),
    cameras: cameraList,
    detectors: request.dets.length ? { ids: request.dets, lookup: knownDetector, bus: detectorBus } : null,
    status: request.status ? { snapshot: detectorViews, bus: detectorBus } : null,
    cameraStatus: request.rec ? cameraStatusFeed : null,
  });
  res.on('drain', session.drain);
  req.on('close', () => {
    muxViewers -= 1;
    session.close();
  });
  return undefined;
});

// ── Person detectors (ESP32_CAM_TFLite_Person) ──
// A detector shows the dashboard what it sees (its 96x96 grayscale frame) and the numbers behind its
// alarm line (brightness, motion, person score, thresholds, GPIO level), so the camera can be aimed and
// the thresholds chosen with visual confirmation. Detectors are often behind a NAT router, so the relay
// never connects to one: the detector connects OUT and keeps ONE connection open, pushing its frames up
// it. The connection is an HTTP Upgrade on this very port (see lib/detectorlink.js for the protocol), so
// the board needs no extra setting, and every refusal is an ordinary HTTP answer it can log.
// Detectors live in their own map: they are not cameras, so they are never recorded, never in /status
// and not hit by "alarm all".
//
//   (Upgrade) GET /detector/:id/uplink   camera key (X-Api-Key): the detector's connection (see below)
//   GET /detectors                        every detector the relay has heard from: { id: view }
//   GET  /detector/:id/view               camera key: the board asks whether to stream (see below)
//   POST /detector/:id/view?action=       control key: the dashboard asks for the live view (on / keep / off)
// The readings and the picture of a detector are read through GET /mux (?status=1, ?dets=), like everything live.
// Reading needs the read key — only the PHP layer should reach this port.
//
// Everything that happens to a detector is logged (connected, refused, disconnected and why, the first
// picture, a picture that never comes, the dashboard asking for one that does not exist): a detector
// that "does not show up" must be explainable from the relay's log alone.
const MAX_DETECTORS = 64;                     // a wrong or hostile id must not grow memory without bound
const NO_PICTURE_WARN_MS = connection.parseTimeoutMs(fromEnv('DETECTOR_NO_PICTURE_WARN_MS'), 10 * 1000); // connected and reporting numbers, but no picture for this long: say so
const MAX_BAD_MESSAGES_IN_A_ROW = 25;         // then the connection is not a detector's: drop it
const detectors = {}; // id -> record, see getDetector()
const DETECTOR_VIEW_MINUTES = detectorview.viewMinutes(fromEnv('DETECTOR_VIEW_MINUTES', config.detectorViewMinutes)); // how long a detector streams after somebody asked (10 by default)
const detectorBus = new EventEmitter();        // 'change' whenever any detector's readings or connection change: feeds /mux
detectorBus.setMaxListeners(2 * muxfeed.MAX_VIEWERS + 4);   // a /mux viewer listens up to twice: its detector pictures and its readings
const detectorViewThrottle = new Throttle(5 * 60 * 1000); // the dashboard asking for a picture that is not there: once per 5 min per detector and state

function getDetector(id) {
  if (!detectors[id]) {
    detectors[id] = {
      report: null, receivedAt: 0,           // the latest readings and when they arrived
      frame: null, frameAt: 0,               // the latest picture (a JPEG) and when it arrived
      emitter: new EventEmitter(),           // 'frame' for every picture, to the /mux viewers
      socket: null, connected: false, ip: null, connectedAt: 0,
      lastDisconnectAt: 0, lastDisconnectWhy: '',
      connections: 0, pictures: 0, pictureLogged: false, noPictureWarned: false, badInARow: 0,
      ...detectorview.newRecord(),           // the live view switch: who wants to look, when the board last asked
      lastAnswer: '',                        // what the board was last told (logged when it changes)
    };
    detectors[id].emitter.setMaxListeners(50);
  }
  return detectors[id];
}

// An event about a detector, as seen by the relay (carries the detector's address).
function detLog(level, id, message, opts = {}) {
  const det = detectors[id];
  relayLog(level, message, Object.assign({ sender: id, ip: det && det.ip, via: 'relay' }, opts));
}

// What noteWifi() says when a detector turns up on a Wi-Fi network (see there).
function announceDetectorWifi(id) {
  return (ssid) => detLog('INFO', id, `the detector is on the Wi-Fi network '${ssid}'`);
}

// Why a connection ended, in words (the OS only gives a code).
function describeSocketEnd(code) {
  if (!code) return 'the board closed the connection';
  if (code === 'ECONNRESET') return 'the connection was reset: the board lost power or Wi-Fi, or restarted';
  if (code === 'ETIMEDOUT') return 'the connection timed out';
  return code;
}

// A detector authenticated while an older connection for the same id is still registered: it is either
// still sending (two boards share an id — both stay, and the log says so) or gone quiet (the same board
// reconnecting after its old connection died silently, typical on weak Wi-Fi — close the leftover).
// (lastPushData / retiredSockets are the camera push connection's, defined with it below.)
function handlePreviousDetectorConnection(previous, id, now) {
  const silentMs = now - (lastPushData.get(previous) || now);
  const silentSeconds = (silentMs / 1000).toFixed(1);
  if (connection.classifyPreviousConnection(silentMs) === 'conflict') {
    const t = eventThrottle.check(`${id}:detector-conflict`, now);
    if (t.allow) detLog('WARN', id, `another connection with the SAME detector id is still sending (from ${logfile.normalizeIp(previous.remoteAddress)}, last data ${silentSeconds}s ago) — is DETECTOR_ID unique per board? Two boards sharing an id corrupt each other's picture${suppressedNote(t.suppressed)}`);
    return;
  }
  retiredSockets.add(previous);
  previous.destroy();
  const t = eventThrottle.check(`${id}:detector-replaced`, now);
  if (t.allow) detLog('INFO', id, `the detector reconnected — closed its previous connection, which had been silent for ${silentSeconds}s${suppressedNote(t.suppressed)}`);
}

function noteBadDetectorMessage(id, det, socket, why) {
  det.badInARow += 1;
  const t = pushErrThrottle.check(`${id}:detector-bad`, Date.now());
  if (t.allow) detLog('WARN', id, `ignored an unusable message from the detector: ${why}${suppressedNote(t.suppressed)}`);
  if (det.badInARow >= MAX_BAD_MESSAGES_IN_A_ROW) {
    detLog('WARN', id, `${det.badInARow} unusable messages in a row — dropping the connection`);
    socket.destroy();
  }
}

// One [length][message] from a detector's connection. A failure here is logged and swallowed: like the
// cameras' push messages it runs inside a raw socket's 'data' event, where an uncaught exception would
// end the whole relay.
function handleDetectorPayload(id, det, socket, payload) {
  try {
    const m = detectorlink.decodeMessage(payload);
    if (!m.ok) return noteBadDetectorMessage(id, det, socket, m.error);
    if (m.kind === 'unknown') return undefined; // a message type newer than this relay: ignore it
    const parsed = detectorstate.parseStatus(m.status);
    if (!parsed.ok) return noteBadDetectorMessage(id, det, socket, parsed.error);
    det.badInARow = 0;
    const now = Date.now();
    det.report = parsed.report;
    det.receivedAt = now;
    noteWifi(det, wifiinfo.parseReading(parsed.report.ssid, parsed.report.rssi), now, announceDetectorWifi(id));
    detectorBus.emit('change');
    if (m.jpeg) {
      det.frame = m.jpeg;
      det.frameAt = now;
      det.pictures += 1;
      if (!det.pictureLogged) {
        det.pictureLogged = true;
        detLog('INFO', id, `detector is sending pictures (the first: ${m.jpeg.length} bytes of JPEG)`);
      }
      det.emitter.emit('frame', m.jpeg);
    } else if (!det.pictureLogged && !det.noPictureWarned && now - det.connectedAt >= NO_PICTURE_WARN_MS) {
      det.noPictureWarned = true;
      const fails = parsed.report.link.jpegFails;
      detLog('WARN', id, `the detector has been connected for ${Math.round((now - det.connectedAt) / 1000)}s and reports its numbers, but has sent no picture${fails ? ` (it reports ${fails} failed JPEG encodings — out of memory on the board?)` : ' — see the detector\'s own log lines for why'}`);
    }
  } catch (err) {
    const t = pushErrThrottle.check(`${id}:detector-error`, Date.now());
    if (t.allow) detLog('ERROR', id, `error handling a message from the detector (it stays connected): ${errorMessage(err)}${suppressedNote(t.suppressed)}`, { trace: errorTrace(err) });
  }
  return undefined;
}

// An HTTP Upgrade request arrived (the only kind the relay accepts): a detector opening its uplink.
function handleDetectorUpgrade(req, socket, head) {
  // The HTTP server stops listening for errors on a socket once it has handed it over; without our own
  // listener a reset connection would be an uncaught exception, which ends the relay.
  let lastSocketError = null;
  socket.on('error', (err) => { lastSocketError = err && err.code ? err.code : String(err); });

  const peerIp = logfile.normalizeIp(socket.remoteAddress);
  const asked = detectorlink.matchPath(req.url);
  const sender = asked || 'unknown';

  const refuse = (status, message) => {
    socket.end(detectorlink.refusalResponse(status, message));
    setTimeout(() => socket.destroy(), 2000).unref(); // a client that never reads must not keep the socket
  };

  const locked = AUTH_LOCKS.camera.check(peerIp || 'unknown', Date.now());
  if (locked.blocked) {
    const t = authFailThrottle.check(`detector:${peerIp}:429`, Date.now());
    if (t.allow) relayLog('WARN', `refused a detector uplink request from ${peerIp || 'unknown address'}: locked out after too many wrong keys, ${locked.retryAfterSec} s left${suppressedNote(t.suppressed)}`, { sender, via: 'relay' });
    return refuse(429, `too many wrong keys from this address: locked out, try again in ${locked.retryAfterSec} s`);
  }
  const checked = detectorlink.checkUpgrade(req, (presented) => keyCheck('camera', peerIp, presented, API_KEY).state === 'ok');
  if (!checked.ok) {
    const t = authFailThrottle.check(`detector:${peerIp}:${checked.status}`, Date.now());
    if (t.allow) relayLog('WARN', `refused a detector uplink request from ${peerIp || 'unknown address'} for ${JSON.stringify(String(req.url).slice(0, 100))}: HTTP ${checked.status} — ${checked.error}${suppressedNote(t.suppressed)}`, { sender, via: 'relay' });
    return refuse(checked.status, checked.error);
  }

  const id = checked.id;
  if (!detectors[id] && Object.keys(detectors).length >= MAX_DETECTORS) {
    relayLog('WARN', `refused a detector uplink from ${peerIp || 'unknown address'}: already ${MAX_DETECTORS} detectors known, so ${id} is not accepted`, { sender: id, via: 'relay' });
    return refuse(503, `the relay already knows ${MAX_DETECTORS} detectors and accepts no more`);
  }

  const det = getDetector(id);
  const previous = det.socket && det.socket !== socket && !det.socket.destroyed ? det.socket : null;
  const connectedAt = Date.now();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, PUSH_KEEPALIVE_MS);
  socket.setTimeout(PUSH_IDLE_TIMEOUT_MS);
  lastPushData.set(socket, connectedAt);
  det.socket = socket;
  det.connected = true;
  det.ip = peerIp;
  det.connectedAt = connectedAt;
  det.connections += 1;
  det.pictureLogged = false;
  det.noPictureWarned = false;
  det.badInARow = 0;
  const picturesBefore = det.pictures;
  socket.write(detectorlink.acceptResponse());

  const tc = eventThrottle.check(`${id}:detector-connect`, connectedAt);
  if (tc.allow) detLog('INFO', id, `detector connected${det.connections > 1 ? ` (connection number ${det.connections} since the relay started)` : ''}${suppressedNote(tc.suppressed)}`);
  if (previous) handlePreviousDetectorConnection(previous, id, connectedAt);

  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const drain = () => {
    let drained;
    try {
      drained = protocol.drainFrames(buf, detectorlink.MAX_MESSAGE_BYTES);
    } catch (err) {
      lastSocketError = `the stream is corrupt: ${err.message}`;
      detLog('WARN', id, `dropped the connection: ${err.message} (a corrupt or out-of-step stream — is this really a detector?)`);
      socket.destroy();
      return;
    }
    buf = drained.rest;
    for (const payload of drained.frames) handleDetectorPayload(id, det, socket, payload);
  };
  drain(); // whatever came with the request itself

  socket.on('data', (chunk) => {
    lastPushData.set(socket, Date.now());
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    drain();
  });

  // The board closed its end (it restarted, say). The HTTP server creates its sockets with allowHalfOpen, so
  // unlike the raw push port's sockets this one would otherwise stay half-open — looking connected — until the
  // idle timeout, and then be blamed on silence.
  socket.on('end', () => socket.end());

  // No bytes at all for too long: the other end is gone (a detector sends something at least every second).
  socket.on('timeout', () => {
    lastSocketError = `no data for ${Math.round(PUSH_IDLE_TIMEOUT_MS / 1000)}s`;
    socket.destroy();
  });

  socket.on('close', (hadError) => {
    const wasCurrent = det.socket === socket;
    const why = lastSocketError && lastSocketError.includes(' ') ? lastSocketError : describeSocketEnd(lastSocketError);
    if (wasCurrent) {
      det.socket = null;
      det.connected = false;
      det.lastDisconnectAt = Date.now();
      det.lastDisconnectWhy = why;
      detectorBus.emit('change');
    }
    if (retiredSockets.has(socket)) return;
    const t = eventThrottle.check(`${id}:detector-disconnect`, Date.now());
    if (!t.allow) return;
    const secs = Math.round((Date.now() - connectedAt) / 1000);
    detLog(hadError || lastSocketError ? 'WARN' : 'INFO', id, `detector disconnected after ${secs}s, ${det.pictures - picturesBefore === 1 ? '1 picture' : `${det.pictures - picturesBefore} pictures`} received (${why})${wasCurrent ? '' : ' [a newer connection had already replaced it]'}${suppressedNote(t.suppressed)}`);
  });
  return undefined;
}

// The uplink address reached WITHOUT the Upgrade headers (Node hands real upgrade requests to
// handleDetectorUpgrade() instead, so this only ever sees plain ones): a browser, curl, or a board whose
// HTTP code dropped the headers. Say what is needed rather than a bare 404.
app.get('/detector/:id/uplink', (req, res) => {
  res.status(426).set({ Upgrade: detectorlink.PROTOCOL, 'Cache-Control': 'no-store' }).json({
    error: `this address only speaks the detector uplink: send "Connection: Upgrade" and "Upgrade: ${detectorlink.PROTOCOL}" together with the camera key in X-Api-Key`,
  });
});

// Every detector the relay has heard from: { id: view } — see detectorstate.buildView().
// The detector with this id, if the relay has heard from it (a read never creates one: that would let a viewer
// fill the MAX_DETECTORS places that real detectors need).
function knownDetector(id) {
  return Object.prototype.hasOwnProperty.call(detectors, id) ? detectors[id] : undefined;
}

// A viewer asks for the picture of a detector that has none to show (it never connected, is silent or resting, or
// sends numbers without pictures): said in the log, at most once per 5 minutes per detector and state, because the
// /mux connection itself stays open and says nothing. A read never creates a detector record (see knownDetector).
function warnIfNoDetectorPicture(id) {
  const now = Date.now();
  const view = detectorstate.buildView(knownDetector(id), now);
  if (view.state === 'online') return;
  const t = detectorViewThrottle.check(`${id}:${view.state}`, now);
  if (!t.allow) return;
  detLog('WARN', id, `${detectorstate.missingPictureNotice(id, view, Object.keys(detectors))}${suppressedNote(t.suppressed)}`);
}

function detectorViews() {
  const now = Date.now();
  const out = {};
  for (const id of Object.keys(detectors).sort()) out[id] = detectorstate.buildView(detectors[id], now);
  return out;
}
app.get('/detectors', requireReadKey, (req, res) => res.json(detectorViews()));

// Single still image, handy for thumbnails/testing
app.get('/snapshot/:id', requireReadKey, (req, res) => {
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
    return validation.countRecordingFiles(await fsp.readdir(cameraDir(id)));
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
// Every camera's recording state, FILES count and switch, as { camId: view } — what GET /status answers and what
// the mux stream pushes (see cameraStatusFeed).
async function buildStatusMap() {
  const ids = [...new Set([...Object.keys(cameras), ...(await recordingFolderIds())])].sort();
  refreshSwitch();
  const now = Date.now();
  const views = await Promise.all(ids.map(async (id) =>
    statusView.buildCameraStatusView(cameras[id] || NEVER_SEEN, await countRecordings(id), describeOff(recSwitch.offState(id, now), now), now)));
  const out = {};
  ids.forEach((id, i) => { out[id] = views[i]; });
  return out;
}

app.get('/status', requireReadKey, async (req, res) => {
  try {
    res.json(await buildStatusMap());
  } catch (err) {
    relayLog('ERROR', `GET /status failed: ${err.message}`, { trace: err && err.stack });
    res.sendStatus(500);
  }
});

// The same map for the viewers of GET /mux?rec=1: worked out once every CAMERA_STATUS_PUSH_MS for all of them, and
// only while there is one (see lib/sharedsnapshot.js). The dashboard stops asking GET /status every few seconds
// while these arrive; it still asks once after each of its own commands, and when they stop.
const CAMERA_STATUS_PUSH_MS = 2000;
const cameraStatusFeed = sharedsnapshot.createSharedSnapshot({
  compute: async () => JSON.stringify(await buildStatusMap()),
  intervalMs: CAMERA_STATUS_PUSH_MS,
  onError: (err) => relayLog('ERROR', `the live camera status failed: ${err.message}`, { trace: err && err.stack }),
});

// ── Recording storage ──
// GET /storage -> { known, freeMB?, minFreeMB, low }   how much room the recordings' disk has left, and whether
// that is below the minimum set on the dashboard's settings page (minFreeStorageMB; 0 = no warning). The dashboard
// shows an alert on every page load while `low` is true, so old recordings are deleted before the disk is full.
// The minimum is read on every request, so a change saved on the settings page applies at once.
// A disk the system will not report on answers known: false, low: false — never an error, never a false alarm.
const DISK_QUERY_TIMEOUT_MS = 5000;
const diskDeps = {
  statfs: typeof fsp.statfs === 'function' ? (dir) => fsp.statfs(dir) : undefined,
  execFile: (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: DISK_QUERY_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }),
};

async function readStorageView() {
  const minFreeMB = sysconfig.currentValue('minFreeStorageMB', systemSettingsState());
  const freeBytes = await diskspace.readFreeBytes(RECORDINGS_DIR, diskDeps);
  return diskspace.buildStorageView(freeBytes, minFreeMB);
}

app.get('/storage', requireReadKey, async (req, res) => res.json(await readStorageView()));

// The same check, for a user who does not open the dashboard: while the disk is below the minimum, the notification
// channels get a message when it becomes low and a reminder every notifications.storageReminderHours (default 24;
// 0 = no reminders) — see lib/storagenotice.js. The first look is one interval after the start, so a relay that is
// restarted in quick succession does not repeat itself. unref(): this timer never keeps the process alive.
const STORAGE_CHECK_MS = 60 * 1000;
const storageNotifier = storagenotice.createStorageNotifier({
  notifier,
  readView: readStorageView,
  config: storageNoticeCfg,
  baseUrl: noticeCfg.footageBaseUrl,
  now: Date.now,
  log: relayLog,
});
setInterval(() => storageNotifier.check(), STORAGE_CHECK_MS).unref();

// ── Settings ──
// GET  /settings                         -> { alarmRecordSeconds, preRollSeconds }
// POST /settings?alarmRecordSeconds=N    -> save it, returns the new settings
// preRollSeconds is read-only here: it comes from config.js.
// Reading and changing both need the control key (requireReadKey / requireDashboardKey — the dashboard now saves
// through POST /system-settings, so nothing legitimate posts here keyless). Changes take effect on the next alarm; an alarm
// recording that's already running keeps the length it was started with.
app.get('/settings', requireReadKey, (req, res) => {
  res.json(settingsView());
});

app.post('/settings', requireDashboardKey, (req, res) => {
  const result = settingsLogic.applySettingsUpdate(settings, req.query);
  if (result.error) return res.status(400).json({ error: result.error });
  try {
    saveSettings(result.settings);
  } catch (err) {
    relayLog('ERROR', `failed saving settings: ${err.message}`);
    return res.status(500).json({ error: 'could not save settings' });
  }
  settings = result.settings;
  relayLog('INFO', `settings changed by ${actorOf(req)} (POST /settings)`);
  res.json(settingsView());
});

// ── System settings (what config.js used to hold) — edited from the dashboard's settings page ──
//   GET  /system-settings   -> { fields: [...], supervised }   every setting with its current value
//                              (secrets are never sent back, only whether they are set)
//   POST /system-settings   body { "key": value, ... } -> { ok, changed, restartRequired }
//                              all-or-nothing; alarmRecordSeconds applies at once, the rest after a restart
//   POST /restart           -> 202, then the relay exits and its supervisor (systemd / pm2) starts it again
// All three need the CONTROL key (X-Control-Key). They are declared before the recording
// switch's requireControlKey helper is used below, which hoisting makes fine (function declaration).
function systemSettingsState() {
  return { base: baseConfig, overrides: systemOverrides, alarmRecordSeconds: settings.alarmRecordSeconds, env: process.env };
}

// (review NODE-004) the last time POST /restart was accepted, used to enforce a
// minimum gap (default 30s) between two accepted restart requests. A captured
// control key, or a runaway dashboard tab, could otherwise loop the endpoint
// and turn the relay's supervisor into a DoS amplifier.
let lastRestartRequestAt = 0;

app.get('/system-settings', requireControlKey, (req, res) => {
  res.json({ ...sysconfig.buildView(systemSettingsState()), supervised: sysconfig.isSupervised(process.env) });
});

app.post('/system-settings', requireControlKey, express.json({ limit: '16kb' }), (req, res) => {
  const r = sysconfig.applyUpdate(systemSettingsState(), req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.changed.length === 0) return res.json({ ok: true, changed: [], restartRequired: false });
  try {
    if (r.alarmRecordSeconds !== settings.alarmRecordSeconds) saveSettings({ ...settings, alarmRecordSeconds: r.alarmRecordSeconds });
    if (r.changed.some((k) => k !== 'alarmRecordSeconds')) writeFileAtomic(SYSTEM_SETTINGS_FILE, JSON.stringify(r.overrides, null, 2));
  } catch (err) {
    relayLog('ERROR', `failed saving system settings: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not save the settings' });
  }
  settings = { ...settings, alarmRecordSeconds: r.alarmRecordSeconds };
  systemOverrides = r.overrides;
  // The person check reads its switch and its sensitivity for every clip it judges, so a saved one counts from the
  // next clip on (a check already running keeps the value it started with; clips still waiting are left alone when
  // it is switched off). Nothing to restart.
  scanCfg.confidence = sysconfig.currentValue('personScanConfidence', systemSettingsState());
  scanCfg.enabled = sysconfig.currentValue('personScanEnabled', systemSettingsState());
  // Names only — values can be keys.
  relayLog('INFO', `system settings changed by ${actorOf(req)}: ${r.changed.join(', ')}${r.restartRequired ? ' (restart needed to apply)' : ''}`);
  return res.json({ ok: true, changed: r.changed, restartRequired: r.restartRequired });
});

app.post('/restart', requireControlKey, (req, res) => {
  if (!sysconfig.isSupervised(process.env)) {
    return res.status(409).json({ error: 'the relay was not started by systemd or pm2, so it would not come back on its own — restart it by hand (or set RELAY_SUPERVISED=1 if something else restarts it)' });
  }
  // (review NODE-004) refuse a restart that follows another too closely: a
  // captured control key, or a runaway dashboard tab, could otherwise loop
  // POST /restart and the supervisor would bring the relay back just in time
  // for the next call to drop it again — a quiet DoS that looks like flapping.
  // RESTART_COOLDOWN_MS (default 30s) is the floor between two accepted calls;
  // a request inside the window is answered 429 with Retry-After.
  const cooldownMs = parseInt(process.env.RESTART_COOLDOWN_MS, 10) || 30 * 1000;
  const now = Date.now();
  const sinceLast = now - lastRestartRequestAt;
  if (sinceLast < cooldownMs) {
    const retryAfter = Math.ceil((cooldownMs - sinceLast) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.set('Connection', 'close');
    const ip = logfile.normalizeIp(req.socket.remoteAddress);
    relayLog('WARN', `POST /restart from ${ip || 'unknown address'} refused: ${retryAfter}s of the ${Math.round(cooldownMs / 1000)}s cooldown remains`);
    return res.status(429).json({ error: `restart requested too soon: try again in ${retryAfter}s` });
  }
  lastRestartRequestAt = now;
  relayLog('INFO', `restart requested by ${actorOf(req)}`);
  res.status(202).json({ ok: true });
  res.on('finish', () => {
    setTimeout(() => {
      relayLogSync('INFO', 'relay restarting (requested from the dashboard)');
      process.exit(sysconfig.RESTART_EXIT_CODE);
    }, 200);
  });
});

// ── Recording switch: changing it (authenticated) and reading it ──
//   POST /recording/camera/:id/off?minutes=N   switch ONE camera OFF for N minutes (default 60; 0 or negative = until ON)
//   POST /recording/camera/:id/on
//   POST /recording/all/off?minutes=N          the same for every camera the relay knows right now
//   POST /recording/all/on
//   GET  /recording/state                      who is OFF (needs the control key once one is set)
// The four POSTs need `X-Control-Key: <controlKey>`; see the notes at the switch above.
// Guards what only the dashboard does — changing settings, starting/stopping/extending a recording by hand, deleting
// or marking recordings (review R-03). The dashboard's PHP already sends X-Control-Key on exactly these calls; the
// camera boards use none of them (their alarm goes in-band on the authenticated push connection, with POST /alarm
// as an unauthenticated fallback that stays open because the firmware cannot send a key there). Fails CLOSED:
// without a controlKey in the relay config these routes answer 503, the same as the recording switch does.
function requireDashboardKey(req, res, next) {
  if (!CONTROL_KEY) {
    return res.status(503).json({ error: 'this action is disabled: controlKey is not set in the relay config' });
  }
  const provided = req.headers['x-control-key'];
  const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = dashboardAuthThrottle.check(ip || 'unknown', Date.now());
  if (t.allow) relayLog('WARN', `REJECTED ${req.method} ${req.path} from ${ip || 'unknown address'}: missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}

// Guards what the cameras SEE: live video, snapshots, recordings, and the lists of who is connected and what
// state it is in. Only the dashboard's PHP asks for these (it sends X-Control-Key on every one; the browser never
// talks to the relay), and the camera boards use none of them. Anyone who could reach this port used to be able to
// watch and download everything.
//
// (review NODE-H2): requireReadKey used to fail OPEN when no controlKey was set, on the theory that a fresh
// install should keep working until the operator configures one. That meant an unconfigured relay exposed every
// camera's live stream and every recording to anyone on the LAN. It now fails CLOSED (503): the dashboard
// shows "set controlKey" instead of live video, which is the safer default. The relay already logs a warning
// at startup when controlKey is empty. Operators who genuinely want keyless reads (e.g. a trusted LAN with no
// Tor exposure) can opt in with READ_KEY_REQUIRED=0 in the relay's environment.
const READ_KEY_REQUIRED = process.env.READ_KEY_REQUIRED !== '0';
function requireReadKey(req, res, next) {
  if (!CONTROL_KEY) {
    if (READ_KEY_REQUIRED) {
      return res.status(503).json({ error: 'this relay is not configured: set controlKey in config.js (and relay_control_key in the dashboard\'s config.php) — reads are refused until then' });
    }
    return next();
  }
  const provided = req.headers['x-control-key'];
  const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = readAuthThrottle.check(ip || 'unknown', Date.now());
  if (t.allow) relayLog('WARN', `REJECTED ${req.method} ${req.path} from ${ip || 'unknown address'}: missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}

function requireControlKey(req, res, next) {
  if (!CONTROL_KEY) {
    return res.status(503).json({ error: 'switching is disabled: controlKey is not set in the relay config' });
  }
  const provided = req.headers['x-control-key'];
  const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = switchAuthThrottle.check(ip || 'unknown', Date.now());
  if (t.allow) relayLog('WARN', `REJECTED a recording on/off request from ${ip || 'unknown address'} (${req.method} ${req.path}): missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}

// Who is doing this, for the log: the dashboard passes the logged-in user's
// name in X-Actor (the relay only sees the web server's own address).
// X-Actor is honoured ONLY when the request comes from loopback
// (review NODE-M1): a non-loopback caller (someone reaching the relay
// directly on the LAN, or a future attacker who has the control key) cannot
// forge the audit log by setting X-Actor to "innocent-bystander". Their
// address is used as the actor instead.
function isLoopback(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}
function actorOf(req) {
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const raw = req.headers['x-actor'];
  if (isLoopback(req.socket.remoteAddress) && typeof raw === 'string' && raw.trim() !== '') {
    return `${logfile.safeToken(raw.trim())} (via ${ip || 'unknown address'})`;
  }
  return ip || 'unknown address';
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

app.get('/recording/state', requireReadKey, (req, res) => {
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

// Keeps what a camera's log batch says about its board (firmware, uptime, free memory) for the dashboard's camera card.
// Only for a camera the relay already knows: a log request must not be able to add cameras to the dashboard.
function noteCameraDevice(batch, now) {
  const cam = cameras[batch.camera];
  if (!cam) return;
  cam.device = deviceinfo.remember(cam.device, deviceinfo.fromLogBatch(batch), now);
}

// Echo to the console too (journalctl / pm2 logs), one short line each.
function echoCameraLogBatch(batch) {
  for (const e of batch.entries) {
    console[consoleMethodFor(e.level)](`[${batch.camera}] ${e.level} ${e.message.split('\n')[0]}`);
  }
}

app.post('/log',
  (req, res, next) => {
    const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
    if (keyState === 'ok') return next();
    if (keyState === 'locked') return undefined;
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
    noteCameraDevice(batch, Date.now());
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
    const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
    if (keyState === 'ok') return next();
    if (keyState === 'locked') return undefined;
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
    const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
    if (keyState === 'ok') return next();
    if (keyState === 'locked') return undefined;
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

// ── Changing settings that are already stored in a board (the dashboard's camera settings page) ──
// The staging above only fills gaps. This queues a change for a board whose settings are all there; the
// board asks for it, applies it with its own checks (it refuses anything unsafe), and reports what it
// holds and how it went. The relay only keeps the state (see "Changes queued from the dashboard" in
// lib/devicesettings.js) — it never validates a value.
//   GET  /device-settings/:type/:id/change   camera key:  "<number>\n<KEY=value;...>" if a change is queued, else 404
//   POST /device-settings/:type/:id/report   camera key:  body "<number>\n<boot|applied|rejected>\n<message>\n<KEY=value;...>"
//   GET  /device-settings/:type/:id/state    control key: { reported, pending (names only), last }
//   PUT  /device-settings/:type/:id/change   control key: queue the line in the body (empty body = cancel what is queued)
//   POST /device-settings/:type/:id/reboot   control key: queue a restart of the board — a command, not a change
//                                            (see "Commands" in lib/devicesettings.js); the board answers it like a change
function requireCameraKeyForDevice(req, res, next) {
  const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = deviceSettingsAuthThrottle.check(`get:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `rejected a ${req.method} ${req.path} from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong key' });
}
function requireControlKeyForDevice(req, res, next) {
  if (!CONTROL_KEY) return res.status(503).json({ error: 'changing device settings is disabled: controlKey is not set in the relay config' });
  const provided = req.headers['x-control-key'];
  const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = deviceSettingsAuthThrottle.check(`put:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `REJECTED a ${req.method} ${req.path} from ${ip || 'unknown address'}: missing or wrong control key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong control key' });
}
function checkDeviceParams(req, res, next) {
  if (!devicesettings.isType(req.params.type)) return res.status(400).json({ error: 'the type must be recorder or detector' });
  if (!devicesettings.isId(req.params.id)) return res.status(400).json({ error: 'not a valid device id' });
  return next();
}
// ── the live view switch of a detector (lib/detectorview.js) ─────────────────
// A detector streams only while somebody wants to look: it rests otherwise (no connection, the Wi-Fi
// modem sleeps) and asks here, about every 30 s, whether to stream. Answer: "view=1;stop=0".
//   GET  /detector/:id/view          camera key (the board)
//   POST /detector/:id/view?action=  control key (the dashboard): on | keep | off
app.get('/detector/:id/view', requireCameraKeyForDevice, (req, res) => {
  const id = req.params.id;
  if (!logentry.CAMERA_ID_RE.test(id)) return res.status(400).json({ error: 'invalid detector id' });
  if (!detectors[id] && Object.keys(detectors).length >= MAX_DETECTORS) {
    return res.status(503).json({ error: `the relay already knows ${MAX_DETECTORS} detectors and accepts no more` });
  }
  const det = getDetector(id);
  const now = Date.now();
  const firstAsk = det.polls === 0;
  det.ip = logfile.normalizeIp(req.socket.remoteAddress) || det.ip;
  // A resting detector has no uplink; its poll carries its Wi-Fi network and signal (?ssid=...&rssi=...).
  noteWifi(det, wifiinfo.parseQueryReading(req.query.ssid, req.query.rssi), now, announceDetectorWifi(id));
  const answer = detectorview.answerPoll(det, now);
  const text = detectorview.encodeAnswer(answer, DETECTOR_VIEW_MINUTES);
  if (firstAsk || text !== det.lastAnswer) {
    detLog('INFO', id, `the detector asked whether to stream: ${answer.stop ? 'stop streaming' : answer.view ? 'somebody wants to look: stream' : 'nobody is looking: keep resting'}`);
    det.lastAnswer = text;
  }
  detectorBus.emit('change');
  return res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).send(text);
});

app.post('/detector/:id/view', requireControlKeyForDevice, (req, res) => {
  const id = req.params.id;
  if (!logentry.CAMERA_ID_RE.test(id)) return res.status(400).json({ error: 'invalid detector id' });
  const action = req.query.action;
  if (!detectorview.isAction(action)) return res.status(400).json({ error: `action must be one of ${detectorview.ACTIONS.join(', ')}` });
  const det = detectors[id];
  if (!det) return res.status(404).json({ error: `no detector called '${id}' has connected to the relay since it started` });
  const now = Date.now();
  detectorview.ask(det, action, now);
  if (action !== 'keep') detLog('INFO', id, `live view ${action === 'on' ? 'switched ON' : 'switched OFF'} by ${actorOf(req)}`);
  detectorBus.emit('change');
  return res.json({ ok: true, view: detectorview.describe(det, now) });
});
// ── end of the live view switch ──────────────────────────────────────────────

function loadDeviceState(type, id) {
  return devicesettings.parseState(readStagedFile(devicesettings.stateFile(DEVICE_SETTINGS_DIR, type, id)) || '');
}
function saveDeviceState(type, id, state) {
  const file = devicesettings.stateFile(DEVICE_SETTINGS_DIR, type, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state));
}

app.get('/device-settings/:type/:id/change', requireCameraKeyForDevice, checkDeviceParams, (req, res) => {
  const { type, id } = req.params;
  let state;
  try {
    state = loadDeviceState(type, id);
  } catch (err) {
    relayLog('ERROR', `could not read the settings state of ${id}: ${errorMessage(err)}`, { sender: id });
    return res.status(500).json({ error: 'could not read the state' });
  }
  const now = Date.now();
  const reply = devicesettings.changeReply(state, now);
  if (reply === null) return res.status(404).type('text/plain').send('nothing queued');
  if (deviceSettingsLogGate.check(`${id}:change`, state.pending.rev, now)) {
    const command = devicesettings.commandOf(state.pending);
    relayLog('INFO', command
      ? `${id} (${type}) asked for its queued ${command} and was sent it`
      : `${id} (${type}) asked for its queued settings change and was sent it (${devicesettings.keyNames(state.pending.line).join(', ') || 'no settings'})`, { sender: id });
  }
  return res.type('text/plain').send(reply);
});

app.post('/device-settings/:type/:id/report', requireCameraKeyForDevice, checkDeviceParams, express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
  const { type, id } = req.params;
  const rep = devicesettings.parseReportBody(typeof req.body === 'string' ? req.body : '');
  if (!rep.ok) return res.status(400).json({ error: rep.error });
  try {
    saveDeviceState(type, id, devicesettings.applyReport(loadDeviceState(type, id), rep, Date.now()));
  } catch (err) {
    relayLog('ERROR', `could not save the settings state of ${id}: ${errorMessage(err)}`, { sender: id });
    return res.status(500).json({ error: 'could not save the state' });
  }
  if (rep.result === 'boot') relayLog('INFO', `${id} (${type}) reported its settings (${Object.keys(devicesettings.parseSettingsLine(rep.line)).length} stored)`, { sender: id });
  else relayLog(rep.result === 'applied' ? 'INFO' : 'WARN', `${id} (${type}) ${rep.result} the settings change ${rep.rev}: ${rep.message}`, { sender: id });
  return res.json({ ok: true });
});

app.get('/device-settings/:type/:id/state', requireControlKeyForDevice, checkDeviceParams, (req, res) => {
  try {
    const now = Date.now();
    return res.json({ ...devicesettings.viewState(loadDeviceState(req.params.type, req.params.id), now), now });
  } catch (err) {
    relayLog('ERROR', `could not read the settings state of ${req.params.id}: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not read the state' });
  }
});

// GET /setup-mode  control key: { devices: [ { type, id, reportedAt } ] } — the boards whose last report said
// SETUP_MODE=1 (open to anyone on the public setup Wi-Fi). The dashboard shows a banner while the list is not
// empty. Read from the state files on each ask: it is one small request a minute, and a file that cannot be
// read or understood is skipped (parseState turns damage into an empty state) rather than failing the answer.
function listSetupModeDevices() {
  const entries = [];
  for (const type of devicesettings.TYPES) {
    const dir = path.dirname(devicesettings.stateFile(DEVICE_SETTINGS_DIR, type, 'x'));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') relayLog('WARN', `could not list ${dir}: ${errorMessage(err)}`);
      continue;
    }
    for (const name of names) {
      const id = devicesettings.stateIdFromFileName(name);
      if (id === null) continue;
      try {
        entries.push({ type, id, state: loadDeviceState(type, id) });
      } catch (err) {
        relayLog('WARN', `could not read the settings state of ${id} (${type}): ${errorMessage(err)}`);
      }
    }
  }
  return devicesettings.setupModeDevices(entries);
}
app.get('/setup-mode', requireControlKeyForDevice, (req, res) => res.json({ devices: listSetupModeDevices() }));

app.put('/device-settings/:type/:id/change', requireControlKeyForDevice, checkDeviceParams, express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  const { type, id } = req.params;
  const text = typeof req.body === 'string' ? req.body.trim() : '';
  const checked = text === '' ? { ok: true, line: '' } : devicesettings.checkStagedLine(text);   // empty = cancel what is queued
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  let queued;
  try {
    queued = devicesettings.queueChange(loadDeviceState(type, id), checked.line, Date.now(), actorOf(req));
    saveDeviceState(type, id, queued.state);
  } catch (err) {
    relayLog('ERROR', `could not queue a settings change for ${id}: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not save the change' });
  }
  if (queued.rev === null) {
    relayLog('INFO', `${actorOf(req)} cancelled the settings change queued for ${type} ${id}`);
    return res.json({ ok: true, cancelled: true });
  }
  const keys = devicesettings.keyNames(checked.line);
  // Names only: the values may be sensitive.
  relayLog('INFO', `${actorOf(req)} queued a settings change for ${type} ${id}: ${keys.join(', ') || 'none'} (number ${queued.rev})`);
  return res.json({ ok: true, rev: queued.rev, keys });
});

// Restart a board. No body: the command is the route. Refused (409) for a device the relay has never heard
// from — it would never be picked up — and expires by itself if the board does not ask in time.
app.post('/device-settings/:type/:id/reboot', requireControlKeyForDevice, checkDeviceParams, (req, res) => {
  const { type, id } = req.params;
  let queued;
  try {
    const state = loadDeviceState(type, id);
    const refusal = devicesettings.commandRefusal(state);
    if (refusal) return res.status(409).json({ error: refusal });
    queued = devicesettings.queueCommand(state, 'reboot', Date.now(), actorOf(req));
    saveDeviceState(type, id, queued.state);
  } catch (err) {
    relayLog('ERROR', `could not queue a reboot for ${id}: ${errorMessage(err)}`);
    return res.status(500).json({ error: 'could not save the command' });
  }
  relayLog('INFO', `${actorOf(req)} queued a reboot for ${type} ${id} (number ${queued.rev})`);
  return res.json({ ok: true, rev: queued.rev, command: 'reboot' });
});

// An oversized or unreadable staging body gets a clear answer, not Express's HTML error page.
app.use('/device-settings', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
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
  const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = firmwareAuthThrottle.check(`get:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `rejected a GET ${req.path} from ${ip || 'unknown address'}: missing or wrong key${suppressedNote(t.suppressed)}`);
  return res.status(401).json({ error: 'missing or wrong key' });
}

function requireControlKeyForOta(req, res, next) {
  if (!CONTROL_KEY) return res.status(503).json({ error: 'firmware publishing is disabled: controlKey is not set in the relay config' });
  const provided = req.headers['x-control-key'];
  const keyState = checkKey('control', req, res, provided, CONTROL_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
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

// An oversized or unreadable upload from a camera with the right key gets a clear answer, not Express's HTML
// error page and an ERROR stack trace in the log.
app.use('/upload', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large (limit 2 MB)' });
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

// ── Alarm authentication (review NODE-H1 / COMBINED-H3) ──
// The HTTP alarm routes used to be unauthenticated, on the assumption that the
// firmware "cannot send a key there". That was wrong: the firmware has the
// camera key flashed (it uses it on every other HTTP call). The current
// firmware sends X-Api-Key on /alarm too, so the key is enforced by default.
//
// Old firmware that does not send the key still works IF the operator opts in
// by setting ALLOW_KEYLESS_ALARM=1 in the relay's environment. The opt-in is
// logged at startup. Without it, a keyless POST is refused with 401 (the same
// answer every other camera-keyed route gives), which closes the easy
// disk-filling DoS where anyone on the LAN could POST /alarm/all in a loop.
const ALLOW_KEYLESS_ALARM = process.env.ALLOW_KEYLESS_ALARM === '1';

// (review NODE-002) when ALLOW_KEYLESS_ALARM is set, POST /alarm/:id and
// /alarm/all accept requests with no key. Anyone who can reach the relay's
// HTTP port could otherwise loop /alarm/all and fill the disk: although
// MAX_ALARM_RECORDINGS caps concurrent recordings at 16 (default), an attacker
// can simply wait for one to finish and start another, sustaining the load
// indefinitely. A per-source throttle (one accepted alarm per minute per IP,
// env-tunable) is the cheapest mitigation that keeps the legacy opt-in usable
// for genuine old firmware without leaving the door wide open.
const KEYLESS_ALARM_GAP_MS = parseInt(process.env.KEYLESS_ALARM_GAP_MS, 10) || 60 * 1000;
const keylessAlarmThrottle = new Throttle(KEYLESS_ALARM_GAP_MS);

function requireCameraKeyForAlarm(req, res, next) {
  if (ALLOW_KEYLESS_ALARM) {
    // Even keyless, refuse to let one source spray /alarm/all in a loop. A
    // genuine alarm source (an old firmware board) sends at most one alarm per
    // motion event, which is many seconds apart at the fastest; 60s/IP is well
    // above that and matches the longest recording we would start. Cameras
    // behind a NAT share an address, so the limit is per source IP, not per
    // camera id — that is the correct granularity for "is this an attacker".
    const ip = logfile.normalizeIp(req.socket.remoteAddress) || 'unknown';
    const t = keylessAlarmThrottle.check(`alarm:${ip}`, Date.now());
    if (!t.allow) {
      res.set('Retry-After', String(Math.ceil(KEYLESS_ALARM_GAP_MS / 1000)));
      res.set('Connection', 'close');
      return res.status(429).json({ error: `ALLOW_KEYLESS_ALARM is on but you are sending /alarm requests too fast: try again in ${Math.ceil((KEYLESS_ALARM_GAP_MS - (Date.now() % KEYLESS_ALARM_GAP_MS)) / 1000)}s${suppressedNote(t.suppressed)}` });
    }
    return next();
  }
  const keyState = checkKey('camera', req, res, auth.extractKey(req), API_KEY);
  if (keyState === 'ok') return next();
  if (keyState === 'locked') return undefined;
  const ip = logfile.normalizeIp(req.socket.remoteAddress);
  const t = authFailThrottle.check(`alarm:${ip}`, Date.now());
  if (t.allow) relayLog('WARN', `rejected a POST ${req.path} from ${ip || 'unknown address'}: missing or wrong key (set ALLOW_KEYLESS_ALARM=1 only if you have old firmware that cannot send X-Api-Key)${suppressedNote(t.suppressed)}`);
  res.set('Connection', 'close');
  return res.status(401).json({ error: 'missing or wrong key — send X-Api-Key (or set ALLOW_KEYLESS_ALARM=1 for old firmware)' });
}

// Hard cap on simultaneous recordings to keep a keyless (or compromised)
// alarm source from filling the disk: once this many cameras are recording,
// further alarm-triggered recordings are refused with 503.
const MAX_ALARM_RECORDINGS = parseInt(process.env.MAX_ALARM_RECORDINGS, 10) || 16;
function alarmRecordingAllowed() {
  const active = Object.values(cameras).filter((c) => c && c.recording).length;
  return active < MAX_ALARM_RECORDINGS;
}

// Registered before /alarm/:id so "all" isn't taken as a literal camera id.
app.post('/alarm/all', requireCameraKeyForAlarm, (req, res) => {
  if (!alarmRecordingAllowed()) return res.status(503).json({ error: `too many concurrent recordings (cap ${MAX_ALARM_RECORDINGS}) — refuse to start more` });
  res.json({ cameras: triggerAlarmAll() });
});

app.post('/alarm/:id', requireCameraKeyForAlarm, (req, res) => {
  if (!alarmRecordingAllowed()) return res.status(503).json({ error: `too many concurrent recordings (cap ${MAX_ALARM_RECORDINGS}) — refuse to start more` });
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
app.post('/record/all', requireDashboardKey, requireRecordSeconds, (req, res) => {
  const results = Object.keys(cameras).map((id) => startOrExtendRecording(cameras[id], id, req.recordSeconds));
  res.json({ cameras: results });
});

// Start recording this camera's incoming frames to a file for `seconds`
// (plus the pre-roll lead-in — see the Recording notes above). If it's
// already recording, this extends it instead — see extendRecording().
// Needs the control key (requireDashboardKey, review R-03): called by the PHP layer — the dashboard's
// RECORD button, which sends X-Control-Key. The camera boards do not call this route; their alarm is
// in-band on the push connection, with POST /alarm/:id above as the keyless fallback.
app.post('/record/:id', requireDashboardKey, requireRecordSeconds, (req, res) => {
  const result = startOrExtendRecording(getCamera(req.params.id), req.params.id, req.recordSeconds);
  // A person pressing RECORD must be told it did not happen; a camera's alarm (below) just gets the summary.
  if (result.suppressed) return res.status(409).json(Object.assign({ error: 'recording is switched OFF for this camera' }, result));
  res.json(result);
});

// Stop a recording early. Encoding into the final .mp4 happens in the
// background — it won't show up in /recordings/:id until ffmpeg finishes.
app.post('/record/:id/stop', requireDashboardKey, (req, res) => {
  const cam = cameras[req.params.id];
  const rec = cam && stopRecording(cam);
  if (!rec) return res.status(409).json({ error: 'not recording' });
  res.json({ id: req.params.id, recording: false, encoding: rec.frameCount > 0 });
});

// Current recording status/progress for one camera.
app.get('/record/:id', requireReadKey, (req, res) => {
  const cam = cameras[req.params.id];
  if (!cam || !cam.recording) return res.json({ recording: false });
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

// A clip counts as SEEN once the dashboard has told the relay so (it does when
// someone plays or downloads it). That is remembered as an empty sidecar file
// next to the clip — "<clip>.mp4.seen" — which is never listed or counted as a
// recording (it does not end in .mp4) and goes away with its clip. Kept on the
// relay, not in the browser, so every device viewing the dashboard agrees.
function seenMarkerPath(clipPath) {
  return clipPath + '.seen';
}
function isSeen(clipPath) {
  return fs.existsSync(seenMarkerPath(clipPath));
}
function removeClip(clipPath) {
  fs.unlinkSync(clipPath);
  fs.rmSync(seenMarkerPath(clipPath), { force: true });
  fs.rmSync(personscan.thumbnailPath(clipPath), { force: true });
}

// The person check: one clip at a time (lib/scanqueue.js), each judged by lib/sorter.js, which only ever
// moves/deletes a clip on a clear "nobody in it" answer. Disk access is injected here.
const sorter = createSorter({
  config: scanCfg,
  files: {
    isBeingWritten: (p) => clipsBeingEncoded.has(p),
    exists: (p) => fs.existsSync(p),
    move: (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      fs.rmSync(seenMarkerPath(from), { force: true });
    },
    remove: removeClip,
    removeThumbnail: (p) => fs.rmSync(personscan.thumbnailPath(p), { force: true }),
  },
  runDetector: (args) => runProcess(scanCfg.python, args, { env: personscan.scanEnv(process.env), timeoutMs: scanCfg.timeoutMs }),
});
// A person found in a fresh recording is announced through the notification channels (lib/detectionnotice.js).
const detectionNotifier = detectionnotice.createDetectionNotifier({
  notifier,
  config: noticeCfg,
  throttle: new Throttle(noticeCfg.cooldownMs),
  now: Date.now,
  files: {
    readThumbnail: (clipPath) => fs.readFileSync(personscan.thumbnailPath(clipPath)),
    sizeOf: (clipPath) => fs.statSync(clipPath).size,
  },
  log: relayLog,
});
const scanQueue = new ScanQueue({
  work: (job) => sorter.sort(job.payload.clipPath),
  onFinished: (job, outcome) => {
    detectionNotifier.onScanFinished(job, outcome);   // never throws, never rejects
    const name = path.basename(job.payload.clipPath);
    const detail = { state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    relayLog(outcome.state === 'error' ? 'WARN' : 'INFO', `person check of ${name}: ${detail.state}${detail.reason ? ` (${detail.reason})` : ''}`, { sender: job.payload.camId });
  },
});
const scanKey = (camId, filename) => `${camId}/${filename}`;

// The archive (<camera>/no-person/): counted and deleted through lib/archive.js, which only touches plain clip files.
const archive = createArchive({ fs });

// Queues one clip. A clip that already has its person picture was checked before and is skipped.
// notify: a person found in it is announced (only for a clip the relay has just saved, not for a re-check).
// -> 'queued' | 'duplicate' | 'done'
function queueScan(camId, filename, { notify = false } = {}) {
  const clipPath = path.join(cameraDir(camId), filename);
  if (fs.existsSync(personscan.thumbnailPath(clipPath))) return 'done';
  return scanQueue.enqueue(scanKey(camId, filename), { camId, clipPath, notify });
}

// Resolves /recordings/:id/:filename to req.recordingPath, or answers 400 (not a
// name the relay would have generated — which rules out path traversal too)
// or 404 (no such file).
function requireExistingRecording(req, res, next) {
  const { id, filename } = req.params;
  if (!validation.isSafeFilename(filename)) return res.sendStatus(400);
  const filePath = path.join(cameraDir(id), filename);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  req.recordingPath = filePath;
  return next();
}

// List saved recordings for a camera, newest first. `seen` says whether the
// clip has been played or downloaded yet (see seenMarkerPath above).
app.get('/recordings/:id', requireReadKey, (req, res) => {
  const dir = cameraDir(req.params.id);
  const files = recordingFileNames(dir)
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      const clipPath = path.join(dir, f);
      return {
        filename: f, sizeBytes: stat.size, createdAt: stat.birthtime, seen: isSeen(clipPath),
        person: fs.existsSync(personscan.thumbnailPath(clipPath)),
        scan: scanQueue.stateOf(scanKey(req.params.id, f)),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(files);
});

// Delete every saved recording for a camera at once (the per-camera
// "DELETE ALL" button). Same path as the list route above, distinguished
// by method — no filename segment, so it can't collide with the
// single-file delete route below.
app.delete('/recordings/:id', requireDashboardKey, (req, res) => {
  const dir = cameraDir(req.params.id);
  const deleted = recordingFileNames(dir);
  relayLog('INFO', `all ${deleted.length} recording(s) of ${req.params.id} deleted by ${actorOf(req)}`);
  for (const f of deleted) removeClip(path.join(dir, f));
  res.json({ deleted });
});

// How many clips the person check has filed under <camera>/no-person/ (the "archive"). Registered before
// the /:filename routes, which would answer 400 for the name "archive".
app.get('/recordings/:id/archive', requireReadKey, (req, res) => {
  res.json({ count: archive.count(cameraDir(req.params.id)) });
});

// The archived clips, newest first (same entries as the list of recordings).
app.get('/recordings/:id/archive/files', requireReadKey, (req, res) => {
  res.json(archive.list(cameraDir(req.params.id)));
});

// Resolves /recordings/:id/archive/:filename to req.archivePath, or answers 404 — also for a name that is
// not an archived plain clip file (archive.pathOf checks the name and the file).
function requireArchivedClip(req, res, next) {
  const clipPath = archive.pathOf(cameraDir(req.params.id), req.params.filename);
  if (clipPath === null) return res.sendStatus(404);
  req.archivePath = clipPath;
  return next();
}

// Play / download one archived clip (Range requests work like for any recording).
app.get('/recordings/:id/archive/:filename', requireReadKey, requireArchivedClip, (req, res) => {
  res.download(req.archivePath);
});

// Give one archived clip back to the recordings: it is on the dashboard's list again. 409 when a recording
// of that name exists already (nothing is overwritten).
app.post('/recordings/:id/archive/:filename/restore', requireDashboardKey, (req, res) => {
  const { id, filename } = req.params;
  const outcome = archive.restore(cameraDir(id), filename);
  if (outcome.state === 'missing') return res.sendStatus(404);
  if (outcome.state === 'exists') return res.status(409).json({ error: 'a recording with this name exists already — nothing was overwritten' });
  if (outcome.state === 'error') {
    relayLog('WARN', `archive of ${id}: restoring ${filename} failed (${outcome.reason}), requested by ${actorOf(req)}`);
    return res.status(500).json({ error: `could not restore the recording: ${outcome.reason}` });
  }
  relayLog('INFO', `archive of ${id}: ${filename} restored by ${actorOf(req)}`);
  return res.json({ restored: filename });
});

// Delete the whole archive of a camera for good (the dashboard's "DELETE ARCHIVE" button).
app.delete('/recordings/:id/archive', requireDashboardKey, (req, res) => {
  const { deleted, failed } = archive.removeAll(cameraDir(req.params.id));
  const by = actorOf(req);
  if (failed.length === 0) {
    relayLog('INFO', `archive of ${req.params.id}: ${deleted.length} recording(s) deleted by ${by}`);
    return res.json({ deleted });
  }
  relayLog('WARN', `archive of ${req.params.id}: ${deleted.length} recording(s) deleted by ${by}, ${failed.length} could not be (${failed[0].name}: ${failed[0].reason})`);
  return res.status(500).json({ error: `${failed.length} archived recording(s) could not be deleted: ${failed[0].reason}`, deleted });
});

// Download one recording (recordings.php decides whether the browser sees
// it as an attachment or inline/playable — see that file's play vs
// download handling). Range requests are handled automatically by
// Express's res.download()/sendFile() — that's what lets the dashboard's
// inline <video> player seek/scrub instead of only ever playing from the
// start, as long as recordings.php forwards the Range header through.
app.get('/recordings/:id/:filename', requireReadKey, requireExistingRecording, (req, res) => {
  res.download(req.recordingPath);
});

// Delete one recording.
app.delete('/recordings/:id/:filename', requireDashboardKey, requireExistingRecording, (req, res) => {
  removeClip(req.recordingPath);
  relayLog('INFO', `recording ${req.params.id}/${req.params.filename} deleted by ${actorOf(req)}`);
  res.json({ deleted: req.params.filename });
});

// Mark one recording as seen (played or downloaded). Harmless and repeatable.
app.post('/recordings/:id/:filename/seen', requireDashboardKey, requireExistingRecording, (req, res) => {
  fs.writeFileSync(seenMarkerPath(req.recordingPath), '');
  res.json({ seen: req.params.filename });
});

// The picture of the first person found in a clip (written by tools/person_scan.py).
app.get('/recordings/:id/:filename/thumbnail', requireReadKey, requireExistingRecording, (req, res) => {
  const thumb = personscan.thumbnailPath(req.recordingPath);
  if (!fs.existsSync(thumb)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.type('image/jpeg').sendFile(thumb);
});

// Is the person check usable? Answers 409 (with the reason) when it is switched off, so the dashboard can say why.
function requireScanEnabled(req, res, next) {
  if (scanCfg.enabled) return next();
  return res.status(409).json({ error: 'the person check is switched off (switch it on under SETTINGS → Person check, or personScan.enabled in config.js — see INSTALL.md)' });
}

// Sort out one clip: a clip without a person is moved to no-person/ (or deleted, personScan.action).
app.post('/recordings/:id/:filename/scan', requireDashboardKey, requireScanEnabled, requireExistingRecording, (req, res) => {
  const result = queueScan(req.params.id, req.params.filename);
  relayLog('INFO', `person check of ${req.params.id}/${req.params.filename} requested by ${actorOf(req)} (${result})`);
  res.status(202).json({ scan: result });
});

// Sort out every clip of a camera that has not been checked yet.
app.post('/recordings/:id/scan', requireDashboardKey, requireScanEnabled, (req, res) => {
  const results = recordingFileNames(cameraDir(req.params.id)).map((f) => queueScan(req.params.id, f));
  const queued = results.filter((r) => r === 'queued').length;
  relayLog('INFO', `person check of ${queued} recording(s) of ${req.params.id} requested by ${actorOf(req)}`);
  res.status(202).json({ queued });
});

// Sends a test notification (with the relay's test picture) through every configured channel, so a new setup
// can be checked without waiting for a person: 409 when no channel is configured, else 200 with one entry per
// channel ({ name, ok, error? } — an error never contains a secret, see lib/notify/telegram.js).
app.post('/notifications/test', requireDashboardKey, async (req, res) => {
  if (notifier.isEmpty()) return res.status(409).json({ error: 'no notification channel is configured (notifications in config.js — see lib/notify/README.md)' });
  const results = await notifier.send({ text: `Test notification from the camera relay, requested by ${actorOf(req)}`, image: fs.readFileSync(path.join(__dirname, 'testimage.jpg')) });
  for (const r of results.filter((x) => !x.ok)) relayLog('WARN', `test notification through ${r.name} failed: ${r.error}`);
  return res.json({ results });
});

// Any error a route doesn't handle itself ends up here: recorded with its stack
// trace (Express's default handler would only print it to the console), and
// answered with a plain 500.
app.use((err, req, res, next) => {
  if (err instanceof CameraIdError) {
    if (err.status === 503) relayLog('WARN', `refused ${req.method} ${req.path}: ${err.message}`, { via: 'relay' });
    if (res.headersSent) return next(err);
    return res.status(err.status).json({ error: err.message });
  }
  relayLog('ERROR', `unhandled error in ${req.method} ${req.path}: ${errorMessage(err)}`, { trace: err && err.stack });
  if (res.headersSent) return next(err);
  return res.sendStatus(500);
});

// Where the HTTP server listens. The relay binds to all interfaces by
// default because cameras (OTA, settings sync, /log, alarm fallback) and
// detectors (the HTTP Upgrade uplink on /detector/:id/uplink) are on the LAN
// and reach the relay at the Pi's LAN address.
//
// (review NODE-H2): a previous version of this patch defaulted to 127.0.0.1
// on the theory that only the PHP layer needs the HTTP port. That broke
// detector uplinks entirely and silently broke camera OTA / settings / log
// calls — both use the HTTP port from the LAN. The correct NODE-H2 fix is
// requireReadKey() failing closed when no controlKey is set (above), not
// restricting the bind. Operators who genuinely want loopback-only (e.g.
// everything on one machine) can still opt in with RELAY_BIND=127.0.0.1.
const RELAY_BIND = process.env.RELAY_BIND || '0.0.0.0';

// Known-weak / template values for camKey and controlKey that must never reach
// production. Reported by the relay at startup so a copied example.config.js
// does not silently expose every camera-keyed route. (review NODE-001)
const camKeyProblem = keypolicy.keyStrengthProblem('camKey', API_KEY);
if (camKeyProblem) {
  relayLog('ERROR', `${camKeyProblem}: every camera-keyed route (/upload, /log, /alarm, OTA, device-settings, discovery) is exposed. Generate one with: openssl rand -hex 24`);
}
const controlKeyProblem = CONTROL_KEY ? keypolicy.keyStrengthProblem('controlKey', CONTROL_KEY) : null;
if (controlKeyProblem) {
  relayLog('ERROR', `${controlKeyProblem}: every dashboard-keyed route (recording switch, settings, firmware publish, restart) is exposed. Generate one with: openssl rand -hex 24`);
}
if (keypolicy.keysAreEqualAndNonEmpty(API_KEY, CONTROL_KEY)) {
  relayLog('ERROR', 'camKey and controlKey are the SAME value: every camera board (which has camKey in its flash) would gain full dashboard power (recording switch, settings, firmware publish, restart). Use two different keys.');
}

const httpServer = app.listen(PORT, RELAY_BIND, () => {
  console.log(`Camera relay (HTTP) listening on ${RELAY_BIND}:${PORT}`);
  if (!CONTROL_KEY) {
    relayLog('WARN', `controlKey is not set: live video, snapshots, recordings and the camera list are REFUSED (503) until controlKey is set in config.js (and relay_control_key in the dashboard's config.php). Set READ_KEY_REQUIRED=0 only on a trusted LAN with no Tor exposure.`);
  }
});
// A person detector opens its uplink with an HTTP Upgrade (see the "Person detectors" section above).
httpServer.on('upgrade', handleDetectorUpgrade);

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
  cam.connectedAt = now;
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
      // (review NODE-011) defense in depth: the camera is authenticated and the
      // push port is plain TCP, so anyone who has sniffed the API key (or a MITM
      // that substituted the frame in transit) could push a non-JPEG payload
      // that the relay would later serve to viewers as image/jpeg. classifyPayload()
      // only distinguishes CONTROL_MARKER (0x00) from "everything else"; refuse
      // everything that is not a real JPEG here too, mirroring the /upload check.
      if (!isJpeg(payload)) {
        throw new Error('rejected a payload that does not start with the JPEG magic (FF D8 FF)');
      }
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
    } else if (msg.kind === 'wifi') {
      // The camera is authenticated, but what it says is still checked: it ends up on the dashboard.
      noteWifi(getCamera(camId), wifiinfo.parseReading(msg.ssid, msg.rssi), Date.now(), (ssid) => camLog('INFO', camId, `the camera is on the Wi-Fi network '${ssid}'`));
    }
    // msg.kind === 'unknown': a control message from newer firmware than this
    // relay — ignore it rather than mistake it for a frame or drop the camera.
  } catch (err) {
    logPushError(camId, kind === 'frame' ? 'video frame' : kind === 'alarm' ? 'alarm' : kind === 'wifi' ? 'Wi-Fi report' : 'message', err);
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

  // An address that is locked out (too many wrong keys) is not even listened to.
  const lockedOut = AUTH_LOCKS.camera.check(peerIp || 'unknown', Date.now());
  if (lockedOut.blocked) {
    socket.on('error', () => {});
    reject(null, `locked out after too many wrong keys, ${lockedOut.retryAfterSec} s left`);
    return;
  }

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
    const keyState = keyCheck('camera', peerIp, parsed.key, API_KEY).state;
    if (keyState === 'locked') return reject(parsed.id, 'locked out after too many wrong keys');
    if (keyState !== 'ok') return reject(parsed.id, 'wrong key');
    // Even with the right key the id must be a plain camera id: it names a recordings folder (and a map entry).
    if (!logentry.CAMERA_ID_RE.test(parsed.id)) return reject(null, 'invalid camera id');
    try {
      acceptPushCamera(socket, parsed.id, peerIp);
    } catch (err) {
      return reject(null, errorMessage(err)); // e.g. the relay already knows MAX_CAMERAS cameras
    }
    camId = parsed.id;
    authed = true;
    connectedAt = Date.now();
    socket.setTimeout(PUSH_IDLE_TIMEOUT_MS);
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

// ── Discovery responder (UDP) ──
// A camera whose stored SERVER_HOST stops answering (the router gave the Pi another address) asks
// the network "where is the relay?" with a tiny UDP probe — to a broadcast address and to the other
// addresses of its subnet, which is the only thing that reaches a relay from behind a NAT router —
// and this answers it, proving it knows camKey without ever sending it (see lib/discovery.js for the
// protocol). The camera then stores the address it was answered from. Entirely optional: if the port
// is taken or the socket fails, the relay carries on and cameras simply keep their stored address.
// discoveryPort in config.js (or DISCOVERY_PORT): default 8082, 0 = off. It must equal the
// firmware's RELAY_FIND_PORT. The Pi's firewall has to let UDP in on it (INSTALL.md).
const discoveryCfg = discovery.resolveDiscoveryPort(fromEnv('DISCOVERY_PORT', config.discoveryPort));
for (const w of discoveryCfg.warnings) console.warn(`[config] ${w}`);
const discoveryAnswerGap = new Throttle(100);          // at most ~10 answers a second to one address
const discoveryLogGap = new Throttle(60 * 60 * 1000);  // a camera asks every minute: log it once an hour

function startDiscoveryResponder() {
  if (discoveryCfg.port === 0) {
    console.log('Camera relay (discovery) is off (discoveryPort = 0)');
    return;
  }
  if (!API_KEY) {
    relayLog('WARN', 'discovery responder not started: camKey is empty, so no camera could check an answer');
    return;
  }
  const socket = dgram.createSocket('udp4');
  socket.on('error', (err) => {
    relayLog('WARN', `discovery responder stopped: ${errorMessage(err)} — cameras keep using the SERVER_HOST they have stored`);
    try { socket.close(); } catch (e) { /* already closed */ }
  });
  socket.on('message', (msg, rinfo) => {
    try {
      const nonce = discovery.parseProbe(msg);
      if (!nonce) return; // not a probe: stay silent
      const now = Date.now();
      if (!discoveryAnswerGap.check(rinfo.address, now).allow) return;
      const reply = discovery.buildReply(nonce, API_KEY);
      if (!reply) return;
      socket.send(reply, rinfo.port, rinfo.address, () => { /* a lost answer is just a lost UDP datagram */ });
      const t = discoveryLogGap.check(rinfo.address, now);
      if (t.allow) relayLog('INFO', `a camera at ${rinfo.address} asked where the relay is${suppressedNote(t.suppressed)}`);
    } catch (err) {
      relayLog('ERROR', `discovery probe failed: ${errorMessage(err)}`, { trace: err && err.stack }); // never let a datagram stop the relay
    }
  });
  socket.bind(discoveryCfg.port, () => console.log(`Camera relay (discovery) listening on UDP :${discoveryCfg.port}`));
}
startDiscoveryResponder();

// ── Event-loop watchdog (the hanging-dashboard investigation) ──
// The relay is one process with one event loop: when something in it blocks
// synchronously, every camera's stream, every /status answer and every
// detector's uplink stalls at once, boards reboot on their "the relay stopped
// accepting data" watchdog, and the dashboard looks dead. From the browser that
// is indistinguishable from the web server being the problem — and the two need
// the opposite fix, so the first fact to establish is which side it is (see
// lib/loopwatch.js and the debug runbook it points to).
//
// One INFO line a minute (worst stall, memory, fds, who is connected) and a
// WARN the moment the loop is blocked for a second or more. Heartbeat lines
// keep coming → the relay is alive and the stall is in Apache/PHP; they stop →
// the relay itself is stuck, and the WARN after the gap says since when.
// LOOPWATCH=0 turns it off; its timers are unref'd, so it never holds the
// process open by itself.
function viewerSummary() {
  const cams = Object.values(cameras);
  const dets = Object.values(detectors);
  return `${cams.filter((c) => c.socket).length}/${cams.length} cameras connected, `
    + `${dets.filter((d) => d.connected).length}/${dets.length} detectors connected, `
    + `${muxViewers} mux viewers`;
}
if (fromEnv('LOOPWATCH', '1') !== '0') {
  createLoopWatch({ log: relayLog, snapshot: viewerSummary }).start();
}

// ── Process lifecycle, for the log ──
// A relay that restarted is the first thing to rule in or out when a camera
// "dropped", and a crash is useless without its stack trace — so both leave a
// line (written synchronously: the process may be about to die).
relayLog('INFO', notifier.isEmpty() ? 'notifications: no channel configured' : `notifications: ${notifier.names().join(', ')}`);
relayLog('INFO', `relay started (pid ${process.pid}, node ${process.version}; HTTP :${PORT}, push :${PUSH_PORT}; pre-roll ${preRollCfg.seconds}s; log file ${logCfg.file}; recording on/off switch ${CONTROL_KEY ? 'enabled' : 'DISABLED (no controlKey in config.js)'})`);

if (ALLOW_KEYLESS_ALARM) {
  relayLog('WARN', 'ALLOW_KEYLESS_ALARM=1 is set: POST /alarm/:id and /alarm/all accept requests with no camera key. This is for old firmware only — set X-Api-Key on every alarm POST and remove this env var once every camera runs firmware that sends it.');
}

for (const w of loadedOverrides.warnings) relayLog('WARN', w);

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
