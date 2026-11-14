#!/usr/bin/env node
'use strict';
// test_device_info_dom.js — the board line of a CAMERA's card (address, connection time, uptime, free memory, firmware)
// on the REAL dashboard page (served by a real PHP server, in front of a fake relay, loaded into jsdom with its
// scripts running), and the detector's info line that is built by the same code.
//   * a camera the relay knows facts about gets a line under its header; one without facts has none (hidden, empty)
//   * the line follows the data (a new reading replaces the old; no facts any more: hidden, nothing left)
//   * a hostile firmware name is shown as TEXT: no element, no script ran, window.__pwned never set
//   * the detector's info line still reads as before (address, uptime, memory, reconnects, JPEG failures, firmware)
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_device_info_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');
const { installFakeMux } = require('./fake_mux');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_DEVDOM_PORT || 19482);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const basic = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
const EVIL_FW = '<img src=x onerror=__pwned=1>';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); }
}

function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
        text: () => Promise.resolve(data),
        json: () => Promise.resolve().then(() => JSON.parse(data)),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// What the relay pushes on the mux.php connection (the test plays the connection: see fake_mux.js).
const device = (over) => Object.assign({ ip: '192.168.1.50', connectedForMs: 125000, fw: 'abc123', uptimeMs: 7200000, heapBytes: 81920 }, over);
const relayStatus = {
  cam1: { lastSeen: null, recording: false, recordingCount: 0, device: device() },
  cam2: { lastSeen: null, recording: false, recordingCount: 0, device: device({ fw: EVIL_FW }) },
  cam3: { lastSeen: null, recording: false, recordingCount: 0 },
};
const relayDetectors = {
  'det-1': { state: 'online', online: true, hasPicture: true, connected: true, ageMs: 100, pictureAgeMs: 100, ip: '10.0.0.7', message: '',
    report: { ip: '10.0.0.7', fw: 'dfw1', uptimeMs: 5000,
      scene: { state: 'active', brightness: 100, motion: 10, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: { x0: 0, y0: 0, x1: 95, y1: 95 } },
      person: { score: 0.1, detectAt: 0.6, clearAt: 0.5, detected: false }, gpio: { pin: 13, high: false }, link: { frames: 1, jpegFails: 2, reconnects: 3, heap: 90000 } },
    wifi: null, view: { supported: true, wanted: true } },
};

function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');   // (all the page asks of it at load is the recording counts)
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-devdom-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const cams = [
    { id: 'cam1', name: 'Front door', icon: '📷', detector: 'det-1' },
    { id: 'cam2', name: 'Garage', icon: '📷', detector: 'det-2' },
    { id: 'cam3', name: 'Garden', icon: '📷' },
    { id: 'cam4', name: 'Attic', icon: '📷', detector: 'det-4' },   // a detector the relay never heard from
  ];
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => json_decode(${JSON.stringify(JSON.stringify(cams))}, true)];\n`);
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = http.get(`${BASE}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error('php -S not ready in 5s'));
    })();
  });
}
function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 1500);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; let relay; let dir; let dom;
  try {
    relay = await startRelay();
    dir = makeDashboard();
    php = await startPhp(dir);
    const html = await (await nodeFetch(`${BASE}/index.php`, { headers: { Authorization: basic } })).text();

    let mux;
    dom = new JSDOM(html, {
      url: `${BASE}/index.php`, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'wifi-info.js', 'camera-offline.js', 'alarm-chain.js', 'busy.js', 'device-info.js']), pretendToBeVisual: true,
      beforeParse(window) {
        window.__pwned = undefined;
        mux = installFakeMux(window);
        window.confirm = () => false;
        window.alert = () => {};
        window.fetch = (u, opts = {}) => nodeFetch(new URL(u, `${BASE}/index.php`).toString(), { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
      },
    });
    const { window } = dom;
    const doc = window.document;
    const $ = (id) => doc.getElementById(id);

    // The page's script has run (its external scripts are loaded before it): now the relay's pushes can arrive.
    check('the page opens its one mux connection', !!(await waitFor(() => mux.options)));
    mux.pushCameraStatus(relayStatus);
    mux.pushStatus({ cam1: relayDetectors['det-1'] });   // the readings, keyed by camera as mux.php shapes them

    const loaded = await waitFor(() => window.CamDeviceInfo && $('dev-cam1') && !$('dev-cam1').hidden);
    check('the page loads js/device-info.js and a camera the relay knows facts about gets a line', !!loaded, 'dev-cam1 hidden or CamDeviceInfo missing');

    const line1 = $('dev-cam1');
    check('the camera line says address, connection time, uptime, memory and firmware',
      line1.textContent === '192.168.1.50 · connected 2 min · up 2 h 0 min · 80 KB free · fw abc123', JSON.stringify(line1.textContent));
    check('the line sits in the camera\'s card, not inside its title', $('card-cam1').contains(line1) && !$('card-cam1').querySelector('.cam-title').contains(line1));
    check('a camera without facts has no line (hidden and empty)', $('dev-cam3').hidden && $('dev-cam3').textContent === '');

    const line2 = $('dev-cam2');
    check('a hostile firmware name is shown as TEXT', line2.textContent.includes(EVIL_FW) && line2.querySelector('img, b, script') === null && line2.childElementCount === 0, line2.innerHTML);
    check('... and nothing ran', window.__pwned === undefined && doc.querySelectorAll('img[src="x"]').length === 0);

    // ── the line follows the data ─────────────────────────────────
    window.applyCameraStatuses({ cam1: { recording: false, recordingCount: 0, device: { ip: '10.1.1.1', fw: 'new9' } } });
    check('a new reading replaces the old one, and what is not known any more is not left over', line1.textContent === '10.1.1.1 · fw new9', line1.textContent);
    window.applyCameraStatuses({ cam1: { recording: false, recordingCount: 0, device: null } });
    check('no facts any more: hidden, nothing of the old line left', line1.hidden && line1.textContent === '');
    window.applyCameraStatuses({});
    check('a camera the relay does not know: also no line', line1.hidden && $('dev-cam2').hidden);

    // ── the detector's line, built by the same code ───────────────
    const det = await waitFor(() => $('detinfo-cam1') && $('detinfo-cam1').textContent !== '');
    check('the detector\'s info line reads as before', !!det && $('detinfo-cam1').textContent === '10.0.0.7 · up 5 s · 88 KB free · 3 reconnects · 2 JPEG failures · fw dfw1', $('detinfo-cam1').textContent);
    window.renderDetector('cam1', Object.assign({}, relayDetectors['det-1'], { report: Object.assign({}, relayDetectors['det-1'].report, { ip: undefined, fw: undefined, uptimeMs: null, link: {} }) }));
    check('... and leaves out what the detector did not report', $('detinfo-cam1').textContent === '', JSON.stringify($('detinfo-cam1').textContent));
    check('nothing ran in the end either', window.__pwned === undefined);
  } finally {
    closeWindow(dom);
    await stopProc(php);
    if (relay) await new Promise((r) => relay.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}).catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
