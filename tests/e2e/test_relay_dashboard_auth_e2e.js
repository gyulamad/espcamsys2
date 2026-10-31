#!/usr/bin/env node
'use strict';
// test_relay_dashboard_auth_e2e.js — end-to-end check that what only the dashboard does needs the relay's
// CONTROL key (security review finding R-03), against a REAL `server.js` process, real HTTP:
//   - POST /settings, POST /record/:id, POST /record/all, POST /record/:id/stop, DELETE /recordings/:id,
//     DELETE /recordings/:id/:filename and POST /recordings/:id/:filename/seen are refused (401) with no key,
//     a wrong key, an empty key, the CAMERA key (as X-Control-Key and as X-Api-Key) and the control key in
//     the query string — and a refused request changes nothing (settings, clips, seen flags, recordings);
//   - with the control key they work, and who did it (X-Actor) is logged;
//   - with NO controlKey configured they answer 503 (closed, not open), even to an empty key;
//   - what stays open stays open: GET /settings, GET /status, GET /record/:id, GET /recordings/..., and
//     POST /alarm/:id and /alarm/all (the camera boards' keyless HTTP fallback cannot send a key);
//   - refusals are logged, and neither key ever appears in the log.
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway log/settings/switch files in a
// temp folder. Recordings live in the relay's real recordings/ folder (not configurable), so it only touches
// the folder e2e-dauth-cam and removes it. Core modules only. Takes about 5 seconds.
//
// Usage:  node tests/e2e/test_relay_dashboard_auth_e2e.js
//         E2E_DASHAUTH_PORT=19392 E2E_DASHAUTH_PUSH_PORT=19393 node tests/e2e/test_relay_dashboard_auth_e2e.js
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
const PORT = Number(process.env.E2E_DASHAUTH_PORT || 19392);
const PUSH_PORT = Number(process.env.E2E_DASHAUTH_PUSH_PORT || 19393);
const CAM_KEY = 'e2e-dauth-cam-key';
const CONTROL_KEY = 'e2e-dauth-control-key';
const CAM = 'e2e-dauth-cam';

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

const WRONG_KEY = 'e2e-dauth-a-wrong-key';
const CAM_DIR = path.join(RECORDINGS_DIR, CAM);
const clip = (name) => path.join(CAM_DIR, name);
const withKey = (key, extra) => ({ headers: Object.assign({ 'X-Control-Key': key }, extra) });
const settingsOf = async () => (await get('/settings')).json;

(async () => {
  const preexisting = fs.existsSync(CAM_DIR);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-dauth-'));
  const logFile = path.join(tmp, 'relay.log');
  const files = { LOG_FILE: logFile, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  const seed = () => {
    fs.mkdirSync(CAM_DIR, { recursive: true });
    for (const n of ['clip1.mp4', 'clip2.mp4']) fs.writeFileSync(clip(n), 'clip ' + n);
  };
  const clips = () => (fs.existsSync(CAM_DIR) ? fs.readdirSync(CAM_DIR).filter((n) => n.endsWith('.mp4')).sort().join(',') : '');
  const notRecording = async () => (await get(`/record/${CAM}`)).json.recording === false;
  let relay = null;

  try {
    relay = await startRelay(files);
    seed();

    // ── 1. refused without the right key, and nothing changes ─────────
    const refusals = [
      ['no key at all', {}],
      ['a wrong key', withKey(WRONG_KEY)],
      ['an empty key', withKey('')],
      ['the CAMERA key as X-Control-Key', withKey(CAM_KEY)],
      ['the CAMERA key as X-Api-Key', { headers: { 'X-Api-Key': CAM_KEY } }],
    ];
    const guarded = [
      ['POST', '/settings?alarmRecordSeconds=5'],
      ['POST', `/record/${CAM}?seconds=5`],
      ['POST', '/record/all?seconds=5'],
      ['POST', `/record/${CAM}/stop`],
      ['DELETE', `/recordings/${CAM}`],
      ['DELETE', `/recordings/${CAM}/clip1.mp4`],
      ['POST', `/recordings/${CAM}/clip1.mp4/seen`],
    ];
    for (const [method, url] of guarded) {
      for (const [what, opts] of refusals) {
        const r = await request(method, url, opts);
        check(`${method} ${url.split('?')[0].replace(CAM, '<cam>')} with ${what} is refused (401)`, r.status === 401, `got ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    let r = await request('DELETE', `/recordings/${CAM}/clip1.mp4?key=${CONTROL_KEY}`);
    check('the control key in the query string does not count (401)', r.status === 401, `got ${r.status}`);
    r = await request('POST', `/settings?alarmRecordSeconds=5&key=${CONTROL_KEY}`);
    check('...not for POST /settings either (401)', r.status === 401, `got ${r.status}`);

    check('after all those refusals no clip was deleted', clips() === 'clip1.mp4,clip2.mp4', clips());
    check('...the alarm length setting is unchanged (60)', (await settingsOf()).alarmRecordSeconds === 60);
    check('...no recording was started', await notRecording());
    r = await get(`/recordings/${CAM}`);
    check('...and no clip was marked as seen', r.status === 200 && r.json.length === 2 && r.json.every((c) => c.seen === false), r.text);

    // ── 2. the log: who was refused, never a key ──────────────────────
    check('the refusals are in the log', await waitFor(() => /WARN .*REJECTED (POST|DELETE) .*missing or wrong control key/.test(readFile(logFile)), 3000) !== null);
    const log1 = readFile(logFile);
    check('...and neither the control key, the camera key nor the wrong key ever appears in the log', !log1.includes(CONTROL_KEY) && !log1.includes(CAM_KEY) && !log1.includes(WRONG_KEY));

    // ── 3. what stays open stays open ─────────────────────────────────
    r = await get('/settings');
    check('GET /settings is still open (200)', r.status === 200 && r.json && r.json.alarmRecordSeconds === 60, `got ${r.status}`);
    check('GET /status is still open (200)', (await get('/status')).status === 200);
    check('GET /record/<id> is still open (200)', (await get(`/record/${CAM}`)).status === 200);
    r = await get(`/recordings/${CAM}`);
    check('GET /recordings/<id> is still open (200)', r.status === 200 && r.json.length === 2, `got ${r.status}`);
    r = await get(`/recordings/${CAM}/clip1.mp4`);
    check('downloading a clip is still open (200)', r.status === 200 && r.text === 'clip clip1.mp4', `got ${r.status}`);
    r = await post(`/alarm/${CAM}`);
    check('POST /alarm/<id> is still open: the boards\' HTTP fallback sends no key (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await post('/alarm/all');
    check('POST /alarm/all is still open (200)', r.status === 200, `got ${r.status}`);

    // ── 4. with the control key everything works ──────────────────────
    const actor = { 'X-Actor': 'alice@192.0.2.7' };
    r = await post(`/record/${CAM}/stop`, withKey(CONTROL_KEY, actor));
    check('with the control key, stopping the alarm recording started above works (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await post(`/record/${CAM}?seconds=5`, withKey(CONTROL_KEY, actor));
    check('...starting a recording works (200)', r.status === 200 && r.json && r.json.recording === true, `got ${r.status} ${r.text.slice(0, 80)}`);
    r = await post('/record/all?seconds=5', withKey(CONTROL_KEY, actor));
    check('...record/all works (200)', r.status === 200, `got ${r.status}`);
    r = await post(`/record/${CAM}/stop`, withKey(CONTROL_KEY, actor));
    check('...stopping it works (200)', r.status === 200, `got ${r.status}`);
    r = await post('/settings?alarmRecordSeconds=45', withKey(CONTROL_KEY, actor));
    check('...changing the alarm length works, and the new value is returned', r.status === 200 && r.json && r.json.alarmRecordSeconds === 45, `got ${r.status} ${r.text.slice(0, 80)}`);
    check('...and it stuck', (await settingsOf()).alarmRecordSeconds === 45);
    r = await post(`/recordings/${CAM}/clip1.mp4/seen`, withKey(CONTROL_KEY, actor));
    check('...marking a clip seen works (200)', r.status === 200, `got ${r.status}`);
    r = await get(`/recordings/${CAM}`);
    check('...and it shows as seen', r.json.find((c) => c.filename === 'clip1.mp4').seen === true && r.json.find((c) => c.filename === 'clip2.mp4').seen === false, r.text);
    r = await del(`/recordings/${CAM}/clip1.mp4`, withKey(CONTROL_KEY, actor));
    check('...deleting one clip works, and only that clip is gone', r.status === 200 && clips() === 'clip2.mp4', `got ${r.status} ${clips()}`);
    seed();
    r = await del(`/recordings/${CAM}`, withKey(CONTROL_KEY, actor));
    check('...deleting all of a camera\'s clips works', r.status === 200 && clips() === '', `got ${r.status} ${clips()}`);
    check('who changed the settings is in the log', await waitFor(() => /settings changed by alice@192\.0\.2\.7/.test(readFile(logFile)), 3000) !== null);
    check('who deleted the clips is in the log', await waitFor(() => /clip1\.mp4 deleted by alice@192\.0\.2\.7/.test(readFile(logFile)) && /recording\(s\) of e2e-dauth-cam deleted by alice@192\.0\.2\.7/.test(readFile(logFile)), 3000) !== null);
    check('...and still no key in the log', !readFile(logFile).includes(CONTROL_KEY));
    await stopRelay(relay); relay = null;

    // ── 5. no controlKey configured: closed, not open ─────────────────
    relay = await startRelay(Object.assign({ CONTROL_KEY: '' }, files));
    seed();
    const sBefore = (await settingsOf()).alarmRecordSeconds;
    for (const [method, url] of guarded) {
      for (const [what, opts] of [['no key', {}], ['an empty key', withKey('')], ['a made-up key', withKey(WRONG_KEY)]]) {
        const res = await request(method, url, opts);
        check(`with no controlKey set, ${method} ${url.split('?')[0].replace(CAM, '<cam>')} with ${what} answers 503`, res.status === 503 && /controlKey/.test(res.text), `got ${res.status} ${res.text.slice(0, 80)}`);
      }
    }
    check('...and nothing changed: clips are all there', clips() === 'clip1.mp4,clip2.mp4', clips());
    check('...the setting is unchanged', (await settingsOf()).alarmRecordSeconds === sBefore);
    check('...nothing is recording', await notRecording());
    r = await post(`/alarm/${CAM}`);
    check('...and the open routes still work (alarm 200)', r.status === 200, `got ${r.status}`);
    check('the relay is still up, with no ERROR in its log', (await get('/status')).status === 200 && !/ ERROR /.test(readFile(logFile)));
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
