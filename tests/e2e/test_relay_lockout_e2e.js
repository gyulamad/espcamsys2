#!/usr/bin/env node
'use strict';
// test_relay_lockout_e2e.js — end-to-end check that guessing a key gets slower and then impossible, and that the
// relay's folder settings cannot be pointed outside its own folder (security review finding R-04), against a REAL
// `server.js` process:
//   - wrong camera keys: the first 5 are plain 401/403s, from the 6th on the address is locked out (429 with
//     Retry-After) — on EVERY route that takes the camera key, on the TCP push port and on the detector uplink —
//     and even the RIGHT key is refused while the lock lasts; 200 guesses in a row yield exactly 5 real answers;
//   - the control key is counted on its own: locking out the camera key does not lock the dashboard's actions;
//   - a request with no key at all is not a guess and never locks anyone out;
//   - a spoofed X-Forwarded-For does not get around it; the lock ends on time, and the next one is twice as long;
//   - one "LOCKED OUT" line per lock in the log, never a key;
//   - POST /system-settings refuses a folder/file setting that points outside the relay's folder (absolute path,
//     "..", the relay's own code, a hidden folder) and changes nothing; a path inside it is saved. (logFile and
//     switchFile are covered by tests/node/test_sysconfig.js: this test sets them from the environment, which
//     makes them unchangeable here.)
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway log/settings/switch/system-settings
// files in a temp folder, the lockout set to 5 failures / 2 s so it runs in about 20 seconds. Core modules only.
//
// Usage:  node tests/e2e/test_relay_lockout_e2e.js
//         E2E_LOCKOUT_PORT=19396 E2E_LOCKOUT_PUSH_PORT=19397 node tests/e2e/test_relay_lockout_e2e.js
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
const PORT = Number(process.env.E2E_LOCKOUT_PORT || 19396);
const PUSH_PORT = Number(process.env.E2E_LOCKOUT_PUSH_PORT || 19397);
const CAM_KEY = 'e2e-lockout-cam-key';
const CONTROL_KEY = 'e2e-lockout-control-key';
const CAM = 'e2e-lockout-cam';

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

const FAILS = 5;          // AUTH_MAX_FAILURES below
const LOCK_S = 2;         // AUTH_LOCK_SECONDS below: the first lock; the second is twice as long
const WRONG = 'e2e-lockout-a-wrong-key';
const JPEG_BODY = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('picture'), Buffer.from([0xff, 0xd9])]);
const readLog = () => readFile(logFile_);
let logFile_ = '';

const camLog = (key, extra) => request('POST', '/log', { headers: Object.assign({ 'Content-Type': 'application/json', 'X-Api-Key': key }, extra), body: Buffer.from(JSON.stringify({ camera: 'cam9', fw: 'x', attempt: 0, dropped: 0, entries: [{ seq: 1, level: 'INFO', ageMs: 0, uptimeMs: 1, message: 'hello' }] })) });
const ctlSettings = (key, extra) => request('POST', '/settings?alarmRecordSeconds=60', { headers: Object.assign({ 'X-Control-Key': key }, extra) });
const sysSet = (values) => request('POST', '/system-settings', { headers: { 'Content-Type': 'application/json', 'X-Control-Key': CONTROL_KEY }, body: Buffer.from(JSON.stringify(values)) });
const sysView = async () => Object.fromEntries(((await get('/system-settings', { headers: { 'X-Control-Key': CONTROL_KEY } })).json.fields || []).map((f) => [f.key, f.value]));

// A detector's uplink request, as raw HTTP over TCP; resolves to the status line's number (0 if cut off).
function uplink(key) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET /detector/e2e-lockout-det/uplink HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: espcam-detector/1\r\nX-Api-Key: ${key}\r\n\r\n`));
    let got = '';
    s.on('data', (d) => { got += d.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(got); if (m) { s.destroy(); resolve(Number(m[1])); } });
    s.on('error', () => resolve(0));
    s.on('close', () => resolve(/^HTTP\/1\.1 (\d{3})/.test(got) ? Number(/^HTTP\/1\.1 (\d{3})/.exec(got)[1]) : 0));
    setTimeout(() => { s.destroy(); resolve(0); }, 3000);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relay-lockout-'));
  logFile_ = path.join(tmp, 'relay.log');
  const files = {
    LOG_FILE: logFile_, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json'),
    SYSTEM_SETTINGS_FILE: path.join(tmp, 'system-settings.json'),
    AUTH_MAX_FAILURES: String(FAILS), AUTH_LOCK_SECONDS: String(LOCK_S), AUTH_LOCK_MAX_SECONDS: '8',
  };
  let relay = null;
  const socks = [];

  try {
    relay = await startRelay(files);

    // ── 1. a request with no key is not a guess ───────────────────────
    let r;
    for (let i = 0; i < 25; i += 1) r = await request('POST', '/log', { headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}') });
    check('25 requests without any key are all plain refusals (401), never a lockout', r.status === 401, `last was ${r.status}`);
    r = await camLog(CAM_KEY);
    check('...and the right key still works right after them (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);

    // ── 2. wrong camera keys ──────────────────────────────────────────
    const first = [];
    for (let i = 0; i < FAILS; i += 1) first.push((await camLog(WRONG)).status);
    check(`the first ${FAILS} wrong camera keys are ordinary refusals (401)`, first.every((s) => s === 401), first.join(','));
    r = await camLog(WRONG);
    check('the next one is locked out: 429', r.status === 429, `got ${r.status}`);
    const retry = Number(r.headers['retry-after']);
    check(`...with a Retry-After of about ${LOCK_S} s and a clear message`, retry >= 1 && retry <= LOCK_S && /locked out/.test((r.json || {}).error || ''), `retry-after=${r.headers['retry-after']} ${r.text.slice(0, 100)}`);
    r = await camLog(CAM_KEY);
    check('...and so is the RIGHT camera key while the lock lasts (429)', r.status === 429, `got ${r.status}`);
    r = await camLog(CAM_KEY, { 'X-Forwarded-For': '203.0.113.99' });
    check('...a spoofed X-Forwarded-For does not get around it (429)', r.status === 429, `got ${r.status}`);
    r = await request('POST', '/log', { headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}') });
    check('...a request with no key from a locked address is refused too (429)', r.status === 429, `got ${r.status}`);

    // every route that takes the camera key, the push port and the detector uplink
    r = await request('POST', `/upload/${CAM}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: JPEG_BODY });
    check('the HTTP upload with the right key is locked out too (429)', r.status === 429, `got ${r.status}`);
    r = await get('/device-settings/recorder/e2e-lockout-cam/change', { headers: { 'X-Api-Key': CAM_KEY } });
    check('...and the device-settings route (429)', r.status === 429, `got ${r.status}`);
    r = await get('/ota/recorder/version?id=e2e-lockout-cam', { headers: { 'X-Api-Key': CAM_KEY } });
    check('...and the firmware route (429)', r.status === 429, `got ${r.status}`);
    const lockedPush = await pushConnect(CAM, CAM_KEY);
    socks.push(lockedPush);
    check('...a push connection with the right key is dropped', await waitClosed(lockedPush, 3000));
    check('...a detector uplink with the right key is answered 429', (await uplink(CAM_KEY)) === 429);

    // ── 3. the control key is counted on its own ──────────────────────
    r = await ctlSettings(CONTROL_KEY);
    check('while the camera key is locked out, the dashboard\'s control key still works (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);

    // ── 4. logging ────────────────────────────────────────────────────
    check('one "LOCKED OUT" line says who, how long and why', await waitFor(() => /WARN .*LOCKED OUT .* for 2 s after 5 wrong camera keys/.test(readLog()), 3000) !== null);
    check('...exactly one for this lock, however many requests followed', (readLog().match(/LOCKED OUT/g) || []).length === 1, String((readLog().match(/LOCKED OUT/g) || []).length));
    check('...and no key is ever in the log', !readLog().includes(CAM_KEY) && !readLog().includes(CONTROL_KEY) && !readLog().includes(WRONG));

    // ── 5. the lock ends, and the next one is twice as long ───────────
    await sleep(LOCK_S * 1000 + 300);
    r = await camLog(WRONG);
    check(`after ${LOCK_S} s the address may try again (a wrong key is a 401 again, not a 429)`, r.status === 401, `got ${r.status}`);
    for (let i = 1; i < FAILS; i += 1) await camLog(WRONG);
    r = await camLog(WRONG);
    check('five more wrong keys without a right one in between lock it again (429)', r.status === 429, `got ${r.status}`);
    const retry2 = Number(r.headers['retry-after']);
    check(`...this time for about ${LOCK_S * 2} s: twice as long`, retry2 > LOCK_S && retry2 <= LOCK_S * 2, `retry-after=${r.headers['retry-after']}`);
    await sleep(LOCK_S * 1000 + 300);
    r = await camLog(CAM_KEY);
    check(`...and it is still locked after the FIRST lock's length (the right key: 429)`, r.status === 429, `got ${r.status}`);
    await sleep(LOCK_S * 1000);
    r = await camLog(CAM_KEY);
    check('...and open again when the longer lock is over: the right key works (200)', r.status === 200, `got ${r.status} ${r.text.slice(0, 80)}`);

    // ── 6. guessing in a loop gets 5 real answers and nothing more ────
    let real = 0; let refused = 0;
    for (let i = 0; i < 200; i += 1) { const s = (await camLog(`${WRONG}-${i}`)).status; if (s === 401) real += 1; else if (s === 429) refused += 1; }
    check('200 wrong keys in a row: exactly 5 get a real answer, all the others are locked out', real === FAILS && refused === 200 - FAILS, `real=${real} refused=${refused}`);
    await sleep(LOCK_S * 4 * 1000 + 500);

    // ── 7. the control key ────────────────────────────────────────────
    const ctl = [];
    for (let i = 0; i < FAILS; i += 1) ctl.push((await ctlSettings(WRONG)).status);
    check(`the first ${FAILS} wrong control keys are ordinary refusals (401)`, ctl.every((s) => s === 401), ctl.join(','));
    r = await ctlSettings(WRONG);
    check('then the address is locked out of the control routes (429)', r.status === 429, `got ${r.status}`);
    r = await ctlSettings(CONTROL_KEY);
    check('...even for the right control key (429)', r.status === 429, `got ${r.status}`);
    r = await request('DELETE', `/recordings/${CAM}`, { headers: { 'X-Control-Key': CONTROL_KEY } });
    check('...on every control route (DELETE /recordings: 429)', r.status === 429, `got ${r.status}`);
    r = await camLog(CAM_KEY);
    check('...while the camera key is not affected (200)', r.status === 200, `got ${r.status}`);
    check('the log says it was the control key', await waitFor(() => /LOCKED OUT .* after 5 wrong control keys/.test(readLog()), 3000) !== null);
    await sleep(LOCK_S * 1000 + 300);
    r = await ctlSettings(CONTROL_KEY);
    check('and the control key works again when the lock is over (200)', r.status === 200, `got ${r.status}`);

    // ── 8. R-04: the folder settings stay inside the relay's folder ───
    const before = await sysView();
    const refusals = [
      ['firmwareDir', '/tmp/e2e-lockout-fw', 'an absolute path'],
      ['deviceSettingsDir', '../outside', 'a ".." path'],
      ['deviceSettingsDir', '/etc/cron.d', 'an absolute folder'],
      ['deviceSettingsDir', 'node_modules/x', 'a folder inside node_modules'],
      ['firmwareDir', 'lib/x', 'a folder inside the relay\'s code'],
      ['firmwareDir', '.git/hooks', 'a hidden folder'],
      ['firmwareDir', 'C:\\\\fw', 'a Windows drive path'],
    ];
    for (const [key, value, what] of refusals) {
      r = await sysSet({ [key]: value });
      check(`POST /system-settings with ${key} = ${what} is refused (400)`, r.status === 400 && /inside the relay's own folder/.test((r.json || {}).error || ''), `got ${r.status} ${r.text.slice(0, 120)}`);
    }
    r = await sysSet({ preRollSeconds: '9', firmwareDir: '/tmp/e2e-lockout-fw' });
    check('one bad path refuses the whole request, even next to a good value (400)', r.status === 400, `got ${r.status}`);
    const after = await sysView();
    check('...and after all of them nothing changed', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after).slice(0, 200));
    check('...and no settings file was written', !fs.existsSync(path.join(tmp, 'system-settings.json')));
    r = await sysSet({ firmwareDir: 'data/fw/', deviceSettingsDir: './staged//settings' });
    check('a path inside the relay\'s folder is saved (200, restart needed)', r.status === 200 && r.json && r.json.restartRequired === true && r.json.changed.length === 2, `got ${r.status} ${r.text.slice(0, 100)}`);
    const saved = JSON.parse(readFile(path.join(tmp, 'system-settings.json')) || '{}');
    check('...normalised in the settings file (no trailing slash)', saved.firmwareDir === 'data/fw' && saved.deviceSettingsDir === 'staged/settings', JSON.stringify(saved));
    check('the relay is still up, with no ERROR in its log', (await get('/status')).status === 200 && !/ ERROR /.test(readLog()), readLog().split('\n').filter((l) => / ERROR /.test(l)).slice(0, 2).join(' | '));
  } catch (err) {
    check('the test ran to the end without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    for (const s of socks) s.destroy();
    await stopRelay(relay);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  }
  summarize();
})();
