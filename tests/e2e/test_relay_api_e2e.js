#!/usr/bin/env node
'use strict';
// test_relay_api_e2e.js — end-to-end check of the relay's remaining HTTP and TCP
// behaviour, against a REAL `server.js` process, real HTTP and real TCP:
//   - the HTTP frame upload (POST /upload/:id, key-protected) and the snapshot it feeds
//   - /record/... input validation, the recording status route and stop
//   - listing, downloading and deleting saved recordings (one file / all), including
//     the refusal of unsafe names
//   - a request the relay cannot even parse ends in a logged 500, not a crash
//   - a camera that sends junk on the push port (an endless "first line", or a
//     corrupt frame length) is disconnected and the relay says why
//   - things that go wrong on the relay's own side are survivable and visible:
//     an unwritable settings file or switch file, ffmpeg missing, ffmpeg failing
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway
// log/settings/switch files in a temp folder. Recordings live in the relay's real
// recordings/ folder (not configurable), so it only touches folders named
// e2e-api-*, and removes the ones it created. Core modules only. Needs ffmpeg
// (like the pre-roll test). Takes about 15 seconds.
//
// Usage:  node tests/e2e/test_relay_api_e2e.js
//         E2E_API_PORT=19330 E2E_API_PUSH_PORT=19331 node tests/e2e/test_relay_api_e2e.js
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
const PORT = Number(process.env.E2E_API_PORT || 19330);
const PUSH_PORT = Number(process.env.E2E_API_PUSH_PORT || 19331);
const CAM_KEY = 'e2e-api-cam-key';
const CONTROL_KEY = 'e2e-api-control-key';
const CAMS = ['e2e-api-cam', 'e2e-api-junk', 'e2e-api-ffmpeg', 'e2e-api-noffmpeg'];

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
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
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

let createdTempConfig = false;
// env: extra/overriding environment for the relay. Uses process.execPath, not "node",
// so a PATH that hides ffmpeg from the relay cannot hide node from this test.
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY, CONTROL_KEY }, env),
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

// An HTTP request returning status, headers, the raw body, and the body parsed as JSON when it is.
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body !== undefined) h['Content-Length'] = body.length;
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (p, opts) => request('POST', p, opts);
const get = (p, opts) => request('GET', p, opts);
const del = (p, opts) => request('DELETE', p, opts);

// A camera on the raw push port: "<id>\t<key>\n" then optionally frames (4-byte big-endian length + payload).
function pushConnect(id, key, preamble) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PUSH_PORT, '127.0.0.1', () => { sock.write(preamble !== undefined ? preamble : `${id}\t${key}\n`); resolve(sock); });
    sock.on('data', () => {}); // read (and ignore) the relay's greeting, or a closed connection is never noticed
    sock.on('error', reject);
  });
}
const frameBytes = (payload) => { const len = Buffer.alloc(4); len.writeUInt32BE(payload.length); return Buffer.concat([len, payload]); };
const waitClosed = (sock, ms) => new Promise((resolve) => {
  if (sock.destroyed) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  sock.on('close', () => { clearTimeout(t); resolve(true); });
  sock.on('error', () => {});
});

const readFile = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not a real picture, but it starts like one'), Buffer.from([0xff, 0xd9])]);

(async () => {
  const preexisting = new Set(CAMS.filter((id) => fs.existsSync(path.join(RECORDINGS_DIR, id))));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-api-'));
  const logFile = path.join(tmp, 'relay.log');
  const common = { LOG_FILE: logFile, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  let relay = null;
  let junkSock = null;

  try {
    // ── 1. HTTP upload and snapshot ───────────────────────────────────
    relay = await startRelay(common);
    const cam = CAMS[0];

    let r = await post(`/upload/${cam}?key=wrong`, { headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
    check('an HTTP frame upload with a wrong key is refused (403)', r.status === 403, `got ${r.status}`);
    r = await get(`/snapshot/${cam}`);
    check('...and nothing was stored: the snapshot does not exist (404)', r.status === 404, `got ${r.status}`);

    r = await post(`/upload/${cam}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
    check('an HTTP frame upload with the camera key is accepted (200)', r.status === 200, `got ${r.status}`);
    r = await get(`/snapshot/${cam}`);
    check('the snapshot is that frame, served as a JPEG', r.status === 200 && /image\/jpeg/.test(r.headers['content-type'] || '') && r.raw.equals(JPEG), `status ${r.status}`);
    r = await get('/snapshot/e2e-api-never-seen');
    check('a snapshot of a camera that never sent anything is 404', r.status === 404, `got ${r.status}`);

    // ── 2. record validation, status, stop ────────────────────────────
    r = await post(`/record/${cam}?seconds=abc`);
    check('/record/:id with seconds that is not a number is refused (400)', r.status === 400 && /seconds must be/.test((r.json || {}).error || ''), `got ${r.status} ${r.text}`);
    r = await post(`/record/${cam}?seconds=0`);
    check('...and so is 0 seconds (400)', r.status === 400, `got ${r.status}`);
    r = await post('/record/all?seconds=abc');
    check('/record/all with seconds that is not a number is refused (400)', r.status === 400 && /seconds must be/.test((r.json || {}).error || ''), `got ${r.status} ${r.text}`);
    r = await get(`/record/${cam}`);
    check('the recording status of an idle camera says so', r.status === 200 && r.json && r.json.recording === false, r.text);
    r = await post(`/record/${cam}/stop`);
    check('stopping when nothing is recording is a 409, not a crash', r.status === 409 && (r.json || {}).error === 'not recording', `got ${r.status} ${r.text}`);

    r = await post(`/record/${cam}?seconds=30`);
    check('a valid /record/:id starts a recording', r.status === 200 && r.json && !r.json.error, `got ${r.status} ${r.text}`);
    r = await get(`/record/${cam}`);
    const st = r.json || {};
    check('the status then shows it: start, end, elapsed and remaining', r.status === 200 && st.recording === true && !!st.startedAt && !!st.endAt && typeof st.elapsed === 'number' && st.remaining > 20 && st.remaining <= 30, r.text);  // elapsed / remaining are in seconds
    r = await post(`/record/${cam}/stop`);
    // The frame uploaded in step 1 sat in the pre-roll buffer, so the recording does hold one frame to encode.
    check('stopping it works, and the recording holds the pre-roll frame, so it is encoded', r.status === 200 && r.json && r.json.recording === false && r.json.encoding === true, `got ${r.status} ${r.text}`);

    // ── 3. listing, downloading and deleting recordings ───────────────
    const dir = path.join(RECORDINGS_DIR, cam);
    fs.mkdirSync(dir, { recursive: true });
    const clipA = `${cam}_0.mp4`, clipB = `${cam}_1.mp4`, clipC = `${cam}_2.mp4`;
    const bytesA = Buffer.from('pretend this is an mp4 (A)');
    fs.writeFileSync(path.join(dir, clipA), bytesA);
    fs.writeFileSync(path.join(dir, clipB), 'B');
    fs.writeFileSync(path.join(dir, clipC), 'C');

    r = await get(`/recordings/${cam}`);
    check('the file list shows the three clips', r.status === 200 && Array.isArray(r.json) && r.json.length === 3, r.text);
    r = await get(`/recordings/${cam}/${clipA}`);
    check('a clip downloads with exactly its bytes', r.status === 200 && r.raw.equals(bytesA), `got ${r.status}`);
    r = await get(`/recordings/${cam}/notes.txt`);
    check('a name that is not a recording is refused (400)', r.status === 400, `got ${r.status}`);
    r = await get(`/recordings/${cam}/${cam}_99.mp4`);
    check('a recording that does not exist is a 404', r.status === 404, `got ${r.status}`);

    r = await del(`/recordings/${cam}/notes.txt`);
    check('deleting a name that is not a recording is refused (400)', r.status === 400, `got ${r.status}`);
    r = await del(`/recordings/${cam}/${cam}_99.mp4`);
    check('deleting a recording that does not exist is a 404', r.status === 404, `got ${r.status}`);
    r = await del(`/recordings/${cam}/${clipA}`);
    check('deleting one clip answers with its name and removes the file', r.status === 200 && (r.json || {}).deleted === clipA && !fs.existsSync(path.join(dir, clipA)), `got ${r.status} ${r.text}`);
    check('...the other clips are untouched', fs.existsSync(path.join(dir, clipB)) && fs.existsSync(path.join(dir, clipC)));
    r = await del(`/recordings/${cam}`);
    check('deleting all lists exactly the remaining clips', r.status === 200 && r.json && Array.isArray(r.json.deleted) && r.json.deleted.length === 2 && r.json.deleted.includes(clipB) && r.json.deleted.includes(clipC), r.text);
    r = await del('/recordings/e2e-api-no-such-camera');
    check('deleting all for a camera with no folder is an empty answer, not an error', r.status === 200 && r.json && r.json.deleted.length === 0, `got ${r.status} ${r.text}`);

    // ── 4. a request the relay cannot parse ───────────────────────────
    r = await get('/snapshot/%E0%A4%A');
    check('a request with a broken %-escape ends in a plain 500', r.status === 500, `got ${r.status}`);
    check('...and the relay logged it as an unhandled error', await waitFor(() => /ERROR .*unhandled error in GET/.test(readFile(logFile)), 3000) !== null);
    r = await get('/status');
    check('...and the relay is still serving', r.status === 200, `got ${r.status}`);

    // ── 5. junk on the push port ──────────────────────────────────────
    junkSock = await pushConnect(null, null, Buffer.alloc(400, 0x41)); // 400 bytes, never a newline
    check('a "first line" that never ends is cut off', await waitClosed(junkSock, 3000));
    check('...and logged as an oversized or malformed first line', await waitFor(() => /rejected a push connection .*oversized or malformed first line/.test(readFile(logFile)), 3000) !== null);

    junkSock = await pushConnect(CAMS[1], CAM_KEY);
    await sleep(200);
    junkSock.write(Buffer.alloc(4, 0)); // a frame length of 0
    check('a camera that sends a corrupt frame length is disconnected', await waitClosed(junkSock, 3000));
    check('...and the relay says the stream was corrupt, naming the camera', await waitFor(() => /WARN .*e2e-api-junk.*dropped the connection/.test(readFile(logFile)), 3000) !== null);

    // ── 6. ffmpeg cannot make a video from the frames ─────────────────
    // (garbage that only looks like JPEG: ffmpeg starts, then refuses it)
    const ff = CAMS[2];
    const sock = await pushConnect(ff, CAM_KEY);
    for (let i = 0; i < 6; i++) { sock.write(frameBytes(JPEG)); await sleep(60); }
    r = await post(`/record/${ff}?seconds=30`);
    for (let i = 0; i < 6; i++) { sock.write(frameBytes(JPEG)); await sleep(60); }
    await post(`/record/${ff}/stop`);
    check('when ffmpeg fails the relay logs the exit code and keeps the raw frames', await waitFor(() => /ERROR .*e2e-api-ffmpeg.*ffmpeg exited with code [1-9]\d*.*raw frames kept/.test(readFile(logFile)), 10000) !== null, readFile(logFile).split('\n').slice(-6).join(' | '));
    sock.destroy();
    await stopRelay(relay); relay = null;

    // ── 7. no ffmpeg on the relay's PATH ──────────────────────────────
    relay = await startRelay(Object.assign({}, common, { PATH: path.join(tmp, 'no-such-bin') }));
    const nf = CAMS[3];
    const sock2 = await pushConnect(nf, CAM_KEY);
    for (let i = 0; i < 5; i++) { sock2.write(frameBytes(JPEG)); await sleep(60); }
    await post(`/record/${nf}?seconds=30`);
    for (let i = 0; i < 5; i++) { sock2.write(frameBytes(JPEG)); await sleep(60); }
    await post(`/record/${nf}/stop`);
    check('with no ffmpeg installed the relay logs that, and keeps the raw frames', await waitFor(() => /ERROR .*e2e-api-noffmpeg.*ffmpeg failed to start.*raw frames kept/.test(readFile(logFile)), 10000) !== null);
    r = await get('/status');
    check('...and the relay keeps running', r.status === 200, `got ${r.status}`);
    sock2.destroy();
    await stopRelay(relay); relay = null;

    // ── 8. the relay's own files are unusable ─────────────────────────
    // A "folder" that is really a file, so nothing can ever be written below it.
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder is needed');
    relay = await startRelay({ LOG_FILE: logFile, SETTINGS_FILE: path.join(blocker, 'settings.json'), SWITCH_FILE: path.join(blocker, 'switch.json') });

    r = await post('/settings?alarmRecordSeconds=15');
    check('saving settings to an unusable file is a 500 with a clear message', r.status === 500 && (r.json || {}).error === 'could not save settings', `got ${r.status} ${r.text}`);
    r = await get('/settings');
    check('...and the setting was NOT changed in memory either (still the default)', r.status === 200 && r.json && r.json.alarmRecordSeconds === 60, r.text);
    check('...and the failure is in the log', await waitFor(() => /ERROR .*failed saving settings/.test(readFile(logFile)), 3000) !== null);

    r = await post(`/recording/camera/${CAMS[0]}/off?minutes=5`, { headers: { 'X-Control-Key': CONTROL_KEY } });
    check('switching recording off still works when its state file cannot be saved', r.status === 200, `got ${r.status} ${r.text}`);
    check('...and the log warns it will be forgotten on restart', await waitFor(() => /ERROR .*could not save the recording switch.*forgotten if the relay restarts/.test(readFile(logFile)), 3000) !== null);
  } catch (err) {
    check('the test ran to the end without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (junkSock) junkSock.destroy();
    await stopRelay(relay);
    for (const id of CAMS) if (!preexisting.has(id)) fs.rmSync(path.join(RECORDINGS_DIR, id), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  }
  summarize();
})();
