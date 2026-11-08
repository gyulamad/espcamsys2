#!/usr/bin/env node
'use strict';
// test_wifi_info_e2e.js — the Wi-Fi network and signal strength of cameras and detectors, through a REAL
// `server.js` with real TCP "cameras" and real HTTP "detectors" (core modules only).
//   * the relay tells a camera it understands Wi-Fi reports (the third greeting byte) and a camera that sends
//     one shows up in GET /status with the network, the signal and the reading's age
//   * a report is checked: a name with control characters, a name that is too long, "not connected" (0) and
//     a report too short to mean anything leave the dashboard's view alone and never disconnect the camera
//   * a camera that never reports (older firmware) has wifi null, and its frames still arrive
//   * a resting detector's live-view poll carries its network (?ssid=&rssi=): it appears in GET /detectors
//     although the detector holds no connection; hostile query values are ignored
//   * a change of network is written to the log, naming the network but never anything it did not report
// Own ports, throwaway state/log/settings files. Needs the relay's npm packages ("npm install" there).
//
//   node tests/e2e/test_wifi_info_e2e.js      (E2E_WIFI_PORT=19470 E2E_WIFI_PUSH_PORT=19471 to move it)

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_WIFI_PORT || 19470);
const PUSH_PORT = Number(process.env.E2E_WIFI_PUSH_PORT || 19471);
const CAM_KEY = 'e2e-wifi-cam-key';
const CONTROL_KEY = 'e2e-wifi-control-key-0123456789';   // reads (GET /status, /detectors) need it, as for the dashboard
const CAM = 'e2e-wifi-cam';
const OLD_CAM = 'e2e-wifi-old';
const DET = 'e2e-wifi-det';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2500) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(25); }
}

// The bytes a camera writes (the same layout as logic.h's encodeWifiMessage()), built here on purpose from
// the documented layout and not by importing the relay's encoder, so a mistake in both would still show.
function wifiMessage(ssidBytes, rssi) {
  const body = Buffer.concat([Buffer.from([0x00, 0x03, rssi & 0xff]), Buffer.from(ssidBytes)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY, CONTROL_KEY }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 5s:\n${out}`)); } }, 5000).unref();
  });
}

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    nodeHttp.get(`http://127.0.0.1:${PORT}${urlPath}`, { headers: Object.assign({ 'X-Control-Key': CONTROL_KEY }, headers) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    }).on('error', reject);
  });
}

// A camera on the push port. It reads what the relay says first (the greeting) and keeps it.
class FakeCamera {
  constructor(id) { this.id = id; this.greeting = []; this.closed = false; }
  connect() {
    return new Promise((resolve) => {
      this.socket = net.connect(PUSH_PORT, '127.0.0.1', () => { this.socket.write(`${this.id}\t${CAM_KEY}\n`); resolve(); });
      this.socket.on('data', (d) => { this.greeting.push(...d); });
      this.socket.on('close', () => { this.closed = true; });
      this.socket.on('error', () => {});
    });
  }
  send(bytes) { this.socket.write(bytes); }
  sendFrame(jpeg) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(jpeg.length, 0);
    this.socket.write(Buffer.concat([header, jpeg]));
  }
  stop() { this.socket.destroy(); }
}

const statusOf = async (id) => { const r = await get('/status'); return r.json && r.json[id]; };
const detectorOf = async (id) => { const r = await get('/detectors'); return r.json && r.json[id]; };
const poll = (query) => get(`/detector/${DET}/view${query}`, { 'X-Api-Key': CAM_KEY });

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    return;
  }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wifi-')));
  const logFile = path.join(tmp, 'relay.log');
  const relay = await startRelay({ SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: logFile, SWITCH_FILE: path.join(tmp, 'switch.json') });
  const cams = [];
  const cam = async (id) => { const c = new FakeCamera(id); await c.connect(); cams.push(c); return c; };
  try {
    // ── a camera that reports its network ──────────────────────────
    const camera = await cam(CAM);
    check('the relay says it understands Wi-Fi reports (greeting: resume, in-band alarm, Wi-Fi)',
      !!(await waitFor(() => camera.greeting.length >= 3)) && camera.greeting.slice(0, 3).join() === '1,2,3', camera.greeting.join());

    camera.send(wifiMessage('HomeNet', -61));
    const shown = await waitFor(async () => { const s = await statusOf(CAM); return s && s.wifi; });
    check('a camera\'s report shows up in /status with the network and the signal', !!shown && shown.ssid === 'HomeNet' && shown.rssi === -61, JSON.stringify(shown));
    check('... with the age of the reading', !!shown && typeof shown.ageMs === 'number' && shown.ageMs >= 0 && shown.ageMs < 2500, JSON.stringify(shown));

    camera.send(wifiMessage('HomeNet', -75));
    const weaker = await waitFor(async () => { const s = await statusOf(CAM); return s && s.wifi && s.wifi.rssi === -75 && s.wifi; });
    check('a newer report replaces the older one (the signal moves)', !!weaker && weaker.ssid === 'HomeNet', JSON.stringify(weaker));

    // ── hostile or meaningless reports change nothing and cost nothing ──
    camera.send(wifiMessage('evil\nINFO forged log line', -50));
    camera.send(wifiMessage('x'.repeat(33), -50));
    camera.send(wifiMessage('NotConnected', 0));
    camera.send(wifiMessage([0xff, 0xfe], -50));
    camera.send(Buffer.from([0, 0, 0, 2, 0x00, 0x03]));          // too short to hold the signal byte
    camera.sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));       // and a frame after them all: the stream is intact
    await sleep(250);
    const after = await statusOf(CAM);
    check('refused reports leave the earlier reading in place', !!after && !!after.wifi && after.wifi.ssid === 'HomeNet' && after.wifi.rssi === -75, JSON.stringify(after && after.wifi));
    check('... and the camera stays connected, its frames still counted', !camera.closed && !!after && after.lastSeen !== null);

    // ── a change of network is logged, a change of signal is not ──
    camera.send(wifiMessage('Neighbour 5G', -58));
    await waitFor(async () => { const s = await statusOf(CAM); return s && s.wifi && s.wifi.ssid === 'Neighbour 5G'; });
    await sleep(300);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('the first network and a change of network are in the log', /on the Wi-Fi network 'HomeNet'/.test(log) && /on the Wi-Fi network 'Neighbour 5G'/.test(log), log.slice(-400));
    check('a change of signal alone is not logged (it changes every few seconds)', (log.match(/on the Wi-Fi network 'HomeNet'/g) || []).length === 1);
    check('a refused report never reaches the log (no forged line)', !/forged log line/.test(log));

    // ── an older camera that never reports ─────────────────────────
    const old = await cam(OLD_CAM);
    old.sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const oldStatus = await waitFor(async () => { const s = await statusOf(OLD_CAM); return s && s.lastSeen && s; });
    check('a camera that sends no Wi-Fi report has wifi null (nothing is invented)', !!oldStatus && oldStatus.wifi === null, JSON.stringify(oldStatus));

    // ── a resting detector: its poll carries the network ───────────
    const first = await poll('');
    check('a poll without a network is answered as before', first.status === 200, JSON.stringify(first));
    check('... and the detector has no Wi-Fi reading yet', (await detectorOf(DET)).wifi === null);

    const answered = await poll('?ssid=HomeNet&rssi=-64');
    check('a poll with ?ssid=&rssi= is answered normally', answered.status === 200, JSON.stringify(answered));
    const resting = await detectorOf(DET);
    check('a resting detector shows its network and signal (no uplink is open)',
      !!resting && !!resting.wifi && resting.wifi.ssid === 'HomeNet' && resting.wifi.rssi === -64 && resting.connected === false, JSON.stringify(resting));

    await poll('?ssid=' + encodeURIComponent('a\nb') + '&rssi=-10');
    await poll('?ssid=Other&rssi=0x10');
    await poll('?ssid=Other&rssi=1e1');
    await poll('?ssid=Other&rssi=-10&rssi=-20');
    await poll('?ssid=A&ssid=B&rssi=-10');
    await poll('?ssid=' + 'x'.repeat(200) + '&rssi=-10');
    const kept = await detectorOf(DET);
    check('hostile poll values change nothing', !!kept && !!kept.wifi && kept.wifi.ssid === 'HomeNet' && kept.wifi.rssi === -64, JSON.stringify(kept && kept.wifi));

    const denied = await get(`/detector/${DET}/view?ssid=Evil&rssi=-1`, { 'X-Api-Key': 'wrong-key' });
    check('a poll with a wrong key is refused and records nothing', denied.status === 401 && (await detectorOf(DET)).wifi.ssid === 'HomeNet', String(denied.status));
  } finally {
    for (const c of cams) c.stop();
    relay.kill('SIGTERM');
    await sleep(150);
    if (createdTempConfig) fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(RELAY_DIR, 'recordings', CAM), { recursive: true, force: true });
    fs.rmSync(path.join(RELAY_DIR, 'recordings', OLD_CAM), { recursive: true, force: true });
  }
}

main().then(() => { finished = true; console.log(`\n${passCount} passed, ${failCount} failed`); process.exitCode = failCount === 0 ? 0 : 1; })
  .catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
