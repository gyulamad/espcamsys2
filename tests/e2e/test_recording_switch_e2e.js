#!/usr/bin/env node
'use strict';
// test_recording_switch_e2e.js — end-to-end check of the recording ON/OFF
// switch against a REAL `server.js`, real HTTP, real TCP "cameras", and the
// real state file and log file on disk.
//
// The switch exists so that nothing records while people are at the
// surveilled place. This checks that:
//   - changing it needs the CONTROL key (X-Control-Key) — no key / wrong key /
//     the key in the URL are all refused and logged with the sender's address;
//     with no controlKey configured it is refused outright, never left open
//   - while a camera is OFF NOTHING can start a recording, by any route: HTTP
//     alarm, in-band alarm (what the camera board really sends), the RECORD
//     button, RECORD ALL — and a recording already running is stopped
//   - cameras are independent; "all cameras" sets every camera the relay knows
//     (not ones it hasn't seen), after which each can be changed alone
//   - minutes default to 60, 0 or negative means "until switched ON", junk is
//     rejected
//   - the state survives a relay restart (timed OFF as an absolute end time),
//     a timer that runs out while the relay is down is honoured, and a damaged
//     state file means everything RECORDS
//   - a timer ending switches the camera back ON by itself
//   - footage a camera streamed while OFF can never end up in a recording
//     afterwards (the rolling pre-roll buffer is not a back door)
//   - every change is written to the log, with who did it
//
// Independent client, own ports, throwaway state/log/settings files in a temp
// folder, only touches recordings/ folders of its own camera ids. Takes about
// 30 seconds (real time). Core modules only.
//
// Usage:  node tests/e2e/test_recording_switch_e2e.js
//         E2E_SWITCH_PORT=19320 E2E_SWITCH_PUSH_PORT=19321 node ...
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const RECORDINGS_DIR = path.join(RELAY_DIR, 'recordings');
const JPEG = fs.readFileSync(path.join(RELAY_DIR, 'testimage.jpg'));
const PORT = Number(process.env.E2E_SWITCH_PORT || 19320);
const PUSH_PORT = Number(process.env.E2E_SWITCH_PUSH_PORT || 19321);
const CAM_KEY = 'e2e-cam-key';
const CONTROL_KEY = 'e2e-control-key-different-from-the-camera-key';
const WRONG_KEY = 'a-guessed-key-that-must-never-appear-in-the-log';

const A = 'e2e-sw-a', B = 'e2e-sw-b', C = 'e2e-sw-c', D = 'e2e-sw-d', LATE = 'e2e-sw-late';
const TEST_CAMS = [A, B, C, D, LATE];
const MIN = 60000;

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY, PREROLL_SECONDS: '3' }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve({ child, output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 5s:\n${out}`)); } }, 5000).unref();
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

function request(method, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: Object.assign({ 'Content-Length': 0 }, headers) }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}
const get = (p) => request('GET', p);
const post = (p) => request('POST', p);
const ctl = (p, extra) => request('POST', p, { headers: Object.assign({ 'X-Control-Key': CONTROL_KEY }, extra) });
const camOff = (id, q = '', extra) => ctl(`/recording/camera/${id}/off${q}`, extra);
const camOn = (id, extra) => ctl(`/recording/camera/${id}/on`, extra);

// A fake camera on the raw push port. It streams at ~10 fps once started and can send the in-band alarm.
class FakeCamera {
  constructor(id) { this.id = id; this.pushed = 0; this.timer = null; this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(PUSH_PORT, '127.0.0.1', () => { this.socket.write(`${this.id}\t${CAM_KEY}\n`); resolve(); });
      this.socket.on('data', () => {});
      this.socket.on('error', reject);
    });
  }
  start() {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(JPEG.length, 0);
    const frame = Buffer.concat([header, JPEG]);
    this.timer = setInterval(() => { if (!this.socket.destroyed) { this.socket.write(frame); this.pushed += 1; } }, 100);
  }
  sendAlarm() { this.socket.write(Buffer.from([0, 0, 0, 2, 0x00, 0x01])); }
  stop() { clearInterval(this.timer); if (this.socket) this.socket.destroy(); }
}

async function waitFor(fn, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}
const readFile = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
// The relay writes its log asynchronously, so a line may land a moment AFTER the
// request that caused it has been answered: wait for it instead of reading once.
let LOG_FILE_PATH = '';
const logMatches = async (re, timeoutMs = 2500) => !!(await waitFor(() => re.test(readFile(LOG_FILE_PATH)), timeoutMs, 50));
const statusOf = async (id) => { const r = await get('/status'); return r.json && r.json[id]; };
const isRecording = async (id) => { const s = await statusOf(id); return !!(s && s.recording); };

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    summarize();
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-switch-'));
  const files = { SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: path.join(tmp, 'relay.log'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  LOG_FILE_PATH = files.LOG_FILE;
  const preexisting = new Set(TEST_CAMS.filter((id) => fs.existsSync(path.join(RECORDINGS_DIR, id))));
  const cams = {};
  let relay;
  const startCam = async (id) => { const c = new FakeCamera(id); await c.connect(); c.start(); cams[id] = c; return c; };
  const stopCams = () => { for (const id of Object.keys(cams)) { cams[id].stop(); delete cams[id]; } };
  try {
    // ── 1. reading is open, changing needs the key ──────────────────
    relay = await startRelay(Object.assign({ CONTROL_KEY }, files));
    let r = await get('/recording/state');
    check('GET /recording/state needs no key and starts empty', r.status === 200 && JSON.stringify(r.json.off) === '{}' && r.json.controlEnabled === true && r.json.defaultMinutes === 60, JSON.stringify(r));

    await startCam(A); await startCam(B); await startCam(C); await startCam(D);
    await sleep(300);

    r = await post(`/recording/camera/${A}/off`);
    check('switching OFF without a key is refused (401)', r.status === 401, JSON.stringify(r));
    r = await request('POST', `/recording/camera/${A}/off`, { headers: { 'X-Control-Key': WRONG_KEY } });
    check('switching OFF with a wrong key is refused (401)', r.status === 401, JSON.stringify(r));
    r = await request('POST', `/recording/camera/${A}/off?key=${CONTROL_KEY}`);
    check('the key in the URL is NOT accepted (it would end up in logs and history)', r.status === 401, JSON.stringify(r));
    r = await request('POST', `/recording/camera/${A}/off`, { headers: { 'X-Api-Key': CAM_KEY } });
    check('the CAMERA key does not open it (a stolen camera board must not be able to switch the system off)', r.status === 401, JSON.stringify(r));
    r = await request('POST', '/recording/all/off', { headers: { 'X-Control-Key': WRONG_KEY } });
    check('the all-cameras button is protected the same way', r.status === 401);
    r = await request('POST', `/recording/camera/${A}/on`);
    check('switching ON needs the key too', r.status === 401);
    check('nothing changed after all those refusals', JSON.stringify((await get('/recording/state')).json.off) === '{}');
    check('refusals are logged with the sender\'s address', await logMatches(/REJECTED a recording on\/off request from 127\.0\.0\.1/));
    const log1 = readFile(files.LOG_FILE);
    check('...once, not once per attempt (six requests were refused above)',
      (log1.match(/REJECTED a recording on\/off request from 127\.0\.0\.1/g) || []).length === 1, log1);
    check('...and the keys themselves are never written to the log', !log1.includes(CONTROL_KEY) && !log1.includes(WRONG_KEY));

    // ── 2. validation ───────────────────────────────────────────────
    r = await camOff(A, '?minutes=abc');
    check('minutes that is not a number is rejected (400)', r.status === 400 && r.json && r.json.error, JSON.stringify(r));
    r = await camOff(A, '?minutes=1.5');
    check('a fractional number of minutes is rejected (400)', r.status === 400);
    r = await camOff(A, '?minutes=99999999');
    check('an absurdly large number of minutes is rejected, pointing at "forever" (400)', r.status === 400 && /0/.test(r.json.error), JSON.stringify(r));
    r = await camOff('bad%20id');
    check('an unsafe camera id is rejected (400)', r.status === 400, JSON.stringify(r));
    check('rejected requests changed nothing', JSON.stringify((await get('/recording/state')).json.off) === '{}');

    // ── 3. minutes semantics ────────────────────────────────────────
    r = await camOff(A);
    check('no minutes given -> the 60-minute default', r.status === 200 && r.json.forever === false && r.json.minutes === 60 && between(r.json.off[A].remainingMs, 59 * MIN, 60 * MIN), JSON.stringify(r));
    r = await camOff(A, '?minutes=1');
    check('minutes=1 -> OFF for one minute', between(r.json.off[A].remainingMs, 55000, 60000) && r.json.forever === false, JSON.stringify(r.json));
    r = await camOff(A, '?minutes=0');
    check('0 -> OFF until switched ON (no end, no countdown)', r.json.forever === true && r.json.off[A].until === null && r.json.off[A].remainingMs === null, JSON.stringify(r.json));
    r = await camOff(A, '?minutes=-15');
    check('a negative number -> OFF until switched ON as well', r.json.forever === true, JSON.stringify(r.json));

    // ── 4. while OFF, nothing can start a recording ─────────────────
    const stA = await statusOf(A);
    check('/status shows the camera as OFF, and the others as not', stA.recordingOff && stA.recordingOff.forever === true && (await statusOf(B)).recordingOff === null, JSON.stringify(stA.recordingOff));
    r = await post(`/alarm/${A}`);
    check('HTTP alarm on an OFF camera: answered 200 (the camera did nothing wrong), but suppressed', r.status === 200 && r.json.suppressed === true && r.json.recording === false && r.json.reason === 'off', JSON.stringify(r));
    r = await post(`/record/${A}?seconds=5`);
    check('the RECORD button on an OFF camera is answered 409 with a clear message', r.status === 409 && r.json.suppressed === true && /OFF/.test(r.json.error), JSON.stringify(r));
    cams[A].sendAlarm();
    await sleep(500);
    check('the in-band alarm a camera board really sends starts nothing either', !(await isRecording(A)));
    r = await post('/record/all?seconds=5');
    const resA = r.json.cameras.find((c) => c.id === A);
    const resB = r.json.cameras.find((c) => c.id === B);
    check('RECORD ALL skips the OFF camera and still records the others',
      r.status === 200 && resA && resA.suppressed === true && resB && resB.recording === true && !resB.suppressed, JSON.stringify(r.json));
    await post(`/record/all/stop`).catch(() => {});
    for (const id of [B, C, D]) await post(`/record/${id}/stop`);
    check('the OFF camera never recorded', !(await isRecording(A)));
    check('ignored requests are logged (once a minute, not per request)', await logMatches(/recording request ignored — recording is switched OFF for this camera/));
    check('...once, not once per ignored request (several were made above)', (readFile(files.LOG_FILE).match(/recording request ignored — recording is switched OFF for this camera/g) || []).length === 1);

    // ── 5. cameras are independent; ON restores one ─────────────────
    r = await post(`/alarm/${B}`);
    check('another camera records normally while this one is OFF', r.json.recording === true && !r.json.suppressed, JSON.stringify(r.json));
    await post(`/record/${B}/stop`);
    r = await camOn(A);
    check('switching ON works and says so', r.status === 200 && r.json.off[A] === null && r.json.affected[0] === A, JSON.stringify(r.json));
    r = await post(`/alarm/${A}`);
    check('the camera records again after switching ON', r.json.recording === true, JSON.stringify(r.json));

    // ── 6. switching OFF stops a recording that is running ──────────
    check('(setup) the camera is recording', await isRecording(A));
    r = await camOff(A, '?minutes=0');
    check('switching OFF stops the running recording', !(await isRecording(A)), JSON.stringify(await statusOf(A)));
    check('...and that is in the log (the clip so far is kept, not discarded)', await logMatches(/recording stopped \(\d+ frames/));
    await camOn(A);

    // ── 7. the all-cameras button ───────────────────────────────────
    r = await ctl('/recording/all/off?minutes=0');
    check('"all cameras OFF" sets every camera the relay knows', r.status === 200 && [A, B, C, D].every((id) => r.json.affected.includes(id)) && [A, B, C, D].every((id) => r.json.off[id] && r.json.off[id].forever), JSON.stringify(r.json));
    for (const id of [A, B, C, D]) cams[id].sendAlarm();
    await sleep(500);
    check('none of them records while all are OFF', (await Promise.all([A, B, C, D].map(isRecording))).every((x) => x === false));
    await startCam(LATE);
    await sleep(300);
    r = await post(`/alarm/${LATE}`);
    check('a camera the relay had not seen yet is NOT affected by an earlier "all OFF"', r.json.recording === true, JSON.stringify(r.json));
    await post(`/record/${LATE}/stop`);
    r = await camOn(C);
    check('after "all OFF", ONE camera can be switched ON alone', r.json.off[C] === null);
    check('...and the others stay OFF', (await statusOf(A)).recordingOff !== null && (await statusOf(B)).recordingOff !== null && (await statusOf(C)).recordingOff === null);
    r = await post(`/alarm/${C}`);
    check('...the one switched ON records', r.json.recording === true);
    await post(`/record/${C}/stop`);
    r = await ctl('/recording/all/on');
    check('"all cameras ON" switches every camera back', r.status === 200 && JSON.stringify((await get('/recording/state')).json.off) === '{}');
    r = await post(`/alarm/${A}`);
    check('and they record again', r.json.recording === true);
    await post(`/record/${A}/stop`);

    // ── 8. the log says who did what ────────────────────────────────
    await camOff(D, '?minutes=30', { 'X-Actor': 'alice' });
    await camOn(D, { 'X-Actor': 'alice' });
    check('every change is logged with who made it (the dashboard passes the logged-in user)',
      (await logMatches(/recording switched OFF until \S+ by alice \(via 127\.0\.0\.1\)/)) && (await logMatches(/recording switched ON by alice \(via 127\.0\.0\.1\)/)), readFile(files.LOG_FILE).slice(-700));

    // ── 9. footage from the OFF period never leaks into a clip ──────
    await camOff(C, '?minutes=0');
    await sleep(4000);   // C keeps streaming for 4 s while OFF (~40 frames; its buffer holds the last 3 s)
    await camOn(C);
    r = await post(`/alarm/${C}`);
    const leaked = r.json.preRollFrames;
    await post(`/record/${C}/stop`);
    r = await post(`/alarm/${B}`);   // B was never OFF during that time: its buffer holds a full 3 s
    const normal = r.json.preRollFrames;
    await post(`/record/${B}/stop`);
    check('right after switching ON, the recording contains NO footage from the OFF period (pre-roll starts afterwards)', typeof leaked === 'number' && leaked <= 3, `leaked=${leaked}`);
    check('...while a camera that was never OFF still gets its full pre-roll (so this check is not vacuous)', between(normal, 24, 36), `normal=${normal}`);

    // ── 10. restart keeps the state ─────────────────────────────────
    await camOff(A, '?minutes=0');
    await camOff(B, '?minutes=30');
    stopCams();
    await stopRelay(relay);
    const saved = JSON.parse(readFile(files.SWITCH_FILE));
    check('the state is saved to a file: forever as null, timed as an absolute end time',
      saved.cameras[A] && saved.cameras[A].until === null && saved.cameras[B] && between(saved.cameras[B].until, Date.now() + 29 * MIN, Date.now() + 30 * MIN), JSON.stringify(saved));
    check('...and ONLY cameras that are OFF are in it', Object.keys(saved.cameras).sort().join() === [A, B].sort().join(), JSON.stringify(saved));
    relay = await startRelay(Object.assign({ CONTROL_KEY }, files));
    r = await get('/recording/state');
    check('after a relay restart both cameras are still OFF',
      r.json.off[A] && r.json.off[A].forever === true && r.json.off[B] && between(r.json.off[B].remainingMs, 28 * MIN, 30 * MIN), JSON.stringify(r.json));
    check('...and the restart says so in the log', await logMatches(/recording is switched OFF \(restored from .*\) for: .*e2e-sw-a until it is switched back ON/));
    r = await post(`/alarm/${A}`);
    check('...and it still blocks recording', r.json.suppressed === true);
    await camOn(A); await camOn(B);
    await stopRelay(relay);
    check('switching ON is saved too: the file is empty again', Object.keys(JSON.parse(readFile(files.SWITCH_FILE)).cameras).length === 0);

    // ── 11. a timer that ends ───────────────────────────────────────
    fs.writeFileSync(files.SWITCH_FILE, JSON.stringify({ v: 1, cameras: { [A]: { until: Date.now() + 2500 }, [B]: { until: Date.now() - 1000 }, [C]: { until: null } } }));
    relay = await startRelay(Object.assign({ CONTROL_KEY }, files));
    await startCam(A); await startCam(B); await startCam(C);
    r = await get('/recording/state');
    check('a timed OFF with time left is restored; one that ran out while the relay was down is not; forever is',
      r.json.off[A] && !r.json.off[B] && r.json.off[C] && r.json.off[C].forever, JSON.stringify(r.json));
    check('...and the one that ran out while the relay was stopped is reported in the log', await logMatches(/recording for e2e-sw-b was switched OFF for a limited time, which ran out while the relay was stopped/));
    r = await post(`/alarm/${A}`);
    check('while its timer still runs, the camera does not record', r.json.suppressed === true);
    const timerEnded = await waitFor(async () => !(await get('/recording/state')).json.off[A], 5000);
    check('when the timer runs out the camera switches itself back ON', !!timerEnded);
    check('...and logs it', await logMatches(/recording switched back ON automatically/));
    r = await post(`/alarm/${A}`);
    check('...and records again', r.json.recording === true && !r.json.suppressed, JSON.stringify(r.json));
    check('...with a pre-roll that starts when the timer ended, not before (A streamed ~3 s while it was OFF)', typeof r.json.preRollFrames === 'number' && r.json.preRollFrames <= 14, `pre-roll=${r.json.preRollFrames}`);
    await post(`/record/${A}/stop`);
    check('the expiry was saved: the file no longer lists A', !('cameras' in JSON.parse(readFile(files.SWITCH_FILE))) || !JSON.parse(readFile(files.SWITCH_FILE)).cameras[A]);
    stopCams();
    await stopRelay(relay);

    // ── 12. a damaged state file means everything records ───────────
    fs.writeFileSync(files.SWITCH_FILE, '{ this is not json');
    relay = await startRelay(Object.assign({ CONTROL_KEY }, files));
    r = await get('/recording/state');
    check('a damaged state file: the relay starts and EVERY camera records', r.status === 200 && JSON.stringify(r.json.off) === '{}', JSON.stringify(r));
    check('...and warns about it', await logMatches(/the recording-switch file is not valid JSON/));
    r = await post(`/alarm/${A}`);
    check('...recording works', r.json.recording === true);
    await post(`/record/${A}/stop`);
    await stopRelay(relay);

    // ── 13. no controlKey configured: refused, never open ───────────
    relay = await startRelay(Object.assign({ CONTROL_KEY: '' }, files));
    r = await ctl(`/recording/camera/${A}/off`);
    check('with no controlKey configured, switching is refused (503) rather than left open', r.status === 503 && /controlKey/.test(r.json.error), JSON.stringify(r));
    r = await request('POST', `/recording/camera/${A}/off`, { headers: { 'X-Control-Key': '' } });
    check('...an EMPTY key does not match an empty setting either', r.status === 503, JSON.stringify(r));
    r = await get('/recording/state');
    check('...reading still works and says control is disabled', r.status === 200 && r.json.controlEnabled === false);
    r = await post(`/alarm/${A}`);
    check('...and recording is unaffected', r.json.recording === true);
    check('the relay says at startup that the switch is disabled', await logMatches(/recording on\/off switch DISABLED/));
    await post(`/record/${A}/stop`);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    stopCams();
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    for (const id of TEST_CAMS) if (!preexisting.has(id)) fs.rmSync(path.join(RECORDINGS_DIR, id), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
