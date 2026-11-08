#!/usr/bin/env node
'use strict';
// test_dashboard_switch_e2e.js — end-to-end check of the dashboard's recording
// ON/OFF proxy (php/cameras/recording-switch.php): a REAL PHP server in front
// of a fake relay that records exactly what it is sent.
//
// Switching recording off is what someone who wants to go unrecorded would
// try, so the proxy has to be strict. This checks that:
//   - without the dashboard login it is refused (401)
//   - without the custom X-Requested-With header the dashboard's own script
//     sends, it is refused (403) — a page on another website can't make a
//     browser send that header, so it can't trigger "OFF" with the login the
//     browser has cached
//   - only POST is accepted
//   - with no relay_control_key configured it refuses (503) instead of
//     sending an unauthenticated request
//   - a valid request reaches the relay as the right POST — path, minutes,
//     the control key, and WHO is acting (the logged-in user) — and the relay's
//     answer and status code come back unchanged (so a wrong key shows up as a
//     401 the dashboard can explain)
//   - nonsense never reaches the relay: bad action/scope/minutes (400), an
//     unknown camera or a path-smuggling id (404)
//   - the control key never reaches the browser, in any response or page
//   - a key with a line break (header injection) is refused
//   - an unreachable relay is a 502
//
// Needs `php` on PATH (skips with a message if not). Own ports, a throwaway
// copy of the dashboard with a generated config.php (your real one is never
// read), everything removed afterwards. Core modules only.
//
// Usage:  node tests/e2e/test_dashboard_switch_e2e.js
//         E2E_SWDASH_PORT=19330 E2E_SWDASH_RELAY_PORT=19331 node ...
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_SWDASH_PORT || 19330);
const RELAY_PORT = Number(process.env.E2E_SWDASH_RELAY_PORT || 19331);
const DEAD_PORT = Number(process.env.E2E_SWDASH_DEAD_PORT || 19332);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const KEY = 'a-long-secret-control-key-0123456789';
const CAMS = ['e2e-cam-a', 'e2e-cam-b'];

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

// A throwaway copy of the dashboard with a generated config.
// `keyPhp` is the PHP expression for relay_control_key (or null to leave it out entirely).
function makeDashboard(relayUrl, keyPhp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-swdash-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const cams = CAMS.map((id) => `['id' => '${id}', 'name' => '${id}', 'icon' => '📷']`).join(', ');
  const keyLine = keyPhp === null ? '' : `'relay_control_key' => ${keyPhp}, `;
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => '${relayUrl}', ${keyLine}'cameras' => [${cams}]];\n`);
  return dir;
}

function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${out}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error(`php -S not ready in 5s: ${out}`));
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

// What the fake relay saw, and what it answers. (Loading the dashboard PAGE makes PHP
// ask the relay for the FILES counts too, so "was something forwarded" counts only the
// switch endpoints.)
const seen = [];
const switchCalls = () => seen.filter((x) => x.url.startsWith('/recording/')).length;
let relayAnswer = { status: 200, body: { ok: true } };
function startFakeRelay() {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.statusCode = relayAnswer.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(relayAnswer.body));
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

// A request to the dashboard. opts: { method, auth (default true), ajax (default true) }
function dash(pathAndQuery, { method = 'POST', auth = true, ajax = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (auth) h.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    if (ajax === true) h['X-Requested-With'] = 'camdash';
    else if (typeof ajax === 'string') h['X-Requested-With'] = ajax;
    if (method === 'POST') h['Content-Length'] = 0;
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
const sw = (q, o) => dash(`recording-switch.php?${q}`, o);

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard proxy.');
    finished = true;
    return;
  }
  const dirs = [];
  let php; let relay;
  try {
    relay = await startFakeRelay();
    let docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, `'${KEY}'`);
    dirs.push(docroot);
    php = await startPhp(docroot);

    // ── who may call it ─────────────────────────────────────────────
    let r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=30', { auth: false });
    check('without the dashboard login: refused (401)', r.status === 401, `status=${r.status}`);
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=30', { ajax: false });
    check('logged in but WITHOUT the dashboard\'s request header (what a page on another website would send): refused (403)', r.status === 403 && r.json && r.json.error, JSON.stringify(r));
    r = await sw('scope=camera&cam=e2e-cam-a&action=off', { ajax: 'XMLHttpRequest' });
    check('...a different X-Requested-With value does not pass either (403)', r.status === 403);
    r = await sw('scope=camera&cam=e2e-cam-a&action=off', { method: 'GET' });
    check('GET is not accepted (405) — switching can\'t be triggered by merely opening a link', r.status === 405, `status=${r.status}`);
    check('none of those reached the relay', switchCalls() === 0, JSON.stringify(seen));

    // ── a valid request reaches the relay exactly ───────────────────
    relayAnswer = { status: 200, body: { ok: true, action: 'off', affected: ['e2e-cam-a'], off: { 'e2e-cam-a': { forever: false } } } };
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=30');
    const s1 = seen[seen.length - 1];
    check('a valid OFF is answered with the relay\'s own JSON and status', r.status === 200 && r.json && r.json.ok === true && r.json.affected[0] === 'e2e-cam-a', JSON.stringify(r));
    check('...as a POST to /recording/camera/<id>/off?minutes=30 on the relay', s1 && s1.method === 'POST' && s1.url === '/recording/camera/e2e-cam-a/off?minutes=30', JSON.stringify(s1));
    check('...carrying the control key in X-Control-Key (added by the server — the browser never sent it)', s1 && s1.headers['x-control-key'] === KEY, JSON.stringify(s1 && s1.headers));
    check('...and who is acting, for the relay\'s log', s1 && s1.headers['x-actor'] === `${AUTH.user}@127.0.0.1`, JSON.stringify(s1 && s1.headers['x-actor']));

    await sw('scope=all&action=on');
    check('all cameras ON -> POST /recording/all/on', seen[seen.length - 1].url === '/recording/all/on' && seen[seen.length - 1].method === 'POST', JSON.stringify(seen[seen.length - 1]));
    await sw('scope=all&action=off&minutes=0');
    check('0 minutes passes through unchanged ("until switched ON")', seen[seen.length - 1].url === '/recording/all/off?minutes=0', seen[seen.length - 1].url);
    await sw('scope=camera&cam=e2e-cam-b&action=off&minutes=-15');
    check('a negative number passes through unchanged', seen[seen.length - 1].url === '/recording/camera/e2e-cam-b/off?minutes=-15', seen[seen.length - 1].url);
    await sw('scope=camera&cam=e2e-cam-b&action=off');
    check('no minutes: nothing is invented here — the relay applies its 60-minute default', seen[seen.length - 1].url === '/recording/camera/e2e-cam-b/off', seen[seen.length - 1].url);

    // ── the relay's answers are passed back faithfully ──────────────
    for (const [status, body] of [[401, { error: 'missing or wrong control key' }], [503, { error: 'switching is disabled' }], [400, { error: 'minutes must be a whole number' }]]) {
      relayAnswer = { status, body };
      r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
      check(`a ${status} from the relay comes back as ${status} with its message (so the dashboard can explain it)`, r.status === status && r.json && r.json.error === body.error, JSON.stringify(r));
    }
    relayAnswer = { status: 200, body: { ok: true } };

    // ── nonsense never reaches the relay ────────────────────────────
    const before = switchCalls();
    const bad = [
      ['scope=camera&cam=e2e-cam-a&action=toggle', 400],
      ['scope=camera&cam=e2e-cam-a', 400],
      ['scope=everything&action=off', 400],
      ['scope=camera&cam=e2e-cam-a&action=off&minutes=abc', 400],
      ['scope=camera&cam=e2e-cam-a&action=off&minutes=1.5', 400],
      ['scope=camera&cam=no-such-camera&action=off', 404],
      ['scope=camera&action=off', 404],
      ['scope=camera&cam=..%2F..%2Fx&action=off', 404],
      ['scope=camera&cam=e2e-cam-a%2F..%2Fall&action=off', 404],
    ];
    for (const [q, expected] of bad) {
      r = await sw(q);
      check(`refused with ${expected}: ${q}`, r.status === expected && r.json && typeof r.json.error === 'string', JSON.stringify(r));
    }
    check('...and none of them was forwarded to the relay', switchCalls() === before, `forwarded ${switchCalls() - before}`);

    // ── the key never reaches the browser ───────────────────────────
    const page = await dash('index.php', { method: 'GET', ajax: false });
    check('the dashboard page loads with the switch controls', page.status === 200 && page.text.includes('id="switch-all"') && page.text.includes('id="sw-pill-e2e-cam-a"') && page.text.includes('const SWITCH_ENABLED = true'), `status=${page.status}`);
    check('the control key is NOT in the dashboard page', !page.text.includes(KEY));
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
    check('...nor in the proxy\'s response', !r.text.includes(KEY));

    // ── relay unreachable ───────────────────────────────────────────
    await stopProc(php);
    docroot = makeDashboard(`http://127.0.0.1:${DEAD_PORT}`, `'${KEY}'`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
    check('an unreachable relay is a 502, with a message', r.status === 502 && r.json && r.json.error, JSON.stringify(r));
    await stopProc(php);

    // ── not configured / unsafe key ─────────────────────────────────
    docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, null);
    dirs.push(docroot);
    php = await startPhp(docroot);
    const n = switchCalls();
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
    check('no relay_control_key in config.php: refused (503) with instructions, NOT sent without a key', r.status === 503 && /relay_control_key/.test(r.json.error) && switchCalls() === n, JSON.stringify(r));
    const page2 = await dash('index.php', { method: 'GET', ajax: false });
    check('...and the dashboard shows the buttons as not set up', page2.text.includes('const SWITCH_ENABLED = false'));
    await stopProc(php);

    docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, `''`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
    check('an EMPTY relay_control_key is treated as not configured (503)', r.status === 503 && switchCalls() === n, JSON.stringify(r));
    await stopProc(php);

    docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, `"k\\r\\nX-Evil: 1"`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    r = await sw('scope=camera&cam=e2e-cam-a&action=off&minutes=5');
    check('a control key containing a line break (header injection) is refused (500) and nothing is sent', r.status === 500 && switchCalls() === n, JSON.stringify(r));
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    await stopProc(php);
    if (relay) relay.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    summarize();
  }
}

main();
