#!/usr/bin/env node
'use strict';
// test_dashboard_pictures_e2e.js — the dashboard's live pictures in a REAL browser (Chromium), in front of
// the real dashboard (php -S) and a fake relay. Three things that only a browser can show:
//   1. A picture whose stream ends (the relay restarted, went quiet, the network dropped) is started again
//      by itself — the browser fires no event for it and used to leave the last frame frozen on screen —
//      and RELOAD ALL starts the detector's picture again too, not only the cameras'.
//   2. A crowded dashboard (more live pictures than the ~6 connections a browser allows per address): a
//      click on SIMPLE LIST must not wait in the browser's queue behind the pictures (the top bar spun
//      for ever until the stop button was pressed), and a detector row that has no numbers must say so
//      ("WAITING FOR DATA…", then "NO DATA") instead of claiming "DETECTOR OFFLINE" next to a live picture.
// Needs php and Playwright with its Chromium (npm i playwright; npx playwright install chromium); skips
// itself, saying so, when either is missing. Override the ports with E2E_PICTURES_PORT (uses four).
//   node tests/e2e/test_dashboard_pictures_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const JPEG = fs.readFileSync(path.join(__dirname, '../../nodejs/camera-relay/testimage.jpg'));
const BASE = Number(process.env.E2E_PICTURES_PORT || 19520);
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, ms, stepMs = 200) {
  for (const started = Date.now(); Date.now() - started < ms;) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// A relay that serves a picture stream for every camera / detector path and counts how often each was asked
// for. `up = false` makes it drop every connection; dropStreams() ends the open pictures (as a restart does).
function createFakeRelay() {
  const open = new Set();
  const hits = {};
  const relay = { up: true, hits, server: null, dropStreams: () => { for (const res of [...open]) res.end(); } };
  relay.server = nodeHttp.createServer((req, res) => {
    if (!relay.up) { req.socket.destroy(); return; }
    if (req.url.startsWith('/detectors/events')) {   // the numbers stream: open, but never says anything
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      return;
    }
    const picture = /^\/(stream\/[A-Za-z]+|detector\/[A-Za-z]+\/stream)$/.exec(req.url);
    if (!picture) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    hits[req.url] = (hits[req.url] || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', Connection: 'close' });
    open.add(res);
    const timer = setInterval(() => {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
      res.write(JPEG);
      res.write('\r\n');
    }, 150);
    req.on('close', () => { clearInterval(timer); open.delete(res); });
  });
  return relay;
}

// The real dashboard in a temporary folder with a config of the given cameras ({ id, detector? }).
async function startDashboard(port, relayPort, cameras) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pictures-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const list = cameras.map((c) => `['id' => '${c.id}', 'name' => '${c.id}', 'icon' => 'x'${c.detector ? `, 'detector' => '${c.detector}'` : ''}]`).join(', ');
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${relayPort}', 'relay_control_key' => '${KEY}', 'cameras' => [${list}]];\n`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pictures-tmp-'));
  // every live picture and the numbers stream keep one PHP worker for as long as they are open
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '40', TMPDIR: tmp } });
  const ready = await waitFor(() => new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${port}/`, () => r(true)); q.on('error', () => r(false)); }), 5000, 100);
  if (!ready) { child.kill('SIGKILL'); throw new Error('php -S not ready in 5s'); }
  return { stop() { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const hitsOf = (relay, pathName) => relay.hits[pathName] || 0;

async function scenarioPicturesRecover(browser) {
  const relay = createFakeRelay();
  let dashboard;
  const context = await browser.newContext({ httpCredentials: { username: AUTH.user, password: AUTH.pass } });
  try {
    await new Promise((r) => relay.server.listen(BASE + 1, '127.0.0.1', r));
    dashboard = await startDashboard(BASE, BASE + 1, [{ id: 'camA', detector: 'detA' }]);
    const camera = '/stream/camA', detector = '/detector/detA/stream';
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${BASE}/index.php`, { waitUntil: 'commit' });
    check('the camera and the detector pictures connect, once each',
      await waitFor(() => hitsOf(relay, camera) >= 1 && hitsOf(relay, detector) >= 1, 8000), JSON.stringify(relay.hits));
    await sleep(3000);
    check('a healthy picture is not restarted (no reconnect while frames keep coming)',
      hitsOf(relay, camera) === 1 && hitsOf(relay, detector) === 1, JSON.stringify(relay.hits));

    // the streams end; the browser says nothing; the pictures must come back by themselves
    const before = { camera: hitsOf(relay, camera), detector: hitsOf(relay, detector) };
    relay.dropStreams();
    check('the camera picture comes back by itself after its stream ended', await waitFor(() => hitsOf(relay, camera) > before.camera, 30000), JSON.stringify(relay.hits));
    check('the detector picture comes back by itself after its stream ended', await waitFor(() => hitsOf(relay, detector) > before.detector, 30000), JSON.stringify(relay.hits));

    // the relay is away for a while, then back
    relay.up = false;
    relay.dropStreams();
    await sleep(6000);
    const down = { camera: hitsOf(relay, camera), detector: hitsOf(relay, detector) };
    relay.up = true;
    check('both pictures recover after the relay was away', await waitFor(() => hitsOf(relay, camera) > down.camera && hitsOf(relay, detector) > down.detector, 60000), JSON.stringify(relay.hits));

    // RELOAD ALL starts every picture again, the detector's too
    const beforeReload = { camera: hitsOf(relay, camera), detector: hitsOf(relay, detector) };
    await page.click('text=RELOAD ALL');
    check('RELOAD ALL reloads the camera picture', await waitFor(() => hitsOf(relay, camera) > beforeReload.camera, 5000));
    check('RELOAD ALL reloads the detector picture', await waitFor(() => hitsOf(relay, detector) > beforeReload.detector, 5000));
  } finally {
    await context.close();
    if (dashboard) dashboard.stop();
    relay.server.close();
    relay.dropStreams();
  }
}

async function scenarioCrowdedDashboard(browser) {
  const relay = createFakeRelay();
  let dashboard;
  const context = await browser.newContext({ httpCredentials: { username: AUTH.user, password: AUTH.pass } });
  try {
    await new Promise((r) => relay.server.listen(BASE + 3, '127.0.0.1', r));
    // 4 cameras + 2 detectors + the numbers stream: more than the 6 connections a browser opens to one address
    dashboard = await startDashboard(BASE + 2, BASE + 3, [{ id: 'camA', detector: 'detA' }, { id: 'camB', detector: 'detB' }, { id: 'camC' }, { id: 'camD' }]);
    const page = await context.newPage();
    page.goto(`http://127.0.0.1:${BASE + 2}/index.php`, { waitUntil: 'commit' }).catch(() => { /* never "loads": the pictures never end */ });
    const label = () => page.evaluate(() => (document.getElementById('dettitle-camA') || {}).textContent).catch(() => null);
    check('before any numbers arrived the detector row does not claim to be offline', await waitFor(async () => (await label()) === 'WAITING FOR DATA…', 8000), String(await label()));
    check('with no numbers for a while it says so ("NO DATA"), still not "DETECTOR OFFLINE"', await waitFor(async () => (await label()) === 'NO DATA', 15000), String(await label()));

    let arrivedAfterMs = null;
    const clickedAt = Date.now();
    page.on('response', (r) => { if (/\/simple-list\.php$/.test(r.url()) && arrivedAfterMs === null) arrivedAfterMs = Date.now() - clickedAt; });
    page.click('#btn-simple-list', { timeout: 3000 }).catch(() => { /* reported by the check below */ });
    await waitFor(() => arrivedAfterMs !== null, 15000);
    check('SIMPLE LIST opens at once although the pictures hold every connection (' + arrivedAfterMs + ' ms)', arrivedAfterMs !== null && arrivedAfterMs < 5000);
  } finally {
    await context.close();
    if (dashboard) dashboard.stop();
    relay.server.close();
    relay.dropStreams();
  }
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }
  if (!chromium) { console.log('SKIP: Playwright is not installed (npm i playwright; npx playwright install chromium) — pictures that freeze in a real browser are not tested.'); finished = true; return; }
  let browser;
  try {
    browser = await chromium.launch();
    await scenarioPicturesRecover(browser);
    await scenarioCrowdedDashboard(browser);
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (browser) await browser.close();
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
