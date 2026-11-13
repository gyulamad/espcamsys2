#!/usr/bin/env node
'use strict';
// test_setup_mode_e2e.js — end-to-end check of GET /setup-mode against a REAL `server.js` process,
// real HTTP and real state files: which boards last reported SETUP_MODE=1 (armed: they open their own
// setup Wi-Fi and wait there), so the dashboard can show a persistent warning.
//   - the CONTROL key is needed (none / wrong / the camera key -> 401; no control key configured -> 503)
//   - nothing reported -> { devices: [] }; boards report over the real POST .../report route
//   - only SETUP_MODE exactly "1" counts; the answer is sorted by type, then id, with reportedAt
//   - it clears by itself when the board reports SETUP_MODE=0 again
//   - damaged / stray files in the state folder are ignored and never break the answer
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway folders. Core modules only.
//
// Usage:  node tests/e2e/test_setup_mode_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.
const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_SETUPMODE_PORT || 19340);
const PUSH_PORT = Number(process.env.E2E_SETUPMODE_PUSH_PORT || 19341);
const KEY = 'e2e-setupmode-key';
const CONTROL = 'e2e-setupmode-control';

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
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-setupmode-switch-${process.pid}.json`) }, env),
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

// A board's report (camera key): "<number>\nboot\n<message>\n<KEY=value;...>"
const report = (type, id, line) => request('POST', `/device-settings/${type}/${id}/report`, {
  headers: { 'X-Api-Key': KEY, 'Content-Type': 'text/plain' },
  body: `0\nboot\n\n${line}\n`,
});
const getSetup = (key) => request('GET', '/setup-mode', { headers: key === undefined ? {} : { 'X-Control-Key': key } });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-setupmode-'));
  const dir = path.join(tmp, 'device-settings');
  const env = { DEVICE_SETTINGS_DIR: dir, LOG_FILE: path.join(tmp, 'camera.log'), CONTROL_KEY: CONTROL, SETTINGS_FILE: path.join(tmp, 'settings.json') };
  let relay = null;
  try {
    relay = await startRelay(env);

    check('no key is refused', (await getSetup()).status === 401);
    check('a wrong control key is refused', (await getSetup('nope')).status === 401);
    check('the CAMERA key is not the control key', (await getSetup(KEY)).status === 401);

    const none = await getSetup(CONTROL);
    check('nothing reported (no folder yet) -> an empty list', none.status === 200 && JSON.stringify(none.json) === '{"devices":[]}', JSON.stringify(none));

    check('boards report', (await report('recorder', 'cam2', 'NAME=a;SETUP_MODE=1')).status === 200
      && (await report('detector', 'det1', 'SETUP_MODE=1')).status === 200
      && (await report('recorder', 'cam1', 'SETUP_MODE=1;X=2')).status === 200
      && (await report('recorder', 'cam3', 'SETUP_MODE=0')).status === 200
      && (await report('recorder', 'cam4', 'X=1')).status === 200
      && (await report('recorder', 'cam5', 'SETUP_MODE=true')).status === 200);

    const on = await getSetup(CONTROL);
    const devs = (on.json && on.json.devices) || [];
    check('only boards with SETUP_MODE=1 are listed, sorted by type then id',
      devs.map((d) => `${d.type}/${d.id}`).join(',') === 'detector/det1,recorder/cam1,recorder/cam2', JSON.stringify(on.json));
    check('each entry has exactly type, id and a numeric reportedAt',
      devs.every((d) => Object.keys(d).sort().join() === 'id,reportedAt,type' && Number.isSafeInteger(d.reportedAt) && d.reportedAt > 0), JSON.stringify(devs));

    // Damaged and stray files must not break the answer.
    const stateDir = path.join(dir, 'recorder', 'state');
    fs.writeFileSync(path.join(stateDir, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(stateDir, 'notes.txt'), 'SETUP_MODE=1');
    fs.writeFileSync(path.join(stateDir, 'bad id.json'), JSON.stringify({ reported: { line: 'SETUP_MODE=1', at: 1 } }));
    fs.writeFileSync(path.join(stateDir, 'forged.json'), JSON.stringify({ reported: { line: 'SETUP_MODE=1', at: 'x' } }));
    const messy = await getSetup(CONTROL);
    check('damaged and stray files are ignored', messy.status === 200 && messy.json.devices.length === 3, JSON.stringify(messy));

    check('the board switching it off clears it by itself', (await report('recorder', 'cam2', 'SETUP_MODE=0')).status === 200
      && (await getSetup(CONTROL)).json.devices.map((d) => d.id).join() === 'det1,cam1');

    await stopRelay(relay);
    relay = await startRelay(Object.assign({}, env, { CONTROL_KEY: '' }));
    check('without a configured control key it answers 503', (await getSetup(CONTROL)).status === 503);
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
