#!/usr/bin/env node
'use strict';
// test_camera_device_e2e.js — what the dashboard may know about a CAMERA's board (address, connection time, firmware,
// uptime, free memory), through a REAL `server.js` with real TCP "cameras" (core modules only).
//   * a connected camera shows its address and how long it has been connected in GET /status, before it logs anything
//     (the relay's own observation); firmware, uptime and memory are null until the camera's /log says them
//   * a /log batch fills in firmware, uptime and free memory (uptime as of the arrival: entry uptime + entry age)
//   * a later batch replaces them; a batch from a camera the relay does not know adds no camera
//   * hostile values in a batch (a firmware name with control characters, a negative heap) never reach /status
//   * a camera that is no longer sending keeps its firmware but has no uptime or memory "now"
// Own ports, throwaway state/log/settings files. Needs the relay's npm packages ("npm install" there).
//
//   node tests/e2e/test_camera_device_e2e.js      (E2E_DEVINFO_PORT=19472 E2E_DEVINFO_PUSH_PORT=19473 to move it)

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DEVINFO_PORT || 19472);
const PUSH_PORT = Number(process.env.E2E_DEVINFO_PUSH_PORT || 19473);
const CAM_KEY = 'e2e-devinfo-cam-key';
const CONTROL_KEY = 'e2e-devinfo-control-key-0123456789';   // reads (GET /status, /detectors) need it, as for the dashboard
const CAM = 'e2e-devinfo-cam';
const OLD_CAM = 'e2e-devinfo-old';

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

const postLog = (camera, entries, fw) => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ camera, fw, entries });
  const req = nodeHttp.request(`http://127.0.0.1:${PORT}/log`, { method: 'POST', headers: { 'X-Api-Key': CAM_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end(payload);
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    return;
  }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-devinfo-')));
  const relay = await startRelay({ SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: path.join(tmp, 'relay.log'), SWITCH_FILE: path.join(tmp, 'switch.json') });
  const cams = [];
  const cam = async (id) => { const c = new FakeCamera(id); await c.connect(); cams.push(c); return c; };
  try {
    const camera = await cam(CAM);
    camera.sendFrame(JPEG);
    const first = await waitFor(async () => { const s = await statusOf(CAM); return s && s.device && s; });
    const d0 = first && first.device;
    check('a connected camera shows its address and connection time before it has logged anything',
      !!d0 && d0.ip === '127.0.0.1' && typeof d0.connectedForMs === 'number' && d0.connectedForMs >= 0 && d0.connectedForMs < 2500, JSON.stringify(d0));
    check('... and no firmware, uptime or memory (nothing is invented)', !!d0 && d0.fw === null && d0.uptimeMs === null && d0.heapBytes === null, JSON.stringify(d0));

    const status = await postLog(CAM, [{ level: 'INFO', message: 'heartbeat', uptimeMs: 60000, heap: 81920, ageMs: 5000 }], 'abc123');
    check('the camera\'s /log batch is accepted', status === 200, String(status));
    const d1 = (await statusOf(CAM)).device;
    check('the firmware and the free memory come from the batch', d1.fw === 'abc123' && d1.heapBytes === 81920, JSON.stringify(d1));
    check('the uptime is as of the arrival (60 s + 5 s ago), running on from there', d1.uptimeMs >= 65000 && d1.uptimeMs < 68000, JSON.stringify(d1));

    await postLog(CAM, [{ level: 'INFO', message: 'heartbeat', uptimeMs: 600000, heap: 70000, ageMs: 0 }], 'def456');
    const d2 = (await statusOf(CAM)).device;
    check('a later batch replaces the firmware, uptime and memory', d2.fw === 'def456' && d2.heapBytes === 70000 && d2.uptimeMs >= 600000, JSON.stringify(d2));

    await postLog(CAM, [{ level: 'INFO', message: 'hostile', heap: -5 }], "evil\u0001fw");
    const d3 = (await statusOf(CAM)).device;
    check('hostile values change nothing the dashboard sees (no control characters; a negative memory is no reading, the last good one stays)',
      !/[\u0000-\u001f]/.test(d3.fw) && d3.heapBytes === 70000, JSON.stringify(d3));

    await postLog('e2e-devinfo-ghost', [{ level: 'INFO', message: 'x', uptimeMs: 1, heap: 1 }], 'ghost');
    check('a log request for a camera the relay does not know adds no camera', (await statusOf('e2e-devinfo-ghost')) === undefined);

    const old = await cam(OLD_CAM);
    old.sendFrame(JPEG);
    const oldDevice = await waitFor(async () => { const s = await statusOf(OLD_CAM); return s && s.device; });
    check('a camera that never logs has an address but no firmware, uptime or memory', !!oldDevice && oldDevice.ip === '127.0.0.1' && oldDevice.fw === null && oldDevice.uptimeMs === null, JSON.stringify(oldDevice));

    camera.stop();
    await sleep(6000);   // past the relay's "online" window (5 s)
    const gone = await statusOf(CAM);
    check('a camera that stopped sending: no uptime, memory or connection time any more, the firmware stays',
      !!gone && gone.online === false && !!gone.device && gone.device.uptimeMs === null && gone.device.heapBytes === null && gone.device.connectedForMs === null && gone.device.fw !== null, JSON.stringify(gone && gone.device));
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
