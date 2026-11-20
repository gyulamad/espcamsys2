#!/usr/bin/env node
'use strict';
// test_detector_settings_atlas_dom.js — the person detector's SETTINGS page (camera-settings-page.php
// with &type=detector, the ⚙ CALIBRATE button of its camera) in jsdom, with its scripts running against
// a real PHP server and a fake relay, about the Settings Atlas layout (F-29 T7c; the page itself is the
// one T7a built, here verified for the detector's own table — PERSON_META and T5b/T5c):
//   * the CATEGORY RAIL names the DETECTOR scope and lists the detector's categories in its table's
//     order with how many settings each holds; the detector starts on Detection (not the camera's
//     Picture & link); the identity keys without a category sit under "Other" at the end
//   * the two categories only the detector has carry their design-board descriptions
//   * the page names what it edits: "the detector of <camera>" in the category heading, the tray note
//     and the apply confirm; the breadcrumb's middle crumb is DETECTOR; the calibration help is shown
//   * the LEVEL switch hides the detector's advanced/expert detection rows at BASIC; a hidden row keeps
//     its edit (still pending)
//   * the MOTION_EMA pairing follows the schema's rule on the page too: switching auto-calibration on
//     (MOTION_EMA_LEN away from 0) demands MOTION_EMA_PCT before anything is sent, and then queues BOTH
//     in one change — the page agrees with the server (buildDeviceChange, tested in test_logic.php)
//   * the DETECT_THRESH / CLEAR_THRESH cross-check refuses to apply an inverted pair, and nothing is sent
//   * the PENDING-CHANGES TRAY counts edits across categories, offers ONE apply that queues them in one
//     line on the relay's detector endpoint, DISCARD sends nothing, and a reboot-apply edit says the
//     detector restarts
//   * rows carry the Atlas tags (serial only, preferences / default, live / reboot) and
//     the ↺ RESET TO default button; a locked secret is disabled and masked
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_detector_settings_atlas_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_CAMDETATLASDOM_PORT || 19710);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PAGE = `${BASE}/camera-settings-page.php?cam=cam-a&type=detector`;
const API = `${BASE}/camera-settings.php?cam=cam-a&type=detector`;
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

// What the detector reports (the identity keys it holds in its flash, plus the detection values it has
// tuned). DETECT_THRESH is 0.75 while its default is 0.6, so the row's reset button has something to do;
// DARK_HYST is left out, so the page first shows it from its default, tagged (a board that predates the
// key); MOTION_EMA_LEN is 0, so MOTION_EMA_PCT is not needed (and switching it on changes that).
const BOARD = {
  WIFI: 'home-net:********', SERVER_HOST: '192.168.4.9', HTTP_PORT: '8080', DETECTOR_ID: 'det-1',
  API_KEY: '********', SETUP_PASSWORD: '********', PERSON_GPIO: '12', OTA_ENABLED: '1', SYNC_ENABLED: '1',
  DETECT_THRESH: '0.75', CLEAR_THRESH: '0.5', DARK_THRESH: '40', MOTION_THRESH: '300', MOTION_HOLD_S: '10',
  MOTION_X0: '0', MOTION_Y0: '0', MOTION_X1: '96', MOTION_Y1: '96', MOTION_EMA_LEN: '0', LOOP_DELAY_MS: '10',
  LOG_MIN_LEVEL: '1', LOG_ECHO: '1',
};

let board = BOARD;            // what GET /state answers with
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
        if (url === '/device-settings/detector/det-1/state') {
          const now = Date.now();
          res.end(JSON.stringify({ reported: { settings: board, at: now - 4000 }, pending: null, last: null, now }));
        } else if (url === '/device-settings/detector/det-1/change' && req.method === 'PUT') {
          staged = body;
          // like the real board: store the change, so the page's reload shows the new values
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-camdetatlasdom-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => 'control-key-1', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪', 'detector' => 'det-1']]];\n`);
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

// The page in jsdom: the inline script runs, toast.js and busy.js load, and the page's own fetches are
// forwarded with the login so the real PHP server and the fake relay answer them.
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
  await waitFor(() => window.CamToast && window.document.getElementById('f-DETECT_THRESH'));
  window.CamToast.show = (t, kind) => { toasts.push(String(t)); };   // the page's own notify(), captured
  return dom;
}
const setField = (window, name, value) => {
  const i = window.document.getElementById('f-' + name);
  i.value = value;
  i.dispatchEvent(new window.Event('change', { bubbles: true }));
};
// APPLY, then wait until the POST left and, when asked, until the relay was handed exactly that line.
const clickApply = async (window, nBefore, expectStaged) => {
  window.document.getElementById('save').click();
  const posted = await waitFor(() => (posts.length > nBefore ? true : null));
  if (!posted || expectStaged === undefined) return posted;
  return waitFor(() => (staged === expectStaged ? true : null));
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

    // what the detector firmware's table says (the same data the page builds the rail and the rows from)
    const schemaKeys = (await (await nodeFetch(API, { headers: { Authorization: basic, 'X-Requested-With': 'camdash' } })).json()).keys;
    const meta = (name) => schemaKeys.find((d) => d.name === name) || {};
    const catFirstSeen = [];
    for (const d of schemaKeys) { const c = d.category || ''; if (!catFirstSeen.includes(c)) catFirstSeen.push(c); }
    const namedCats = catFirstSeen.filter((c) => c !== '');
    const expectCats = namedCats.concat(['']);   // the ones without a category sit under "Other", last
    const catCount = (c) => schemaKeys.filter((d) => (d.category || '') === c).length;

    let toasts = [];
    let dom = await openPage(toasts);
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    const row = (name) => window.document.getElementById('r-' + name);
    const railItem = (c) => window.document.querySelector(`#rail .rail-item[data-cat="${c}"]`);

    // ── the category rail: the detector's own table, in its order ───────────────────────────
    check('the rail is shown with the DETECTOR scope as its heading',
      $('rail').hidden === false && $('rail').querySelector('.rail-head').textContent === 'DETECTOR');
    const railCats = Array.from(window.document.querySelectorAll('#rail .rail-item')).map((b) => b.dataset.cat);
    check('the rail lists the detector table\u2019s categories in order, "Other" last for the identity keys',
      JSON.stringify(railCats) === JSON.stringify(expectCats) && railCats[0] === 'Detection', JSON.stringify(railCats));
    check('each rail entry counts its settings',
      Array.from(window.document.querySelectorAll('#rail .rail-item')).every((b) => Number(b.querySelector('.rail-count').textContent) === catCount(b.dataset.cat)));
    check('the page opens on Detection (a camera opens on Picture & link) with its design-board description',
      $('crumb-cat').textContent === 'Detection' && $('cat-title').textContent === 'Detection'
        && $('cat-desc').textContent.includes('Person thresholds, darkness check and the motion gate')
        && $('cat-desc').textContent.includes('Editing the detector of Front door.'));
    check('the breadcrumb names the dashboard scope DETECTOR and links back to the settings hub',
      $('crumb-scope').textContent === 'DETECTOR' && window.document.querySelector('.crumbs a[href="settings-page.php"]') !== null);
    check('the header names the detector: title and subtitle carry the camera and the detector id',
      $('title').textContent.includes('Front door') && $('title').textContent.includes('detector')
        && $('subtitle').textContent === 'Person detector settings (det-1)');
    check('the calibration help is shown on the detector page', $('calib-help').hidden === false);
    check('the apply button says where the change goes',
      $('save').textContent === '⬆ APPLY TO DETECTOR');
    check('a row of the shown category is visible, one of another category is hidden',
      row('DETECT_THRESH').hidden === false && row('STREAM_JPEG_Q').hidden === true);

    // ── the two categories only the detector has ────────────────────────────────────────────
    railItem('Picture & live view').click();
    check('"Picture & live view" carries its design-board description and rows of the live view',
      $('cat-desc').textContent.includes('Frame rate, JPEG quality and write timeout')
        && row('STREAM_MAX_FPS').hidden === false && row('DETECT_THRESH').hidden === true);
    check('its rows are reboot-apply (the picture pauses while the detector restarts)',
      row('STREAM_JPEG_Q').querySelector('.tag.apply').textContent === 'reboot');
    railItem('Detection').click();

    // ── no tier filter: every setting of every level is on the page at once (F-37) ──────────
    check('the LEVEL switch is gone', $('tierbar') === null);
    check('the advanced and expert detection rows are visible',
      row('LOOP_DELAY_MS').hidden === false && row('DARK_HYST').hidden === false);
    setField(window, 'LOOP_DELAY_MS', '20');
    check('the edit is counted', $('pending-count').textContent === '1 PENDING');

    // ── the MOTION_EMA pairing, the detector's own rule between two settings ────────────────
    // With MOTION_EMA_LEN 0 the margin is not needed: its row is hidden (and dimmed). Turning the
    // auto-calibration on (a pending edit, not yet applied) makes it needed — the row appears, and
    // APPLY refuses until it has a value, then queues BOTH in one change — the page's copy of the
    // server-side rule in buildDeviceChange (test_logic.php). The edit above is discarded first,
    // so the pairing below is the only pending edit and its one change can be told apart.
    window.document.getElementById('revert').click();
    check('with the auto-calibration off its margin row is not needed: hidden, and dimmed as unused',
      row('MOTION_EMA_PCT').hidden === true && row('MOTION_EMA_PCT').classList.contains('unused') === true);
    setField(window, 'MOTION_EMA_LEN', '3000');
    check('turning the auto-calibration on shows the margin row (the edit made it needed)',
      row('MOTION_EMA_PCT').hidden === false && row('MOTION_EMA_PCT').classList.contains('unused') === false);
    const nPostsEma = posts.length;
    await clickApply(window, nPostsEma, undefined);
    check('APPLY refuses until the margin has a value, and sends nothing',
      toasts.some((t) => /MOTION_EMA_PCT is needed too/.test(t)) && posts.length === nPostsEma, JSON.stringify(toasts));
    setField(window, 'MOTION_EMA_PCT', '30');
    check('the pairing is queued in ONE change, the way the board expects it',
      await clickApply(window, nPostsEma, 'MOTION_EMA_LEN=3000;MOTION_EMA_PCT=30')
        && posts[nPostsEma] && posts[nPostsEma].body === '{"values":{"MOTION_EMA_LEN":"3000","MOTION_EMA_PCT":"30"}}'
        && posts[nPostsEma].url.includes('camera-settings.php?cam=cam-a&type=detector'),
      JSON.stringify({ posted: posts[nPostsEma], staged }));
    await waitFor(() => $('f-MOTION_EMA_LEN').value === '3000' && $('pending-count').hidden === true);

    // ── the DETECT_THRESH / CLEAR_THRESH cross-check ────────────────────────────────────────
    setField(window, 'DETECT_THRESH', '0.4');
    const nPostsX = posts.length;
    $('save').click();
    await waitFor(() => toasts.some((t) => /CLEAR_THRESH/.test(t)) || posts.length > nPostsX);
    check('an inverted pair is refused before anything is sent',
      toasts.some((t) => /CLEAR_THRESH \(0.5\) must not be higher than DETECT_THRESH \(0.4\)/.test(t)) && posts.length === nPostsX,
      JSON.stringify(toasts));
    setField(window, 'DETECT_THRESH', String(BOARD.DETECT_THRESH));
    await waitFor(() => $('pending-count').hidden === true);

    // ── the tray: edits from every category, ONE apply, the reboot note ─────────────────────
    setField(window, 'LOG_MIN_LEVEL', '2');       // Logging, live
    railItem('Picture & live view').click();
    setField(window, 'STREAM_JPEG_Q', '70');      // Picture & live view, reboot
    check('edits from both categories are counted together',
      $('pending-count').textContent === '2 PENDING' && window.document.querySelectorAll('#pending-list .pending-row').length === 2);
    check('the tray note names the detector, not the camera',
      $('tray-note').textContent.includes('the detector of Front door picks them up'), $('tray-note').textContent);
    check('a reboot-apply edit says the detector restarts',
      /after the detector restarts/.test($('tray-note').textContent), $('tray-note').textContent);
    check('the rows carry their apply tags: a live row live, a reboot row reboot',
      row('LOG_MIN_LEVEL').querySelector('.tag.apply').textContent === 'live'
        && row('STREAM_JPEG_Q').querySelector('.tag.apply').textContent === 'reboot');
    const nPosts = posts.length;
    check('APPLY sends the edits of every category in ONE change to the detector endpoint',
      await clickApply(window, nPosts, 'STREAM_JPEG_Q=70;LOG_MIN_LEVEL=2')
        && posts[nPosts] && posts[nPosts].body === '{"values":{"STREAM_JPEG_Q":"70","LOG_MIN_LEVEL":"2"}}',
      JSON.stringify({ posted: posts[nPosts] && posts[nPosts].body, staged }));
    await waitFor(() => $('f-STREAM_JPEG_Q').value === '70' && $('f-LOG_MIN_LEVEL').value === '2'
      && $('pending-count').hidden === true && $('save').disabled === true);
    check('after the detector takes the change the tray empties and shows the new values', $('tray-note').hidden === true);

    // ── the row's reset-to-default button ───────────────────────────────────────────────────
    railItem('Detection').click();
    const dtReset = $('f-DETECT_THRESH').closest('.ctl').querySelector('.btn.reset');
    check('a row whose value differs from its default offers RESET TO the default',
      dtReset !== null && dtReset.textContent.includes('RESET TO 0.6') && dtReset.disabled === false, dtReset && dtReset.textContent);
    dtReset.click();
    check('resetting puts the default into the input and counts as a pending change',
      $('f-DETECT_THRESH').value === '0.6' && $('pending-count').textContent === '1 PENDING'
        && $('f-DETECT_THRESH').classList.contains('changed') === true);
    check('reset is disabled while the input already holds the default',
      $('f-CLEAR_THRESH').closest('.ctl').querySelector('.btn.reset').disabled === true);
    const nPosts2 = posts.length;
    check('the reset value is applied like any hand edit', await clickApply(window, nPosts2, 'DETECT_THRESH=0.6')
      && posts[nPosts2] && posts[nPosts2].body === '{"values":{"DETECT_THRESH":"0.6"}}',
      JSON.stringify({ posted: posts[nPosts2] && posts[nPosts2].body, staged }));
    await waitFor(() => $('f-DETECT_THRESH').value === '0.6');

    // ── DISCARD: everything back, nothing sent ──────────────────────────────────────────────
    setField(window, 'DARK_THRESH', '60');
    setField(window, 'LOG_MIN_LEVEL', '3');
    window.document.getElementById('revert').click();
    // waited for, not asserted in the same tick: the APPLY before it re-renders through load(true),
    // and on a slow machine the restore could still be settling when a same-tick assert reads it
    const restored = await waitFor(() => $('pending-count').hidden === true && $('save').disabled === true
      && $('f-DARK_THRESH').value === String(BOARD.DARK_THRESH) && $('f-LOG_MIN_LEVEL').value === '2');
    check('DISCARD empties the tray and restores the stored values, without posting',
      restored === true && posts.length === nPosts2 + 1,
      JSON.stringify({ restored, dark: $('f-DARK_THRESH').value, minlevel: $('f-LOG_MIN_LEVEL').value, posts: posts.length, want: nPosts2 + 1 }));
    check('the discard said so in a toast', toasts.some((t) => /Discarded/.test(t)), JSON.stringify(toasts));

    // ── the row tags over the detector's table ──────────────────────────────────────────────
    check('no row wears a "was hard-coded" tag (F-39)', window.document.querySelectorAll('.tag.hardcoded').length === 0);
    check('a reported row carries the preferences tag and its default value, not the "default" tag',
      Array.from(row('LOG_ECHO').querySelectorAll('.tag')).some((t) => t.textContent === 'preferences')
        && Array.from(row('LOG_ECHO').querySelectorAll('.tag')).some((t) => t.textContent === 'default on')
        && row('LOG_ECHO').querySelector('.tag.default') === null);
    check('a row the detector has not stored shows the default, tagged, with reset disabled',
      row('DARK_HYST').querySelector('.tag.default') !== null
        && $('f-DARK_HYST').value === String(meta('DARK_HYST').default)
        && $('f-DARK_HYST').closest('.ctl').querySelector('.btn.reset').disabled === true);
    check('the identity rows are serial-only, disabled and masked where they are secret',
      row('WIFI').querySelector('.tag.lock') !== null && $('f-WIFI').disabled === true
        && $('f-WIFI').value === 'home-net:********'
        && $('f-API_KEY').value === '********' && $('f-API_KEY').disabled === true
        && row('PERSON_GPIO').querySelector('.tag.lock') !== null);
    check('a locked row has no reset button',
      $('f-WIFI').closest('.ctl').querySelector('.btn.reset') === null);
    check('a number row shows its range, a boolean row says ON / OFF',
      row('DARK_THRESH').querySelector('.range').textContent === meta('DARK_THRESH').min + ' TO ' + meta('DARK_THRESH').max
        && row('CAM_VFLIP').querySelector('.range').textContent === 'ON / OFF',
        row('DARK_THRESH').querySelector('.range').textContent);
    check('a row edited right now wears the changed tag', (() => {
      setField(window, 'LOG_ECHO', '0');
      const t = row('LOG_ECHO').querySelector('.tag.changed');
      const ok = t !== null && t.hidden === false && $('f-LOG_ECHO').classList.contains('changed');
      setField(window, 'LOG_ECHO', '1');
      return ok;
    })());

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
