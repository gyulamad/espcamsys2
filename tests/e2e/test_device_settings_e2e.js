#!/usr/bin/env node
'use strict';
// test_device_settings_e2e.js — end-to-end check of the settings the relay keeps
// ready for boards that are missing some, against a REAL `server.js` process,
// real HTTP and the real files on disk.
//
// A board whose Wi-Fi and relay settings are fine, but which lacks a setting its
// new firmware needs, asks GET /device-settings/<type>/<id> for it. This checks:
//   - asking needs the CAMERA key (no key / wrong key -> 401), staging needs the
//     CONTROL key, and staging is off when no control key is configured
//   - nothing staged -> 404 (and a warning in the relay log saying what to do)
//   - a line staged for one device reaches that device only; a line staged for a
//     type reaches every device of the type; the device's own line wins
//   - what is stored is exactly what was sent (escapes and spaces intact)
//   - an empty PUT removes it; files survive a relay restart
//   - bad types / ids / bodies are refused clearly, and no id can reach outside
//     the settings folder
//   - the relay log names the settings that were staged and sent, but NEVER
//     their values (they can be Wi-Fi passwords and API keys)
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway
// folders in a temp dir. Core modules only. Takes a few seconds.
//
// Usage:  node tests/e2e/test_device_settings_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DEVSET_PORT || 19330);
const PUSH_PORT = Number(process.env.E2E_DEVSET_PUSH_PORT || 19331);
const KEY = 'e2e-devset-key';
const CONTROL = 'e2e-devset-control';

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

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-devset-switch-${process.pid}.json`) }, env),
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
// Stops a child and resolves when it is gone; safe on one that already ended (a signal-killed
// child has exitCode null — signalCode must be checked too, or this would wait forever).
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

// An HTTP request with optional headers and a JSON (or raw string) body.
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== null) {
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: h }, (res) => {
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
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const get = (urlPath, key) => request('GET', urlPath, { headers: key === undefined ? {} : { 'X-Api-Key': key } });
const put = (urlPath, body, key) => request('PUT', urlPath, {
  headers: Object.assign({ 'Content-Type': 'text/plain' }, key === undefined ? {} : { 'X-Control-Key': key }),
  body,
});
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-devset-'));
  const dir = path.join(tmp, 'device-settings');
  const logFile = path.join(tmp, 'camera.log');
  const env = { DEVICE_SETTINGS_DIR: dir, LOG_FILE: logFile, CONTROL_KEY: CONTROL, SETTINGS_FILE: path.join(tmp, 'settings.json') };
  let relay = null;
  try {
    relay = await startRelay(env);

    // ── authentication ──
    check('asking without a key is refused', (await get('/device-settings/recorder/cam1')).status === 401);
    check('asking with the wrong key is refused', (await get('/device-settings/recorder/cam1', 'nope')).status === 401);
    check('the key may also be given as ?key= (like /log)', (await request('GET', `/device-settings/recorder/cam1?key=${KEY}`)).status === 404);
    check('staging without a control key is refused', (await put('/device-settings/recorder/cam1', 'A=1')).status === 401);
    check('the CAMERA key does not allow staging', (await put('/device-settings/recorder/cam1', 'A=1', KEY)).status === 401);
    check('the CONTROL key does not allow asking', (await get('/device-settings/recorder/cam1', CONTROL)).status === 401);
    check('nothing was written by the refused requests', !fs.existsSync(dir));

    // ── nothing staged ──
    const none = await get('/device-settings/recorder/cam1?need=NEW_KEY', KEY);
    check('nothing staged -> 404', none.status === 404, JSON.stringify(none));
    await sleep(150);
    const log1 = readLog(logFile);
    check('the relay log says the device asked, what it lacked and what to do',
      /cam1 \(recorder\) is missing settings \(NEW_KEY\) and nothing is staged/.test(log1) && /PUT \/device-settings\/recorder\/cam1/.test(log1), log1);

    // ── staging for one device ──
    const line = 'NEW_KEY=7;LOG_ECHO=0';
    const st = await put('/device-settings/recorder/cam1', line + '\n', CONTROL);
    check('staging for one device works', st.status === 200 && st.json && st.json.ok === true, JSON.stringify(st));
    check('the response lists the setting names', JSON.stringify(st.json && st.json.settings) === JSON.stringify(['NEW_KEY', 'LOG_ECHO']), JSON.stringify(st.json));
    const got = await get('/device-settings/recorder/cam1?need=NEW_KEY', KEY);
    check('that device gets exactly the line', got.status === 200 && got.text.trim() === line, JSON.stringify(got.text));
    check('another device of the same type gets nothing', (await get('/device-settings/recorder/cam2', KEY)).status === 404);
    check('the same id under the other type gets nothing', (await get('/device-settings/detector/cam1', KEY)).status === 404);

    // ── staging for the whole type; the device's own line wins ──
    check('staging for a whole type works', (await put('/device-settings/recorder', 'FLEET_KEY=1', CONTROL)).status === 200);
    check('a device without its own line gets the fleet line', (await get('/device-settings/recorder/cam2', KEY)).text.trim() === 'FLEET_KEY=1');
    check('a device WITH its own line gets that one, not the fleet one', (await get('/device-settings/recorder/cam1', KEY)).text.trim() === line);
    check('the other type is unaffected by the fleet line', (await get('/device-settings/detector/dev1', KEY)).status === 404);

    // ── exact storage: spaces and escapes ──
    const tricky = 'WIFI=my net:pa\\;ss;API_KEY=a=b';
    await put('/device-settings/detector/dev1', tricky, CONTROL);
    check('spaces, escapes and = inside values are kept exactly', (await get('/device-settings/detector/dev1', KEY)).text.trim() === tricky);

    // ── the log: names, never values ──
    await sleep(150);
    const log2 = readLog(logFile);
    check('the log names the staged settings', /staged settings for recorder cam1: NEW_KEY, LOG_ECHO/.test(log2) && /staged settings for every recorder: FLEET_KEY/.test(log2), log2);
    check('the log says what was sent to the device', /cam1 \(recorder\) is missing settings \(NEW_KEY\) and was sent the device line staged for it \(NEW_KEY, LOG_ECHO\)/.test(log2), log2);
    check('the log NEVER contains a value', !/net:pa|a=b|hunter/.test(log2) && !log2.includes('NEW_KEY=7'), log2);

    // ── the log does not fill up while a board keeps asking ──
    await get('/device-settings/recorder/cam1?need=NEW_KEY', KEY); // establishes this ask as the "last one" the log gate remembers
    await sleep(150);
    const before = (readLog(logFile).match(/is missing settings/g) || []).length;
    for (let i = 0; i < 6; i += 1) await get('/device-settings/recorder/cam1?need=NEW_KEY', KEY);
    await sleep(150);
    const after = (readLog(logFile).match(/is missing settings/g) || []).length;
    check('repeated identical asks are not logged every time', after === before, `${before} -> ${after}`);

    // ── removing ──
    const rm = await put('/device-settings/recorder/cam1', '', CONTROL);
    check('an empty PUT removes the device line', rm.status === 200 && rm.json && rm.json.removed === true, JSON.stringify(rm));
    check('then the device falls back to the fleet line', (await get('/device-settings/recorder/cam1', KEY)).text.trim() === 'FLEET_KEY=1');
    check('removing something that is not there is fine', (await put('/device-settings/recorder/cam9', '', CONTROL)).status === 200);

    // ── bad input ──
    check('an unknown type is refused (GET)', (await get('/device-settings/camera/cam1', KEY)).status === 400);
    check('an unknown type is refused (PUT)', (await put('/device-settings/camera', 'A=1', CONTROL)).status === 400);
    check('a bad id is refused (GET)', (await get('/device-settings/recorder/.hidden', KEY)).status === 400);
    check('a bad id is refused (PUT)', (await put('/device-settings/recorder/_fleet', 'A=1', CONTROL)).status === 400);
    check('an id can not climb out of the folder', (await get('/device-settings/recorder/..%2F..%2Fconfig', KEY)).status === 400);
    check('a body that is not KEY=value is refused', (await put('/device-settings/recorder/cam3', 'hello', CONTROL)).status === 400);
    check('a multi-line body is refused', (await put('/device-settings/recorder/cam3', 'A=1\nB=2', CONTROL)).status === 400);
    const big = await put('/device-settings/recorder/cam3', 'A=' + 'x'.repeat(2000), CONTROL);
    check('a line over the board limit is refused with a reason', big.status === 400 && /too long/.test((big.json || {}).error || ''), JSON.stringify(big));
    const huge = await put('/device-settings/recorder/cam3', 'A=' + 'x'.repeat(8000), CONTROL);
    check('a huge body is answered with 413, not an HTML page', huge.status === 413 && huge.json && huge.json.error, JSON.stringify(huge));
    check('nothing was stored for any refused line', !fs.existsSync(path.join(dir, 'recorder', 'cam3.txt')));
    const stray = fs.readdirSync(dir, { recursive: true }).filter((f) => !/(^|[\\/])(_fleet|cam1|cam2|dev1)\.txt$|^(recorder|detector)$/.test(String(f)) && !String(f).endsWith('.tmp'));
    check('only the expected files exist in the settings folder', stray.length === 0, JSON.stringify(stray));

    // ── survives a restart ──
    await stopRelay(relay);
    relay = await startRelay(env);
    check('staged settings survive a relay restart', (await get('/device-settings/recorder/cam2', KEY)).text.trim() === 'FLEET_KEY=1');
    await stopRelay(relay);

    // ── staging is off without a control key ──
    relay = await startRelay(Object.assign({}, env, { CONTROL_KEY: '' }));
    const off = await put('/device-settings/recorder/cam1', 'A=1', CONTROL);
    check('without a configured control key, staging answers 503', off.status === 503, JSON.stringify(off));
    check('asking still works then', (await get('/device-settings/recorder/cam2', KEY)).status === 200);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
