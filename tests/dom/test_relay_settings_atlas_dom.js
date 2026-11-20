#!/usr/bin/env node
'use strict';
// test_relay_settings_atlas_dom.js — the relay settings page in the ATLAS layout (relay-settings-page.php,
// F-29 T7d, designs/Category-v2.png) in jsdom, with its inline script running against a real PHP server and
// a fake relay answering /system-settings the way lib/sysconfig.js's buildView does (the same fake as
// test_settings_dom.js, plus the two camera-breaking rows camKey and pushPort):
//   * the CATEGORY RAIL lists the categories in the order the page promises (the relay's groups, the
//     dashboard's own "Dashboard" last), each with how many settings it holds; picking one shows its rows,
//     hides the others, and names it in the breadcrumb — which links back to the settings hub
//   * every setting is shown, whatever tier the relay names it for (F-37: the LEVEL switch is gone);
//     a row is hidden only because another category is the one on view, and an edit made in one
//     category survives moving to another and is still counted
//   * the PENDING-CHANGES TRAY lists every unsaved edit — from every category — with its old → new value
//     (a secret as a mask, never its text), counts them in the header pill, warns about restart and
//     camera-breaking edits, and offers ONE apply button that saves through the same POST as the hub's
//     form (confirm:true for the camera-breaking keys); DISCARD puts everything back and sends nothing
//   * each row shows its tags (affects cameras / locked / changed; restarts relay, set by the environment,
//     from config.js, and the default value, highlighted while the shown value differs) and its
//     ↺ DEFAULT button, which goes through the same change tracking as a hand edit
//   * the LOCKED rows (the programs the relay runs) are shown read-only and are never sent; a row the
//     environment overrides is read-only, like before; the file and folder paths never reach the page
//   * a jump from the settings search (?find=KEY, F-29 T7b) opens the key's category and frames the
//     row; a key the relay does not have leaves the page as it always opens
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_relay_settings_atlas_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_RELATLASDOM_PORT || 19800);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PAGE = `${BASE}/relay-settings-page.php`;
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

// The relay's settings table, the way GET /system-settings answers it (lib/sysconfig.js buildView):
// a representative slice of F-29 T6a's rows — every type at least once — with tiers, defaults,
// restart flags, one locked row, one environment-override row, and the two CAMERA-BREAKING keys
// (camKey, pushPort) whose change disconnects every board. `store` holds what POSTs saved, so a GET
// after a save shows the new value, like the real store would — but a secret is never echoed back,
// only that it is set.
const TABLE = [
  { key: 'alarmRecordSeconds', type: 'int', tier: 'basic', group: 'Recording', restart: false, min: 1, max: 3600, value: 60, default: 60, source: 'settings',
    label: 'Alarm recording length (seconds)', help: 'How long a recording started by an alarm input runs.' },
  { key: 'preRollSeconds', type: 'int', tier: 'basic', group: 'Recording', restart: true, min: 0, max: 60, value: 7, default: 5, source: 'settings',
    label: 'Pre-roll (seconds)', help: 'Footage from BEFORE the trigger that every recording starts with.' },
  { key: 'preRollMaxBytes', type: 'int', tier: 'advanced', group: 'Recording', restart: true, min: 65536, max: 1073741824, value: 8388608, default: 8388608, source: 'default',
    label: 'Pre-roll RAM cap per camera (bytes)', help: 'The buffer drops its oldest frames first.' },
  { key: 'personScanEnabled', type: 'bool', tier: 'basic', group: 'Person check', restart: false, value: true, default: true, source: 'settings',
    label: 'Person check', help: 'ON: every new recording is checked by the person detector.' },
  { key: 'personScanConfidence', type: 'float', tier: 'basic', group: 'Person check', restart: false, value: 0.4, default: 0.4, source: 'default', step: 0.05, minExclusive: true, min: 0, max: 1,
    label: 'Sensitivity', help: 'How sure the detector must be.' },
  { key: 'personScanAction', type: 'choice', tier: 'advanced', group: 'Person check', restart: true, value: 'move', default: 'move', source: 'default', options: ['move', 'delete'],
    label: 'What to do with a clip without a person', help: 'move files it under no-person/.' },
  { key: 'personScanPython', type: 'string', tier: 'expert', group: 'Person check', restart: true, locked: true, value: 'python3', default: 'python3', source: 'config.js', min: 1, max: 300,
    label: 'Python program that runs the detector', help: 'LOCKED: it decides what program the relay runs.' },
  { key: 'alarmSoundRecordStart', type: 'sound', tier: 'basic', group: 'Alarm sounds', restart: false, value: 'siren.wav', default: '', source: 'settings', options: ['siren.wav', 'chime.wav'],
    label: 'Sound when a recording starts', help: 'None = no sound.' },
  { key: 'alarmSoundPlayer', type: 'argv', tier: 'expert', group: 'Alarm sounds', restart: true, locked: true, value: ['ffplay', '-nodisp', '-autoexit'], default: ['ffplay', '-nodisp', '-autoexit'], source: 'config.js',
    label: 'Sound player command', help: 'LOCKED: the program that plays a sound on the relay machine.' },
  { key: 'port', type: 'int', tier: 'advanced', group: 'Network', restart: true, min: 1, max: 65535, value: 8080, default: 8080, source: 'default',
    label: 'HTTP port', help: 'The relay\'s HTTP port.' },
  { key: 'pushPort', type: 'int', tier: 'advanced', group: 'Network', restart: true, min: 1, max: 65535, value: 8081, default: 8081, source: 'default',
    label: 'Camera push port', help: 'The raw TCP port the cameras push their frames to. It is flashed into every camera.' },
  { key: 'discoveryPort', type: 'int', tier: 'advanced', group: 'Network', restart: true, min: 0, max: 65535, value: 8888, default: 8888, source: 'default',
    label: 'Camera discovery port (UDP)', help: 'Where the relay answers a camera that lost its address.' },
  { key: 'relayBind', type: 'host', tier: 'expert', group: 'Network', restart: true, value: '0.0.0.0', default: '0.0.0.0', source: 'default',
    label: 'HTTP bind address', help: 'The address the HTTP port listens on.' },
  { key: 'camKey', type: 'secret', tier: 'advanced', group: 'Keys', restart: true, isSet: true, source: 'settings', min: 8, max: 200,
    label: 'Camera key', help: 'Must match the API key of every camera. Leave empty to keep the current one.' },
  { key: 'controlKey', type: 'secret', tier: 'advanced', group: 'Keys', restart: true, isSet: true, source: 'settings', min: 8, max: 200,
    label: 'Control key', help: 'Protects recording ON/OFF, these settings and firmware publishing.' },
  { key: 'logKeepFiles', type: 'int', tier: 'advanced', group: 'Log', restart: true, min: 1, max: 20, value: 2, default: 2, source: 'default',
    label: 'Rotated log files kept', help: 'Disk use is at most (this + 1) x the rotation size.' },
  { key: 'detectorViewMinutes', type: 'int', tier: 'basic', group: 'Detectors', restart: true, min: 1, max: 240, value: 10, default: 10, source: 'default',
    label: 'Detector live view length (minutes)', help: 'How long a person detector keeps streaming.' },
  { key: 'telegramBotToken', type: 'secret', tier: 'basic', group: 'Notifications', restart: true, isSet: true, source: 'config.js', min: 8, max: 200,
    label: 'Telegram bot token', help: 'From @BotFather. Leave empty to keep the current one.' },
  { key: 'telegramChatId', type: 'chatids', tier: 'basic', group: 'Notifications', restart: true, value: '-100214748364', default: '', source: 'config.js',
    label: 'Telegram chat id(s)', help: 'Your chat\'s number, or several separated by commas.' },
  { key: 'notifyCooldownSeconds', type: 'int', tier: 'advanced', group: 'Notifications', restart: true, min: 0, max: 86400, value: 60, default: 60, source: 'default',
    label: 'At most one person message per camera in (seconds)', help: 'What is held back is counted in the next message.' },
  { key: 'readKeyRequired', type: 'bool', tier: 'expert', group: 'Security', restart: true, value: true, default: true, source: 'environment',
    envOverride: true, envName: 'READ_KEY_REQUIRED', label: 'Refuse reads while no control key is set',
    help: 'ON (safe): live video, snapshots and recordings are refused until a control key is set.' },
  { key: 'loopWatch', type: 'bool', tier: 'expert', group: 'Diagnostics', restart: true, value: true, default: true, source: 'default',
    label: 'Event-loop watchdog', help: 'Logs when the relay\'s main loop stalls.' },
];
const SECRET_KEYS = TABLE.filter((f) => f.type === 'secret').map((f) => f.key);

const store = {};        // what POST /system-settings has saved (overrides over the table)
const relayPosts = [];   // every POST body the relay was handed

function view() {
  return {
    fields: TABLE.map((f) => {
      if (SECRET_KEYS.includes(f.key)) return { ...f, isSet: true };   // a secret is never echoed back
      return { ...f, value: store[f.key] !== undefined ? store[f.key] : f.value };
    }),
    supervised: true,
  };
}

function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (url === '/system-settings' && req.method === 'GET') {
          res.end(JSON.stringify(view()));
        } else if (url === '/system-settings' && req.method === 'POST') {
          relayPosts.push(body);
          const values = JSON.parse(body || '{}');
          const changed = [];
          for (const [k, v] of Object.entries(values)) {
            store[k] = v;
            changed.push(k);
          }
          res.end(JSON.stringify({ ok: true, changed, restartRequired: false }));
        } else { res.statusCode = 404; res.end('{}'); }
      });
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relatlasdom-')));
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

// The page in jsdom: the inline script runs, toast.js, busy.js and sound-library.js load (the toasts and
// the button busy states are what we assert; without busy.js no click ever reaches its handler), the
// page's own fetches are forwarded with the login so the real PHP server and the fake relay answer them.
const posts = [];       // every POST body the page sent (url + body)
const confirms = [];    // every confirm() text the page asked about
async function openPage(toasts) {
  const html = await (await nodeFetch(PAGE, { headers: { Authorization: basic } })).text();
  const dom = new JSDOM(html, {
    url: PAGE, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js', 'sound-library.js']), pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = (text) => { confirms.push(String(text)); return true; };
      window.alert = () => {};
      window.fetch = (u, opts = {}) => {
        if ((opts.method || 'GET') === 'POST') posts.push({ url: String(u), body: String(opts.body || '') });
        return nodeFetch(new URL(u, PAGE).toString(), { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
      };
    },
  });
  const { window } = dom;
  await waitFor(() => window.CamToast && window.document.getElementById('f-preRollSeconds'));
  window.CamToast.show = (t, kind) => { toasts.push(String(t)); };   // the page's own notify(), captured
  return dom;
}
const setField = (window, name, value) => {
  const i = window.document.getElementById('f-' + name);
  i.value = value;
  i.dispatchEvent(new window.Event('input', { bubbles: true }));
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

    // what the server sends (the same data the page builds the rail and the rows from): the relay's
    // fields as this fake serves them, plus the dashboard's own (system-settings.php appends them)
    const served = (await (await nodeFetch(`${BASE}/system-settings.php`, { headers: { Authorization: basic, 'X-Requested-With': 'camdash' } })).json()).fields;
    const GROUP_ORDER = ['Recording', 'Person check', 'Alarm sounds', 'Network', 'Keys', 'Log', 'Folders', 'Detectors', 'Notifications', 'Security', 'Diagnostics', 'Dashboard'];
    const seen = [];
    for (const f of served) { const g = f.group || ''; if (!seen.includes(g)) seen.push(g); }
    const expectedCats = GROUP_ORDER.filter((g) => seen.includes(g))
      .concat(seen.filter((g) => g !== '' && !GROUP_ORDER.includes(g)));
    const catCount = (c) => served.filter((f) => (f.group || '') === c).length;

    let toasts = [];
    let dom = await openPage(toasts);
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    const row = (name) => window.document.getElementById('r-' + name);
    const railItem = (c) => window.document.querySelector(`#rail .rail-item[data-cat="${c}"]`);
    const defTag = (name) => row(name).querySelector('.tag.defval');

    // ── the category rail ────────────────────────────────────────────────────────────────────
    check('the rail is shown with RELAY as its heading',
      $('rail').hidden === false && $('rail').querySelector('.rail-head').textContent === 'RELAY');
    const railCats = Array.from(window.document.querySelectorAll('#rail .rail-item')).map((b) => b.dataset.cat);
    check('the rail lists the categories in the promised order, the dashboard\u2019s own last',
      JSON.stringify(railCats) === JSON.stringify(expectedCats), JSON.stringify(railCats));
    check('each rail entry counts its settings',
      Array.from(window.document.querySelectorAll('#rail .rail-item')).every((b) => Number(b.querySelector('.rail-count').textContent) === catCount(b.dataset.cat)));
    check('the first category is shown, named in the breadcrumb and the heading, with a description',
      railCats[0] === 'Recording' && $('crumb-cat').textContent === 'Recording' && $('cat-title').textContent === 'Recording'
        && $('cat-desc').textContent.includes('pre-roll'));
    check('the breadcrumb links back to the settings hub',
      window.document.querySelector('.crumbs a[href="settings-page.php"]') !== null);
    check('a row of the shown category is visible, one of another category is hidden',
      row('alarmRecordSeconds').hidden === false && row('personScanEnabled').hidden === true);
    check('a file or folder path never reaches the page, a locked row does',
      $('f-logFile') === null && $('f-personScanModel') === null && row('personScanPython') !== null);

    railItem('Person check').click();
    check('picking a category shows its rows, hides the others, and names it in the breadcrumb',
      row('personScanEnabled').hidden === false && row('alarmRecordSeconds').hidden === true
        && $('crumb-cat').textContent === 'Person check');

    // ── the row tags: defaults, sources, secrets ─────────────────────────────────────────────
    check('a row shows its default', defTag('alarmRecordSeconds') !== null && defTag('alarmRecordSeconds').textContent === 'default 60');
    check('a value that differs from the default highlights the tag', defTag('preRollSeconds').classList.contains('differs') === true,
      defTag('preRollSeconds') && defTag('preRollSeconds').textContent);
    check('a value equal to the default does not', defTag('logKeepFiles').classList.contains('differs') === false);
    check('a boolean default is spelled ON/OFF', defTag('personScanEnabled').textContent === 'default ON');
    check('an empty default is spelled none', defTag('alarmSoundRecordStart').textContent === 'default none');
    check('a secret has no default and no tag', defTag('controlKey') === null);
    check('a secret shows only that it is set, never the value',
      $('f-controlKey').tagName === 'INPUT' && $('f-controlKey').type === 'password'
        && $('f-controlKey').placeholder === '(set — leave empty to keep)' && $('f-controlKey').value === '');
    check('a row that restarts the relay shows the flag',
      row('preRollSeconds').querySelector('.tag.restart') !== null && row('preRollSeconds').querySelector('.tag.restart').textContent === 'restarts relay'
        && row('alarmRecordSeconds').querySelector('.tag.restart') === null);
    check('a value read from config.js says so',
      Array.from(row('telegramChatId').querySelectorAll('.tag')).some((t) => t.textContent === 'from config.js'));
    check('an environment-overridden row is read-only and says so',
      $('f-readKeyRequired').disabled === true
        && Array.from(row('readKeyRequired').querySelectorAll('.tag')).some((t) => t.textContent.includes('READ_KEY_REQUIRED')));
    check('a camera-breaking key wears the affects-cameras tag, a normal key does not',
      row('camKey').querySelector('.tag.danger') !== null && row('camKey').querySelector('.tag.danger').textContent === 'affects cameras'
        && row('pushPort').querySelector('.tag.danger') !== null && row('alarmRecordSeconds').querySelector('.tag.danger') === null);
    check('a number row shows its range, a boolean row says ON / OFF',
      row('preRollSeconds').querySelector('.range').textContent === '0 TO 60'
        && row('personScanEnabled').querySelector('.range').textContent === 'ON / OFF',
        row('preRollSeconds').querySelector('.range').textContent);

    // ── no tier filter: every setting of every level is on the page at once (F-37) ───────────
    check('the LEVEL switch is gone', $('tierbar') === null);
    railItem('Network').click();
    check('the advanced and expert rows of the shown category are visible',
      row('discoveryPort').hidden === false && row('relayBind').hidden === false);
    railItem('Person check').click();
    check('the expert rows of every category are visible', row('personScanPython').hidden === false);
    railItem('Dashboard').click();
    check('the dashboard\u2019s own rows are visible as well', row('auth_user').hidden === false);

    // ── an edit in one category survives moving to another, and stays counted ────────────────
    railItem('Recording').click();
    setField(window, 'preRollMaxBytes', '1000');
    check('the edit is counted', $('pending-count').textContent === '1 PENDING');
    railItem('Network').click();
    check('moving to another category hides the edited row but keeps its edit pending',
      row('preRollMaxBytes').hidden === true && $('pending-count').textContent === '1 PENDING'
        && $('f-preRollMaxBytes').value === '1000');
    railItem('Recording').click();
    check('back in its category the row and its edit are there again',
      row('preRollMaxBytes').hidden === false && $('f-preRollMaxBytes').value === '1000' && $('pending-count').textContent === '1 PENDING');

    // ── the pending-changes tray: one apply for everything, from every category ──────────────
    check('the tray holds ONE apply button', window.document.querySelectorAll('#save').length === 1);
    check('the edit is listed in the tray with its old and new value, and the note says nothing is written until APPLY',
      $('pending-list').textContent.includes('preRollMaxBytes') && $('pending-list').textContent.includes('8388608')
        && $('pending-list').textContent.includes('1000') && $('tray-note').textContent.includes('1 pending change')
        && $('tray-note').textContent.includes('nothing is written until you apply'));
    railItem('Person check').click();
    setField(window, 'personScanConfidence', '0.6');
    check('edits from both categories are counted together',
      $('pending-count').textContent === '2 PENDING' && window.document.querySelectorAll('#pending-list .pending-row').length === 2
        && $('pending-list').textContent.includes('0.4') && $('pending-list').textContent.includes('0.6'));

    // ── the tray note follows the edited rows: restart and camera-breaking ───────────────────
    railItem('Recording').click();
    setField(window, 'preRollSeconds', '9');
    check('a restart-marked edit says the restart in the tray note',
      $('pending-count').textContent === '3 PENDING' && /effect only after the relay restarts/.test($('tray-note').textContent),
      $('tray-note').textContent);
    railItem('Keys').click();
    setField(window, 'camKey', 'a-new-key-9');
    check('a camera-breaking edit warns in the tray note and the secret is listed masked',
      $('pending-count').textContent === '4 PENDING' && /stops every camera from connecting/.test($('tray-note').textContent)
        && $('pending-list').textContent.includes('********') && !$('pending-list').textContent.includes('a-new-key-9'),
        $('tray-note').textContent);

    // ── DISCARD: everything back, nothing sent ───────────────────────────────────────────────
    window.document.getElementById('revert').click();
    check('DISCARD empties the tray and restores the stored values, without posting',
      $('pending-count').hidden === true && $('save').disabled === true
        && $('f-preRollMaxBytes').value === '8388608' && $('f-personScanConfidence').value === '0.4'
        && $('f-preRollSeconds').value === '7' && $('f-camKey').value === ''
        && posts.length === 0);
    check('the discard said so in a toast', toasts.some((t) => /Discarded/.test(t)), JSON.stringify(toasts));

    // ── the row's reset-to-default button ────────────────────────────────────────────────────
    railItem('Recording').click();
    const prReset = $('f-preRollSeconds').closest('.ctl').querySelector('.btn.reset');
    check('a row whose value differs from its default offers DEFAULT, one at its default has it disabled',
      prReset !== null && prReset.disabled === false
        && $('f-alarmRecordSeconds').closest('.ctl').querySelector('.btn.reset').disabled === true);
    prReset.click();
    check('resetting puts the default into the input and counts as a pending change',
      $('f-preRollSeconds').value === '5' && $('pending-count').textContent === '1 PENDING'
        && $('f-preRollSeconds').classList.contains('changed') === true);
    const nPosts = posts.length;
    window.document.getElementById('save').click();
    check('APPLY saves through the same POST as the hub\u2019s form, the relay is handed the value',
      await waitFor(() => (posts.length > nPosts ? true : null)) !== null
        && posts[nPosts].body === '{"values":{"preRollSeconds":"5"},"confirm":false}'
        && await waitFor(() => (relayPosts.length > 0 ? true : null)) !== null
        && relayPosts[0] === '{"preRollSeconds":"5"}',
      JSON.stringify({ posted: posts[nPosts] && posts[nPosts].body, relay: relayPosts[0] }));
    await waitFor(() => $('f-preRollSeconds').value === '5' && $('pending-count').hidden === true
      && defTag('preRollSeconds').classList.contains('differs') === false);
    check('after the save the tray is empty and the default tag is no longer highlighted', $('tray-note').hidden === true);

    // ── locked rows: shown read-only, never sent ─────────────────────────────────────────────
    railItem('Person check').click();
    check('a locked row is read-only with the lock tag and no reset button',
      $('f-personScanPython').disabled === true && row('personScanPython').querySelector('.tag.lock') !== null
        && $('f-personScanPython').value === 'python3'
        && $('f-personScanPython').closest('.ctl').querySelector('.btn.reset') === null);
    railItem('Alarm sounds').click();
    check('a locked argv row shows the command as one line',
      $('f-alarmSoundPlayer').disabled === true && $('f-alarmSoundPlayer').value === 'ffplay -nodisp -autoexit');
    check('the sound library is listed with the sound rows it feeds',
      $('sound-slot').hidden === false && $('sound-slot').querySelector('.sound-list') !== null);
    check('a sound row is a choice among the relay\u2019s offered files',
      $('f-alarmSoundRecordStart').tagName === 'SELECT'
        && Array.from($('f-alarmSoundRecordStart').options).map((o) => o.value).join(',') === ',siren.wav,chime.wav');
    railItem('Network').click();
    check('the sound library shows only in the Alarm sounds category', $('sound-slot').hidden === true);
    check('a word choice is a select of the offered words', $('f-personScanAction').tagName === 'SELECT'
      && Array.from($('f-personScanAction').options).map((o) => o.value).join(',') === 'move,delete');

    // ── saving never sends the locked rows along ─────────────────────────────────────────────
    railItem('Recording').click();
    setField(window, 'alarmRecordSeconds', '75');
    const nPosts2 = posts.length;
    const nRelayPosts = relayPosts.length;
    window.document.getElementById('save').click();
    check('APPLY posts just the changed value',
      await waitFor(() => (posts.length > nPosts2 ? true : null)) !== null
        && posts[nPosts2].body === '{"values":{"alarmRecordSeconds":"75"},"confirm":false}',
      JSON.stringify(posts.slice(nPosts2)));
    check('the relay was handed the changed value, none of the locked rows',
      await waitFor(() => (relayPosts.length > nRelayPosts ? true : null)) !== null
        && JSON.parse(relayPosts[nRelayPosts]).alarmRecordSeconds === '75'
        && JSON.parse(relayPosts[nRelayPosts]).personScanPython === undefined
        && JSON.parse(relayPosts[nRelayPosts]).alarmSoundPlayer === undefined,
      JSON.stringify(relayPosts.slice(nRelayPosts)));
    await waitFor(() => $('f-alarmRecordSeconds').value === '75' && $('pending-count').hidden === true);
    check('after the save the page shows the saved value', $('f-alarmRecordSeconds').value === '75');

    // ── APPLY of a camera-breaking key asks, then saves with confirm ─────────────────────────
    railItem('Keys').click();
    setField(window, 'camKey', 'a-new-key-1');
    const nPosts3 = posts.length;
    const nRelayPosts3 = relayPosts.length;
    window.document.getElementById('save').click();
    check('APPLY of a camera-breaking key asks before saving',
      confirms.length === 1 && confirms[0].includes('camKey') && confirms[0].includes('EVERY camera'),
      JSON.stringify(confirms));
    check('the save went out with confirm:true, and the relay took the new key',
      await waitFor(() => (posts.length > nPosts3 ? true : null)) !== null
        && JSON.parse(posts[nPosts3].body).confirm === true
        && JSON.parse(posts[nPosts3].body).values.camKey === 'a-new-key-1'
        && await waitFor(() => (relayPosts.length > nRelayPosts3 ? true : null)) !== null
        && JSON.parse(relayPosts[nRelayPosts3]).camKey === 'a-new-key-1',
      JSON.stringify({ posted: posts[nPosts3] && posts[nPosts3].body, relay: relayPosts[nRelayPosts3] }));
    await waitFor(() => $('pending-count').hidden === true);
    check('after the save the secret row shows only that it is set again',
      $('f-camKey').value === '' && $('f-camKey').placeholder === '(set — leave empty to keep)');

    check('the run left no error toasts', !toasts.some((t) => /error|could not/i.test(t)), JSON.stringify(toasts));
    closeWindow(dom);

    // ── the search's jump (?find=KEY, F-29 T7b) ──────────────────────────────────────────────
    // A fresh page opened with ?find=discoveryPort (Network): the key's category opens and the row is
    // framed. A key the relay does not have is ignored and the page opens as always (the first
    // category, nothing framed).
    toasts = [];
    const openFind = async (find) => {
      const url = `${BASE}/relay-settings-page.php${find ? '?find=' + encodeURIComponent(find) : ''}`;
      const html = await (await nodeFetch(url, { headers: { Authorization: basic } })).text();
      const d = new JSDOM(html, {
        url, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js', 'sound-library.js']), pretendToBeVisual: true,
        beforeParse(window) {
          window.confirm = () => true;
          window.alert = () => {};
          window.fetch = (u, opts = {}) => nodeFetch(new URL(u, url).toString(), { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
        },
      });
      await waitFor(() => d.window.CamToast && d.window.document.getElementById('f-discoveryPort'));
      return d;
    };
    const domFind = await openFind('discoveryPort');
    let w = domFind.window;
    check('the search\u2019s jump opens the key\u2019s category in the breadcrumb and the rail',
      w.document.getElementById('crumb-cat').textContent === 'Network'
        && w.document.querySelector('#rail .rail-item.on').dataset.cat === 'Network');
    check('the jumped-to row is shown and framed', w.document.getElementById('r-discoveryPort').hidden === false
      && w.document.getElementById('r-discoveryPort').classList.contains('found') === true);
    closeWindow(domFind);
    const domMiss = await openFind('noSuchKey');
    w = domMiss.window;
    check('an unknown key leaves the page as always',
      w.document.getElementById('crumb-cat').textContent === 'Recording'
        && w.document.querySelectorAll('.row.found').length === 0);
    closeWindow(domMiss);
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
