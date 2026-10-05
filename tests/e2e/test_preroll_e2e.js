#!/usr/bin/env node
'use strict';
// test_preroll_e2e.js — end-to-end check of the recording PRE-ROLL ("black
// box") feature against a REAL `server.js` process, with a fake camera
// speaking the real raw-TCP push protocol.
//
// The bug this guards against: when a recording was triggered (person
// detector -> alarm -> HTTP request over weak Wi-Fi), the clip only began
// once the request arrived, so a person who had already walked through the
// frame was missing from the footage. Now the relay keeps the last
// preRollSeconds of every camera in RAM and starts every recording with it.
//
// What this checks, over real sockets and real HTTP:
//   - the relay buffers ONLY the configured window (not everything)
//   - a new recording starts with that window (preRollFrames on the response,
//     and — if ffmpeg/ffprobe are installed — in the encoded .mp4 itself)
//   - extending a running recording adds no second pre-roll
//   - a recording right after another doesn't repeat footage the previous
//     clip already holds
//   - preRollSeconds=0 disables it, and a bad value falls back with a warning
//   - on connect the relay greets a camera with the legacy "resume" byte and
//     the "I understand in-band alarms" capability byte
//   - /status carries each camera's recordingCount (what the dashboard's
//     FILES button shows): it equals the length of the file list and the
//     files on disk, counts a camera that only exists as a folder of footage,
//     ignores a recording in progress, and drops when recordings are deleted
//   - a failure while handling an in-band alarm (here: the recordings folder
//     is unusable) never takes the relay down: the camera stays connected,
//     live viewers keep getting frames, the error is logged, and the next
//     alarm works once the problem is gone (an error escaping the raw socket
//     handler would otherwise kill the whole relay process — every stream
//     black, no recording — at exactly the moment an alarm arrives)
//   - the camera's alarm sent IN-BAND (a 6-byte control message on the push
//     connection, no HTTP request) starts a recording with the pre-roll, for
//     just that camera or for all of them, without disturbing the frame
//     stream; unknown control messages are ignored, not mistaken for frames
//
// Like the other e2e test it is an independent client (no require() of lib/
// or server.js), runs on its own ports (never the real 8080/8081), uses a
// throwaway settings file, and only creates/removes recordings under its own
// camera ids. Core modules only. Takes roughly 15-20 seconds (real time).
//
// Usage:
//   node tests/e2e/test_preroll_e2e.js
//   E2E_PREROLL_PORT=19290 E2E_PREROLL_PUSH_PORT=19291 node tests/e2e/test_preroll_e2e.js
//
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const RECORDINGS_DIR = path.join(RELAY_DIR, 'recordings');
const JPEG = fs.readFileSync(path.join(RELAY_DIR, 'testimage.jpg')); // a real, encodable JPEG

const PORT = Number(process.env.E2E_PREROLL_PORT || 19290);
const PUSH_PORT = Number(process.env.E2E_PREROLL_PUSH_PORT || 19291);
const BASE = `http://127.0.0.1:${PORT}`;
const CAM_KEY = 'e2e-preroll-key';

const CAM = 'e2e-preroll-cam';
const CAM_OFF = 'e2e-preroll-cam-off';
const CAM_IB = 'e2e-inband-cam-a';     // sends in-band alarms
const CAM_IB2 = 'e2e-inband-cam-b';    // a bystander camera, only recorded by "alarm all"
const CAM_UNK = 'e2e-inband-cam-unk';  // receives an unknown control message
const CAM_FAIL = 'e2e-inband-cam-fail'; // its recordings folder is deliberately broken
const CAM_FOLDER = 'e2e-folder-only';   // footage on disk, camera never connected this run
const TEST_CAMS = [CAM, CAM_OFF, CAM_IB, CAM_IB2, CAM_UNK, CAM_FAIL, CAM_FOLDER];

const PREROLL_SECONDS = 3;
const FRAME_INTERVAL_MS = 100; // fake camera runs at ~10 fps
const NOMINAL_PRE_FRAMES = (PREROLL_SECONDS * 1000) / FRAME_INTERVAL_MS; // ~30
const READY_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 150000; // generous: ffmpeg encodes slowly on a loaded or low-power machine

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
  }
}
let finished = false; // set once the run reaches its summary
// If the process ever ends WITHOUT reaching the summary (an awaited promise that
// never settles lets Node quit quietly with exit code 0), that must read as a
// failure, not a pass.
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
});
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

let createdTempConfig = false;
function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
  createdTempConfig = true;
  console.log('(no config.js found — wrote a temporary throwaway one for this test run)');
}
const preExistingRecDirs = new Set();
function noteExistingRecDirs() {
  for (const id of TEST_CAMS) {
    if (fs.existsSync(path.join(RECORDINGS_DIR, id))) preExistingRecDirs.add(id);
  }
}
function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
}
function cleanup(settingsFile) {
  if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  for (const id of TEST_CAMS) {
    if (!preExistingRecDirs.has(id)) removeDir(path.join(RECORDINGS_DIR, id));
  }
  for (const f of [settingsFile, settingsFile + '.tmp']) {
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
  }
  try { fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true }); } catch (e) { /* gone */ } // the temp folder that held it
}

// Starts the relay with extra env vars; resolves { child, output() }.
function startRelay(settingsFile, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PUSH_PORT: String(PUSH_PORT),
        CAM_KEY,
        SETTINGS_FILE: settingsFile,
        LOG_FILE: path.join(path.dirname(settingsFile), 'relay.log'), // never write into the real logs/ folder
      }, extraEnv),
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in ${READY_TIMEOUT_MS}ms. Output:\n${output}`)); }
    }, READY_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes(`raw push) listening on :${PUSH_PORT}`)) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`relay exited early (code ${code}):\n${output}`)); }
    });
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(); // a child ended by a signal has exitCode null
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } }, 1500).unref();
  });
}

function http(method, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(BASE + pathAndQuery, { method, headers: { 'Content-Length': 0 } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`request timed out: ${method} ${pathAndQuery}`)));
    req.end();
  });
}
const get = (p) => http('GET', p);
const post = (p) => http('POST', p);

// A fake camera: connects to the raw push port, authenticates, and sends
// the same JPEG every FRAME_INTERVAL_MS using the real wire format
// ("<id>\t<key>\n", then [4-byte big-endian length][JPEG] repeatedly).
class FakeCamera {
  constructor(id) {
    this.id = id;
    this.pushed = 0;          // frames written so far
    this.firstBytes = [];     // bytes the relay sent back to us (the legacy resume byte)
    this.timer = null;
    this.socket = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(PUSH_PORT, '127.0.0.1', () => {
        this.socket.write(`${this.id}\t${CAM_KEY}\n`);
        resolve();
      });
      this.socket.on('data', (d) => { for (const b of d) this.firstBytes.push(b); });
      this.socket.on('error', reject);
    });
  }
  start() {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(JPEG.length, 0);
    const frame = Buffer.concat([header, JPEG]);
    this.timer = setInterval(() => {
      this.socket.write(frame);
      this.pushed += 1;
    }, FRAME_INTERVAL_MS);
  }
  // One frame, right now (for cameras that don't stream continuously).
  pushOne() {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(JPEG.length, 0);
    this.socket.write(Buffer.concat([header, JPEG]));
    this.pushed += 1;
  }
  // The exact bytes the firmware writes for an alarm (see logic.h
  // encodeAlarmMessage): [00 00 00 02][00][01 = this camera | 02 = all].
  sendAlarm(all) {
    this.socket.write(Buffer.from([0, 0, 0, 2, 0x00, all ? 0x02 : 0x01]));
  }
  // A control message of a type the relay has never heard of.
  sendUnknownControl() {
    this.socket.write(Buffer.from([0, 0, 0, 2, 0x00, 0x7f]));
  }
  isOpen() {
    return !!this.socket && !this.socket.destroyed;
  }
  stop() {
    clearInterval(this.timer);
    if (this.socket) this.socket.destroy();
  }
}

// A live viewer of /stream/<id> (what the dashboard is). Counts the video
// frames it receives and how many were not valid JPEGs.
function openViewer(id) {
  const v = { frames: 0, bad: 0, req: null };
  let buf = Buffer.alloc(0);
  v.req = nodeHttp.get(`${BASE}/stream/${id}`, (res) => {
    res.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) break;
        const m = /Content-Length: (\d+)/.exec(buf.slice(0, end).toString());
        if (!m) break;
        const n = Number(m[1]);
        if (buf.length < end + 4 + n + 2) break;
        v.frames += 1;
        if (buf[end + 4] !== 0xff || buf[end + 5] !== 0xd8) v.bad += 1;
        buf = buf.slice(end + 4 + n + 2);
      }
    });
  });
  v.req.on('error', () => {});
  v.close = () => v.req.destroy();
  return v;
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

function ffprobeFrameCount(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const n = parseInt(String(r.stdout).trim(), 10);
  return Number.isFinite(n) ? n : null;
}
// An .mp4 shows up on disk as soon as ffmpeg STARTS encoding it, but it only
// becomes readable once encoding has FINISHED (the index is written last).
// So never ffprobe a clip just because the file exists — poll until it can be
// read. How long that takes depends on the machine and on how many clips are
// encoding at once, which is why a fixed check right after the file appears
// passes on a fast box and fails on a slow or busy one.
const waitForFrameCount = (file) => waitFor(() => ffprobeFrameCount(file), 30000);
const haveTool = (name) => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;

async function main() {
  const overallTimer = setTimeout(() => {
    console.error('[FAIL] overall test timed out');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref();

  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-preroll-')), 'settings.json');
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first (the relay needs express)`);
    summarize();
    return;
  }
  ensureConfigExists();
  noteExistingRecDirs();

  let relay;
  let cam;
  try {
    // ── 1. Pre-roll enabled (3s) ────────────────────────────────────
    relay = await startRelay(settingsFile, { PREROLL_SECONDS: String(PREROLL_SECONDS) });
    check('relay starts up and reports ready', true);

    let r = await get('/settings');
    check('GET /settings exposes the configured pre-roll length (read-only)',
      r.body && r.body.preRollSeconds === PREROLL_SECONDS, JSON.stringify(r.body));
    await post('/settings?alarmRecordSeconds=5');

    cam = new FakeCamera(CAM);
    await cam.connect();
    cam.start();

    // Run the camera for 4.5s: 45 frames, but only the last ~3s may be kept.
    await sleep(4500);

    r = await get('/status');
    const pr = r.body && r.body[CAM] && r.body[CAM].preRoll;
    check('/status reports a pre-roll buffer for the camera, sized to the configured window',
      pr && pr.windowSeconds === PREROLL_SECONDS, JSON.stringify(pr));
    check('the relay buffered only the last ~3s of the ~4.5s streamed (not everything)',
      pr && between(pr.frames, NOMINAL_PRE_FRAMES - 6, NOMINAL_PRE_FRAMES + 6) && cam.pushed >= 40,
      `buffered=${pr && pr.frames} pushed=${cam.pushed}`);
    check('buffered span is about the window length',
      pr && between(pr.bufferedSeconds, PREROLL_SECONDS - 0.7, PREROLL_SECONDS + 0.3), JSON.stringify(pr));
    check('the relay greets the camera with the legacy "resume" byte (0x01) then the in-band-alarm capability byte (0x02)',
      cam.firstBytes.length >= 2 && cam.firstBytes[0] === 1 && cam.firstBytes[1] === 2, JSON.stringify(cam.firstBytes));

    // ── 2. Alarm: the new recording must START with the pre-roll ────
    r = await post(`/alarm/${CAM}`);
    const pushedAtAlarm = cam.pushed;
    const preFrames = r.body && r.body.preRollFrames;
    check('POST /alarm/:id starts a recording that includes the pre-roll',
      r.status === 200 && r.body.recording === true && r.body.extended === false
        && between(preFrames, NOMINAL_PRE_FRAMES - 6, NOMINAL_PRE_FRAMES + 6),
      JSON.stringify(r));
    check('the pre-roll is the window (~30 frames), not the whole ~45 streamed so far',
      typeof preFrames === 'number' && preFrames < pushedAtAlarm - 5, `pre=${preFrames} pushed=${pushedAtAlarm}`);

    // Keep streaming ~1.5s of "live" footage into the recording.
    await sleep(1500);

    // ── 3. A repeat alarm extends; it must NOT add a second pre-roll ─
    r = await post(`/alarm/${CAM}`);
    check('a repeat alarm extends the running recording and adds no extra pre-roll',
      r.status === 200 && r.body.extended === true && r.body.preRollFrames === 0, JSON.stringify(r));

    // ── 4. Stop, then check the encoded clip ────────────────────────
    r = await post(`/record/${CAM}/stop`);
    const pushedAtStop = cam.pushed;
    check('stopping the recording starts encoding', r.status === 200 && r.body.encoding === true, JSON.stringify(r));

    // ── 5. A recording right after must not repeat the previous clip's footage ─
    await sleep(500); // ~5 frames arrive between the clips
    const pushedBeforeSecond = cam.pushed;
    r = await post(`/alarm/${CAM}`);
    const gapFrames = pushedBeforeSecond - pushedAtStop;
    check('a recording right after another gets only the NEW footage as pre-roll (no overlap with the previous clip)',
      r.status === 200 && between(r.body.preRollFrames, Math.max(0, gapFrames - 3), gapFrames + 3),
      `second pre-roll=${r.body && r.body.preRollFrames}, frames since previous clip ended ≈ ${gapFrames}`);
    await sleep(300);
    await post(`/record/${CAM}/stop`);

    // ── 6. The encoded .mp4 really starts with the pre-roll ─────────
    if (haveTool('ffmpeg') && haveTool('ffprobe')) {
      const dir = path.join(RECORDINGS_DIR, CAM);
      const mp4s = await waitFor(() => {
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).sort() : [];
        return files.length >= 2 ? files : null; // both clips encoded
      }, 20000);
      check('ffmpeg produced an .mp4 for each of the two recordings', !!mp4s, JSON.stringify(fs.existsSync(dir) ? fs.readdirSync(dir) : []));
      if (mp4s) {
        const frames = await waitForFrameCount(path.join(dir, mp4s[0]));
        const expected = preFrames + (pushedAtStop - pushedAtAlarm);
        check('first clip holds the pre-roll frames PLUS the live frames (it starts before the trigger)',
          frames !== null && Math.abs(frames - expected) <= 4 && frames > pushedAtStop - pushedAtAlarm + 20,
          `clip frames=${frames}, expected≈${expected} (pre ${preFrames} + live ${pushedAtStop - pushedAtAlarm})`);
        // make sure the second clip has finished encoding too before the count checks below
        await waitForFrameCount(path.join(dir, mp4s[1]));
      }
    } else {
      console.log('(ffmpeg/ffprobe not installed — skipping the encoded-clip check)');
    }

    // ── 6a. The FILES count shown on the dashboard ───────────────────
    {
      const dir = path.join(RECORDINGS_DIR, CAM);
      const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).length : 0;
      const list = await get(`/recordings/${CAM}`);
      const st = await get('/status');
      const count = st.body && st.body[CAM] && st.body[CAM].recordingCount;
      check('/status reports the camera\'s recording count, equal to the file list and to the files on disk',
        Array.isArray(list.body) && count === list.body.length && count === onDisk,
        `status=${count} list=${Array.isArray(list.body) ? list.body.length : '?'} disk=${onDisk}`);
      if (haveTool('ffmpeg') && haveTool('ffprobe')) {
        check('...and it is the two clips recorded above', count === 2, `count=${count}`);
      }

      // A camera with footage on disk that never connected during this relay run is still counted,
      // and a recording in progress (.tmp_ folder) or a stray file is not.
      const fdir = path.join(RECORDINGS_DIR, CAM_FOLDER);
      fs.mkdirSync(path.join(fdir, '.tmp_2026-01-01T00-00-00-000Z'), { recursive: true });
      for (const n of ['e2e-folder-only_a.mp4', 'e2e-folder-only_b.mp4', 'e2e-folder-only_c.mp4', 'notes.txt']) {
        fs.writeFileSync(path.join(fdir, n), 'x');
      }
      const st2 = await get('/status');
      const fo = st2.body && st2.body[CAM_FOLDER];
      check('a camera that only exists as a folder of footage is listed with its recording count',
        fo && fo.recordingCount === 3 && fo.recording === false && fo.lastSeen === null, JSON.stringify(fo));
      check('...a recording in progress (.tmp_ folder) and other stray files are not counted', fo && fo.recordingCount === 3);

      // Deleting recordings brings the count down on the very next status call.
      const del = await http('DELETE', `/recordings/${CAM_FOLDER}`);
      const st3 = await get('/status');
      check('deleting all recordings drops the count to 0',
        del.status === 200 && st3.body[CAM_FOLDER] && st3.body[CAM_FOLDER].recordingCount === 0, JSON.stringify(st3.body[CAM_FOLDER]));
      const st4 = await get('/status');
      check('a camera with no recordings folder at all reports 0, not "unknown"',
        st4.body[CAM_OFF] === undefined || st4.body[CAM_OFF].recordingCount === 0, JSON.stringify(st4.body[CAM_OFF]));
    }

    cam.stop();
    cam = null;

    // ── 6b. Alarm sent IN-BAND on the push connection (no HTTP request) ──
    // Two streaming cameras for 4.5s so each has a full pre-roll buffer.
    const ib = new FakeCamera(CAM_IB);
    const ib2 = new FakeCamera(CAM_IB2);
    await ib.connect();
    await ib2.connect();
    ib.start();
    ib2.start();
    await sleep(4500);

    const isRecording = async (id) => {
      const st = await get('/status');
      return !!(st.body && st.body[id] && st.body[id].recording);
    };

    ib.sendAlarm(false);
    const ibStarted = await waitFor(() => isRecording(CAM_IB), 2000, 50);
    check('an in-band alarm starts a recording on the sending camera (no HTTP request involved)', !!ibStarted);
    check('...and does not touch another camera', !(await isRecording(CAM_IB2)));
    check('...and the camera\'s frame connection stays open and streaming', ib.isOpen());
    await post(`/record/${CAM_IB}/stop`);

    ib.sendAlarm(true);
    const bothStarted = await waitFor(async () => (await isRecording(CAM_IB)) && (await isRecording(CAM_IB2)), 2000, 50);
    check('an in-band "alarm all" starts a recording on every camera', !!bothStarted);
    await post(`/record/${CAM_IB}/stop`);
    await post(`/record/${CAM_IB2}/stop`);

    if (haveTool('ffmpeg') && haveTool('ffprobe')) {
      // The 2nd camera's clip came from "alarm all" with a full buffer: it must
      // hold ~3s of pre-roll even though the alarm arrived as a message, not a request.
      const dir2 = path.join(RECORDINGS_DIR, CAM_IB2);
      const clips = await waitFor(() => {
        const f = fs.existsSync(dir2) ? fs.readdirSync(dir2).filter((x) => x.endsWith('.mp4')) : [];
        return f.length ? f : null;
      }, 20000);
      const n = clips ? await waitForFrameCount(path.join(dir2, clips[0])) : null;
      check('a recording started by an in-band alarm begins with the pre-roll (clip holds ~3s of earlier footage)',
        n !== null && n >= NOMINAL_PRE_FRAMES - 8, `clip frames=${n}`);
    }
    ib.stop();
    ib2.stop();

    // Unknown control messages are ignored: not recorded as a frame, and the
    // connection survives. (The camera sends no real frame until after.)
    const unk = new FakeCamera(CAM_UNK);
    await unk.connect();
    unk.sendUnknownControl();
    await sleep(400);
    r = await get('/status');
    check('an unknown control message is not mistaken for a frame',
      r.body[CAM_UNK] && r.body[CAM_UNK].preRoll.frames === 0, JSON.stringify(r.body[CAM_UNK]));
    check('...and does not make the relay drop the camera', unk.isOpen());
    unk.pushOne();
    await sleep(300);
    r = await get('/status');
    check('...frames after it are still accepted',
      r.body[CAM_UNK] && r.body[CAM_UNK].preRoll.frames === 1, JSON.stringify(r.body[CAM_UNK]));
    unk.stop();

    // ── 6c. A failure while handling an in-band alarm must not kill the relay ──
    // Make the camera's recordings folder unusable (a FILE where the folder
    // should be), so starting a recording throws inside the raw socket handler.
    const failDir = path.join(RECORDINGS_DIR, CAM_FAIL);
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    removeDir(failDir);
    fs.writeFileSync(failDir, 'not a folder');
    const fail = new FakeCamera(CAM_FAIL);
    await fail.connect();
    fail.start();
    const viewer = openViewer(CAM_FAIL);
    await sleep(1500);
    const framesBefore = viewer.frames;
    check('(setup) a live viewer is receiving the camera\'s frames', framesBefore >= 5, `frames=${framesBefore}`);

    fail.sendAlarm(false); // starting the recording will throw
    await sleep(1200);
    r = await get('/status').catch(() => ({ status: 0 }));
    check('the relay is still alive after an in-band alarm that failed to start a recording', r.status === 200, JSON.stringify(r));
    check('...the camera is still connected', fail.isOpen());
    check('...live viewers keep receiving frames (the stream does not go black)',
      viewer.frames >= framesBefore + 8 && viewer.bad === 0, `before=${framesBefore} after=${viewer.frames} bad=${viewer.bad}`);
    check('...and the error is logged with the camera id, not swallowed silently',
      relay.output().includes(`[${CAM_FAIL}] error handling a alarm`), relay.output());

    removeDir(failDir); // the problem goes away (disk space freed, permissions fixed...)
    fail.sendAlarm(false);
    const recovered = await waitFor(() => isRecording(CAM_FAIL), 3000, 100);
    check('...and the next alarm works as soon as the problem is gone', !!recovered);
    await post(`/record/${CAM_FAIL}/stop`);
    viewer.close();
    fail.stop();

    await stopRelay(relay);

    // ── 7. A bad config value falls back to the default, loudly ─────
    relay = await startRelay(settingsFile, { PREROLL_SECONDS: 'abc' });
    r = await get('/settings');
    check('an unusable preRollSeconds falls back to the default (5s) instead of breaking the relay',
      r.status === 200 && r.body.preRollSeconds === 5, JSON.stringify(r.body));
    check('...and logs a warning naming the bad setting',
      relay.output().includes('[config] preRollSeconds'), relay.output());
    await stopRelay(relay);

    // ── 8. preRollSeconds=0 disables the feature ────────────────────
    relay = await startRelay(settingsFile, { PREROLL_SECONDS: '0' });
    cam = new FakeCamera(CAM_OFF);
    await cam.connect();
    cam.start();
    await sleep(1500);
    r = await get('/status');
    check('with preRollSeconds=0 nothing is buffered',
      r.body[CAM_OFF] && r.body[CAM_OFF].preRoll.frames === 0, JSON.stringify(r.body[CAM_OFF]));
    r = await post(`/alarm/${CAM_OFF}`);
    check('with preRollSeconds=0 a recording starts live, with no pre-roll',
      r.status === 200 && r.body.recording === true && r.body.preRollFrames === 0, JSON.stringify(r));
    await post(`/record/${CAM_OFF}/stop`);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    if (cam) cam.stop();
    await stopRelay(relay);
    clearTimeout(overallTimer);
    cleanup(settingsFile);
    summarize();
  }
}

main();
