#!/usr/bin/env node
'use strict';
// test_relay_read_auth_e2e.js — end-to-end check that what the cameras SEE needs the control key (security review
// follow-up R-08: live video, snapshots, recordings and the lists were readable by anyone who could reach port 8080),
// against a REAL `server.js` process, real HTTP:
//   - GET /stream, /snapshot, /status, /settings, /detectors, /detector/<id>/stream, /record/<id>, /recordings/<id>,
//     /recordings/<id>/<file> and /recording/state answer 401 with no key, a wrong key, an empty key, the CAMERA key
//     (as X-Control-Key and as X-Api-Key) and the control key in the query string — and say NOTHING about the
//     cameras: no picture bytes, no file names, no camera ids, in the refusal;
//   - with the control key every one of them answers, and answers with the real thing (the exact picture, the exact
//     recording bytes, the list, the live stream's first frame);
//   - what the boards use stays as it was: POST /alarm (keyless fallback), POST /upload and the push port with the
//     camera key, GET /device-settings with the camera key;
//   - with NO controlKey configured the reads are let through (nothing to check against), the relay says so in its
//     log at startup, and what changes things is still refused (503);
//   - refusals are WARN lines in the log, throttled, and never contain a key.
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway files in a temp folder; recordings
// live in the relay's real recordings/ folder, so it only touches the folder e2e-readauth-cam and removes it.
// Core modules only. About 5 seconds.
//
// Usage:  node tests/e2e/test_relay_read_auth_e2e.js
//         E2E_READAUTH_PORT=19398 E2E_READAUTH_PUSH_PORT=19399 node tests/e2e/test_relay_read_auth_e2e.js
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
const PORT = Number(process.env.E2E_READAUTH_PORT || 19398);
const PUSH_PORT = Number(process.env.E2E_READAUTH_PUSH_PORT || 19399);
const CAM_KEY = 'e2e-readauth-cam-key';
const CONTROL_KEY = 'e2e-readauth-control-key';
const CAM = 'e2e-readauth-cam';

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

const PICTURE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('the-exact-picture-bytes-0123456789'), Buffer.from([0xff, 0xd9])]);
const CLIP = 'cam-readauth-20260101-000000.mp4';
const CLIP_BYTES = Buffer.from('the exact bytes of a recording');
const CAM_DIR = path.join(RECORDINGS_DIR, CAM);
const DET = 'e2e-readauth-det';
const WRONG = 'e2e-readauth-a-wrong-key';
const readLog = () => readFile(logFile_);
// ERROR lines, except the encoder's: the POST /alarm above starts a recording, and a machine without ffmpeg says so
const errorLines = () => readLog().split('\n').filter((l) => / ERROR /.test(l) && !/ffmpeg/.test(l));
let logFile_ = '';
const withKey = (key) => ({ headers: { 'X-Control-Key': key } });

// A live stream: resolves to { status, type, body } once the first part has arrived (or { status } at once on a refusal).
function readStream(urlPath, headers) {
  return new Promise((resolve) => {
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}${urlPath}`, { headers }, (res) => {
      if (res.statusCode !== 200) { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: t })); return; }
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).includes(PICTURE)) { req.destroy(); resolve({ status: 200, type: res.headers['content-type'], body: Buffer.concat(chunks) }); } });
    });
    req.on('error', () => {});
    setTimeout(() => { req.destroy(); resolve({ status: 0 }); }, 4000);
  });
}

(async () => {
  const preexisting = fs.existsSync(CAM_DIR);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-readauth-'));
  logFile_ = path.join(tmp, 'relay.log');
  const files = { LOG_FILE: logFile_, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json'), AUTH_MAX_FAILURES: '100000' };
  let relay = null;

  // every read route, what it must answer to the key, and what a refusal must NOT contain
  const reads = [
    ['/stream/' + CAM, null],
    ['/snapshot/' + CAM, null],
    ['/status', null],
    ['/settings', null],
    ['/detectors', null],
    ['/detector/' + DET + '/stream', null],
    ['/record/' + CAM, null],
    ['/recordings/' + CAM, null],
    ['/recordings/' + CAM + '/' + CLIP, null],
    ['/recording/state', null],
  ];
  const isStream = (u) => /^\/(stream\/|detector\/[^/]+\/stream)/.test(u);
  const ask = (u, headers) => (isStream(u) ? readStream(u, headers).then((r) => ({ status: r.status, text: String(r.body || ''), headers: {} })) : request('GET', u, { headers }));
  const leaks = (text) => PICTURE.toString('latin1').slice(4, 20) && (text.includes('the-exact-picture') || text.includes(CLIP) || text.includes(CAM) || text.includes('the exact bytes') || text.includes('alarmRecordSeconds') || text.includes('"off"'));

  try {
    relay = await startRelay(files);
    fs.mkdirSync(CAM_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAM_DIR, CLIP), CLIP_BYTES);
    let r = await request('POST', `/upload/${CAM}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: PICTURE });
    check('(setup) the camera uploads a picture with the camera key', r.status === 200, `got ${r.status}`);

    // ── 1. refused, and silent about what is behind it ────────────────
    const refusals = [
      ['no key at all', {}],
      ['a wrong key', { 'X-Control-Key': WRONG }],
      ['an empty key', { 'X-Control-Key': '' }],
      ['the CAMERA key as X-Control-Key', { 'X-Control-Key': CAM_KEY }],
      ['the CAMERA key as X-Api-Key', { 'X-Api-Key': CAM_KEY }],
    ];
    for (const [u] of reads) {
      for (const [what, headers] of refusals) {
        r = await ask(u, headers);
        check(`GET ${u.replace(CAM, '<cam>').replace(CLIP, '<clip>').replace(DET, '<det>')} with ${what} is refused (401)`, r.status === 401 && !leaks(r.text) && /missing or wrong control key/.test(r.text), `got ${r.status} ${r.text.slice(0, 100)}`);
      }
      r = await ask(`${u}${u.includes('?') ? '&' : '?'}key=${CONTROL_KEY}`, {});
      check(`...and the control key in the query string does not count (401)`, r.status === 401 && !leaks(r.text), `got ${r.status}`);
    }
    check('the refusals are WARN lines in the log', await waitFor(() => /WARN .*REJECTED GET .* missing or wrong control key/.test(readLog()), 3000) !== null);
    check('...and no key is in the log', !readLog().includes(CONTROL_KEY) && !readLog().includes(CAM_KEY) && !readLog().includes(WRONG));

    // ── 2. with the key: the real thing ───────────────────────────────
    r = await request('GET', '/snapshot/' + CAM, withKey(CONTROL_KEY));
    check('with the control key /snapshot is exactly the picture the camera sent', r.status === 200 && Buffer.compare(r.raw, PICTURE) === 0, `got ${r.status}, ${r.raw && r.raw.length} bytes`);
    r = await request('GET', '/status', withKey(CONTROL_KEY));
    check('/status lists the camera', r.status === 200 && r.json && r.json[CAM] !== undefined, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await request('GET', '/settings', withKey(CONTROL_KEY));
    check('/settings answers', r.status === 200 && r.json && Number.isInteger(r.json.alarmRecordSeconds), `got ${r.status}`);
    r = await request('GET', '/detectors', withKey(CONTROL_KEY));
    check('/detectors answers', r.status === 200, `got ${r.status}`);
    r = await request('GET', '/record/' + CAM, withKey(CONTROL_KEY));
    check('/record/<cam> says whether it is recording', r.status === 200 && r.json && r.json.recording === false, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await request('GET', '/recording/state', withKey(CONTROL_KEY));
    check('/recording/state answers', r.status === 200 && r.json && r.json.off !== undefined, `got ${r.status}`);
    r = await request('GET', '/recordings/' + CAM, withKey(CONTROL_KEY));
    check('/recordings/<cam> lists the clip', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.filename === CLIP), `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await request('GET', '/recordings/' + CAM + '/' + CLIP, withKey(CONTROL_KEY));
    check('...and the clip downloads byte for byte', r.status === 200 && Buffer.compare(r.raw, CLIP_BYTES) === 0, `got ${r.status}`);
    r = await request('GET', '/recordings/' + CAM + '/' + CLIP, { headers: { 'X-Control-Key': CONTROL_KEY, Range: 'bytes=4-8' } });
    check('...and a ranged request still works with the key (206, the right bytes)', r.status === 206 && r.raw.toString() === CLIP_BYTES.slice(4, 9).toString(), `got ${r.status} ${r.raw && r.raw.toString()}`);
    const live = readStream('/stream/' + CAM, { 'X-Control-Key': CONTROL_KEY });
    await sleep(200);
    await request('POST', `/upload/${CAM}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: PICTURE });
    const lr = await live;
    check('the live stream, with the key, delivers the camera\'s frame as multipart video', lr.status === 200 && /multipart\/x-mixed-replace/.test(lr.type || '') && Buffer.from(lr.body).includes(PICTURE), `status=${lr.status} type=${lr.type}`);
    r = await readStream('/stream/' + CAM, {});
    check('the same live stream without the key is a 401, not a stream', r.status === 401, `got ${r.status}`);

    // ── 3. what the boards use is unchanged ───────────────────────────
    r = await request('POST', `/alarm/${CAM}`);
    check('POST /alarm/<id> is still keyless (the boards\' HTTP fallback, 200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await request('POST', `/record/${CAM}/stop`, withKey(CONTROL_KEY));
    check('(and what it started can be stopped with the key)', r.status === 200, `got ${r.status}`);
    r = await request('POST', `/upload/${CAM}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: PICTURE });
    check('POST /upload with the camera key still works (200)', r.status === 200, `got ${r.status}`);
    const push = await pushConnect(CAM, CAM_KEY);
    check('the push port with the camera key still accepts the camera', !(await waitClosed(push, 700)));
    push.destroy();
    r = await request('GET', '/device-settings/recorder/' + CAM, { headers: { 'X-Api-Key': CAM_KEY } });
    check('GET /device-settings with the camera key is still answered by the camera-key check (not 401)', r.status !== 401, `got ${r.status}`);
    r = await request('GET', '/ota/recorder/version?id=' + CAM, { headers: { 'X-Api-Key': CAM_KEY } });
    check('GET /ota/.../version with the camera key is not refused as a read (not 401)', r.status !== 401, `got ${r.status}`);
    await stopRelay(relay); relay = null;

    // ── 4. no controlKey configured ───────────────────────────────────
    relay = await startRelay(Object.assign({ CONTROL_KEY: '' }, files));
    for (const [u] of reads.filter(([x]) => !isStream(x))) {
      r = await request('GET', u);
      check(`with no controlKey set, GET ${u.replace(CAM, '<cam>').replace(CLIP, '<clip>')} is let through (not 401)`, r.status !== 401 && r.status !== 503, `got ${r.status}`);
    }
    r = await readStream('/stream/' + CAM, {});
    check('...and so is the live stream (it is a stream, not a refusal)', r.status === 200 || r.status === 0, `got ${r.status}`);
    check('the relay says at startup that reads are open because no controlKey is set', await waitFor(() => /WARN .*controlKey is not set: live video, snapshots, recordings/.test(readLog()), 3000) !== null);
    r = await request('DELETE', `/recordings/${CAM}/${CLIP}`);
    check('...but what CHANGES things is still refused (503), and the clip is still there', r.status === 503 && fs.existsSync(path.join(CAM_DIR, CLIP)), `got ${r.status}`);
    check('the relay is still up, with no ERROR in its log', (await request('GET', '/status')).status === 200 && !errorLines().length, errorLines().slice(0, 2).join(' | '));
  } catch (err) {
    check('the test ran to the end without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    await stopRelay(relay);
    if (!preexisting) fs.rmSync(CAM_DIR, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  }
  summarize();
})();
