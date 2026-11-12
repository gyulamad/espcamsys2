#!/usr/bin/env node
'use strict';
// test_dashboard_stream_smooth_e2e.js — small live pictures reach the browser ONE BY ONE.
// PHP's blocking fread() on the relay's stream waits for a whole 8 KB buffer, so the detector's tiny
// 96x96 JPEGs (1-3 KB) used to come out in bursts about once a second even though the board sent ten a
// second: "less than a frame per second" on screen. Real php -S in front of a fake relay that sends a
// small picture every 100 ms on the mux stream, through mux.php, once for a camera's picture and once for the
// detector's; each picture must arrive as its own separate delivery. Core modules only; skips if php is missing.
//   node tests/e2e/test_dashboard_stream_smooth_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_SMOOTH_PORT || 19460);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';
const PERIOD_MS = 100;
const RUN_MS = 3000;

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const enc = require('../../nodejs/camera-relay/lib/muxcodec');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const picture = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n - 4, 1), Buffer.from([0xff, 0xd9])]);
const relay = nodeHttp.createServer((req, res) => {
  const source = { '/mux?cams=camA': enc.cameraSource('camA'), '/mux?dets=detA': enc.detectorSource('detA') }[req.url];
  if (source === undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
  const message = enc.encodeFrame(source, picture(1200));
  res.writeHead(200, { 'Content-Type': enc.CONTENT_TYPE, Connection: 'close' });
  const t = setInterval(() => res.write(message), PERIOD_MS);
  req.on('close', () => clearInterval(t));
});

let phpTmp, docroot;
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-smooth-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'detA']]];\n`);
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

// Counts the separate deliveries (data events more than 30 ms apart) of one stream page over RUN_MS.
function deliveries(page) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64'), 'X-Requested-With': 'camdash', 'Sec-Fetch-Site': 'same-origin' };
    const req = nodeHttp.get({ host: '127.0.0.1', port: PHP_PORT, path: page, headers }, (res) => {
      const times = [];
      let bytes = 0;
      res.on('data', (c) => { times.push(Date.now()); bytes += c.length; });
      setTimeout(() => {
        req.destroy();
        let groups = 0, last = -1e9;
        for (const t of times) { if (t - last > 30) groups++; last = t; }
        resolve({ status: res.statusCode, groups, bytes });
      }, RUN_MS);
    });
    req.on('error', reject);
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php;
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-smooth-tmp-'));
    docroot = makeDashboard();
    php = await startPhp(docroot);
    const expected = RUN_MS / PERIOD_MS;
    for (const page of ['/mux.php?dets=camA', '/mux.php?cams=camA']) {
      const r = await deliveries(page);
      check(`${page}: 200 and pictures flow`, r.status === 200 && r.bytes > 0, `status ${r.status}, ${r.bytes} bytes`);
      check(`${page}: ten small pictures a second arrive as ~ten separate deliveries, not in bursts (${r.groups} of ${expected})`, r.groups >= expected * 0.8, `${r.groups} deliveries`);
    }
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (php) { php.removeAllListeners('exit'); php.kill('SIGKILL'); }
    try { relay.close(); } catch (e) { /* closed */ }
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
