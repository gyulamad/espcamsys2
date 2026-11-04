#!/usr/bin/env node
'use strict';
// test_relay_detector_view_e2e.js — the live view switch of a REAL server.js (lib/detectorview.js):
//   * the board asks GET /detector/:id/view (camera key) and is told view=0 until the dashboard asks
//   * POST /detector/:id/view?action=on|keep|off (control key): wrong/missing key, bad action, unknown detector
//   * a resting detector (asks, no uplink) shows as 'idle' in GET /detectors; an uplink makes it 'online'
//   * OFF is passed on as stop=1 until the next ON; a closed uplink with the board still asking is idle again
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_relay_detector_view_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DETVIEW_PORT || 19452);
const PUSH_PORT = PORT + 1;
const KEY = 'e2e-detector-view-key';
const CONTROL = 'e2e-control-key-0123456789abcdef';
const ID = 'e2e-view-1';

let pass = 0, fail = 0, finished = false;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });

let createdConfig = false;
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
  createdConfig = true;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detview-'));
const logFile = path.join(tmp, 'relay.log');
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

const fake = require('./fake_detector');
const { JPEG, status, wire } = fake;

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, CONTROL_KEY: CONTROL,
        SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: logFile, SWITCH_FILE: path.join(tmp, 'switch.json') }),
    });
    let out = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 5000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${PUSH_PORT}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}


function http(method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${p}`, { method, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch (e) { /* text */ } resolve({ status: res.statusCode, text: out, json }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
const board = (id = ID, key = KEY) => http('GET', `/detector/${id}/view`, key === null ? {} : { 'X-Api-Key': key });
const dash = (action, id = ID, key = CONTROL) => http('POST', `/detector/${id}/view${action === null ? '' : `?action=${action}`}`, key === null ? {} : { 'X-Control-Key': key });
const state = async () => (await http('GET', '/detectors', { 'X-Control-Key': CONTROL })).json;

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay');
    return;
  }
  const relay = await startRelay();
  const socks = [];
  try {
    // keys and parameters
    let r = await board(ID, null);
    check('the board\'s ask without the camera key is a 401', r.status === 401, String(r.status));
    r = await board(ID, 'wrong-key');
    check('...and with a wrong key', r.status === 401, String(r.status));
    r = await http('GET', '/detector/bad%20id/view', { 'X-Api-Key': KEY });
    check('an invalid detector id is a 400', r.status === 400, String(r.status));
    r = await dash('on', ID);
    check('the dashboard asking for a detector the relay has never heard of is a 404 that says so', r.status === 404 && /no detector called/.test(r.json.error), r.text);

    // the board asks: nobody is looking
    r = await board();
    check('the board is told view=0;stop=0 (and mins=10) while nobody asked', r.status === 200 && r.text === 'view=0;stop=0;mins=10', r.text);
    let st = (await state())[ID];
    check('a resting detector (it asked, no uplink) is idle in GET /detectors, with its view info', !!st && st.state === 'idle' && st.view.supported === true && st.view.idleFresh === true && st.report === null, JSON.stringify(st));

    // the dashboard side
    r = await dash('on', ID, null);
    check('the dashboard\'s ask without the control key is a 401', r.status === 401, String(r.status));
    r = await dash('toggle');
    check('an unknown action is a 400 that lists the choices', r.status === 400 && /on, keep, off/.test(r.json.error), r.text);
    r = await dash(null);
    check('no action at all is a 400', r.status === 400, String(r.status));
    r = await dash('on');
    check('ON is accepted and says it is wanted', r.status === 200 && r.json.ok === true && r.json.view.wanted === true, r.text);
    r = await board();
    check('the board is now told to stream', r.text === 'view=1;stop=0;mins=10', r.text);
    r = await dash('keep');
    check('KEEP is accepted', r.status === 200 && r.json.view.wanted === true);
    check('the relay logs ON (and who did it)', !!(await waitFor(() => /live view switched ON by/.test(readLog()), 2000)), readLog().slice(-400));
    check('...and what the board was told', /the detector asked whether to stream: somebody wants to look: stream/.test(readLog()));

    // streaming: an uplink makes it online
    const u = await fake.uplink(PORT, ID, { key: KEY });
    check('the board opens its uplink', u.status === 101, String(u.status));
    socks.push(u.socket);
    u.socket.write(wire(status(), JPEG));
    check('with the uplink and numbers arriving it is online (not idle)', !!(await waitFor(async () => (await state())[ID].state === 'online', 2000)));

    // OFF
    r = await dash('off');
    check('OFF is accepted', r.status === 200 && r.json.view.wanted === false, r.text);
    r = await board();
    check('the board is told to stop (stop=1)', r.text === 'view=0;stop=1;mins=10', r.text);
    r = await dash('on');
    r = await board();
    check('ON after OFF cancels the stop', r.text === 'view=1;stop=0;mins=10', r.text);

    // the uplink closes: a resting detector is idle again
    u.socket.destroy();
    check('the board closes its uplink and keeps asking: idle again (not offline)', !!(await waitFor(async () => { await board(); return (await state())[ID].state === 'idle'; }, 12000)), JSON.stringify((await state())[ID]));

    // the new detector id limit also applies to asking
    const many = [];
    for (let i = 0; i < 70; i += 1) many.push((await board(`e2e-viewmany-${i}`)).status);
    check('a runaway number of ids asking is refused at the limit with a 503', many.includes(503), many.join(','));
  } finally {
    socks.forEach((s) => { try { s.destroy(); } catch (e) { /* gone */ } });
    relay.kill('SIGTERM');
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  if (fail > 0) console.error('--- relay log ---\n' + readLog().slice(-3000));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
