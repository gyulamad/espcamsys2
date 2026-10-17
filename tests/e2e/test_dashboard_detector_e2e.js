#!/usr/bin/env node
'use strict';
// test_dashboard_detector_e2e.js — the person-detector row of the dashboard, through a real PHP
// server (php -S) and the real relay (server.js):
//   * index.php shows the detector row (picture + value fields) ONLY for a camera that has a
//     'detector' in config.php
//   * detector-status.php returns the detector's numbers (reported to the relay) keyed by CAMERA id,
//     and "offline, no numbers" for a paired detector the relay has never heard from
//   * detector-stream.php pipes the detector's MJPEG picture; a camera without detector gets 404
//   * both need the dashboard login
// Skips (exit 0) when php is missing. Own ports, temp copy of the dashboard, core modules only.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PHP_PORT = Number(process.env.E2E_DDET_PORT || 19310);
const RELAY_PORT = Number(process.env.E2E_DDET_RELAY_PORT || 19311);
const PUSH_PORT = Number(process.env.E2E_DDET_PUSH_PORT || 19312);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const KEY = 'e2e-key';

let pass = 0, fail = 0, finished = false;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p, { auth = true, wantBody = true, until } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64') } : {};
    const req = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}${p}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (until && until(Buffer.concat(chunks))) { req.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.setTimeout(5000, () => req.destroy(new Error('timeout ' + p)));
  });
}
function postRelay(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = nodeHttp.request(`http://127.0.0.1:${RELAY_PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Api-Key': KEY } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(data);
  });
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const report = () => ({
  ip: '10.0.0.5', fw: 'e2e', uptimeMs: 1000, rssi: -50,
  gpio: { pin: 13, high: true },
  scene: { state: 'active', brightness: 111, motion: 777, darkBelow: 40, motionAtLeast: 300, holdS: 10 },
  person: { score: 0.9, detectAt: 0.6, clearAt: 0.5, detected: true },
  jpeg: JPEG.toString('base64'),
});

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed'); finished = true; return; }
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) { check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ddet-'));
  const dash = path.join(tmp, 'dash');
  fs.mkdirSync(dash);
  spawnSync('cp', ['-r', DASH_SRC + '/.', dash]);
  fs.rmSync(path.join(dash, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dash, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [` +
    `['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-A'], ['id' => 'camB', 'name' => 'B', 'icon' => 'y'], ['id' => 'camC', 'name' => 'C', 'icon' => 'z', 'detector' => 'det-C']]];\n`);

  let createdConfig = false;
  if (!fs.existsSync(CONFIG_PATH)) { fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n"); createdConfig = true; }

  const relay = spawn('node', ['server.js'], { cwd: RELAY_DIR, env: Object.assign({}, process.env, { PORT: String(RELAY_PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SETTINGS_FILE: path.join(tmp, 's.json'), LOG_FILE: path.join(tmp, 'r.log'), SWITCH_FILE: path.join(tmp, 'sw.json') }) });
  // several workers: a stream request keeps one busy until the next frame arrives
  const php = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dash], { stdio: 'ignore', env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' }) });
  try {
    const t0 = Date.now();
    for (;;) {   // wait until both answer
      const up = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${RELAY_PORT}/detectors`, () => r(true)); q.on('error', () => r(false)); });
      const up2 = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
      if (up && up2) break;
      if (Date.now() - t0 > 8000) throw new Error('relay/php not ready');
      await sleep(150);
    }

    check('detector-status.php needs the dashboard login', (await get('/detector-status.php', { auth: false })).status === 401);
    check('detector-stream.php needs the dashboard login', (await get('/detector-stream.php?cam=camA', { auth: false })).status === 401);

    const page = (await get('/index.php')).body.toString('utf8');
    check('camera with a detector gets the detector row', page.includes('id="det-camA"') && page.includes('detector-stream.php?cam=camA'));
    check('the row has the value fields (brightness, motion, human, alarm pin)',
      ['detbright-camA', 'detmotion-camA', 'detperson-camA', 'detpin-camA', 'detgate-camA'].every((i) => page.includes(`id="${i}"`)));
    check('a camera without detector gets no row', !page.includes('id="det-camB"') && !page.includes('detector-stream.php?cam=camB'));

    let r = await get('/detector-status.php');
    let j = JSON.parse(r.body.toString('utf8'));
    check('before any report: paired cameras are offline without numbers; unpaired camera absent',
      r.status === 200 && Object.keys(j).sort().join() === 'camA,camC' && j.camA.online === false && j.camA.report === null && j.camA.detector === 'det-A', r.body.toString());

    check('the detector reports to the relay', (await postRelay('/detector/det-A', report())) === 200);
    r = await get('/detector-status.php');
    j = JSON.parse(r.body.toString('utf8'));
    check('detector-status.php shows its numbers under the CAMERA id', j.camA.online === true && j.camA.report.scene.brightness === 111 &&
      j.camA.report.scene.motionAtLeast === 300 && j.camA.report.person.score === 0.9 && j.camA.report.gpio.high === true && j.camA.report.gpio.pin === 13, r.body.toString());
    check('the other paired camera is still offline', j.camC.online === false);

    r = await get('/detector-stream.php?cam=camA', { until: (b) => b.includes(JPEG) });
    check('detector-stream.php pipes the detector picture as MJPEG', r.status === 200 && /multipart\/x-mixed-replace/.test(r.type || '') && r.body.includes(JPEG), `${r.status} ${r.type}`);
    check('a camera without a detector gets 404 from detector-stream.php', (await get('/detector-stream.php?cam=camB')).status === 404);
    check('an unknown camera gets 404 from detector-stream.php', (await get('/detector-stream.php?cam=nope')).status === 404);
  } finally {
    relay.kill('SIGTERM'); php.kill('SIGTERM');
    await sleep(200);
    if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
