#!/usr/bin/env node
'use strict';
// test_relay_upload_auth_e2e.js — end-to-end check that POST /upload/:id (the legacy HTTP frame upload) checks the
// camera key BEFORE it reads the body (security review findings R-05 and R-06), against a REAL `server.js`:
//   - a 3 MB body with a wrong or missing key is refused with 403 — not a 500 with a "PayloadTooLargeError" stack
//     trace in the log (what the review reproduced) — and the refusal is one WARN line, not an ERROR;
//   - a wrong key (prefix of the real one, longer, an array, the control key) is a 403 and registers no camera;
//   - with the camera key (?key= or X-Api-Key) a picture is accepted (200) and is what /snapshot then returns;
//   - with the camera key, an oversized body is a clear 413 and an empty body a 400 — neither stores anything;
//   - only POST is an upload route (a GET is not answered 403 by a blanket key check).
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway log/settings/switch files in a
// temp folder; uploads only touch the in-memory camera e2e-upload-cam. Core modules only. About 3 seconds.
//
// Usage:  node tests/e2e/test_relay_upload_auth_e2e.js
//         E2E_UPLOAD_PORT=19394 E2E_UPLOAD_PUSH_PORT=19395 node tests/e2e/test_relay_upload_auth_e2e.js
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
const PORT = Number(process.env.E2E_UPLOAD_PORT || 19394);
const PUSH_PORT = Number(process.env.E2E_UPLOAD_PUSH_PORT || 19395);
const CAM_KEY = 'e2e-upload-cam-key';
const CONTROL_KEY = 'e2e-upload-control-key';
const CAM = 'e2e-upload-cam';

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

const MB = 1024 * 1024;
const BIG = Buffer.alloc(3 * MB, 0x41);
const JPEG_HEADERS = { 'Content-Type': 'image/jpeg' };
const readLog = () => readFile(logFile_);
let logFile_ = '';

// An upload whose answer may never be read: a server that refuses early may close the connection while the
// client is still sending a big body. The status is 0 then (and `error` says why) — the log tells the rest.
function upload(urlPath, { headers = JPEG_HEADERS, body = JPEG } = {}) {
  return request('POST', urlPath, { headers, body }).catch((e) => ({ status: 0, error: String(e && e.code || e), text: '', json: null }));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-upload-'));
  logFile_ = path.join(tmp, 'relay.log');
  const files = { LOG_FILE: logFile_, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  let relay = null;
  const known = async () => Object.keys((await get('/status')).json || {}).filter((id) => id.startsWith('e2e-upload-'));
  const noTraceInLog = () => !/PayloadTooLarge|at .*node_modules|\sERROR\s/.test(readLog());

  try {
    relay = await startRelay(files);

    // ── 1. refused BEFORE the body is read ────────────────────────────
    let r = await upload(`/upload/${CAM}?key=wrong`, { body: BIG });
    check('a 3 MB body with a WRONG key is refused with 403 (not 500, not 413)', r.status === 403 || r.status === 0, `got ${r.status} ${r.error || r.text.slice(0, 80)}`);
    if (r.status === 0) console.log(`      (the relay closed the connection while the client was still sending: ${r.error} — also a refusal)`);
    r = await upload(`/upload/${CAM}`, { body: BIG });
    check('...and with NO key at all', r.status === 403 || r.status === 0, `got ${r.status} ${r.error || r.text.slice(0, 80)}`);
    check('the refusals are WARN lines in the log', await waitFor(() => /WARN .*rejected a POST \/upload .*missing or wrong key/.test(readLog()), 3000) !== null);
    check('...and there is no PayloadTooLargeError, stack trace or ERROR line in the log (the body parser never ran)', noTraceInLog(), readLog().split('\n').filter((l) => /PayloadTooLarge|ERROR/.test(l)).slice(0, 2).join(' | '));
    check('...and neither key appears in the log', !readLog().includes(CAM_KEY) && !readLog().includes(CONTROL_KEY));
    check('...and no camera was registered by any of it', (await known()).length === 0, (await known()).join(','));

    // ── 2. other wrong keys, small bodies ─────────────────────────────
    const wrong = [
      ['a prefix of the real key', CAM_KEY.slice(0, -1)],
      ['the real key plus one character', CAM_KEY + 'x'],
      ['an empty key', ''],
      ['the CONTROL key (only for dashboard actions)', CONTROL_KEY],
    ];
    for (const [what, key] of wrong) {
      r = await upload(`/upload/${CAM}?key=${encodeURIComponent(key)}`);
      check(`${what} is refused (403)`, r.status === 403, `got ${r.status}`);
    }
    r = await upload(`/upload/${CAM}?key=${CAM_KEY}&key=${CAM_KEY}`);
    check('the key given twice (an array in the query) is refused (403), not a crash (500)', r.status === 403, `got ${r.status}`);
    r = await upload(`/upload/${CAM}`, { headers: Object.assign({ 'X-Api-Key': 'wrong' }, JPEG_HEADERS) });
    check('a wrong X-Api-Key is refused (403)', r.status === 403, `got ${r.status}`);
    check('...and none of those registered a camera', (await known()).length === 0);

    // ── 3. the right key still works ──────────────────────────────────
    r = await upload(`/upload/${CAM}?key=${CAM_KEY}`);
    check('?key=<camera key> uploads a picture (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);
    const second = Buffer.concat([JPEG, Buffer.from('second')]);
    r = await upload(`/upload/${CAM}`, { headers: Object.assign({ 'X-Api-Key': CAM_KEY }, JPEG_HEADERS), body: second });
    check('X-Api-Key: <camera key> uploads a picture too (200)', r.status === 200, `got ${r.status}`);
    r = await get(`/snapshot/${CAM}`);
    check('...and /snapshot returns exactly the last picture sent', r.status === 200 && Buffer.compare(r.raw, second) === 0, `got ${r.status}, ${r.raw && r.raw.length} bytes`);
    check('...and the camera is now known', (await known()).join(',') === CAM);

    // ── 4. with the right key: oversized and empty bodies ─────────────
    r = await upload(`/upload/${CAM}?key=${CAM_KEY}`, { body: BIG });
    check('a 3 MB body WITH the right key is a clear 413 (JSON, not an HTML error page)', r.status === 413 && r.json && /too large/.test(r.json.error), `got ${r.status} ${r.error || r.text.slice(0, 80)}`);
    r = await upload(`/upload/${CAM}?key=${CAM_KEY}`, { body: Buffer.alloc(0) });
    check('an empty body WITH the right key is a 400, not a stored "picture"', r.status === 400, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await get(`/snapshot/${CAM}`);
    check('...and neither replaced the last picture', r.status === 200 && Buffer.compare(r.raw, second) === 0);
    check('...and the log still has no stack trace or ERROR', noTraceInLog(), readLog().split('\n').filter((l) => /PayloadTooLarge|ERROR/.test(l)).slice(0, 2).join(' | '));

    // ── 5. only POST is an upload ─────────────────────────────────────
    r = await get(`/upload/${CAM}`);
    check('GET /upload/<id> is a 404, as before (not a blanket 403)', r.status === 404, `got ${r.status}`);
    check('the relay is still up', (await get('/status')).status === 200);
  } catch (err) {
    check('the test ran to the end without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    await stopRelay(relay);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  }
  summarize();
})();
