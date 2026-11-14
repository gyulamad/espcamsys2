#!/usr/bin/env node
'use strict';

// test_offline_preloader_dom.js — F-25: a camera card has two preloaders, the page's own stream overlay
// ("CONNECTING…" / "STREAM ERROR" / "FEED PAUSED") and the relay's "CAMERA OFFLINE / Reconnecting…" cover
// (js/camera-offline.js, shown from the pushed status map), and they must never show at once. Before the fix an
// offline camera stacked them: it never sends the picture that would end the CONNECTING… spinner, so when the
// relay says online: false (or the user asks for a reload while the camera is down) the two preloaders sat on top
// of each other. Checked here on the real page (served by PHP) in jsdom, the connection played by fake_mux.js:
//   - a camera the relay says is offline shows ONLY the cover, whatever the stream layer was doing
//     (connecting at load, CONNECTING… after a RELOAD, STREAM ERROR when the connection ends);
//   - when the camera is back the cover goes and CONNECTING… returns until a picture ends it;
//   - a camera that was live keeps no spinner when it drops and comes back (the cover is the only sign);
//   - a feed the user paused keeps its FEED PAUSED overlay (RESTORE stays reachable) even while offline.
//
// Own ports, a throwaway copy of the dashboard, the relay is a stub that answers {} to everything.
// Needs php and jsdom (cd tests/dom && npm install), Node 16+; skips itself otherwise.
//
// Usage:  node tests/dom/test_offline_preloader_dom.js   (E2E_PRELOAD_DOM_PORT=19490 to move it)
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');
const { installFakeMux } = require('./fake_mux');

let JSDOM;
let VirtualConsole;
let jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM, VirtualConsole } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_PRELOAD_DOM_PORT || 19490);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const basic = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');

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

// What the page uses of a response (global fetch only exists from Node 18).
function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
        text: () => Promise.resolve(data),
        json: () => Promise.resolve().then(() => JSON.parse(data)),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-preload-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [` +
    "['id' => 'camA', 'name' => 'A', 'icon' => 'x'], ['id' => 'camB', 'name' => 'B', 'icon' => 'y']]];\n");
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = http.get(`${BASE}/`, () => r(true)); q.on('error', () => r(false)); });
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
function startRelayStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; let relay; let dir; let dom;
  try {
    relay = await startRelayStub();
    dir = makeDashboard();
    php = await startPhp(dir);
    const html = await (await nodeFetch(`${BASE}/index.php`, { headers: { Authorization: basic } })).text();

    const pageErrors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e && e.message || e)));
    let mux;
    dom = new JSDOM(html, {
      url: `${BASE}/index.php`, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'wifi-info.js', 'camera-offline.js', 'alarm-chain.js', 'busy.js', 'device-info.js']), pretendToBeVisual: true, virtualConsole,
      beforeParse(window) {
        mux = installFakeMux(window);
        window.confirm = () => false;
        window.alert = () => {};
        window.fetch = (u, opts = {}) => {
          const url = new URL(u, `${BASE}/index.php`).toString();
          return nodeFetch(url, { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
        };
      },
    });
    const w = dom.window;
    const d = w.document;
    await sleep(800);

    // The two layers of a card, as the user sees them: "cover" (CAMERA OFFLINE / Reconnecting…) and "overlay"
    // (CONNECTING… / STREAM ERROR / FEED PAUSED). joined: '' none, 'cover', 'overlay', 'cover overlay' = the F-25 bug.
    const layer = (id) => {
      const cover = d.getElementById('offline-' + id);
      const overlay = d.getElementById('overlay-' + id);
      return [!cover.hidden ? 'cover' : '', overlay.classList.contains('visible') ? 'overlay' : ''].filter(Boolean).join(' ');
    };
    // The status maps the relay pushes are always whole (every camera every ~2 s), and a camera missing from one is
    // "not known to be offline". Each map below says both cameras on purpose.
    const st = (online) => ({ recording: false, recordingCount: 0, recordingOff: null, online });
    const A_OFF = { camA: st(false), camB: st(true) };
    const BOTH_ON = { camA: st(true), camB: st(true) };
    const B_OFF = { camA: st(true), camB: st(false) };

    // ── the page's own start: CONNECTING… until a picture arrives ──
    check('the page starts on CONNECTING… with no cover (as its HTML always did)', layer('camA') === 'overlay' && layer('camB') === 'overlay', `camA=${layer('camA')} camB=${layer('camB')}`);

    // ── the F-25 bug: the relay says the camera is not connected ──
    mux.pushCameraStatus(A_OFF);
    check('the relay says camA is offline: the CAMERA OFFLINE cover shows ALONE, the CONNECTING… spinner is gone',
      layer('camA') === 'cover' && d.getElementById('offline-camA').textContent.includes('CAMERA OFFLINE'), `camA=${layer('camA')}`);
    check('...while a camera the relay does not say is offline keeps its CONNECTING… spinner', layer('camB') === 'overlay', `camB=${layer('camB')}`);

    // ── the ticket's moment: a reload while the camera is still down ──
    w.reloadStream('camA');
    check('RELOAD on the offline camera: no CONNECTING… comes back over the cover', layer('camA') === 'cover', `camA=${layer('camA')}`);
    mux.paint('cam', 'camA');   // the relay sends no frames for an offline camera; a stray picture event must not light the spinner
    check('...and no stray picture event can light the spinner either', layer('camA') === 'cover', `camA=${layer('camA')}`);

    // ── the camera connects (the page already saw a picture, so it is 'live' to the stream layer) ──
    mux.pushCameraStatus(BOTH_ON);
    check('the camera is back after a picture arrived: no cover, and no spinner blink (the pictures just resume)', layer('camA') === '' && d.getElementById('pill-camA').textContent === 'LIVE', `camA=${layer('camA')}`);
    w.reloadStream('camA');
    check('...and RELOAD on the online camera still says CONNECTING… until a picture ends it', layer('camA') === 'overlay' && d.getElementById('pill-camA').textContent === 'CONNECTING', `camA=${layer('camA')}`);
    mux.paint('cam', 'camA');
    check('the picture ends it: LIVE, no cover, no spinner', layer('camA') === '' && d.getElementById('pill-camA').textContent === 'LIVE', `camA=${layer('camA')}`);

    // ── a camera that was CONNECTING… the whole time (camB) drops and comes back ──
    mux.pushCameraStatus(B_OFF);
    check('a camera that never sent a picture drops: the cover shows alone', layer('camB') === 'cover', `camB=${layer('camB')}`);
    mux.pushCameraStatus(BOTH_ON);
    check('...and when it is back, CONNECTING… returns (no picture has arrived yet)', layer('camB') === 'overlay' && d.getElementById('pill-camB').textContent === 'CONNECTING', `camB=${layer('camB')}`);
    mux.paint('cam', 'camB');
    check('...and the first picture ends it', layer('camB') === '' && d.getElementById('pill-camB').textContent === 'LIVE', `camB=${layer('camB')}`);

    // ── a camera that was live drops and comes back ──
    mux.pushCameraStatus(A_OFF);
    check('a live camera that drops: the cover dims its last picture alone', layer('camA') === 'cover' && d.getElementById('pill-camA').textContent === 'LIVE', `camA=${layer('camA')}`);
    mux.pushCameraStatus(BOTH_ON);
    check('...and when it is back there is no spinner blink: the pictures just resume', layer('camA') === '', `camA=${layer('camA')}`);
    mux.paint('cam', 'camA');
    check('...and the picture arriving keeps it that way', layer('camA') === '' && d.getElementById('pill-camA').textContent === 'LIVE', `camA=${layer('camA')}`);

    // ── the page's data connection ends (STREAM ERROR) ──
    mux.pushCameraStatus(A_OFF);
    mux.down();
    await sleep(100);
    check('the connection ends: the offline camera keeps its cover instead of a second spinner', layer('camA') === 'cover' && d.getElementById('pill-camA').textContent === 'ERROR', `camA=${layer('camA')}`);
    check('...while the camera that was streaming says STREAM ERROR as before', layer('camB') === 'overlay' && !!d.getElementById('overlay-camB').querySelector('button'), `camB=${layer('camB')}`);

    // ── the connection is back, the camera too ──
    mux.pushCameraStatus(BOTH_ON);
    check('the push after the outage says camA is online again: STREAM ERROR returns (the picture has not yet)', layer('camA') === 'overlay', `camA=${layer('camA')}`);
    mux.paint('cam', 'camA');
    check('...and the picture ends it', layer('camA') === '' && d.getElementById('pill-camA').textContent === 'LIVE', `camA=${layer('camA')}`);

    // ── a feed the user paused on purpose: FEED PAUSED wins, RESTORE stays reachable ──
    mux.pushCameraStatus(B_OFF);
    w.toggleHide('camB');
    check('HIDE on a camera the relay says is offline: FEED PAUSED with RESTORE, the cover steps aside', layer('camB') === 'overlay' && /RESTORE/.test(d.getElementById('overlay-camB').textContent), `camB=${layer('camB')}`);
    w.toggleHide('camB');   // RESTORE: back to the cover, the camera is still offline
    check('RESTORE on the still-offline camera: the CAMERA OFFLINE cover again, alone', layer('camB') === 'cover', `camB=${layer('camB')}`);

    check('the page script threw no error on the way', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  } catch (err) {
    check('the test ran without an unexpected error', false, err && err.stack ? err.stack : String(err));
  } finally {
    closeWindow(dom);
    await stopProc(php);
    if (relay) await new Promise((r) => relay.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarize();
}
main();
