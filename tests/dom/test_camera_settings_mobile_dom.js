#!/usr/bin/env node
'use strict';
// test_camera_settings_mobile_dom.js — the camera SETTINGS page in jsdom, with its scripts running against a
// real PHP server and a fake relay, about the MOBILE layout of the Settings Atlas (F-29 T7e,
// designs/Mobile-v2.png):
//   * on a phone (the page tags <html> with .is-mobile from matchMedia('(max-width: 800px)')) the desktop
//     tray folds into a sticky "N changes → APPLY" bar: the count and the APPLY mirror the tray's count
//     and #save, so the same save path is used; the desktop #save and #status are hidden, the header pill
//     is hidden, and the per-row list, the reboot note and DISCARD live in a collapsible #tray-detail that
//     the count button opens
//   * every interactive control is at least 44 px tall on a phone (the touch-target rule)
//   * clicking the mobile APPLY posts the same change as #save; DISCARD from the expanded detail still
//     empties the tray; the detail collapses again when the tray empties
//
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing. The T7a
// atlas test (test_camera_settings_atlas_dom.js) covers the desktop layout and the rail / tier / tray
// contracts; this one only adds the mobile-specific behaviour, and reuses the same fake relay + PHP
// server harness.
//
//   node tests/dom/test_camera_settings_mobile_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_CAMMOBILEDOM_PORT || 19720);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PAGE = `${BASE}/camera-settings-page.php?cam=cam-a`;
const API = `${BASE}/camera-settings.php?cam=cam-a`;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); }
}

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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// What the board reports. LOG_HEARTBEAT starts at 900 (default 600) so a change has somewhere to go; the
// row is advanced-tier, so the test switches to ADVANCED to reach it (the same pattern as the atlas test).
const BOARD = {
  WIFI: 'net:********', SERVER_HOST: '192.168.4.9', PUSH_PORT: '8081', HTTP_PORT: '8080', CAMERA_ID: 'cam-a',
  API_KEY: '********', PUSH_GAP_MUL: '1.5', PUSH_WR_TMO_MS: '8000', ALARM_GPIO_PIN: '13', ALARM_ACTIVE: 'LOW', ALARM_ALL_CAMS: '0',
  LOG_ENABLED: '1', LOG_MIN_LEVEL: '1', LOG_ECHO: '1', LOG_RETRY_MAX: '3', LOG_RETRY_SEC: '300',
  LOG_FLUSH_SEC: '10', LOG_REPEAT_SEC: '30', LOG_HEARTBEAT: '900', LOG_LOW_HEAP: '30000',
  JPEG_Q_DROP: '1', JPEG_Q_MAX: '63',
};

let board = BOARD;
let staged = null;
const posts = [];

function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (url === '/device-settings/recorder/cam-a/state') {
          const now = Date.now();
          res.end(JSON.stringify({ reported: { settings: board, at: now - 4000 }, pending: null, last: null, now }));
        } else if (url === '/device-settings/recorder/cam-a/change' && req.method === 'PUT') {
          staged = body;
          for (const kv of String(body).split(';')) {
            const eq = kv.indexOf('=');
            if (eq > 0) board[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
          res.end('{"ok":true}');
        } else { res.statusCode = 404; res.end('{}'); }
      });
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cammobiledom-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => 'control-key-1', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪']]];\n`);
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

// The page in jsdom with the viewport forced to a phone: matchMedia('(max-width: 800px)') returns matches=true
// and fires change listeners when the test toggles it. The page's applyMobile() then tags <html> with
// .is-mobile, and the CSS swaps the desktop tray for the mobile bar.
async function openPage(toasts, mobile) {
  let matches = !!mobile;
  const html = await (await nodeFetch(PAGE, { headers: { Authorization: basic } })).text();
  const dom = new JSDOM(html, {
    url: PAGE, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js']), pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      // matchMedia: jsdom's default returns matches=false for everything; the test drives it. addEventListener
      // keeps the listeners so the test can flip the matches field and dispatch a change.
      const listeners = new Set();
      window.matchMedia = (q) => {
        const mq = {
          media: q,
          get matches() { return /max-width: 800px/.test(q) && matches; },
          onchange: null,
          addEventListener: (ev, fn) => { if (ev === 'change') listeners.add(fn); },
          removeEventListener: (ev, fn) => { if (ev === 'change') listeners.delete(fn); },
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
          dispatchEvent: () => false,
        };
        return mq;
      };
      // The test flips the phone-viewport flag through window.__setMobile, which also fires the change
      // listeners the page registered, so applyMobile() runs again.
      window.__setMobile = (on) => {
        matches = !!on;
        for (const fn of listeners) { try { fn({ matches }); } catch (e) { /* a listener throwing must not break the others */ } }
      };
      window.fetch = (u, opts = {}) => {
        if ((opts.method || 'GET') === 'POST') posts.push({ url: String(u), body: String(opts.body || '') });
        return nodeFetch(new URL(u, PAGE).toString(), { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
      };
    },
  });
  const { window } = dom;
  await waitFor(() => window.CamToast && window.document.getElementById('f-LOG_ECHO'));
  window.CamToast.show = (t, kind) => { toasts.push(String(t)); };
  return dom;
}
const setField = (window, name, value) => {
  const i = window.document.getElementById('f-' + name);
  i.value = value;
  i.dispatchEvent(new window.Event('change', { bubbles: true }));
};

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; let relay; let dir;
  try {
    relay = await startRelay();
    dir = makeDashboard();
    php = await startPhp(dir);

    let toasts = [];
    let dom = await openPage(toasts, true);   // start in the phone viewport
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    const cs = (el) => window.getComputedStyle(el);
    const tierBtn = (t) => window.document.querySelector(`#tierbar [data-tier="${t}"]`);

    // ── the page is in its mobile layout ────────────────────────────────────────────────────
    check('the page tags <html> with .is-mobile when matchMedia says narrow',
      window.document.documentElement.classList.contains('is-mobile'));
    check('the mobile bar is shown (display: flex) under .is-mobile',
      cs($('mobile-bar')).display === 'flex', 'display=' + cs($('mobile-bar')).display);
    check('the desktop tray-detail is collapsed by default (display: none) under .is-mobile',
      cs($('tray-detail')).display === 'none', 'display=' + cs($('tray-detail')).display);
    check('the desktop #save in the traybar is hidden under .is-mobile (the mobile bar has the APPLY)',
      cs($('save')).display === 'none', 'display=' + cs($('save')).display);
    check('the desktop #status line is hidden under .is-mobile (the count replaces it)',
      cs($('status')).display === 'none', 'display=' + cs($('status')).display);
    check('the header pending-pill is hidden under .is-mobile (the count is in the bar)',
      cs($('pending-count')).display === 'none', 'display=' + cs($('pending-count')).display);
    check('the mobile bar holds ONE APPLY button (#m-apply), and the desktop has ONE #save',
      window.document.querySelectorAll('#m-apply').length === 1 && window.document.querySelectorAll('#save').length === 1);

    // ── the count and APPLY mirror the tray ────────────────────────────────────────────────
    check('with no edits the count says "No changes" and APPLY is disabled',
      $('m-count').textContent === 'No changes' && $('m-apply').disabled === true,
      'count=' + JSON.stringify($('m-count').textContent) + ' disabled=' + $('m-apply').disabled);
    // LOG_HEARTBEAT is advanced-tier: switch to ADVANCED so its row is shown and editable.
    tierBtn('advanced').click();
    setField(window, 'LOG_HEARTBEAT', '700');
    await waitFor(() => $('m-count').textContent === '1 change');
    check('an edit is reflected in the count ("1 change") and enables APPLY',
      $('m-count').textContent === '1 change' && $('m-apply').disabled === false,
      'count=' + JSON.stringify($('m-count').textContent) + ' disabled=' + $('m-apply').disabled);
    // Replace the 700 with 800 (still one edit, 900 → 800).
    setField(window, 'LOG_HEARTBEAT', '800');
    check('replacing the edit keeps one change in the bar',
      $('m-count').textContent === '1 change' && $('m-apply').disabled === false);

    // ── APPLY from the mobile bar posts the same change as #save ───────────────────────────
    const nPosts = posts.length;
    $('m-apply').click();
    const posted = await waitFor(() => (posts.length > nPosts ? true : null));
    check('clicking #m-apply posts to camera-settings.php', !!posted,
      'posts=' + JSON.stringify(posts.slice(nPosts)));
    check('the body is the same one #save would send ({values:{LOG_HEARTBEAT:"800"}})',
      posts[nPosts] && posts[nPosts].body === '{"values":{"LOG_HEARTBEAT":"800"}}',
      'body=' + JSON.stringify(posts[nPosts] && posts[nPosts].body));
    await waitFor(() => staged === 'LOG_HEARTBEAT=800');
    check('the relay was handed LOG_HEARTBEAT=800', staged === 'LOG_HEARTBEAT=800', 'staged=' + JSON.stringify(staged));
    await waitFor(() => $('f-LOG_HEARTBEAT').value === '800' && $('m-count').textContent === 'No changes');
    check('after the board takes the change, the bar says "No changes" and APPLY is disabled again',
      $('m-count').textContent === 'No changes' && $('m-apply').disabled === true,
      'count=' + JSON.stringify($('m-count').textContent) + ' disabled=' + $('m-apply').disabled);

    // ── the expand toggle opens the detail (DISCARD, the per-row list, the reboot note) ────
    setField(window, 'LOG_HEARTBEAT', '1200');
    await waitFor(() => $('m-count').textContent === '1 change');
    check('before expand: aria-expanded is false, .tray has no .m-expanded',
      $('m-count').getAttribute('aria-expanded') === 'false' && !$('tray').classList.contains('m-expanded'));
    $('m-count').click();
    check('clicking the count button opens the detail (.m-expanded, aria-expanded="true")',
      $('tray').classList.contains('m-expanded') && $('m-count').getAttribute('aria-expanded') === 'true');
    check('the detail panel is now display: block, with the per-row list inside it',
      cs($('tray-detail')).display === 'block' && $('pending-list').textContent.includes('LOG_HEARTBEAT'),
      'display=' + cs($('tray-detail')).display + ' list=' + JSON.stringify($('pending-list').textContent));
    // DISCARD lives in the traybar inside the detail on mobile.
    check('the DISCARD button (#revert) is in the expanded detail and is enabled',
      $('tray-detail').contains($('revert')) && $('revert').disabled === false);
    $('revert').click();
    await waitFor(() => $('m-count').textContent === 'No changes');
    check('DISCARD from the expanded detail empties the bar and restores the value',
      $('m-count').textContent === 'No changes' && $('f-LOG_HEARTBEAT').value === '800',
      'count=' + JSON.stringify($('m-count').textContent) + ' value=' + $('f-LOG_HEARTBEAT').value);
    check('the detail collapsed again when the tray emptied (no stale list)',
      !$('tray').classList.contains('m-expanded') && $('m-count').getAttribute('aria-expanded') === 'false');

    // ── 44 px touch targets: every interactive control under .is-mobile ───────────────────
    const expectTouch = (name, el) => {
      if (!el) { check(name + ' exists', false); return; }
      const h = cs(el).minHeight;
      check(name + ' min-height is 44 px (touch target)', h === '44px', 'got ' + JSON.stringify(h));
    };
    expectTouch('#m-apply', $('m-apply'));
    expectTouch('#m-count', $('m-count'));
    expectTouch('#save (still in the DOM, just hidden)', $('save'));
    expectTouch('#revert', $('revert'));
    expectTouch('a tier button', tierBtn('basic'));
    expectTouch('a category rail item', window.document.querySelector('#rail .rail-item'));
    const ctlEl = window.document.querySelector('.ctl input, .ctl select');
    expectTouch('a row input or select', ctlEl);
    expectTouch('a row reset button', window.document.querySelector('.ctl .btn.reset'));

    // ── switching back to the desktop viewport hides the mobile bar again ─────────────────
    window.__setMobile(false);
    await waitFor(() => !window.document.documentElement.classList.contains('is-mobile'));
    check('flipping matchMedia back to wide removes .is-mobile from <html>',
      !window.document.documentElement.classList.contains('is-mobile'));
    check('the mobile bar is hidden again on the desktop layout',
      cs($('mobile-bar')).display === 'none', 'display=' + cs($('mobile-bar')).display);
    check('the desktop #save is shown again (display: inline-block or block, not none)',
      cs($('save')).display !== 'none', 'display=' + cs($('save')).display);
    check('the desktop tier button no longer has the 44 px floor',
      cs(tierBtn('basic')).minHeight !== '44px', 'minHeight=' + JSON.stringify(cs(tierBtn('basic')).minHeight));
    // The existing T7a atlas contracts still hold on the desktop side: the tray's APPLY is the one APPLY.
    check('on desktop there is still exactly one #save and one #m-apply (now hidden)',
      window.document.querySelectorAll('#save').length === 1 && window.document.querySelectorAll('#m-apply').length === 1);

    closeWindow(dom);
  } finally {
    if (php) await stopProc(php);
    if (relay) await new Promise((r) => relay.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}).catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
