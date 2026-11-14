#!/usr/bin/env node
'use strict';
// test_wifi_dom.js — the Wi-Fi network and signal on the REAL dashboard page (served by a real PHP server, in front
// of a fake relay, loaded into jsdom with its scripts running), and what a hostile network name can do.
//   * a camera that reported its network gets a chip under its header: signal bars (4), "network · -61 dBm", the band
//     (data-level, colour) and a tooltip; a camera without a reading has no chip
//   * a detector row has a WI-FI line the same way; a RESTING detector (no readings) shows its network too
//   * the old "-xx dBm" in the detector's info line is gone (the signal has the line of its own)
//   * a hostile network name (markup, script) is shown as TEXT: no element, no script ran, window.__pwned never set
//   * the chip follows the data: when the reading goes away (a stale one, an older firmware) it is hidden and empty
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_wifi_dom.js

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
const PHP_PORT = Number(process.env.E2E_WIFIDOM_PORT || 19480);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const basic = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
// Exactly 32 bytes: the longest name that is believed, so the page really gets it (a longer one is refused on the way).
const EVIL_SSID = '<img src=x onerror=__pwned=1><b>';

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
const wifi = (ssid, rssi) => ({ ssid, rssi, ageMs: 4000 });
const relayStatus = {
  cam1: { lastSeen: null, recording: false, recordingCount: 0, wifi: wifi('HomeNet', -61) },
  cam2: { lastSeen: null, recording: false, recordingCount: 0, wifi: wifi(EVIL_SSID, -50) },
  cam3: { lastSeen: null, recording: false, recordingCount: 0 },
};
const relayDetectors = {
  'det-1': { state: 'online', online: true, hasPicture: true, connected: true, ageMs: 100, pictureAgeMs: 100, ip: '10.0.0.7', message: '',
    report: { ip: '10.0.0.7', fw: 'abc', rssi: -66, ssid: 'DetNet', uptimeMs: 5000,
      scene: { state: 'active', brightness: 100, motion: 10, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: { x0: 0, y0: 0, x1: 95, y1: 95 } },
      person: { score: 0.1, detectAt: 0.6, clearAt: 0.5, detected: false }, gpio: { pin: 13, high: false }, link: { frames: 1, jpegFails: 0, reconnects: 0, heap: 90000 } },
    wifi: wifi('DetNet', -66), view: { supported: true, wanted: true } },
  'det-2': { state: 'idle', online: false, hasPicture: false, connected: false, ageMs: 9000, pictureAgeMs: null, ip: null, message: 'the live view is off',
    report: null, wifi: wifi('RestNet', -80), view: { supported: true, wanted: false } },
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wifidom-')));
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
      url: `${BASE}/index.php`, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['wifi-info.js', 'camera-offline.js', 'alarm-chain.js', 'busy.js', 'device-info.js']), pretendToBeVisual: true,
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
    mux.pushStatus({ cam1: relayDetectors['det-1'], cam2: relayDetectors['det-2'] });   // the readings, keyed by camera as mux.php shapes them

    const loaded = await waitFor(() => window.CamWifi && $('wifi-cam1') && !$('wifi-cam1').hidden);
    check('the page loads js/wifi-info.js and a camera that reported its network gets a chip', !!loaded, 'wifi-cam1 hidden or CamWifi missing');

    // ── cameras ───────────────────────────────────────────────────
    const chip1 = $('wifi-cam1');
    check('the camera chip says the network and the strength', chip1.textContent.trim() === 'HomeNet · -61 dBm', JSON.stringify(chip1.textContent));
    check('... with 4 signal bars, the band (good = 3) and a tooltip', chip1.querySelectorAll('.wifi-bars i').length === 4 && chip1.dataset.level === '3' && /good signal, reported 4 s ago/.test(chip1.title), `${chip1.dataset.level} ${chip1.title}`);
    check('the chip sits under the camera\'s header, not inside its title', !$('card-cam1').querySelector('.cam-title').contains(chip1) && $('card-cam1').contains(chip1));
    check('a camera without a reading has no chip (hidden and empty)', $('wifi-cam3').hidden && $('wifi-cam3').textContent === '');

    check('(the hostile name is a name the page is meant to accept: 32 bytes at most)', Buffer.byteLength(EVIL_SSID) <= 32, String(Buffer.byteLength(EVIL_SSID)));
    const chip2 = $('wifi-cam2');
    check('a hostile network name is shown as TEXT', chip2.textContent.includes(EVIL_SSID) && chip2.querySelector('img, b, script') === null && chip2.querySelector('.wifi-text').childElementCount === 0, chip2.innerHTML);
    check('... and nothing ran', window.__pwned === undefined && doc.querySelectorAll('img[src="x"]').length === 0);

    // ── detectors ─────────────────────────────────────────────────
    const detShown = await waitFor(() => $('detwifi-cam1') && !$('detwifi-cam1').hidden);
    check('a detector row gets its WI-FI line', !!detShown && !$('detwifirow-cam1').hidden && $('detwifi-cam1').textContent.trim() === 'DetNet · -66 dBm', $('detwifi-cam1') && $('detwifi-cam1').textContent);
    check('... the band is fair (2) for -66 dBm', $('detwifi-cam1').dataset.level === '2');
    check('the signal is no longer part of the detector\'s info line', !/dBm/.test($('detinfo-cam1').textContent) && /fw abc/.test($('detinfo-cam1').textContent), $('detinfo-cam1').textContent);

    const resting = await waitFor(() => $('detwifi-cam2') && !$('detwifi-cam2').hidden);
    check('a RESTING detector (live view off, no readings) still shows its network', !!resting && $('detwifi-cam2').textContent.trim() === 'RestNet · -80 dBm' && $('detwifi-cam2').dataset.level === '1', $('detwifi-cam2').textContent);
    check('a detector the relay never heard from has no Wi-Fi line', $('detwifirow-cam4').hidden && $('detwifi-cam4').hidden);
    check('a camera without a detector has no detector Wi-Fi line at all', $('detwifirow-cam3') === null);

    // ── the chips follow the data ─────────────────────────────────
    window.applyCameraStatuses({ cam1: { recording: false, recordingCount: 0, wifi: { ssid: 'Upstairs', rssi: -82, ageMs: 100 } } });
    check('a new reading replaces the old one (another network, a weaker signal)', chip1.textContent.trim() === 'Upstairs · -82 dBm' && chip1.dataset.level === '1' && chip1.querySelectorAll('.wifi-bars i').length === 4, chip1.textContent);
    window.applyCameraStatuses({ cam1: { recording: false, recordingCount: 0, wifi: null } });
    check('no reading any more: hidden, and nothing of the old one is left', chip1.hidden && chip1.textContent === '' && !chip1.hasAttribute('title') && !chip1.hasAttribute('data-level'));
    window.applyCameraStatuses({});
    check('a camera the relay does not know: also no chip', chip1.hidden && $('wifi-cam2').hidden);

    window.renderDetector('cam1', Object.assign({}, relayDetectors['det-1'], { wifi: null }));
    check('a detector without a reading loses its line (label and chip)', $('detwifirow-cam1').hidden && $('detwifi-cam1').textContent === '');
    window.renderDetector('cam1', null);
    check('no answer about the detector at all: no Wi-Fi line either', $('detwifirow-cam1').hidden);
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
