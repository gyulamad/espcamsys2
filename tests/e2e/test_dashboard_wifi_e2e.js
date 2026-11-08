#!/usr/bin/env node
'use strict';
// test_dashboard_wifi_e2e.js — the Wi-Fi network and signal of the cameras and detectors on the dashboard, on a
// REAL PHP server in front of a fake relay (core modules only: runs without the relay's npm packages).
//   * status.php and detector-status.php carry each device's network and signal, checked again on the way
//   * a reading the relay got wrong (control characters, a signal out of range) never reaches the browser
//   * a detector's own rssi/ssid readings are carried as `wifi`, not twice; a resting detector still shows its network
//   * the dashboard page has a chip per camera and a line per detector, and no network name is written into it
// Own ports, throwaway dashboard copy. Needs `php` (skips if missing).
//   node tests/e2e/test_dashboard_wifi_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_DWIFI_PORT || 19460);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the fake relay: what GET /status and GET /detectors answer ──
const wifi = (ssid, rssi) => ({ ssid, rssi, ageMs: 1500 });
const relayStatus = {
  camA: { lastSeen: '2026-11-07T10:00:00.000Z', recording: false, recordingCount: 3, wifi: wifi('HomeNet', -61) },
  camB: { lastSeen: '2026-11-07T10:00:00.000Z', recording: true, recordingCount: 0, wifi: wifi('GarageNet', -72) },
  camC: { lastSeen: null, recording: false, wifi: { ssid: 'evil\nname', rssi: -50, ageMs: 1 } },   // a reading that is not one
  camD: { lastSeen: null, recording: false, wifi: { ssid: 'x'.repeat(40), rssi: -50, ageMs: 1 } }, // a name longer than 32 bytes
  camE: { lastSeen: null, recording: false, wifi: { ssid: 'Net', rssi: 0, ageMs: 1 } },            // 0 = not connected
  camF: { lastSeen: null, recording: false },                                                       // an older firmware: no reading
};
const relayDetectors = {
  'det-A': { state: 'online', online: true, hasPicture: true, connected: true, ageMs: 100, pictureAgeMs: 100, ip: '10.0.0.7', message: '',
    report: { ip: '10.0.0.7', fw: 'abc', rssi: -66, ssid: 'DetNet', uptimeMs: 5000, scene: { state: 'active' } }, wifi: wifi('DetNet', -66), view: { supported: true, wanted: true } },
  'det-C': { state: 'idle', online: false, hasPicture: false, connected: false, ageMs: 9000, pictureAgeMs: null, ip: null, message: 'the live view is off',
    report: null, wifi: wifi('RestNet', -80), view: { supported: true, wanted: false } },
};
function relayHandler(req, res) {
  const body = req.url === '/status' ? relayStatus : req.url === '/detectors' ? relayDetectors : null;
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body || { error: 'not found' }));
}

let docroot, phpTmp;
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dwifi-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [` +
    "['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-A'], ['id' => 'camB', 'name' => 'B', 'icon' => 'y'], ['id' => 'camC', 'name' => 'C', 'icon' => 'z', 'detector' => 'det-C']]];\n");
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', TMPDIR: phpTmp } });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    (async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL'); reject(new Error('php -S not ready in 5s'));
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

// A request to the dashboard. `own` = the dashboard's own script (the header and same-origin marker). `body` is sent as JSON.
function call(method, p, { auth = true, own = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { Host: `127.0.0.1:${PHP_PORT}`, 'Content-Length': Buffer.byteLength(payload) };
    if (payload) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    if (own) Object.assign(headers, { 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin' });
    const req = nodeHttp.request({ host: '127.0.0.1', port: PHP_PORT, path: '/' + p, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; const relay = nodeHttp.createServer(relayHandler);
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dwifi-tmp-'));
    docroot = makeDashboard();
    php = await startPhp(docroot);

    // ── shown by default ──────────────────────────────────────────
    let r = await call('GET', 'status.php');
    check('status.php: a camera\'s network and signal are shown', r.status === 200 && JSON.stringify(r.json.camA.wifi) === JSON.stringify(wifi('HomeNet', -61)), r.text);
    check('... with everything else of the camera as the relay said', r.json.camA.recordingCount === 3 && r.json.camB.recording === true && r.json.camA.lastSeen === '2026-11-07T10:00:00.000Z');
    check('a reading the relay got wrong (a control character in the name) does not reach the browser', r.json.camC.wifi === null && !/evil/.test(r.text), r.text);
    check('a name that is too long, a signal of 0 and no reading at all each give null', r.json.camD.wifi === null && r.json.camE.wifi === null && r.json.camF.wifi === null, r.text);

    r = await call('GET', 'detector-status.php');
    check('detector-status.php: the detector\'s network and signal are shown', r.status === 200 && JSON.stringify(r.json.camA.wifi) === JSON.stringify(wifi('DetNet', -66)), r.text);
    check('... and its readings no longer carry them (one place)', r.json.camA.report && r.json.camA.report.fw === 'abc' && !('rssi' in r.json.camA.report) && !('ssid' in r.json.camA.report), r.text);
    check('a resting detector shows its network although it has no readings', r.json.camC.state === 'idle' && r.json.camC.report === null && r.json.camC.wifi && r.json.camC.wifi.ssid === 'RestNet', r.text);

    r = await call('GET', 'index.php');
    check('the dashboard page has a Wi-Fi chip per camera and a line per detector, and loads the script', r.status === 200 && /id="wifi-camA"/.test(r.text) && /id="wifi-camB"/.test(r.text) && /id="detwifi-camA"/.test(r.text) && /id="detwifirow-camC"/.test(r.text) && !/id="detwifi-camB"/.test(r.text) && /src="js\/wifi-info\.js"/.test(r.text), String(r.status));
    check('... and none of the networks is written into the page (they arrive as data)', !/HomeNet|DetNet|GarageNet|RestNet/.test(r.text));
  } finally {
    await stopProc(php);
    await new Promise((resolve) => relay.close(resolve));
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
}

main().then(() => { finished = true; console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail === 0 ? 0 : 1; })
  .catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
