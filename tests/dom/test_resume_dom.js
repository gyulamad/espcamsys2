#!/usr/bin/env node
'use strict';

// test_resume_dom.js — the dashboard page after the phone was locked (bug: "when the screen lock appears and I
// open the phone and go back to the dashboard, all the streams and detector views are blank black"), and while its
// one live connection is down.
//
// A locked phone cannot keep its connection: it dies without a sound, and a bare <img> does not fire any event for
// that. The dashboard has ONE connection, mux.php, for every picture and every reading (js/mux-pictures.js; the test
// plays it with fake_mux.js, which logs what the page asks of it). So when the page comes back after it was hidden for a
// while, the connection must be opened again, every picture asked for again, and nothing may be asked of the relay by
// timer or at once by request: the relay sends the state when the connection opens.
// Checked here on the real page (served by PHP) in a simulated browser whose clock and visibility the test drives:
//   - at load:                              one connection object, every camera and the detector wanted, no src on any
//                                           picture and no request for a stream, a status or a detector;
//   - hidden for a long time, then shown:   the connection is reopened, every picture asked for again, the cards say
//                                           "connecting", and still no status request;
//   - hidden for a moment (a tab switch):   nothing is asked, the connection is fine;
//   - a camera the user pressed HIDE on stays hidden, and so does its detector picture;
//   - the back/forward cache (pageshow, persisted) counts as coming back; a normal pageshow does not;
//   - while the page is hidden nothing is asked; shown without ever being seen hidden = reopen;
//   - the connection down: the cards say so, the detector bars and the switch pills say NO DATA (also when every
//     camera is hidden, and the 1 s clock of the pills does not wipe it), and the next push draws the real state.
//
// Own ports, a throwaway copy of the dashboard, the relay is a stub that answers {} to everything.
// Needs php and jsdom (cd tests/dom && npm install), Node 16+; skips itself otherwise.
//
// Usage:  node tests/dom/test_resume_dom.js        (E2E_RESUME_DOM_PORT=19440 to move it)
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
const PHP_PORT = Number(process.env.E2E_RESUME_DOM_PORT || 19440);
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-resume-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [` +
    "['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-A'], ['id' => 'camB', 'name' => 'B', 'icon' => 'y']]];\n");
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
    check('the page loads, with a detector view on camera A only', html.includes('id="detimg-camA"') && !html.includes('id="detimg-camB"'), html.slice(0, 100));

    const fetched = [];
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
          fetched.push(url.replace(BASE + '/', ''));
          return nodeFetch(url, { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
        };
      },
    });
    const w = dom.window;
    const d = w.document;
    await sleep(800);

    // The test's clock and the page's visibility.
    let hidden = false;
    let skew = 0;
    Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
    const realNow = w.Date.now.bind(w.Date);
    w.Date.now = () => realNow() + skew;
    const hide = () => { hidden = true; d.dispatchEvent(new w.Event('visibilitychange')); };
    const show = (awayMs) => { skew += awayMs; hidden = false; d.dispatchEvent(new w.Event('visibilitychange')); };
    let mark = mux.calls.length;
    const since = () => { const calls = mux.calls.slice(mark); mark = mux.calls.length; return calls; };
    const liveRequests = () => fetched.filter((u) => /stream|status|events/.test(u));
    const LOCK_CALLS = ['reconnect', 'show camA', 'show camB', 'showDetector camA'];
    const hasAll = (calls, wanted) => wanted.every((c) => calls.includes(c));

    // ── at load ──
    check('(setup) the page opens ONE mux object, pointed at mux.php', mux.created === 1 && mux.options.url === 'mux.php');
    check('(setup) every camera and the detector of camera A are wanted, the readings and the recording state watched',
      mux.shown('cam').join() === 'camA,camB' && mux.shown('det').join() === 'camA' && mux.calls.includes('watchStatus true') && mux.calls.includes('watchCameraStatus true'), mux.calls.join(', '));
    check('no picture has a src of its own (a src would be a connection of its own)', !d.getElementById('img-camA').hasAttribute('src') && !d.getElementById('img-camB').hasAttribute('src') && !d.getElementById('detimg-camA').hasAttribute('src'));
    check('nothing is requested at load for a stream, a status or a detector (all of it comes on the connection)', liveRequests().length === 0, liveRequests().join());
    check('the page says it is connecting until a picture arrives', d.getElementById('pill-camA').textContent === 'CONNECTING');
    mux.paint('cam', 'camA');
    check('a picture arriving makes the card LIVE and takes the spinner away', d.getElementById('pill-camA').textContent === 'LIVE' && !d.getElementById('overlay-camA').classList.contains('visible'));
    since();

    // ── a tab switch is not a lock ──
    hide();
    show(1000);
    check('hidden for a second only (a tab switch): the connection is left alone', since().length === 0);

    // ── a locked phone ──
    hide();
    await sleep(30);
    check('while the page is hidden nothing is asked either', since().length === 0);
    fetched.length = 0;
    show(60000);
    const afterLock = since();
    check('hidden for a minute (a locked phone), then shown: the connection is opened again', afterLock.includes('reconnect'), afterLock.join());
    check('...and every picture is asked for again: the cameras and the detector', hasAll(afterLock, LOCK_CALLS), afterLock.join());
    check('...and the card says it is connecting again (not "LIVE" over a dead picture)', /CONNECTING/.test(d.getElementById('overlay-camA').textContent) && d.getElementById('overlay-camA').classList.contains('visible'));
    await sleep(300);
    check('the state is NOT asked for by request: the relay sends it when the connection opens', liveRequests().length === 0, liveRequests().join());

    // ── the user pressed HIDE ──
    w.toggleHide('camB');
    check('(setup) camera B is hidden by the user: no picture is wanted for it', d.getElementById('img-camB').dataset.hidden === '1' && mux.shown('cam').join() === 'camA' && since().includes('hide camB'));
    hide();
    show(60000);
    const afterLockWithHidden = since();
    check('after a lock, a camera the user hid stays hidden (no picture asked for)', !afterLockWithHidden.includes('show camB') && mux.shown('cam').join() === 'camA' && d.getElementById('img-camB').dataset.hidden === '1', afterLockWithHidden.join());
    check('...while the connection is reopened and the visible camera and its detector are asked for again', hasAll(afterLockWithHidden, ['reconnect', 'show camA', 'showDetector camA']), afterLockWithHidden.join());

    // ── the user hid the camera that has a detector ──
    w.toggleHide('camA');
    check('(setup) hiding camera A stops its picture and its detector\'s', mux.shown('cam').length === 0 && mux.shown('det').length === 0 && hasAll(since(), ['hide camA', 'hideDetector camA']));
    hide();
    show(60000);
    const afterBothHidden = since();
    check('a hidden camera\'s detector picture is not asked for again either', !afterBothHidden.includes('showDetector camA') && !afterBothHidden.includes('show camA') && mux.shown('det').length === 0, afterBothHidden.join());
    check('...but the connection is still reopened (the readings and the recording state ride on it)', afterBothHidden.includes('reconnect'), afterBothHidden.join());
    w.toggleHide('camA');
    w.toggleHide('camB');
    check('(RESTORE still brings them back)', mux.shown('cam').join() === 'camA,camB' && mux.shown('det').join() === 'camA', mux.shown('cam').join() + ' / ' + mux.shown('det').join());
    since();

    // ── the back/forward cache ──
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: false }));
    check('an ordinary pageshow (the first load) asks for nothing', since().length === 0);
    await sleep(5);
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
    check('a page restored from the back/forward cache opens the connection again and asks for every picture', hasAll(since(), LOCK_CALLS));

    // ── shown without ever being seen hidden (opened in a background tab) ──
    await sleep(5);
    d.dispatchEvent(new w.Event('visibilitychange'));
    check('a page shown that was never seen hidden (opened in a background tab) opens the connection again', hasAll(since(), LOCK_CALLS));

    // ── repeated locks ──
    for (let i = 0; i < 3; i += 1) { await sleep(5); hide(); show(30000); check(`lock number ${i + 1} reopens the connection again`, hasAll(since(), LOCK_CALLS)); }

    // ── the connection is down ──
    const swPill = (id) => d.getElementById('sw-pill-' + id).textContent;
    mux.pushCameraStatus({ camA: { recording: false, recordingCount: 2, recordingOff: null }, camB: { recording: false, recordingCount: 0, recordingOff: null } });
    check('(setup) with the state pushed, the switch pills say REC ON', swPill('camA') === 'REC ON' && swPill('camB') === 'REC ON' && d.getElementById('switch-all-pill').textContent === 'ALL ON', swPill('camA'));
    mux.down();
    await sleep(100);
    check('the connection ends: every shown camera card says so (with a RETRY button)', d.getElementById('pill-camA').textContent === 'ERROR' && d.getElementById('pill-camB').textContent === 'ERROR' && !!d.getElementById('overlay-camA').querySelector('button'));
    check('...the detector bars say NO DATA and are dimmed', d.getElementById('det-camA').classList.contains('stale') && d.getElementById('dettitle-camA').textContent === 'NO DATA' && /connection/.test(d.getElementById('detwhy-camA').textContent), d.getElementById('dettitle-camA').textContent);
    check('...and so do the switch pills: they must not keep saying REC ON for a state nobody reports', swPill('camA') === 'NO DATA' && swPill('camB') === 'NO DATA' && d.getElementById('switch-all-pill').textContent === 'NO DATA', swPill('camA'));
    await sleep(1300);
    check('...also after the 1 s clock of the pills ticked (it does not wipe the message)', swPill('camA') === 'NO DATA' && d.getElementById('switch-all-pill').textContent === 'NO DATA', swPill('camA'));
    mux.pushCameraStatus({ camA: { recording: false, recordingCount: 2, recordingOff: { forever: true } }, camB: { recording: false, recordingCount: 0, recordingOff: null } });
    check('the next push of the recording state draws the real pills again', /^REC OFF/.test(swPill('camA')) && swPill('camB') === 'REC ON' && d.getElementById('switch-all-pill').textContent === '1 of 2 OFF', swPill('camA') + ' / ' + d.getElementById('switch-all-pill').textContent);
    mux.pushStatus({ camA: { state: 'offline', online: false, hasPicture: false, message: 'gone' } });
    await sleep(100);
    check('the next push of the readings replaces NO DATA on the detector', d.getElementById('dettitle-camA').textContent === 'DETECTOR OFFLINE' && d.getElementById('detwhy-camA').textContent === 'gone', d.getElementById('dettitle-camA').textContent);
    mux.pushCameraStatus({ error: 'Could not reach relay' });
    mux.down();
    await sleep(50);
    mux.pushCameraStatus({ camA: 'not a status', error: 'x' });
    check('an error-shaped push is not a state: the pills stay on NO DATA', swPill('camA') === 'NO DATA', swPill('camA'));

    // ── every camera hidden, then the connection goes down: still said ──
    mux.pushStatus({ camA: { state: 'offline', online: false, hasPicture: false, message: 'gone' } });
    await sleep(100);
    w.toggleHide('camA');
    w.toggleHide('camB');
    check('(setup) no camera picture is wanted any more', mux.shown('cam').length === 0);
    mux.down();
    await sleep(100);
    check('the connection ending with every camera hidden still says NO DATA on the detector bars and pills', d.getElementById('dettitle-camA').textContent === 'NO DATA' && swPill('camA') === 'NO DATA', d.getElementById('dettitle-camA').textContent + ' / ' + swPill('camA'));

    check('the page opened no stream, status or detector request on the way', liveRequests().length === 0, liveRequests().join());
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
