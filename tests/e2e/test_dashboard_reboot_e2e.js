#!/usr/bin/env node
'use strict';
// test_dashboard_reboot_e2e.js — end-to-end check of the dashboard's reset endpoint
// (php/cameras/reboot.php): a REAL PHP server in front of a fake relay that records exactly what it is sent.
//
// Resetting a board is a hard action, so the endpoint is strict. This checks that:
//   - without the dashboard login (401), without the dashboard's own X-Requested-With header (403), or
//     with GET (405) it is refused and nothing reaches the relay
//   - with no relay_control_key configured it refuses (503) rather than call the relay without one
//   - a valid detector reset reaches the relay as POST /device-settings/detector/<paired id>/reboot,
//     with the control key and who is acting, and the dashboard answers { ok, target, message }
//   - the relay's refusals (409 never reported, 401 wrong key ...) come back with their own message
//   - targets that are not built yet are 501, unknown ones 400, unknown/unpaired cameras 404 - none forwarded
//   - the control key never reaches the browser; a key with a line break is refused; a dead relay is 502
//
// Needs `php` on PATH (skips if not). Own ports, a throwaway dashboard copy with a generated config.php.
// Usage:  node tests/e2e/test_dashboard_reboot_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_REBOOT_PORT || 19340);
const RELAY_PORT = Number(process.env.E2E_REBOOT_RELAY_PORT || 19341);
const DEAD_PORT = Number(process.env.E2E_REBOOT_DEAD_PORT || 19342);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const KEY = 'a-long-secret-control-key-0123456789';
const CAMS = [['e2e-cam-a', 'e2e-det-a'], ['e2e-cam-b', null]];   // [camera id, paired detector id]

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rbdash-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const cams = CAMS.map(([id, det]) => `['id' => '${id}', 'name' => '${id}', 'icon' => '📷'${det ? `, 'detector' => '${det}'` : ''}`+']').join(', ');
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
// ask the relay for other things too, so "was something forwarded" counts only the reboot endpoint.)
const seen = [];
const rebootCalls = () => seen.filter((x) => x.url.endsWith('/reboot')).length;
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
const rb = (q, o) => dash(`reboot.php?${q}`, o);

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard endpoint.');
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
    const Q = 'target=detector&cam=e2e-cam-a';

    let r = await rb(Q, { auth: false });
    check('without the dashboard login: refused (401)', r.status === 401, `status=${r.status}`);
    r = await rb(Q, { ajax: false });
    check('without the dashboard\'s request header: refused (403)', r.status === 403 && r.json && r.json.error, JSON.stringify(r));
    r = await rb(Q, { method: 'GET' });
    check('GET is not accepted (405): a link cannot reset a board', r.status === 405, `status=${r.status}`);
    check('none of those reached the relay', rebootCalls() === 0, JSON.stringify(seen));

    relayAnswer = { status: 200, body: { ok: true, rev: 7, command: 'reboot' } };
    r = await rb(Q);
    const s1 = seen[seen.length - 1];
    check('a valid detector reset is answered { ok, target, message }', r.status === 200 && r.json && r.json.ok === true && r.json.target === 'detector' && /30 seconds/.test(r.json.message), JSON.stringify(r));
    check('...as a POST to the PAIRED detector id on the relay', s1 && s1.method === 'POST' && s1.url === '/device-settings/detector/e2e-det-a/reboot', JSON.stringify(s1));
    check('...with the control key (added by the server)', s1 && s1.headers['x-control-key'] === KEY, JSON.stringify(s1 && s1.headers));
    check('...and who is acting', s1 && s1.headers['x-actor'] === `${AUTH.user}@127.0.0.1`, JSON.stringify(s1 && s1.headers['x-actor']));

    for (const [status, error] of [[409, 'this device has not reported yet'], [401, 'missing or wrong control key'], [503, 'disabled']]) {
      relayAnswer = { status, body: { error } };
      r = await rb(Q);
      check(`a ${status} from the relay comes back as ${status} with its own message`, r.status === status && r.json && r.json.error === error && !r.json.ok, JSON.stringify(r));
    }
    relayAnswer = { status: 200, body: { ok: false } };
    r = await rb(Q);
    check('a 200 that does not say ok is not reported as success (502)', r.status === 502 && r.json && r.json.error, JSON.stringify(r));
    relayAnswer = { status: 200, body: { ok: true } };

    const before = rebootCalls();
    const bad = [
      ['target=toaster&cam=e2e-cam-a', 400],
      ['cam=e2e-cam-a', 400],
      ['target[]=detector&cam=e2e-cam-a', 400],
      ['target=camera&cam=e2e-cam-a', 501],
      ['target=both&cam=e2e-cam-a', 501],
      ['target=nodejs', 501],
      ['target=php', 501],
      ['target=relay', 501],
      ['target=all', 501],
      ['target=detector&cam=no-such-camera', 404],
      ['target=detector', 404],
      ['target=detector&cam=e2e-cam-b', 404],
      ['target=detector&cam=..%2F..%2Fx', 404],
      ['target=detector&cam=e2e-cam-a%2F..%2Fx', 404],
    ];
    for (const [q, expected] of bad) {
      r = await rb(q);
      check(`refused with ${expected}: ${q}`, r.status === expected && r.json && typeof r.json.error === 'string', JSON.stringify(r));
    }
    check('...and none of them was forwarded to the relay', rebootCalls() === before, `forwarded ${rebootCalls() - before}`);

    const page = await dash('index.php', { method: 'GET', ajax: false });
    check('the control key is NOT in the dashboard page', page.status === 200 && !page.text.includes(KEY));
    r = await rb(Q);
    check('...nor in the endpoint\'s response', !r.text.includes(KEY));

    await stopProc(php);
    docroot = makeDashboard(`http://127.0.0.1:${DEAD_PORT}`, `'${KEY}'`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    r = await rb(Q);
    check('an unreachable relay is a 502, with a message', r.status === 502 && r.json && r.json.error, JSON.stringify(r));
    await stopProc(php);

    docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, null);
    dirs.push(docroot);
    php = await startPhp(docroot);
    const n = rebootCalls();
    r = await rb(Q);
    check('no relay_control_key: refused (503) with instructions, nothing sent', r.status === 503 && /relay_control_key/.test(r.json.error) && rebootCalls() === n, JSON.stringify(r));
    await stopProc(php);

    docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`, `"k\\r\\nX-Evil: 1"`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    r = await rb(Q);
    check('a control key with a line break (header injection) is refused (500), nothing sent', r.status === 500 && rebootCalls() === n, JSON.stringify(r));
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
