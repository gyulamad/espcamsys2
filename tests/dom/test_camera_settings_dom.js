#!/usr/bin/env node
'use strict';
// test_camera_settings_dom.js — the camera SETTINGS page (camera-settings-page.php) in jsdom, with its
// scripts running against a real PHP server and a fake relay, about SAVING a change:
//   * a board that predates the JPEG quality keys (JPEG_Q_DROP / JPEG_Q_MIN / JPEG_Q_MAX / SIZE_DROP,
//     never reported — firmware from before the F-14 link tuning) can still save: no value is demanded
//     for settings such a board cannot have yet, neither for a plain change nor when the quality drop
//     itself is switched on (the version-skew regression: the page used to block every save with
//     "JPEG_Q_DROP is needed too — give it a value", mirroring the buildDeviceChange bug)
//   * a board that HAS the keys with the drop off still has to give the range when it switches the
//     drop on (a feature just switched on must bring its companions — the MOTION_EMA rule)
//   * what the page posts is what Logic.php accepted all along: only what differs, and the relay is
//     handed the final "KEY=value;..." line
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_camera_settings_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_CAMSETDOM_PORT || 19500);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PAGE = `${BASE}/camera-settings-page.php?cam=cam-a`;
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

// What the boards report. OLD_BOARD is firmware from before the F-14 keys: no JPEG_Q_* / SIZE_DROP at
// all. NEW_BOARD has them with the quality drop off — and no range, which it does not need while off.
const OLD_BOARD = {
  WIFI: 'net:********', SERVER_HOST: '192.168.4.9', PUSH_PORT: '8081', HTTP_PORT: '8080', CAMERA_ID: 'cam-a',
  API_KEY: '********', PUSH_GAP_MUL: '1.5', ALARM_GPIO_PIN: '13', ALARM_ACTIVE: 'LOW', ALARM_ALL_CAMS: '0',
  LOG_ENABLED: '1', LOG_MIN_LEVEL: '1', LOG_ECHO: '1', LOG_RETRY_MAX: '3', LOG_RETRY_SEC: '300',
  LOG_FLUSH_SEC: '10', LOG_REPEAT_SEC: '30', LOG_HEARTBEAT: '600', LOG_LOW_HEAP: '30000',
};
const NEW_BOARD = Object.assign({}, OLD_BOARD, { JPEG_Q_DROP: '0', SIZE_DROP: '1' });

let board = OLD_BOARD;        // what GET /state answers with
let staged = null;            // what PUT /change was handed (the final "KEY=value;..." line)
const posts = [];             // what the page POSTed to camera-settings.php

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
          res.end('{"ok":true}');
        } else { res.statusCode = 404; res.end('{}'); }
      });
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-camsetdom-')));
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

// The page in jsdom: the inline script runs, toast.js is loaded (the toasts are what we assert) and busy.js too
// (since F-11 every button runs through CamBusy.run — without it each save click dies with "CamBusy is not defined"
// and nothing is ever posted), the POSTs the page makes are recorded and forwarded with the login, so does the
// fake relay see them.
async function openPage(toasts) {
  const html = await (await nodeFetch(PAGE, { headers: { Authorization: basic } })).text();
  const dom = new JSDOM(html, {
    url: PAGE, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js']), pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      window.fetch = (u, opts = {}) => {
        if ((opts.method || 'GET') === 'POST') posts.push({ url: String(u), body: String(opts.body || '') });
        return nodeFetch(new URL(u, PAGE).toString(), { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
      };
    },
  });
  const { window } = dom;
  await waitFor(() => window.CamToast && window.document.getElementById('f-LOG_ECHO'));
  window.CamToast.show = (t, kind) => { toasts.push(String(t)); };   // the page's own notify(), captured
  return dom;
}
const setField = (window, name, value) => {
  const i = window.document.getElementById('f-' + name);
  i.value = value;
  i.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const clickSave = async (window, toasts, nBefore) => {
  window.document.getElementById('save').click();
  return waitFor(() => (toasts.length > 0 || posts.length > nBefore) && !window.document.getElementById('save').disabled ? true : null);
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

    // ── a board that predates the JPEG quality keys ─────────────────────────────────────────
    let toasts = [];
    let dom = await openPage(toasts);
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    check('the page fills in what the board reported', $('f-LOG_ECHO').value === '1' && $('f-LOG_HEARTBEAT').value === '600');
    check('the JPEG quality rows are shown but empty (the board predates them)', $('f-JPEG_Q_DROP') !== null && $('f-JPEG_Q_DROP').value === '' && !$('r-JPEG_Q_DROP').hidden);

    setField(window, 'LOG_ECHO', '0');
    check('one edit unlocks the save button', !$('save').disabled);
    await clickSave(window, toasts, posts.length);
    check('a plain change is posted — no value demanded for settings the board never reported',
      posts.length === 1 && posts[0].url.includes('camera-settings.php') && posts[0].body === '{"values":{"LOG_ECHO":"0"}}' && staged === 'LOG_ECHO=0',
      JSON.stringify({ posted: posts[0] && posts[0].body, staged }));
    check('…and no toast complains about a missing value', !toasts.some((t) => /needed too/.test(t)), JSON.stringify(toasts));

    await waitFor(() => window.document.getElementById('f-LOG_ECHO'));   // the page re-renders after saving
    setField(window, 'JPEG_Q_DROP', '1');   // the drop itself, range left empty
    await clickSave(window, toasts, posts.length);
    check('switching the quality drop on queues without a range on such a board (it was needed before the change too)',
      posts.length === 2 && posts[1].body === '{"values":{"JPEG_Q_DROP":"1"}}' && staged === 'JPEG_Q_DROP=1',
      JSON.stringify({ posted: posts[1] && posts[1].body, staged }));
    check('…still no toast demanding a value', !toasts.some((t) => /needed too/.test(t)), JSON.stringify(toasts));
    closeWindow(dom);

    // ── a board that HAS the keys, with the drop off and no range yet ───────────────────────
    board = NEW_BOARD;
    toasts = [];
    dom = await openPage(toasts);
    window = dom.window;
    setField(window, 'JPEG_Q_DROP', '1');
    await clickSave(window, toasts, posts.length);
    const demanded = toasts.find((t) => /needed too/.test(t));
    check('switching the drop on demands the range first: nothing is posted',
      posts.length === 2 && demanded === 'JPEG_Q_MIN is needed too — give it a value',
      JSON.stringify({ toasts, posted: posts[2] && posts[2].body }));

    setField(window, 'JPEG_Q_MIN', '12');
    setField(window, 'JPEG_Q_MAX', '63');
    await clickSave(window, toasts, posts.length);
    check('with the range given, the whole quality setting goes out in one change',
      posts.length === 3 && posts[2].body === '{"values":{"JPEG_Q_DROP":"1","JPEG_Q_MIN":"12","JPEG_Q_MAX":"63"}}'
        && staged === 'JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63',
      JSON.stringify({ posted: posts[2] && posts[2].body, staged }));
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
