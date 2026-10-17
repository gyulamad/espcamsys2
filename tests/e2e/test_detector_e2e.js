#!/usr/bin/env node
'use strict';
// test_detector_e2e.js — a person detector reports to a REAL server.js over real HTTP:
// POST /detector/:id (camera key) -> GET /detectors (numbers) and GET /detector/:id/stream (picture).
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_detector_e2e.js        (exit 0 = all passed)

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DETECTOR_PORT || 19290);
const PUSH_PORT = Number(process.env.E2E_DETECTOR_PUSH_PORT || 19291);
const KEY = 'e2e-detector-key';
const ID = 'e2e-detector-1';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detector-'));

function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${p}`, { method, headers: h }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (data !== null) req.write(data);
    req.end();
  });
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const report = () => ({
  ip: '192.168.4.37', fw: 'e2e', uptimeMs: 5000, rssi: -55,
  gpio: { pin: 13, high: true },
  scene: { state: 'active', brightness: 130, motion: 900, darkBelow: 40, motionAtLeast: 300, holdS: 10 },
  person: { score: 0.81, detectAt: 0.6, clearAt: 0.5, detected: true },
  jpeg: JPEG.toString('base64'),
});

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY,
        SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: path.join(tmp, 'relay.log'), SWITCH_FILE: path.join(tmp, 'switch.json'),
      }),
    });
    let out = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 5000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${PUSH_PORT}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}

// Opens the MJPEG stream and resolves with the first part that contains a JPEG.
function firstStreamFrame() {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/detector/${ID}/stream`, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        const all = Buffer.concat(chunks);
        if (all.includes(JPEG)) { req.destroy(); resolve({ type: res.headers['content-type'], found: true }); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.setTimeout(3000, () => { req.destroy(); resolve({ found: false }); });
  });
}

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay');
    return;
  }
  const relay = await startRelay();
  try {
    let r = await request('GET', '/detectors');
    check('no detector known at first', r.status === 200 && Object.keys(r.json).length === 0);

    r = await request('POST', `/detector/${ID}`, { body: report() });
    check('a report without the key is refused (403)', r.status === 403);
    r = await request('POST', `/detector/${ID}`, { headers: { 'X-Api-Key': 'wrong' }, body: report() });
    check('a report with a wrong key is refused (403)', r.status === 403);
    r = await request('POST', `/detector/${ID}`, { headers: { 'X-Api-Key': KEY }, body: { hello: 1 } });
    check('a malformed report is refused (400)', r.status === 400 && /number|object/i.test(r.json.error), JSON.stringify(r.json));
    r = await request('POST', '/detector/bad%20id', { headers: { 'X-Api-Key': KEY }, body: report() });
    check('an invalid detector id is refused (400)', r.status === 400);

    r = await request('POST', `/detector/${ID}`, { headers: { 'X-Api-Key': KEY }, body: report() });
    check('a good report is accepted (200)', r.status === 200);

    r = await request('GET', '/detectors');
    const d = r.json && r.json[ID];
    check('GET /detectors lists the detector as online', !!d && d.online === true, JSON.stringify(r.json));
    check('its numbers and thresholds come back', !!d && d.report.scene.brightness === 130 && d.report.scene.motionAtLeast === 300 &&
      d.report.person.score === 0.81 && d.report.gpio.high === true && d.report.gpio.pin === 13, JSON.stringify(d));
    check('the picture itself is not in the JSON', !!d && d.report.jpeg === undefined);

    r = await request('GET', '/status');
    check('a detector is NOT listed as a camera in /status', r.status === 200 && r.json[ID] === undefined);

    const stream = firstStreamFrame();
    await new Promise((res) => setTimeout(res, 100));
    await request('POST', `/detector/${ID}`, { headers: { 'X-Api-Key': KEY }, body: report() });
    const s = await stream;
    check('the stream is multipart MJPEG and carries the latest picture', s.found && /multipart\/x-mixed-replace/.test(s.type || ''), JSON.stringify(s));

    r = await request('POST', `/alarm/all`);
    check('"alarm all" does not touch the detector', r.status === 200 && !JSON.stringify(r.json).includes(ID), JSON.stringify(r.json));
  } finally {
    relay.kill('SIGTERM');
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
