#!/usr/bin/env node
'use strict';
// test_settings_search_dom.js — the "Jump to any setting" search (F-29 T7b, designs/Search-v2.png) in
// jsdom, with its scripts running against a real PHP server and a fake relay:
//   * the INDEX (settings-search-index.php) lists every setting as one concrete entry — each camera's
//     keys, the detector's keys of the camera it is paired with, the relay's and the dashboard's own
//     fields — with a value that follows the board (the stored value, else the default) and a url that
//     opens the page the setting is edited on with ?find=KEY; a secret is never in it, only the mask
//   * a relay that cannot be reached degrades: the devices stay searchable, relayError says what is missing
//   * the PAGE (the settings page settings-page.php with the search box embedded in it, F-38) matches
//     names, labels and help text (every word typed), ranks a name match above a label above a help
//     match, narrows by the scope pills, names the device on a scope that holds several, and shows the
//     value; the selection and Enter open the hit's url. Typing swaps the settings page for the result
//     list, emptying it (or ESC) brings the settings back; the box never takes the focus by itself
//   * the CAMERA page opened with ?find=KEY shows the key's category, frames and focuses it, and ignores
//     a key the firmware does not have; the SETTINGS page does the same for its rows (a locked row is
//     framed, its input cannot be focused)
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_settings_search_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_SETSEARCHDOM_PORT || 19830);
const RELAY_PORT = PHP_PORT + 1;
const DEAD_PORT = PHP_PORT + 5;          // nothing listens here: the relay-unreachable variant
const PHP_PORT2 = PHP_PORT + 3;          // the second dashboard (its relay is unreachable)
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE2 = `http://127.0.0.1:${PHP_PORT2}`;
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
async function waitFor(fn, ms = 8000) {
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

// What the boards report. cam-a has stored JPEG_Q_MIN=10 (its default is 12) and a secret that must never
// reach the browser unmasked; cam-b has reported nothing at all, so every hit of its keys shows defaults.
const BOARD_A = { CAMERA_ID: 'cam-a', API_KEY: 'super-secret-key', JPEG_Q_MIN: '10', LOG_HEARTBEAT: '900' };
const BOARD_DET = { DETECTOR_ID: 'det-1', DARK_THRESH: '35' };

// The relay's own settings table, shaped like GET /system-settings answers (F-29 T6b): groups, tiers,
// the restart flag, values; personScanPython is locked (shown read-only on the page).
const RELAY_FIELDS = [
  { key: 'alarmRecordSeconds', type: 'int', group: 'Recording', tier: 'basic', restart: false, value: 10, label: 'Alarm recording length (seconds)', help: 'How long an alarm recording runs.' },
  { key: 'personScanStride', type: 'int', group: 'Person check', tier: 'expert', restart: false, value: 4, label: 'Person check every Nth picture', help: 'Scans every Nth stored picture.' },
  { key: 'personScanPython', type: 'string', group: 'Person check', restart: false, locked: true, value: '/usr/bin/python3', label: 'Python program', help: 'What runs the person check.' },
  { key: 'pushPort', type: 'int', group: 'Network', tier: 'advanced', restart: true, value: 8081, label: 'Raw push port', help: 'The port the boards push frames to.' },
];

function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      res.setHeader('Content-Type', 'application/json');
      const now = Date.now();
      if (url === '/device-settings/recorder/cam-a/state') {
        res.end(JSON.stringify({ reported: { settings: BOARD_A, at: now - 4000 }, pending: null, last: null, now }));
      } else if (url === '/device-settings/recorder/cam-b/state') {
        res.end(JSON.stringify({ reported: null, pending: null, last: null, now }));
      } else if (url === '/device-settings/detector/det-1/state') {
        res.end(JSON.stringify({ reported: { settings: BOARD_DET, at: now - 4000 }, pending: null, last: null, now }));
      } else if (url === '/system-settings') {
        res.end(JSON.stringify({ fields: RELAY_FIELDS, supervised: true }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

function makeDashboard(relayPort) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-setsearchdom-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${relayPort}', 'relay_control_key' => 'control-key-1', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪'], ['id' => 'cam-b', 'name' => 'Back gate', 'icon' => '🌳', 'detector' => 'det-1']]];\n`);
  return dir;
}
function startPhp(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    const probe = `http://127.0.0.1:${port}/`;
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = http.get(probe, () => r(true)); q.on('error', () => r(false)); });
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

// The page in jsdom: the inline script runs, the named scripts load, the page's own fetches are
// forwarded with the login so the real PHP server and the fake relay answer them.
async function openPage(url, scripts) {
  const html = await (await nodeFetch(url, { headers: { Authorization: basic } })).text();
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, scripts), pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      window.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom has no layout to scroll
      window.fetch = (u, opts = {}) => nodeFetch(new URL(u, url).toString(), {
        method: opts.method, body: opts.body,
        headers: { ...(opts.headers || {}), Authorization: basic },
      });
    },
  });
  return dom;
}
async function searchLoaded(window) {
  return waitFor(() => {
    const pills = window.document.querySelectorAll('#scopebar .scope-pill');
    return window.CamSearch && pills.length === 4 ? window.CamSearch : null;   // All scopes + the index's three
  });
}
const type = (window, text) => {
  const q = window.document.getElementById('q');
  q.value = text;
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const hitInfo = (window) => Array.from(window.document.querySelectorAll('#results .hit')).map((a) => ({
  href: a.getAttribute('href'), key: a.querySelector('.hit-key').textContent,
  label: (a.querySelector('.hit-label') || { textContent: '' }).textContent,
  chips: Array.from(a.querySelectorAll('.chip')).map((c) => c.textContent),
  value: a.querySelector('.hit-value').textContent,
}));
const SETTINGS_SCRIPTS = ['toast.js', 'busy.js'];   // what a settings page needs (the icon picker etc. are guarded)

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; let php2; let relay; let dir; let dir2;
  try {
    relay = await startRelay();
    dir = makeDashboard(RELAY_PORT);   // the dashboard under test, its relay answering
    dir2 = makeDashboard(DEAD_PORT);   // the same dashboard, but its relay is unreachable
    php = await startPhp(dir, PHP_PORT);
    php2 = await startPhp(dir2, PHP_PORT2);
    const API = `${BASE}/settings-search-index.php`;

    // ── the index ───────────────────────────────────────────────────────────────────────────
    const idx = await (await nodeFetch(API, { headers: { Authorization: basic, 'X-Requested-With': 'camdash' } })).json();
    check('the index names the scopes in the order the search shows them',
      JSON.stringify(idx.scopes) === JSON.stringify(['cameras', 'detectors', 'relay']), JSON.stringify(idx.scopes));
    const byUrl = {};
    for (const e of idx.entries) byUrl[e.url] = e;
    const jpegA = byUrl['camera-settings-page.php?cam=cam-a&find=JPEG_Q_MIN'];
    check('a camera key is an entry with its label, category, tier, apply flag and its stored value',
      jpegA && jpegA.scope === 'cameras' && jpegA.key === 'JPEG_Q_MIN' && jpegA.label === 'Best JPEG quality'
        && jpegA.category === 'Picture & link' && jpegA.tier === 'basic' && jpegA.apply === 'live' && jpegA.value === '10',
      JSON.stringify(jpegA));
    const jpegB = byUrl['camera-settings-page.php?cam=cam-b&find=JPEG_Q_MIN'];
    check('the same key of a board that never reported shows the default',
      jpegB && jpegB.value === '12' && jpegB.deviceName === 'Back gate', JSON.stringify(jpegB));
    const det = byUrl['camera-settings-page.php?cam=cam-b&type=detector&find=DARK_THRESH'];
    check('a detector key opens the paired camera\u2019s CALIBRATE page and shows the detector\u2019s value',
      det && det.scope === 'detectors' && det.category === 'Detection' && det.value === '35' && det.deviceName === 'Back gate',
      JSON.stringify(det));
    const relayHit = byUrl['settings-page.php?find=alarmRecordSeconds'];
    check('a relay field is an entry with its group as the category and its value',
      relayHit && relayHit.scope === 'relay' && relayHit.category === 'Recording' && relayHit.value === '10' && relayHit.apply === 'live',
      JSON.stringify(relayHit));
    check('a relay field that needs a restart says reboot, a locked one keeps its lock',
      byUrl['settings-page.php?find=pushPort'] && byUrl['settings-page.php?find=pushPort'].apply === 'reboot'
        && byUrl['settings-page.php?find=personScanPython'] && byUrl['settings-page.php?find=personScanPython'].locked === true,
      JSON.stringify([byUrl['settings-page.php?find=pushPort'], byUrl['settings-page.php?find=personScanPython']]));
    const secret = byUrl['camera-settings-page.php?cam=cam-a&find=API_KEY'];
    check('a secret is only ever the mask \u2014 the value the board holds never reaches the browser',
      secret && secret.value === '********' && !idx.entries.some((e) => String(e.value).indexOf('super-secret-key') !== -1),
      JSON.stringify(secret));
    const dash = byUrl['settings-page.php?find=auth_pass'];
    check('the dashboard\u2019s own settings are in the relay scope, its password only as (set)',
      dash && dash.scope === 'relay' && dash.value === '(set)' && dash.category === 'Dashboard', JSON.stringify(dash));
    const camB = idx.entries.filter((e) => e.scope === 'cameras' && e.deviceId === 'cam-b');
    check('a board that never reported is searchable with its defaults, not skipped',
      camB.length === idx.entries.filter((e) => e.scope === 'cameras' && e.deviceId === 'cam-a').length && camB.length > 0,
      String(camB.length));
    check('the index endpoint refuses a request that does not come from the dashboard\u2019s own page',
      (await nodeFetch(API, { headers: { Authorization: basic } })).status === 403);

    // ── the search box on the settings page ────────────────────────────────────────────────
    let dom = await openPage(`${BASE}/settings-page.php`, SETTINGS_SCRIPTS.concat(['settings-search.js', 'icon-catalog.js', 'icon-picker.js', 'sound-library.js']));
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    let search = await searchLoaded(window);
    check('the result area starts hidden and the settings page is what shows',
      window.document.getElementById('search-area').hidden === true
        && window.document.getElementById('page').hidden === false
        && window.document.getElementById('results').querySelectorAll('.hit').length === 0);
    check('the embedded search never takes the focus by itself (a ?find= jump must keep it)',
      window.document.activeElement !== $('q'));
    check('the scope pills are there, All scopes first and chosen', (() => {
      const pills = Array.from(window.document.querySelectorAll('#scopebar .scope-pill'));
      return pills.length === 4 && pills[0].textContent === 'All scopes' && pills[0].classList.contains('on')
        && pills.map((p) => p.textContent).join('|') === 'All scopes|Cameras|Detectors|Relay';
    })(), Array.from(window.document.querySelectorAll('#scopebar .scope-pill')).map((p) => p.textContent).join('|'));
    type(window, 'jpeg');
    check('typing swaps the settings page for the result list',
      window.document.getElementById('page').hidden === true
        && window.document.getElementById('search-area').hidden === false);
    let hits = hitInfo(window);
    check('a query by NAME finds the keys on every device that has one',
      hits.length === 7 && hits.filter((h) => h.key === 'JPEG_Q_MIN').length === 2
        && hits.filter((h) => h.key === 'STREAM_JPEG_Q').length === 1,
      JSON.stringify(hits.map((h) => h.key + '@' + h.href)));
    const minA = hits.find((h) => h.key === 'JPEG_Q_MIN' && h.href.includes('cam=cam-a'));
    const minB = hits.find((h) => h.key === 'JPEG_Q_MIN' && h.href.includes('cam=cam-b'));
    check('a hit shows the label, the value, and the path chip Scope / category; equal hits keep the index order',
      minA && minB && minA.label === 'Best JPEG quality' && minA.value === '10'
        && minA.chips.includes('Cameras / Picture & link')
        && hits.indexOf(minA) < hits.indexOf(minB), JSON.stringify([minA, minB]));
    check('on a scope with two cameras a hit names its device, the single-detector scope does not',
      minA.chips.some((c) => /Front door/.test(c)) && minB.chips.some((c) => /Back gate/.test(c))
        && !hits.find((h) => h.key === 'STREAM_JPEG_Q').chips.some((c) => /Front door|Back gate/.test(c)),
      JSON.stringify(hits.map((h) => h.chips)));
    check('a value the board has not stored shows the default it falls back to',
      minB.value === '12' && hits.find((h) => h.key === 'STREAM_JPEG_Q').value === '80');

    // a LABEL match ranks above a HELP-text match
    type(window, 'darkness');
    hits = hitInfo(window);
    check('a query by LABEL ranks the labelled setting above one that only explains it in the help',
      hits.length === 2 && hits[0].key === 'DARK_THRESH' && hits[0].label === 'Darkness threshold (0 = off)'
        && hits[1].key === 'DARK_HYST', JSON.stringify(hits.map((h) => h.key)));
    type(window, 'debounce');
    hits = hitInfo(window);
    check('a query by LABEL finds the setting the label names, on every camera',
      hits.length === 2 && hits.every((h) => h.key === 'ALARM_DEBOUNCE' && h.label === 'Alarm contact debounce (ms)'),
      JSON.stringify(hits.map((h) => h.key)));
    type(window, 'slow-loris');
    hits = hitInfo(window);
    check('a query that only matches a help text finds the settings that explain it',
      hits.length === 3 && hits.every((h) => h.key === 'SETUP_RQ_TMO_MS'), JSON.stringify(hits.map((h) => h.key)));

    // the scope pills narrow the list
    Array.from(window.document.querySelectorAll('#scopebar .scope-pill')).find((p) => p.textContent === 'Relay').click();
    type(window, 'alarm record');
    hits = hitInfo(window);
    check('the Relay scope offers the relay\u2019s and dashboard\u2019s fields only',
      hits.length === 1 && hits[0].href === 'settings-page.php?find=alarmRecordSeconds', JSON.stringify(hits));
    window.CamSearch.scope = 'all';
    hits = hitInfo(window);
    check('every word typed must match, so two words narrow instead of widen',
      hits.length === 5 && hits[0].key === 'alarmRecordSeconds'
        && hits.filter((h) => h.key === 'ALARM_HOLD_MS').length === 2
        && hits.filter((h) => h.key === 'ALARM_ALL_CAMS').length === 2, JSON.stringify(hits.map((h) => h.key)));
    type(window, 'zzzz-nothing');
    check('no match says so, quoting the query',
      window.document.querySelectorAll('#results .hit').length === 0
        && /No setting matches/.test($('results').textContent) && /zzzz-nothing/.test($('results').textContent),
      $('results').textContent);

    // the keyboard: selection moves, Enter opens the selected hit
    type(window, 'jpeg');
    hits = hitInfo(window);
    const opened = [];
    window.CamBusy.navigate = (u) => opened.push(String(u));   // the module hands its Enter opens to CamBusy
    const q = $('q');
    q.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    check('ArrowDown moves the selection to the next hit',
      search.selected === 1 && window.document.querySelectorAll('#results .hit')[1].classList.contains('sel'), String(search.selected));
    q.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('Enter opens the selected hit\u2019s url', opened.length === 1 && opened[0] === hits[1].href, JSON.stringify(opened));
    q.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('ESC clears the query, empties the list and brings the settings page back',
      $('q').value === '' && window.document.querySelectorAll('#results .hit').length === 0
        && window.document.getElementById('page').hidden === false
        && window.document.getElementById('search-area').hidden === true);
    closeWindow(dom);

    // ── the camera page as the jump target ──────────────────────────────────────────────────
    dom = await openPage(`${BASE}/camera-settings-page.php?cam=cam-a&find=SER_BAUD`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-SER_BAUD') && window.document.getElementById('rail').hidden === false);
    check('a jump to a row opens ITS category and frames and focuses the row',
      window.document.getElementById('crumb-cat').textContent === 'Hardware & internals'
        && window.document.getElementById('r-SER_BAUD').hidden === false
        && window.document.getElementById('r-SER_BAUD').classList.contains('found')
        && window.document.activeElement === window.document.getElementById('f-SER_BAUD'),
      JSON.stringify({ cat: window.document.getElementById('crumb-cat').textContent, active: window.document.activeElement && window.document.activeElement.id }));
    check('switching the category takes the frame away again (it points where the search landed)', (() => {
      const rail = Array.from(window.document.querySelectorAll('#rail .rail-item')).find((b) => b.dataset.cat === 'Logging');
      rail.click();
      return window.document.querySelector('.row.found') === null
        && window.document.getElementById('r-LOG_MIN_LEVEL').hidden === false;
    })());
    closeWindow(dom);

    dom = await openPage(`${BASE}/camera-settings-page.php?cam=cam-a&find=LOG_MIN_LEVEL`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-LOG_MIN_LEVEL'));
    check('another jump opens that key\u2019s category and frames the row',
      window.document.getElementById('crumb-cat').textContent === 'Logging'
        && window.document.getElementById('r-LOG_MIN_LEVEL').classList.contains('found'),
      JSON.stringify({ cat: window.document.getElementById('crumb-cat').textContent }));
    closeWindow(dom);

    dom = await openPage(`${BASE}/camera-settings-page.php?cam=cam-a&find=NO_SUCH_KEY`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-JPEG_Q_DROP'));
    check('a key the firmware does not have is ignored: the page opens as always, nothing framed',
      window.document.getElementById('crumb-cat').textContent === 'Picture & link'
        && window.document.querySelector('.row.found') === null);
    closeWindow(dom);

    // ── the settings page as the jump target ────────────────────────────────────────────────
    dom = await openPage(`${BASE}/settings-page.php?find=personScanStride`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-personScanStride'));
    check('a jump to a relay row opens ITS category, frames and focuses the row',
      window.document.getElementById('cat-title').textContent === 'Person check'
        && window.document.getElementById('r-personScanStride').hidden === false
        && window.document.getElementById('r-personScanStride').classList.contains('found')
        && window.document.activeElement === window.document.getElementById('f-personScanStride'),
      JSON.stringify({ cat: window.document.getElementById('cat-title').textContent, active: window.document.activeElement && window.document.activeElement.id }));
    closeWindow(dom);

    dom = await openPage(`${BASE}/settings-page.php?find=personScanPython`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-personScanPython'));
    check('a jump to a locked relay row frames the row; its read-only input takes no focus',
      window.document.getElementById('r-personScanPython').classList.contains('found')
        && window.document.getElementById('f-personScanPython').disabled === true
        && window.document.activeElement !== window.document.getElementById('f-personScanPython'));
    closeWindow(dom);

    dom = await openPage(`${BASE}/settings-page.php?find=notAField`, SETTINGS_SCRIPTS);
    window = dom.window;
    await waitFor(() => window.document.getElementById('f-alarmRecordSeconds'));
    check('a key the settings page does not hold is ignored: nothing framed, page as always',
      window.document.querySelector('.row.found') === null
        && window.document.getElementById('cat-title').textContent === 'Recording');
    closeWindow(dom);

    // ── an unreachable relay degrades; the settings page still searches what it has ─────────
    dom = await openPage(`${BASE2}/settings-page.php`, SETTINGS_SCRIPTS.concat(['settings-search.js', 'icon-catalog.js', 'icon-picker.js', 'sound-library.js']));
    window = dom.window;
    search = await searchLoaded(window);
    check('a relay that cannot be reached degrades: the devices stay searchable, the note says what is missing', (() => {
      type(window, 'jpeg');
      const rows = window.document.querySelectorAll('#results .hit');
      return rows.length === 7 && $('note').textContent.length > 0 && /relay/i.test($('note').textContent)
        && !window.document.querySelector('#results .hit').getAttribute('href').startsWith('settings-page.php?find=');
    })(), $('note').textContent);
    check('the relay scope of an unreachable relay offers nothing (its page could not show them anyway)', (() => {
      window.CamSearch.scope = 'relay';
      return window.document.querySelectorAll('#results .hit').length === 0;
    })());
    check('the settings page carries the search box, the camera page no jump button of any kind',
      (await (await nodeFetch(`${BASE}/settings-page.php`, { headers: { Authorization: basic } })).text()).includes('id="q"')
        && !(await (await nodeFetch(`${BASE}/camera-settings-page.php?cam=cam-a`, { headers: { Authorization: basic } })).text()).includes('JUMP TO SETTING'));
    closeWindow(dom);
  } finally {
    if (php) await stopProc(php);
    if (php2) await stopProc(php2);
    if (relay) await new Promise((r) => relay.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (dir2) fs.rmSync(dir2, { recursive: true, force: true });
  }
}

main().then(() => {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}).catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
