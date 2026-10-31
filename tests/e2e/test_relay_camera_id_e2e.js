#!/usr/bin/env node
'use strict';
// test_relay_camera_id_e2e.js — end-to-end check that a camera id can never be used to leave the
// relay's recordings folder or to grow its memory without bound, against a REAL `server.js`
// process, real HTTP and real TCP (security review findings R-01 and R-02):
//   - R-01: Express percent-decodes a route segment AFTER matching it, so an id like
//     ..%2F..%2Ftmp%2Fx arrives as a real "../..". Every route that takes an :id (list, download,
//     delete, mark-seen, record, stop, alarm) must refuse it with 400 and touch nothing outside the
//     recordings folder: a decoy folder in the temp dir must keep its file, and gain no new folder.
//   - ids that are not plain ("..", ".x", "-x") are refused too; ordinary ids still work end to end.
//   - a camera that authenticates on the push port with a traversal id is disconnected, and the
//     relay stays up.
//   - R-02: the relay remembers at most 64 distinct camera ids; the 65th is refused (503) on every
//     way in (live stream, alarm, record, push), cameras it already knows keep working, and
//     read-only routes (GET /record/:id, stop) never register a camera.
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway log/settings/switch
// files and a decoy folder in a temp directory. Recordings live in the relay's real recordings/
// folder (not configurable), so it only touches folders named e2e-camid-*, and removes them.
// Core modules only. Takes about 5 seconds.
//
// Usage:  node tests/e2e/test_relay_camera_id_e2e.js
//         E2E_CAMID_PORT=19390 E2E_CAMID_PUSH_PORT=19391 node tests/e2e/test_relay_camera_id_e2e.js
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
const PORT = Number(process.env.E2E_CAMID_PORT || 19390);
const PUSH_PORT = Number(process.env.E2E_CAMID_PUSH_PORT || 19391);
const CAM_KEY = 'e2e-camid-cam-key';
const CONTROL_KEY = 'e2e-camid-control-key';
const OK_CAM = 'e2e-camid-ok';
const MAX_CAMERAS = 64; // the relay's cap on distinct camera ids (server.js)

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
// The routes only the dashboard uses need the control key (review R-03). Added here for those routes alone, so a
// test that wants to be REFUSED sends its own headers ({ noKey: true } sends none).
const needsDashboardKey = (method, p) => (method === 'POST' && /^\/(record\/|settings)/.test(p)) || ((method === 'DELETE' || method === 'POST') && /^\/recordings\//.test(p));
function request(method, urlPath, { headers = {}, body, noKey = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, !noKey && needsDashboardKey(method, urlPath) ? { 'X-Control-Key': CONTROL_KEY } : {}, headers);
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


// Opens a live stream and hangs up. Resolves to the HTTP status. An accepted stream sends no headers until
// the camera's first frame, so "no answer for 300 ms" means it was accepted (200); a refusal (400/503) is
// answered at once.
function openStream(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); req.destroy(); resolve(v); } };
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/stream/${id}`, (res) => finish(res.statusCode));
    const timer = setTimeout(() => finish(200), 300);
    req.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
// /status is an object keyed by camera id (cameras the relay knows PLUS folders found on disk). The ids
// this test uses all start with e2e-camid-, so counting those counts what the test registered.
const statusIds = async () => Object.keys((await get('/status')).json || {});
const ourIds = async () => (await statusIds()).filter((id) => id.startsWith('e2e-camid-'));

(async () => {
  const preexisting = fs.existsSync(path.join(RECORDINGS_DIR, OK_CAM));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-camid-'));
  const logFile = path.join(tmp, 'relay.log');
  const common = { LOG_FILE: logFile, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  let relay = null;
  const socks = [];

  // The decoy: a folder OUTSIDE the recordings folder that holds a clip the relay must never reach.
  const decoy = path.join(tmp, 'decoy');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'marker_file.mp4'), 'decoy clip');
  const traversal = encodeURIComponent(path.relative(RECORDINGS_DIR, decoy)); // ..%2F..%2F...%2Fdecoy
  const decoyUntouched = () => {
    const names = fs.readdirSync(decoy);
    return names.length === 1 && names[0] === 'marker_file.mp4' && fs.readFileSync(path.join(decoy, 'marker_file.mp4'), 'utf8') === 'decoy clip';
  };

  try {
    relay = await startRelay(common);

    // ── 1. R-01: every route refuses a percent-encoded traversal id ───
    check('the test is really sending a traversal id', /^\.\.%2F/.test(traversal), traversal);
    const attacks = [
      ['GET', `/recordings/${traversal}`],
      ['DELETE', `/recordings/${traversal}`],
      ['GET', `/recordings/${traversal}/marker_file.mp4`],
      ['DELETE', `/recordings/${traversal}/marker_file.mp4`],
      ['POST', `/recordings/${traversal}/marker_file.mp4/seen`],
      ['POST', `/record/${traversal}?seconds=60`],
      ['POST', `/record/${traversal}/stop`],
      ['GET', `/record/${traversal}`],
      ['POST', `/alarm/${traversal}`],
      ['GET', `/stream/${traversal}`],
      ['GET', `/snapshot/${traversal}`],
    ];
    for (const [method, url] of attacks) {
      const r = method === 'GET' && url.startsWith('/stream/') ? { status: await openStream(traversal) } : await request(method, url);
      check(`${method} ${url.replace(traversal, '<traversal>')} is refused (400)`, r.status === 400, `got ${r.status}`);
    }
    check('...and the decoy folder outside the recordings folder is untouched (no clip lost, nothing created)', decoyUntouched(), fs.readdirSync(decoy).join(','));
    check('...and the relay is still up', (await get('/status')).status === 200);

    // ── 2. ids that are not plain ids ─────────────────────────────────
    for (const id of ['..%2F', '%2E%2E%2F', '.hidden', '-x', '_x', 'a%20b', `${'a'.repeat(65)}`]) {
      const r = await get(`/recordings/${id}`);
      check(`GET /recordings/${id.length > 20 ? id.slice(0, 8) + '...' : id} is refused (400)`, r.status === 400, `got ${r.status}`);
    }
    check('a folder named like the id in the recordings folder was not created for any of them', !fs.existsSync(path.join(RECORDINGS_DIR, '.hidden')) && !fs.existsSync(path.join(RECORDINGS_DIR, '-x')));

    // ── 3. ordinary ids still work end to end ─────────────────────────
    let r = await get(`/recordings/${OK_CAM}`);
    check('listing the recordings of an ordinary camera id works (200, empty list)', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `got ${r.status} ${r.text}`);
    fs.mkdirSync(path.join(RECORDINGS_DIR, OK_CAM), { recursive: true });
    fs.writeFileSync(path.join(RECORDINGS_DIR, OK_CAM, 'clip.mp4'), 'real clip');
    r = await get(`/recordings/${OK_CAM}/clip.mp4`);
    check('downloading one of its clips works', r.status === 200 && r.text === 'real clip', `got ${r.status}`);
    r = await post(`/recordings/${OK_CAM}/clip.mp4/seen`);
    check('marking it seen works', r.status === 200, `got ${r.status}`);
    r = await del(`/recordings/${OK_CAM}/clip.mp4`);
    check('deleting it works, and the file is gone', r.status === 200 && !fs.existsSync(path.join(RECORDINGS_DIR, OK_CAM, 'clip.mp4')), `got ${r.status}`);
    r = await post(`/alarm/${OK_CAM}`);
    check('an alarm for an ordinary camera id is accepted (200)', r.status === 200, `got ${r.status} ${r.text}`);
    r = await post(`/record/${OK_CAM}/stop`);
    check('...and the recording it started can be stopped', r.status === 200, `got ${r.status} ${r.text}`);

    // ── 4. read-only routes never register a camera ───────────────────
    const before = (await statusIds()).sort().join(',');
    r = await get('/record/e2e-camid-never-seen');
    check('GET /record/<unknown camera> says "not recording" (200)', r.status === 200 && r.json && r.json.recording === false, `got ${r.status} ${r.text}`);
    r = await post('/record/e2e-camid-never-seen/stop');
    check('POST /record/<unknown camera>/stop says "not recording" (409)', r.status === 409, `got ${r.status}`);
    r = await get('/record/constructor');
    check('an id that is also an Object.prototype member ("constructor") is just an unknown camera (200, not recording)', r.status === 200 && r.json && r.json.recording === false, `got ${r.status} ${r.text}`);
    r = await post('/record/constructor/stop');
    check('...and stopping it is a 409, not a crash', r.status === 409, `got ${r.status}`);
    check('none of that registered a camera', (await statusIds()).sort().join(',') === before, `${before} -> ${(await statusIds()).sort().join(',')}`);

    // ── 5. a push connection with a traversal id ──────────────────────
    for (const badId of ['../../tmp/e2e-camid-x', '..', '.hidden']) {
      const sock = await pushConnect(null, null, `${badId}\t${CAM_KEY}\n`);
      socks.push(sock);
      check(`a push connection with the RIGHT key but the id "${badId}" is disconnected`, await waitClosed(sock, 3000));
    }
    check('...and the relay logs why', await waitFor(() => /rejected a push connection .*invalid camera id/.test(readFile(logFile)), 3000) !== null);
    check('...and the relay is still up', (await get('/status')).status === 200);
    const good = await pushConnect(OK_CAM, CAM_KEY);
    socks.push(good);
    check('a push connection with an ordinary id is still accepted (stays open)', !(await waitClosed(good, 700)));

    // ── 6. R-02: the cap on distinct camera ids ───────────────────────
    const known = 1; // OK_CAM, which the alarm and the push connection above registered; nothing else (checked next)
    check('the only camera the relay knows before the flood is the ordinary one', (await ourIds()).join(',') === OK_CAM, (await ourIds()).join(','));
    const statuses = await Promise.all(Array.from({ length: MAX_CAMERAS - known + 3 }, (_, i) => openStream(`e2e-camid-flood-${i}`)));
    const accepted = statuses.filter((s) => s === 200).length;
    const refused = statuses.filter((s) => s === 503).length;
    check(`only as many new ids as fit under the cap are accepted (${MAX_CAMERAS - known})`, accepted === MAX_CAMERAS - known, `accepted ${accepted}, refused ${refused}`);
    check('...and every one beyond it is refused with 503', refused === 3 && accepted + refused === statuses.length, JSON.stringify(statuses));
    check(`/status shows exactly ${MAX_CAMERAS} cameras, not one per request`, (await ourIds()).length === MAX_CAMERAS, String((await ourIds()).length));
    r = await post('/alarm/e2e-camid-one-too-many');
    check('an alarm for a NEW id is refused with 503 once the cap is reached', r.status === 503, `got ${r.status}`);
    check('...and it created no recordings folder', !fs.existsSync(path.join(RECORDINGS_DIR, 'e2e-camid-one-too-many')));
    r = await post('/record/e2e-camid-one-too-many?seconds=5');
    check('a record request for a NEW id is refused with 503', r.status === 503, `got ${r.status}`);
    r = await post(`/upload/e2e-camid-one-too-many?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
    check('an authenticated HTTP upload for a NEW id is refused too (503)', r.status === 503, `got ${r.status}`);
    const extra = await pushConnect('e2e-camid-one-too-many', CAM_KEY);
    socks.push(extra);
    check('a push connection for a NEW id is disconnected', await waitClosed(extra, 3000));
    check('...and the relay logs the refusal', await waitFor(() => /already knows 64 cameras/.test(readFile(logFile)), 3000) !== null);
    r = await post(`/alarm/${OK_CAM}`);
    check('a camera the relay already knows still works at the cap (alarm 200)', r.status === 200, `got ${r.status}`);
    check('...and can still stream', (await openStream(OK_CAM)) === 200);
    const again = await pushConnect(OK_CAM, CAM_KEY);
    socks.push(again);
    check('...and can still connect on the push port', !(await waitClosed(again, 700)));
    check('the relay is still up, with no ERROR in its log from any of this', (await get('/status')).status === 200 && !/ ERROR /.test(readFile(logFile)), readFile(logFile).split('\n').filter((l) => / ERROR /.test(l)).slice(0, 2).join(' | '));
    check('the decoy folder is still untouched at the end', decoyUntouched());
  } catch (err) {
    check('the test ran to the end without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    for (const s of socks) s.destroy();
    await stopRelay(relay);
    if (!preexisting) fs.rmSync(path.join(RECORDINGS_DIR, OK_CAM), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  }
  summarize();
})();
