#!/usr/bin/env node
'use strict';
// test_security_headers_e2e.js — F-06: the PHP side of the safe response headers, on a REAL PHP
// server with NO Apache in front (so it holds even if the vhost's headers are forgotten). Every page
// and endpoint requires auth.php first, so each answer — the page, JSON endpoints, the 401 login
// prompt, the 503 "login not set up" page — must carry nosniff, Referrer-Policy: no-referrer,
// frame-ancestors 'none' (+ X-Frame-Options) and Cache-Control: no-store; a recording keeps its own
// "private, no-cache". (The Apache half is tests/e2e/test_apache_hardening_e2e.js.)
//
// Usage:  node tests/e2e/test_security_headers_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PORT = Number(process.env.E2E_HEADERS_PORT || 19370);
const RELAY_PORT = Number(process.env.E2E_HEADERS_RELAY_PORT || 19371);
const AUTH = { user: 'owner', pass: 'a-good-long-password' };

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
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDashboard(user, pass) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-headers-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${user}', 'auth_pass' => '${pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷']]];\n`);
  return dir;
}
function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', docroot], { stdio: 'ignore' });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PORT}/`, () => r(true)); q.on('error', () => r(false)); });
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
function startFakeRelay() {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      if (req.url.endsWith('.mp4')) { res.setHeader('Content-Type', 'video/mp4'); res.end('x'); }
      else { res.setHeader('Content-Type', 'application/json'); res.end('[]'); }
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}
function get(urlPath, auth) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    const req = nodeHttp.get({ host: '127.0.0.1', port: PORT, path: urlPath, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}
const safe = (r) => r.headers['x-content-type-options'] === 'nosniff'
  && r.headers['referrer-policy'] === 'no-referrer'
  && r.headers['content-security-policy'] === "frame-ancestors 'none'"
  && r.headers['x-frame-options'] === 'DENY';
const detail = (r) => JSON.stringify({ s: r.status, h: r.headers });

async function withDashboard(user, pass, fn) {
  const dir = makeDashboard(user, pass);
  let php;
  try { php = await startPhp(dir); await fn(); } finally { await stopProc(php); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  let relay;
  try {
    relay = await startFakeRelay();
    await withDashboard(AUTH.user, AUTH.pass, async () => {
      let r = await get('/', null);
      check('the 401 login prompt carries the safe headers', r.status === 401 && safe(r) && r.headers['cache-control'] === 'no-store', detail(r));
      const pages = ['/', '/status.php', '/recordings.php?cam=cam-a', '/record.php?cam=cam-a', '/settings.php', '/detector-status.php',
        '/system-settings.php', '/camera-settings.php?cam=cam-a', '/recording-switch.php'];   // (a page that does not exist never reaches PHP: Apache's headers cover that, see the Apache test)
      for (const p of pages) {
        r = await get(p, AUTH);
        check(`${p} (status ${r.status}) has the safe headers and no-store`, safe(r) && r.headers['cache-control'] === 'no-store', detail(r));
      }
      r = await get('/recordings.php?cam=cam-a&play=cam-a-20260101-000000.mp4', AUTH);
      check('a recording is served with "private, no-cache" and the safe headers', r.status === 200 && r.headers['cache-control'] === 'private, no-cache' && safe(r), detail(r));
      check('headers are each sent once (no ", " duplicates)', !/,/.test(r.headers['x-content-type-options'] + r.headers['referrer-policy'] + r.headers['x-frame-options']), detail(r));
    });
    await withDashboard('', '', async () => {
      const r = await get('/', null);
      check('the 503 "login not set up" page carries the safe headers too', r.status === 503 && safe(r), detail(r));
    });
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (relay) relay.close();
  }
  summarize();
}
main();
