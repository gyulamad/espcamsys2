#!/usr/bin/env node
'use strict';
// test_camera_settings_atlas_dom.js — the camera SETTINGS page (camera-settings-page.php) in jsdom, with its
// scripts running against a real PHP server and a fake relay, about the Settings Atlas layout (F-29 T7a,
// designs/Main-v2.png and Category-v2.png):
//   * the CATEGORY RAIL lists the firmware table's categories in its order, with how many settings each
//     holds, and the ones without a category (identity values, serial-only locks, setup mode) under
//     "Other" at the end; picking a category shows its rows, hides the others, and names it in the breadcrumb
//   * the LEVEL switch (BASIC / ADVANCED / EXPERT) hides the rows above the chosen level; a hidden row keeps
//     its value, so an edit made at a higher level survives switching down and is still counted
//   * the PENDING-CHANGES TRAY lists every unsaved edit — from every category — with its old → new value,
//     counts them in the header pill, and offers ONE apply button that sends them all in one change;
//     DISCARD puts everything back and sends nothing
//   * each row shows its tags (serial only / changed; preferences or default, live or
//     reboot, and the default value) and its ↺ RESET TO default button, which goes through the same
//     change tracking as a hand edit
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_camera_settings_atlas_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_CAMATLASDOM_PORT || 19700);
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

// What the board reports. LOG_HEARTBEAT is 900 while its default is 600, so the row's reset button has
// something to do; JPEG_Q_MIN is left out, so the page first shows it from its default, tagged (a board
// that predates the key); PUSH_WR_TMO_MS is there because it is one of the reboot-apply rows.
const BOARD = {
  WIFI: 'net:********', SERVER_HOST: '192.168.4.9', PUSH_PORT: '8081', HTTP_PORT: '8080', CAMERA_ID: 'cam-a',
  API_KEY: '********', PUSH_GAP_MUL: '1.5', PUSH_WR_TMO_MS: '8000', ALARM_GPIO_PIN: '13', ALARM_ACTIVE: 'LOW', ALARM_ALL_CAMS: '0',
  LOG_ENABLED: '1', LOG_MIN_LEVEL: '1', LOG_ECHO: '1', LOG_RETRY_MAX: '3', LOG_RETRY_SEC: '300',
  LOG_FLUSH_SEC: '10', LOG_REPEAT_SEC: '30', LOG_HEARTBEAT: '900', LOG_LOW_HEAP: '30000',
  JPEG_Q_DROP: '1', JPEG_Q_MAX: '63',
};

let board = BOARD;            // what GET /state answers with
let staged = null;            // what PUT /change was handed (the final "KEY=value;..." line)
let relaySettings = {         // what GET /system-settings answers with (F-29 T8: the Linked settings panel)
  fields: [
    { key: 'port', type: 'int', value: 8080, label: 'HTTP port' },
    { key: 'pushPort', type: 'int', value: 8081, label: 'Camera push port' },
    { key: 'discoveryPort', type: 'int', value: 8082, label: 'Camera discovery port' },
    { key: 'camKey', type: 'secret', isSet: true, label: 'Camera key' },
    { key: 'alarmRecordSeconds', type: 'int', value: 60, label: 'Alarm recording length' },
  ],
};
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
        } else if (url === '/system-settings' && req.method === 'GET') {   // the relay's own settings (Linked settings panel)
          res.end(JSON.stringify(relaySettings));
        } else if (url === '/device-settings/recorder/cam-a/change' && req.method === 'PUT') {
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-camatlasdom-')));
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

// The page in jsdom: the inline script runs, toast.js and busy.js load (the toasts and the button busy
// states are what we assert; without busy.js no click ever reaches its handler), the page's own fetches
// are forwarded with the login so the real PHP server and the fake relay answer them.
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
// APPLY, then wait until the POST left (it is recorded when fetch is called) and, when asked, until the
// relay was handed exactly that change line. The apply button itself stays disabled afterwards: the tray
// is empty again, so waiting for `!save.disabled` would wait forever.
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

    // what the firmware's table says (the same data the page builds the rail and the rows from)
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

    // ── the Linked settings panel (F-29 T8): the cross-device rules, watched, with their verdicts ──
    check('the Linked settings panel is shown with the five rules a camera is offered',
      $('linked').hidden === false
      && Array.from(window.document.querySelectorAll('#linked-list .linked-row')).map((r) => r.querySelector('.formula').textContent).join(' | ')
        === 'API_KEY = relay camKey | RF_PORT = relay discoveryPort | PUSH_PORT = relay pushPort | PUSH_WR_TMO_MS > relay LIVE_WINDOW_MS | ALARM_HOLD_MS < relay alarmRecordSeconds');
    check('a healthy board against a healthy relay: every linked rule holds (a green mark on every row)',
      window.document.querySelectorAll('#linked-list .linked-row.ok').length === 5
      && window.document.querySelectorAll('#linked-list .linked-row.bad').length === 0);
    check('the API key rule says plainly that the values are never sent — it watches "set / not set" only',
      window.document.querySelector('#linked-list .linked-row.ok .formula').textContent === 'API_KEY = relay camKey'
      && window.document.querySelector('#linked-list .linked-row.ok .note').textContent.includes('never sent'));

    // ── the category rail ────────────────────────────────────────────────────────────────────
    check('the rail is shown with the dashboard scope as its heading',
      $('rail').hidden === false && $('rail').querySelector('.rail-head').textContent === 'CAMERAS');
    const railCats = Array.from(window.document.querySelectorAll('#rail .rail-item')).map((b) => b.dataset.cat);
    check('the rail lists the firmware table\u2019s categories in order, "Other" last for the ones without a category',
      JSON.stringify(railCats) === JSON.stringify(expectCats), JSON.stringify(railCats));
    check('each rail entry counts its settings',
      Array.from(window.document.querySelectorAll('#rail .rail-item')).every((b) => Number(b.querySelector('.rail-count').textContent) === catCount(b.dataset.cat)));
    check('the first category is shown, named in the breadcrumb and the heading, with a description and the camera',
      railCats[0] === 'Picture & link' && $('crumb-cat').textContent === 'Picture & link' && $('cat-title').textContent === 'Picture & link'
        && $('cat-desc').textContent.includes('JPEG quality') && $('cat-desc').textContent.includes('Front door'));
    check('a row of the shown category is visible, one of another category is hidden',
      row('JPEG_Q_DROP').hidden === false && row('LOG_ECHO').hidden === true);

    railItem('Logging').click();
    check('picking a category shows its rows, hides the others, and names it in the breadcrumb',
      row('LOG_MIN_LEVEL').hidden === false && row('JPEG_Q_DROP').hidden === true && $('crumb-cat').textContent === 'Logging');

    railItem('').click();
    check('the "Other" entry shows the identity and serial-only rows',
      row('WIFI').hidden === false && row('SETUP_MODE') !== null && row('WIFI').querySelector('.tag.lock') !== null);

    // ── no tier filter: every setting of every level is on the page at once (F-37) ───────────
    check('the LEVEL switch is gone', $('tierbar') === null);
    railItem('Logging').click();
    check('the advanced rows of the shown category are visible', row('LOG_ECHO').hidden === false);
    setField(window, 'LOG_HEARTBEAT', '700');
    check('the edit is counted', $('pending-count').textContent === '1 PENDING');
    railItem('Picture & link').click();
    check('moving to another category hides the edited row but keeps its edit pending',
      row('LOG_HEARTBEAT').hidden === true && $('pending-count').textContent === '1 PENDING'
        && $('f-LOG_HEARTBEAT').value === '700');
    railItem('Logging').click();
    check('back in its category the row and its edit are there again',
      row('LOG_HEARTBEAT').hidden === false && $('f-LOG_HEARTBEAT').value === '700' && $('pending-count').textContent === '1 PENDING');

    // ── the pending-changes tray: one apply for everything, from every category ──────────────
    check('the tray holds ONE apply button', window.document.querySelectorAll('#save').length === 1);
    setField(window, 'LOG_HEARTBEAT', '800');   // replaces the 700: still one pending edit, 900 → 800
    check('the edit is listed in the tray with its old and new value, and counted in the header',
      $('pending-count').textContent === '1 PENDING' && $('tray-note').textContent.includes('1 pending change')
        && $('tray-note').textContent.includes('Front door') && $('pending-list').textContent.includes('LOG_HEARTBEAT')
        && $('pending-list').textContent.includes('900') && $('pending-list').textContent.includes('800'));
    railItem('Picture & link').click();
    check('an edit made in another category stays pending while browsing', $('pending-count').textContent === '1 PENDING');
    setField(window, 'JPEG_Q_MIN', '10');
    check('edits from both categories are counted together',
      $('pending-count').textContent === '2 PENDING' && $('tray-note').textContent.includes('2 pending changes')
        && window.document.querySelectorAll('#pending-list .pending-row').length === 2);

    const nPosts = posts.length;
    check('APPLY sends the edits of every category in ONE change', await clickApply(window, nPosts, 'JPEG_Q_MIN=10;LOG_HEARTBEAT=800')
      && posts[nPosts] && posts[nPosts].body === '{"values":{"JPEG_Q_MIN":"10","LOG_HEARTBEAT":"800"}}',
      JSON.stringify({ posted: posts[nPosts] && posts[nPosts].body, staged }));

    await waitFor(() => $('f-JPEG_Q_MIN').value === '10' && $('f-LOG_HEARTBEAT').value === '800'
      && $('pending-count').hidden === true && $('save').disabled === true);
    check('after the board takes the change the tray empties and shows the new values', $('tray-note').hidden === true);

    // ── the reboot flag ──────────────────────────────────────────────────────────────────────
    setField(window, 'PUSH_WR_TMO_MS', '9000');   // a reboot-apply row (Picture & link, advanced)
    check('a reboot-apply edit says the restart in the tray note',
      /takes effect only after the camera restarts/.test($('tray-note').textContent), $('tray-note').textContent);
    check('…and its row is flagged reboot, a live row live',
      row('PUSH_WR_TMO_MS').querySelector('.tag.apply').textContent === 'reboot'
        && row('LOG_ECHO') !== null && row('LOG_ECHO').querySelector('.tag.apply').textContent === 'live');
    setField(window, 'PUSH_WR_TMO_MS', '8000');
    await waitFor(() => $('pending-count').hidden === true);

    // ── the row's reset-to-default button ────────────────────────────────────────────────────
    setField(window, 'LOG_HEARTBEAT', '1200');
    const hbReset = $('f-LOG_HEARTBEAT').closest('.ctl').querySelector('.btn.reset');
    check('a row whose value differs from its default offers RESET TO the default',
      hbReset !== null && hbReset.textContent.includes('RESET TO 600') && hbReset.disabled === false);
    hbReset.click();
    check('resetting puts the default into the input and counts as a pending change',
      $('f-LOG_HEARTBEAT').value === '600' && $('pending-count').textContent === '1 PENDING'
        && $('f-LOG_HEARTBEAT').classList.contains('changed') === true);
    check('reset is disabled while the input already holds the default',
      $('f-JPEG_Q_DROP').closest('.ctl').querySelector('.btn.reset').disabled === true);
    const nPosts2 = posts.length;
    check('the reset value is applied like any hand edit', await clickApply(window, nPosts2, 'LOG_HEARTBEAT=600')
      && posts[nPosts2] && posts[nPosts2].body === '{"values":{"LOG_HEARTBEAT":"600"}}',
      JSON.stringify({ posted: posts[nPosts2] && posts[nPosts2].body, staged }));
    await waitFor(() => $('f-LOG_HEARTBEAT').value === '600');

    // ── DISCARD: everything back, nothing sent ───────────────────────────────────────────────
    setField(window, 'LOG_HEARTBEAT', '1500');
    setField(window, 'JPEG_Q_MIN', '20');
    window.document.getElementById('revert').click();
    check('DISCARD empties the tray and restores the stored values, without posting',
      $('pending-count').hidden === true && $('save').disabled === true
        && $('f-LOG_HEARTBEAT').value === '600' && $('f-JPEG_Q_MIN').value === '10'
        && posts.length === nPosts2 + 1);
    check('the discard said so in a toast', toasts.some((t) => /Discarded/.test(t)), JSON.stringify(toasts));

    // ── the row tags ─────────────────────────────────────────────────────────────────────────
    check('no row wears a "was hard-coded" tag (F-39)', window.document.querySelectorAll('.tag.hardcoded').length === 0);
    check('a reported row carries the preferences tag and its default value, not the "default" tag',
      Array.from(row('LOG_ECHO').querySelectorAll('.tag')).some((t) => t.textContent === 'preferences')
        && Array.from(row('LOG_ECHO').querySelectorAll('.tag')).some((t) => t.textContent === 'default on')
        && row('LOG_ECHO').querySelector('.tag.default') === null);
    check('a row the board has not stored shows the default, tagged, with reset disabled',
      row('SIZE_DROP').querySelector('.tag.default') !== null
        && $('f-SIZE_DROP').value === String(meta('SIZE_DROP').default)
        && $('f-SIZE_DROP').closest('.ctl').querySelector('.btn.reset').disabled === true);
    check('a locked row has no reset button', $('f-WIFI').closest('.ctl').querySelector('.btn.reset') === null
        && row('SETUP_MODE').querySelector('.btn.reset') === null);
    check('a number row shows its range, a boolean row says ON / OFF',
      row('LOG_HEARTBEAT').querySelector('.range').textContent === meta('LOG_HEARTBEAT').min + ' TO ' + meta('LOG_HEARTBEAT').max
        && row('LOG_ECHO').querySelector('.range').textContent === 'ON / OFF',
        row('LOG_HEARTBEAT').querySelector('.range').textContent);
    check('a row edited right now wears the changed tag', (() => {
      setField(window, 'LOG_ECHO', '0');
      const t = row('LOG_ECHO').querySelector('.tag.changed');
      const ok = t !== null && t.hidden === false && $('f-LOG_ECHO').classList.contains('changed');
      setField(window, 'LOG_ECHO', '1');
      return ok;
    })());
    check('a row at its default does not highlight the default tag',
      row('PUSH_GAP_MUL').querySelector('.tag.defval') !== null
        && row('PUSH_GAP_MUL').querySelector('.tag.defval').classList.contains('differs') === false);
    check('the breadcrumb links back to the settings hub',
      window.document.querySelector('.crumbs a[href="settings-page.php"]') !== null);
    closeWindow(dom);

    // ── the Linked settings panel flags a drifted value: the relay's pushPort no longer matches the board ──
    relaySettings.fields.find((f) => f.key === 'pushPort').value = 8099;
    toasts = [];
    dom = await openPage(toasts);
    window = dom.window;
    const badRow = Array.from(window.document.querySelectorAll('#linked-list .linked-row.bad'))
      .find((r) => r.querySelector('.formula').textContent === 'PUSH_PORT = relay pushPort');
    check('a PUSH_PORT that drifted from the relay\'s pushPort is flagged, and the reason names both ports',
      badRow !== undefined && badRow.querySelector('.mark').textContent === '✗'
      && badRow.querySelector('.note').textContent.includes('PUSH_PORT (8081)')
      && badRow.querySelector('.note').textContent.includes('pushPort (8099)'));
    check('the other rules still hold while one has drifted',
      window.document.querySelectorAll('#linked-list .linked-row.ok').length === 4);
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
