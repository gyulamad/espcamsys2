#!/usr/bin/env node
'use strict';

// test_resume_dom.js — the dashboard page after the phone was locked (bug: "when the screen lock appears and I
// open the phone and go back to the dashboard, all the streams and detector views are blank black").
//
// A locked phone cannot keep its connections: the streams die without a sound, and a bare <img> does not fire
// any event for that. So when the page comes back after it was hidden for a while, every picture (a camera's and
// its detector's) must start over from a NEW connection, and the status numbers must be asked for at once.
// Checked here on the real page (served by PHP) in a simulated browser whose clock and visibility the test drives:
//   - hidden for a long time, then shown:   every picture gets a new address (= a new request), the cards say
//                                           "connecting", and the status and detector polls run again at once;
//   - hidden for a moment (a tab switch):   nothing is reloaded, the streams are fine;
//   - a camera the user pressed HIDE on stays hidden, and so does its detector picture;
//   - the back/forward cache (pageshow, persisted) counts as coming back; a normal pageshow does not;
//   - while the page is hidden nothing is reloaded; shown without ever being seen hidden = reload.
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
const { closeWindow } = require('./dom_helpers');

let JSDOM;
let VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) { JSDOM = null; }

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
    dom = new JSDOM(html, {
      url: `${BASE}/index.php`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
      beforeParse(window) {
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
    const addr = (id) => d.getElementById(id).getAttribute('src');
    const snapshot = () => ({ camA: addr('img-camA'), detA: addr('detimg-camA'), camB: addr('img-camB') });
    const stamp = (u) => (/[?&]_=(\d+)/.exec(u || '') || [])[1];
    const changed = (a, b) => ['camA', 'detA', 'camB'].filter((k) => a[k] !== b[k]);

    let before = snapshot();
    check('(setup) the three pictures are on the page, each with an address', before.camA && before.detA && before.camB, JSON.stringify(before));

    // ── a tab switch is not a lock ──
    hide();
    show(1000);
    check('hidden for a second only (a tab switch): nothing is reloaded', changed(before, snapshot()).length === 0, changed(before, snapshot()).join());

    // ── a locked phone ──
    hide();
    await sleep(30);
    check('while the page is hidden nothing is reloaded either', changed(before, snapshot()).length === 0);
    fetched.length = 0;
    show(60000);
    let after = snapshot();
    check('hidden for a minute (a locked phone), then shown: the camera picture starts over from a new request', changed(before, after).includes('camA') && stamp(after.camA) !== stamp(before.camA), `${before.camA} -> ${after.camA}`);
    check('...the other camera too', changed(before, after).includes('camB'), `${before.camB} -> ${after.camB}`);
    check('...and the detector picture', changed(before, after).includes('detA') && stamp(after.detA) !== stamp(before.detA), `${before.detA} -> ${after.detA}`);
    check('...from the same addresses as before, only with a new stamp', after.camA.split('&_=')[0] === before.camA.split('&_=')[0] && after.detA.split('&_=')[0] === before.detA.split('&_=')[0]);
    check('...and the card says it is connecting again (not "LIVE" over a dead picture)', /CONNECTING/.test(d.getElementById('overlay-camA').textContent) && d.getElementById('overlay-camA').classList.contains('visible'));
    await sleep(300);
    check('the status numbers and the detector numbers are asked for at once, not at the next tick', fetched.includes('status.php') && fetched.includes('detector-status.php'), fetched.join());

    // ── the user pressed HIDE ──
    w.toggleHide('camB');
    check('(setup) camera B is hidden by the user', d.getElementById('img-camB').dataset.hidden === '1' && !addr('img-camB'));
    before = snapshot();
    hide();
    show(60000);
    after = snapshot();
    check('after a lock, a camera the user hid stays hidden (no picture started)', !addr('img-camB') && d.getElementById('img-camB').dataset.hidden === '1');
    check('...while the visible camera and its detector start over', changed(before, after).sort().join() === 'camA,detA', changed(before, after).join());

    // ── the user hid the camera that has a detector ──
    w.toggleHide('camA');
    before = snapshot();
    hide();
    show(60000);
    check('a hidden camera\'s detector picture is not restarted either', changed(before, snapshot()).length === 0 && !addr('detimg-camA'), changed(before, snapshot()).join() + ' ' + addr('detimg-camA'));
    w.toggleHide('camA');
    w.toggleHide('camB');
    check('(RESTORE still brings them back)', !!addr('img-camA') && !!addr('img-camB') && !!addr('detimg-camA'));

    // ── the back/forward cache ──
    before = snapshot();
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: false }));
    check('an ordinary pageshow (the first load) reloads nothing', changed(before, snapshot()).length === 0);
    await sleep(5);
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
    check('a page restored from the back/forward cache starts every picture over', changed(before, snapshot()).sort().join() === 'camA,camB,detA', changed(before, snapshot()).join());

    // ── shown without ever being seen hidden (opened in a background tab) ──
    before = snapshot();
    await sleep(5);
    d.dispatchEvent(new w.Event('visibilitychange'));
    check('a page shown that was never seen hidden (opened in a background tab) reloads: its streams were started unseen', changed(before, snapshot()).sort().join() === 'camA,camB,detA', changed(before, snapshot()).join());

    // ── repeated locks ──
    for (let i = 0; i < 3; i += 1) { before = snapshot(); await sleep(5); hide(); show(30000); check(`lock number ${i + 1} reloads again`, changed(before, snapshot()).length === 3); }
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
