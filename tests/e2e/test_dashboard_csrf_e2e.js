#!/usr/bin/env node
'use strict';
// test_dashboard_csrf_e2e.js — F-02: the dashboard's state-changing endpoints (record.php start/stop,
// recordings.php delete / delete-all / seen, and the retired settings.php POST) must refuse a request
// that did not come from the dashboard's own page — a REAL PHP server in front of a fake relay that
// records exactly what it is sent. Checks that:
//   - a cross-site form POST (foreign Origin, form content type, no custom header) is refused (403)
//     and never reaches the relay — for every one of those endpoints
//   - the custom header alone is not enough when the browser says the request is cross-site
//     (foreign Origin, Sec-Fetch-Site: cross-site)
//   - the dashboard's own request (header + same Origin) goes through to the relay, with the control
//     key and X-Actor, and deletes leave an audit line in the web server's error log
//   - seconds above 3600 (and junk, arrays) never reach the relay
//   - POST to the old settings.php is refused (405); GET still works; plain reads need no header
//   - the dashboard page's own fetch() calls send the header (so the real buttons keep working)
// Needs `php` on PATH (skips if missing). Own ports, throwaway dashboard copy, core modules only.
//
// Usage:  node tests/e2e/test_dashboard_csrf_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_CSRF_PORT || 19340);
const RELAY_PORT = Number(process.env.E2E_CSRF_RELAY_PORT || 19341);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const KEY = 'a-long-secret-control-key-0123456789';
const CAM = 'e2e-cam-a';
const FILE = 'e2e-cam-a-20260101-000000.mp4';

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

function makeDashboard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-csrf-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [['id' => '${CAM}', 'name' => '${CAM}', 'icon' => '📷']]];\n`);
  return dir;
}

let phpLog = '';
function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { phpLog += d.toString(); });
    child.stderr.on('data', (d) => { phpLog += d.toString(); });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${phpLog}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
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

const seen = [];
const mutating = () => seen.filter((x) => x.method !== 'GET');
function startFakeRelay() {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/recordings/') && req.method === 'GET' ? [] : { ok: true }));
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

// What a browser would send. kind: 'own' (the dashboard page itself), 'form' (a cross-site <form>),
// 'xsite-fetch' (header present, but the browser marks it cross-site), 'curl' (header only, no Origin).
function dash(pathAndQuery, kind, method = 'POST') {
  return new Promise((resolve, reject) => {
    const h = { Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64'), Host: `127.0.0.1:${PHP_PORT}` };
    if (method === 'POST') h['Content-Length'] = 0;
    if (kind === 'own') Object.assign(h, { 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin' });
    if (kind === 'curl') h['X-Requested-With'] = 'camdash';
    if (kind === 'form') Object.assign(h, { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' });
    if (kind === 'xsite-fetch') Object.assign(h, { 'X-Requested-With': 'camdash', Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    const req = nodeHttp.request(`http://127.0.0.1:${PHP_PORT}/${pathAndQuery}`, { method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  let php; let relay; const dirs = [];
  try {
    relay = await startFakeRelay();
    const docroot = makeDashboard();
    dirs.push(docroot);
    php = await startPhp(docroot);

    const endpoints = [
      ['record.php start', `record.php?cam=${CAM}&seconds=60`],
      ['record.php stop', `record.php?cam=${CAM}&stop=1`],
      ['recordings.php delete one', `recordings.php?cam=${CAM}&delete=${FILE}`],
      ['recordings.php delete ALL', `recordings.php?cam=${CAM}&deleteAll=1`],
      ['recordings.php mark seen', `recordings.php?cam=${CAM}&seen=${FILE}`],
    ];

    // ── attacks are refused and never reach the relay ───────────────
    for (const [name, q] of endpoints) {
      let r = await dash(q, 'form');
      check(`${name}: a cross-site form POST (no header, foreign Origin) is refused (403)`, r.status === 403, `status=${r.status} ${r.text}`);
      r = await dash(q, 'xsite-fetch');
      check(`${name}: header present but the browser says cross-site: refused (403)`, r.status === 403, `status=${r.status}`);
    }
    let r = await dash(`settings.php?alarmRecordSeconds=999999999`, 'form');
    check('settings.php: the old POST is gone (405) even for a cross-site form', r.status === 405, `status=${r.status}`);
    r = await dash(`settings.php?alarmRecordSeconds=45`, 'own');
    check('settings.php: ...and for the dashboard\'s own request (405, use system-settings.php)', r.status === 405, `status=${r.status}`);
    check('none of those reached the relay', mutating().length === 0, JSON.stringify(mutating()));

    // ── the dashboard's own request works and carries key + actor ───
    const expect = [
      ['record.php start', `record.php?cam=${CAM}&seconds=60`, 'POST', `/record/${CAM}?seconds=60`],
      ['record.php stop', `record.php?cam=${CAM}&stop=1`, 'POST', `/record/${CAM}/stop`],
      ['recordings.php delete one', `recordings.php?cam=${CAM}&delete=${FILE}`, 'DELETE', `/recordings/${CAM}/${FILE}`],
      ['recordings.php delete ALL', `recordings.php?cam=${CAM}&deleteAll=1`, 'DELETE', `/recordings/${CAM}`],
      ['recordings.php mark seen', `recordings.php?cam=${CAM}&seen=${FILE}`, 'POST', `/recordings/${CAM}/${FILE}/seen`],
    ];
    for (const [name, q, method, relayUrl] of expect) {
      const before = seen.length;
      r = await dash(q, 'own');
      const call = seen[seen.length - 1];
      check(`${name}: the dashboard's own request is accepted (200)`, r.status === 200 && seen.length === before + 1, `status=${r.status} ${r.text}`);
      check(`${name}: reaches the relay as ${method} ${relayUrl}`, call && call.method === method && call.url === relayUrl, JSON.stringify(call));
      check(`${name}: ...with the control key and who did it`, call && call.headers['x-control-key'] === KEY && call.headers['x-actor'] === `${AUTH.user}@127.0.0.1`, JSON.stringify(call && call.headers));
    }
    r = await dash(`recordings.php?cam=${CAM}&delete=${FILE}`, 'curl');
    check('a request with the header and no Origin (curl, old browsers) still works', r.status === 200, `status=${r.status}`);

    // ── seconds are capped ──────────────────────────────────────────
    const n = mutating().length;
    for (const bad of ['3601', '999999999', '0', '-1', 'abc', '[]=5']) {
      const q = bad === '[]=5' ? `record.php?cam=${CAM}&seconds[]=5` : `record.php?cam=${CAM}&seconds=${bad}`;
      r = await dash(q, 'own');
      check(`record.php: seconds ${bad} is refused (400) and never reaches the relay`, r.status === 400, `status=${r.status} ${r.text}`);
    }
    check('...nothing was forwarded', mutating().length === n);
    r = await dash(`record.php?cam=${CAM}&seconds=3600`, 'own');
    check('record.php: 3600 (the maximum) is accepted', r.status === 200, `status=${r.status}`);

    // ── reads still work without the header ─────────────────────────
    r = await dash(`recordings.php?cam=${CAM}`, 'form', 'GET');
    check('GET recordings.php (the list) needs no header', r.status === 200 && Array.isArray(r.json), `status=${r.status}`);
    r = await dash(`record.php?cam=${CAM}`, 'form', 'GET');
    check('GET record.php (status) needs no header', r.status === 200, `status=${r.status}`);
    r = await dash('settings.php', 'curl', 'GET');
    check('GET settings.php still reads the relay\'s settings', r.status === 200, `status=${r.status}`);

    // ── audit trail ─────────────────────────────────────────────────
    await sleep(200);
    check('deleting leaves an audit line with who and what', phpLog.includes(`camdash audit: ${AUTH.user}@127.0.0.1 delete ALL recordings of ${CAM}`) && phpLog.includes(`delete recording ${CAM}/${FILE}`), phpLog.slice(-600));
    check('...and so do start and stop', phpLog.includes(`start recording ${CAM} for 60s`) && phpLog.includes(`stop recording ${CAM}`));
    check('the control key is not written to the log', !phpLog.includes(KEY));

    // ── the page's own buttons keep working: its fetch() calls carry the header ──
    const page = fs.readFileSync(path.join(DASH_SRC, 'index.php'), 'utf8');
    const posts = page.match(/fetch\([^;]*?\{ method: 'POST'[^;]*?\}/g) || [];
    check('index.php has POST fetch calls to check', posts.length >= 6, String(posts.length));
    check('every POST fetch in index.php sends X-Requested-With', posts.every((p) => p.includes("'X-Requested-With': 'camdash'")), posts.filter((p) => !p.includes('X-Requested-With')).join('\n'));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    if (relay) relay.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  summarize();
}
main();
