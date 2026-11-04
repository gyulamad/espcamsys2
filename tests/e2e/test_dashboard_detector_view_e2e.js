#!/usr/bin/env node
'use strict';
// test_dashboard_detector_view_e2e.js — detector-view.php, the WATCH button's endpoint, on a REAL PHP
// server in front of a fake relay (core modules only: runs without the relay's npm packages).
//   * the dashboard login is needed; POST only; the dashboard's own header (a page on another site cannot send it)
//   * bad parameters never reach the relay: array parameters, unknown action, unknown camera, camera without a detector
//   * a good request reaches the relay as POST /detector/<id>/view?action=... with the CONTROL key and the actor,
//     the detector id and address coming from config.php only; the relay's answer and status are passed on
//   * no control key in config.php: a 503 that says what to add; relay down: a 502 without the relay's address
// Own ports, throwaway dashboard copy. Needs `php` (skips if missing).
//   node tests/e2e/test_dashboard_detector_view_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_DVIEW_PORT || 19444);
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
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

// ── the fake relay ──
const seen = [];
let answer = { status: 200, body: '{"ok":true,"view":{"wanted":true}}' };
function relayHandler(req, res) {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  res.writeHead(answer.status, { 'Content-Type': 'application/json' });
  res.end(answer.body);
}

let docroot, phpTmp;
function makeDashboard(controlKey) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dview-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}'${controlKey ? `, 'relay_control_key' => '${KEY}'` : ''}, 'cameras' => [['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-A'], ['id' => 'camB', 'name' => 'B', 'icon' => 'x']]];\n`);
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

// A request to the dashboard. `own` = the dashboard's own script (the header and same-origin marker).
function call(method, p, { auth = true, own = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${PHP_PORT}` };
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    if (own) Object.assign(headers, { 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin' });
    if (method !== 'GET') headers['Content-Length'] = 0;
    const req = nodeHttp.request({ host: '127.0.0.1', port: PHP_PORT, path: '/' + p, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; const relay = nodeHttp.createServer(relayHandler);
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dview-tmp-'));

    // no control key configured
    docroot = makeDashboard(false);
    php = await startPhp(docroot);
    let r = await call('POST', 'detector-view.php?cam=camA&action=on');
    check('no relay_control_key in config.php: a 503 that says what to add, the relay is not called', r.status === 503 && /relay_control_key/.test(r.json.error) && seen.length === 0, `${r.status} ${r.text}`);
    await stopProc(php); fs.rmSync(docroot, { recursive: true, force: true });

    docroot = makeDashboard(true);
    php = await startPhp(docroot);
    const U = 'detector-view.php?cam=camA&action=on';
    r = await call('POST', U, { auth: false });
    check('needs the dashboard login', r.status === 401 && seen.length === 0, String(r.status));
    r = await call('GET', U);
    check('GET is refused (POST only)', r.status === 405 && r.headers.allow === 'POST', `${r.status}`);
    r = await call('POST', U, { own: false });
    check('without the dashboard\'s own header a page on another site cannot use the login: 403', r.status === 403 && seen.length === 0, String(r.status));

    for (const [name, q] of [['an unknown action', 'detector-view.php?cam=camA&action=toggle'], ['no action', 'detector-view.php?cam=camA'], ['an array camera', 'detector-view.php?cam[]=camA&action=on'], ['an array action', 'detector-view.php?cam=camA&action[]=on'], ['an unknown camera', 'detector-view.php?cam=nope&action=on'], ['a camera without a detector', 'detector-view.php?cam=camB&action=on']]) {
      r = await call('POST', q);
      check(`${name} is refused with a 4xx and the relay is not called`, r.status >= 400 && r.status < 500 && seen.length === 0, `${r.status} ${r.text}`);
    }

    for (const a of ['on', 'keep', 'off']) {
      seen.length = 0;
      r = await call('POST', `detector-view.php?cam=camA&action=${a}`);
      check(`${a}: reaches the relay as POST /detector/det-A/view?action=${a}`, r.status === 200 && seen.length === 1 && seen[0].method === 'POST' && seen[0].url === `/detector/det-A/view?action=${a}`, `${r.status} ${JSON.stringify(seen)}`);
      check(`${a}: the control key and the actor go along, the relay's answer comes back`, seen[0] && seen[0].headers['x-control-key'] === KEY && /^owner@/.test(seen[0].headers['x-actor'] || '') && r.json && r.json.ok === true, JSON.stringify(seen[0] && seen[0].headers));
    }
    seen.length = 0;
    r = await call('POST', 'detector-view.php?cam=camA&action=on&detector=other&url=http://evil');
    check('the detector id and the relay address come from config.php only', r.status === 200 && seen.length === 1 && seen[0].url === '/detector/det-A/view?action=on', JSON.stringify(seen));

    answer = { status: 404, body: '{"error":"no detector called \'det-A\' has connected to the relay since it started"}' };
    r = await call('POST', U);
    check('the relay\'s own refusal (404) is passed on with its reason', r.status === 404 && /has connected to the relay/.test(r.json.error), `${r.status} ${r.text}`);
    answer = { status: 401, body: '{"error":"missing or wrong control key"}' };
    r = await call('POST', U);
    check('a wrong control key is reported as the relay says (401)', r.status === 401 && /control key/.test(r.json.error), `${r.status} ${r.text}`);

    await new Promise((res) => relay.close(res));
    r = await call('POST', U);
    check('relay down: a 502 without the relay\'s address', r.status === 502 && !r.text.includes(String(RELAY_PORT)), `${r.status} ${r.text}`);
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    try { relay.close(); } catch (e) { /* closed */ }
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
