#!/usr/bin/env node
'use strict';
// test_config_overrides_e2e.js — F-18 / F-10: where the dashboard keeps what you change on its settings
// pages, on a REAL PHP server. With the data/ folder that deploy.sh makes:
//   - a save (cameras, login) goes to data/settings.json; config.php is byte-for-byte untouched and can be
//     read-only; the file is mode 0600, whole JSON, with no temporary file left behind
//   - 30 saves fired at the same moment lose nothing
//   - a damaged settings.json (a power cut) does not take the dashboard down: it keeps running on
//     config.php, the damage is logged, and the next save repairs the file; so does an empty one
//   - a tampered file cannot add settings, put in wrong types or an attack camera id
//   - a changed password takes effect from settings.json (the old one stops working)
// And without data/ (before deploy.sh has run as root) the old way still works: config.php is rewritten.
// Needs `php` on PATH (skips if missing). Own ports, throwaway dashboard copies, core modules only.
//
// Usage:  node tests/e2e/test_config_overrides_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_OVERRIDES_PORT || 19420);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const USER = 'owner';
const PASS = 'base-password-123';

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

function makeDashboard(withData) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-overrides-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${USER}', 'auth_pass' => '${PASS}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => 'a-long-secret-control-key-0123456789', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '📷']]];\n`);
  if (withData) fs.mkdirSync(path.join(dir, 'data'), { mode: 0o700 });
  return dir;
}
let phpLog = '';
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '8' } });
    child.stdout.on('data', (d) => { phpLog += d; });
    child.stderr.on('data', (d) => { phpLog += d; });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
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

// The dashboard's own page talking to PHP (header + same Origin), like a browser would.
function dash(method, pathAndQuery, { body, user = USER, pass = PASS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      Host: `127.0.0.1:${PHP_PORT}`, 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin',
    };
    if (method !== 'GET') headers['Content-Length'] = payload ? Buffer.byteLength(payload) : 0;
    if (payload) headers['Content-Type'] = 'application/json';
    const req = nodeHttp.request({ host: '127.0.0.1', port: PHP_PORT, path: '/' + pathAndQuery, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, text: data, json }); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}
const addCam = (id, name = 'Cam ' + id, o = {}) => dash('POST', 'camera-admin.php', { body: { action: 'add', id, name, icon: '🎥' }, ...o });

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  const relay = nodeHttp.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('[]'); });
  await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
  let php; const dirs = [];
  try {
    // ════════ with data/ (after deploy.sh) ════════
    let dir = makeDashboard(true);
    dirs.push(dir);
    const cfgPath = path.join(dir, 'config.php');
    const setPath = path.join(dir, 'data', 'settings.json');
    const configBefore = fs.readFileSync(cfgPath, 'utf8');
    fs.chmodSync(cfgPath, 0o444);   // read-only: saving must never need it
    php = await startPhp(dir);
    const settings = () => JSON.parse(fs.readFileSync(setPath, 'utf8'));
    const leftovers = () => fs.readdirSync(path.join(dir, 'data')).filter((f) => !['settings.json', 'settings.lock'].includes(f));

    let r = await dash('GET', 'index.php');
    check('the dashboard runs on config.php alone', r.status === 200 && r.text.includes('Front door'), `status=${r.status}`);

    r = await addCam('cam-b', 'Garage');
    check('adding a camera works with config.php read-only', r.status === 200 && r.json && r.json.ok === true, `status=${r.status} ${r.text.slice(0, 160)}`);
    check('config.php is byte-for-byte untouched', fs.readFileSync(cfgPath, 'utf8') === configBefore);
    check('the camera is saved in data/settings.json (JSON, only what differs from config.php)', Object.keys(settings()).join() === 'cameras' && settings().cameras.some((c) => c.id === 'cam-b'), fs.readFileSync(setPath, 'utf8'));
    check('...mode 0600, no temporary file left', (fs.statSync(setPath).mode & 0o777) === 0o600 && leftovers().length === 0, `${(fs.statSync(setPath).mode & 0o777).toString(8)} ${leftovers()}`);
    r = await dash('GET', 'index.php');
    check('the page shows both cameras: the one from config.php and the new one', r.text.includes('Front door') && r.text.includes('Garage'));

    // rename + detector pairing + removal all go through the same path
    r = await dash('POST', 'camera-admin.php', { body: { action: 'update', id: 'cam-b', name: 'Garage door', icon: '🚗' } });
    check('renaming a camera works', r.status === 200 && settings().cameras.find((c) => c.id === 'cam-b').name === 'Garage door', r.text.slice(0, 150));
    r = await dash('POST', 'camera-admin.php', { body: { action: 'remove', id: 'cam-b' } });
    check('removing a camera works; the list is config.php\'s again, so no override is kept', r.status === 200 && settings().cameras === undefined, `${r.text.slice(0, 100)} ${fs.readFileSync(setPath, 'utf8')}`);
    r = await dash('GET', 'index.php');
    check('...the page shows only the camera from config.php', r.text.includes('Front door') && !r.text.includes('Garage'));
    const stampBefore = fs.statSync(setPath).mtimeMs;
    r = await dash('POST', 'camera-admin.php', { body: { action: 'add', id: 'cam-a', name: 'duplicate', icon: 'x' } });
    check('a refused change (duplicate id) is a 400 and writes nothing', r.status === 400 && fs.statSync(setPath).mtimeMs === stampBefore, `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await dash('POST', 'camera-admin.php', { body: { action: 'nonsense', id: 'x' } });
    check('an unknown action is a 400', r.status === 400);

    // ── many saves at the same moment ──
    const ids = Array.from({ length: 30 }, (_, i) => `par-${i}`);
    const results = await Promise.all(ids.map((id) => addCam(id)));
    check('30 saves at the same moment all succeed', results.every((x) => x.status === 200), results.filter((x) => x.status !== 200).map((x) => x.text.slice(0, 80)).join(' | '));
    const have = settings().cameras.map((c) => c.id);
    check('...and none of them is lost', ids.every((id) => have.includes(id)) && have.includes('cam-a') && have.length === 31, `${have.length} cameras: ${have.join(',')}`);
    check('...the file is whole JSON and no temporary file is left', leftovers().length === 0);
    check('config.php is still untouched', fs.readFileSync(cfgPath, 'utf8') === configBefore);

    // ── a damaged file (power cut) ──
    const good = fs.readFileSync(setPath, 'utf8');
    fs.writeFileSync(setPath, good.slice(0, Math.floor(good.length / 2)));
    phpLog = '';
    fs.rmSync(path.join(os.tmpdir(), 'camdash-log-' + require('crypto').createHash('sha1').update('settings-invalid:' + setPath).digest('hex')), { force: true });
    r = await dash('GET', 'index.php');
    check('a half-written settings.json does NOT take the dashboard down (200, running on config.php)', r.status === 200 && r.text.includes('Front door') && !r.text.includes('par-3'), `status=${r.status}`);
    r = await dash('GET', 'status.php');
    check('...the other pages too', r.status === 200, `status=${r.status}`);
    await sleep(150);
    check('...and the damage is in the error log, naming the file', /is not valid JSON/.test(phpLog) && phpLog.includes('settings.json'), phpLog.slice(-300));
    r = await addCam('after-crash', 'After');
    check('the next save repairs the file', r.status === 200 && Array.isArray(settings().cameras) && settings().cameras.some((c) => c.id === 'after-crash') && settings().cameras.some((c) => c.id === 'cam-a'), fs.readFileSync(setPath, 'utf8').slice(0, 200));
    fs.writeFileSync(setPath, '');
    r = await dash('GET', 'index.php');
    check('an empty settings.json is fine (nothing saved yet)', r.status === 200 && r.text.includes('Front door'), `status=${r.status}`);
    fs.writeFileSync(setPath, '\0\0\0\0');
    r = await dash('GET', 'index.php');
    check('a file of zero bytes (the classic SD-card result) is fine too', r.status === 200, `status=${r.status}`);

    // ── a tampered file ──
    fs.writeFileSync(setPath, JSON.stringify({
      evil_setting: '<script>1</script>', auth_user: 5, auth_pass: ['x'], record_seconds: '60',
      cameras: [{ id: "a');window.__pwned=1;('", name: 'ATTACKCAM' }, { id: 'fine-cam', name: 'Fine one', icon: '✅' }],
    }));
    r = await dash('GET', 'index.php');
    check('a tampered file: wrong types are ignored, an attack camera id never reaches the page', r.status === 200 && !r.text.includes('ATTACKCAM') && !r.text.includes('__pwned') && !r.text.includes('evil_setting') && r.text.includes('Fine one'), `status=${r.status}`);
    fs.writeFileSync(setPath, '{}\n');

    // ── the login ──
    r = await dash('POST', 'system-settings.php', { body: { values: { auth_pass: 'brand-new-pass-456' } } });
    check('changing the password on the settings page works', r.status === 200 && r.json && /Saved/.test(r.json.message || ''), `status=${r.status} ${r.text.slice(0, 200)}`);
    check('...it is saved in settings.json, config.php still has the old one', settings().auth_pass === 'brand-new-pass-456' && fs.readFileSync(cfgPath, 'utf8') === configBefore);
    r = await dash('GET', 'index.php', { pass: PASS });
    check('...the OLD password no longer works', r.status === 401, `status=${r.status}`);
    r = await dash('GET', 'index.php', { pass: 'brand-new-pass-456' });
    check('...the new one does', r.status === 200, `status=${r.status}`);
    r = await dash('POST', 'system-settings.php', { pass: 'brand-new-pass-456', body: { values: { auth_pass: 'change-me' } } });
    check('a password the dashboard would refuse to start with is not saved', r.status === 400 && settings().auth_pass === 'brand-new-pass-456', `status=${r.status}`);
    r = await dash('POST', 'system-settings.php', { pass: 'brand-new-pass-456', body: { values: { auth_pass: PASS } } });
    check('changing it back to the config.php value drops the override', r.status === 200 && settings().auth_pass === undefined, fs.readFileSync(setPath, 'utf8'));

    await stopProc(php);
    php = null;

    // ════════ without data/ (before deploy.sh has run as root): the old way ════════
    dir = makeDashboard(false);
    dirs.push(dir);
    php = await startPhp(dir);
    r = await addCam('cam-old', 'Old way');
    const oldConfig = fs.readFileSync(path.join(dir, 'config.php'), 'utf8');
    check('without data/, a save still rewrites config.php (nothing breaks before deploy.sh is run)', r.status === 200 && oldConfig.includes('cam-old') && oldConfig.includes('Front door'), `status=${r.status} ${r.text.slice(0, 150)}`);
    check('...and no data/ folder appears by itself', !fs.existsSync(path.join(dir, 'data')));
    const ids2 = Array.from({ length: 20 }, (_, i) => `old-${i}`);
    const results2 = await Promise.all(ids2.map((id) => addCam(id)));
    const cfg2 = fs.readFileSync(path.join(dir, 'config.php'), 'utf8');
    check('the old way: 20 saves at the same moment lose nothing either (one lock from read to write)', results2.every((x) => x.status === 200) && ids2.every((id) => cfg2.includes(`'${id}'`)) && cfg2.includes('cam-old'), `${results2.filter((x) => x.status !== 200).length} failed: ` + results2.filter((x) => x.status !== 200).slice(0, 3).map((x) => x.status + ' ' + x.text.slice(0, 160)).join(' | '));
    r = await dash('GET', 'index.php');
    check('...and the dashboard still runs on the rewritten config.php', r.status === 200 && r.text.includes('Old way'), `status=${r.status}`);
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    relay.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  summarize();
}
main();
