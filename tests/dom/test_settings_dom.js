#!/usr/bin/env node
'use strict';
// test_settings_dom.js — the SETTINGS page (settings-page.php, the relay's and the dashboard's
// own settings) in jsdom, with its inline script running against a REAL PHP server and a fake
// relay answering /system-settings the way lib/sysconfig.js's buildView does. About F-29 T6b:
//   * the form is grouped by category, in the order the page promises (GROUP_ORDER), and every
//     relay row carries its tier — the LEVEL switch hides the rows above the chosen level, and
//     switching it back and forth hides and shows them without losing anything
//   * every row with a default shows it ("default 60"), highlighted while the saved value
//     differs from it; a "restarts relay" row shows that flag
//   * a row's ↺ DEFAULT button puts the default into the input — through the SAME change
//     tracking as a hand-made edit (the save button unlocks, only what differs is posted,
//     and after saving the page shows the default back, un-highlighted)
//   * the LOCKED rows (the programs the relay runs) are shown read-only with the lock tag, and
//     are never sent back: saving another setting posts only what changed
//   * a row the environment overrides is read-only, like before
// The PHP part is the real system-settings.php: it filters what the page may see (no paths,
// locked rows kept) and forwards the save to the relay with the control key.
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
//   node tests/dom/test_settings_dom.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { closeWindow, pageScriptLoader } = require('./dom_helpers');

let JSDOM, jsdomModule;
try { jsdomModule = require('jsdom'); ({ JSDOM } = jsdomModule); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_SETDOM_PORT || 19600);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PAGE = `${BASE}/settings-page.php`;
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
// restart flags, one locked row, one environment-override row. `store` holds what POSTs saved,
// so a GET after a save shows the new value, like the real store would.
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
  { key: 'discoveryPort', type: 'int', tier: 'advanced', group: 'Network', restart: true, min: 0, max: 65535, value: 8888, default: 8888, source: 'default',
    label: 'Camera discovery port (UDP)', help: 'Where the relay answers a camera that lost its address.' },
  { key: 'relayBind', type: 'host', tier: 'expert', group: 'Network', restart: true, value: '0.0.0.0', default: '0.0.0.0', source: 'default',
    label: 'HTTP bind address', help: 'The address the HTTP port listens on.' },
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

const store = {};        // what POST /system-settings has saved (overrides over the table)
const relayPosts = [];   // every POST body the relay was handed

function view() {
  return { fields: TABLE.map((f) => ({ ...f, value: store[f.key] !== undefined ? store[f.key] : f.value })), supervised: true };
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-setdom-')));
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

// The page in jsdom: the inline script runs, toast.js and busy.js load (the toasts and the
// button busy states are what we assert; without busy.js no click ever reaches its handler),
// the page's own fetches are forwarded with the login so the real PHP server answers them.
async function openPage(toasts) {
  const html = await (await nodeFetch(PAGE, { headers: { Authorization: basic } })).text();
  const dom = new JSDOM(html, {
    url: PAGE, runScripts: 'dangerously', resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js']), pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      window.fetch = (u, opts = {}) => new Promise((resolve, reject) => nodeFetch(new URL(u, PAGE).toString(), {
        method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic },
      }).then(resolve, reject));
    },
  });
  const { window } = dom;
  await waitFor(() => window.CamToast && window.document.getElementById('f-preRollSeconds'));
  window.CamToast.show = (t, kind) => { toasts.push(String(t)); };
  return dom;
}
const setField = (window, name, value) => {
  const i = window.document.getElementById('f-' + name);
  i.value = value;
  i.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const clickReset = (window, name) => window.document.getElementById('f-' + name).closest('.ctl').querySelector('.btn.reset').click();
const clickSave = async (window) => {
  window.document.getElementById('save').click();
  await waitFor(() => !window.document.getElementById('save').disabled ? true : null);
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
    let dom = await openPage(toasts);
    let window = dom.window;
    const $ = (id) => window.document.getElementById(id);
    const row = (name) => window.document.getElementById('r-' + name);

    // ── the form: grouped by category, in the page's promised order ─────────────────────
    const legends = Array.from(window.document.querySelectorAll('#form fieldset legend')).map((l) => l.textContent);
    check('the groups come in the promised order, the new ones included',
      JSON.stringify(legends) === JSON.stringify(['Recording', 'Person check', 'Alarm sounds', 'Network', 'Keys', 'Log', 'Detectors', 'Notifications', 'Security', 'Diagnostics', 'Dashboard']),
      JSON.stringify(legends));
    check('a path setting never reaches the page (personScanModel), a locked one does',
      $('f-personScanModel') === null && $('f-personScanPython') !== null);

    // ── no tier filter: every setting of every level is on the page at once (F-37) ───────
    check('the LEVEL switch is gone', $('tierbar') === null);
    check('an advanced row is shown', row('discoveryPort').hidden === false);
    check('an expert row is shown too', row('relayBind').hidden === false && row('loopWatch').hidden === false && row('personScanPython').hidden === false);
    check('the dashboard\'s own rows are shown as well', row('auth_user').hidden === false);

    // ── defaults: shown, highlighted while the saved value differs ──────────────────────
    const defTag = (name) => row(name).querySelector('.tag.default');
    check('a row shows its default', defTag('alarmRecordSeconds') !== null && defTag('alarmRecordSeconds').textContent === 'default 60');
    check('a value that differs from the default highlights the tag', defTag('preRollSeconds').classList.contains('differs') === true,
      defTag('preRollSeconds') && defTag('preRollSeconds').textContent);
    check('a value equal to the default does not', defTag('logKeepFiles').classList.contains('differs') === false);
    check('a boolean default is spelled ON/OFF', defTag('personScanEnabled').textContent === 'default ON');
    check('an empty default is spelled none', defTag('alarmSoundRecordStart').textContent === 'default none');
    check('a secret has no default and no tag', defTag('controlKey') === null);
    check('a row that restarts the relay shows the flag', row('preRollSeconds').querySelector('.tag.restart') !== null && row('alarmRecordSeconds').querySelector('.tag.restart') === null);

    // ── reset to default: through the same change tracking and save as an edit ──────────
    check('the reset button is disabled while the input holds the default', $('f-logKeepFiles').closest('.ctl').querySelector('.btn.reset').disabled === true);
    check('a differing value enables it', $('f-preRollSeconds').closest('.ctl').querySelector('.btn.reset').disabled === false);
    clickReset(window, 'preRollSeconds');
    check('resetting puts the default into the input', $('f-preRollSeconds').value === '5');
    check('it counts as an unsaved change: the save bar unlocks', $('save').disabled === false && $('f-preRollSeconds').classList.contains('changed') === true);
    setField(window, 'preRollSeconds', '9');
    clickReset(window, 'preRollSeconds');
    check('resetting back after a hand edit restores the default again', $('f-preRollSeconds').value === '5');
    const nPosts = relayPosts.length;
    await clickSave(window);
    check('saving posts just the reset value, as an ordinary change',
      relayPosts.length === nPosts + 1 && relayPosts[nPosts] === '{"preRollSeconds":"5"}',
      JSON.stringify(relayPosts.slice(nPosts)));
    await waitFor(() => $('f-preRollSeconds').value === '5' && defTag('preRollSeconds').classList.contains('differs') === false);
    check('after the save the page shows the default back, no longer highlighted',
      $('f-preRollSeconds').value === '5' && defTag('preRollSeconds').classList.contains('differs') === false);

    // ── locked rows: shown read-only, never sent ────────────────────────────────────────
    check('a locked row is read-only with the lock tag',
      $('f-personScanPython').disabled === true && row('personScanPython').querySelector('.tag.lock') !== null && $('f-personScanPython').value === 'python3');
    check('a locked argv row shows the command as one line',
      $('f-alarmSoundPlayer').disabled === true && $('f-alarmSoundPlayer').value === 'ffplay -nodisp -autoexit');
    check('a locked row has no reset button', $('f-personScanPython').closest('.ctl').querySelector('.btn.reset') === null);
    setField(window, 'alarmRecordSeconds', '45');
    const nPosts2 = relayPosts.length;
    await clickSave(window);
    check('saving another setting never sends the locked rows along',
      relayPosts.length === nPosts2 + 1 && JSON.parse(relayPosts[nPosts2]).personScanPython === undefined,
      relayPosts[nPosts2]);

    // ── the environment and the choice ─────────────────────────────────────────────────
    check('an environment-overridden row is read-only and says so',
      $('f-readKeyRequired').disabled === true && Array.from(row('readKeyRequired').querySelectorAll('.tag')).some((t) => t.textContent.includes('READ_KEY_REQUIRED')));
    check('a choice is a select of the offered words', $('f-personScanAction').tagName === 'SELECT'
      && Array.from($('f-personScanAction').options).map((o) => o.value).join(',') === 'move,delete');
    check('the dashboard\'s own rows are editable and untiered', $('f-auth_user').value === AUTH.user && row('auth_user').dataset.tier === undefined);
    check('the cameras list is there', $('cameras').hidden === false && window.document.querySelector('#cam-list .cam-row') !== null);
    check('the page had nothing to complain about', !toasts.some((t) => /error|could not/i.test(t)), JSON.stringify(toasts));
    closeWindow(dom);

    // ── revert: back to what the server sent, in one click ──────────────────────────────
    toasts = [];
    dom = await openPage(toasts);
    window = dom.window;
    setField(window, 'preRollSeconds', '30');
    setField(window, 'logKeepFiles', '5');
    window.document.getElementById('revert').click();
    check('REVERT puts the saved values back and clears the unsaved changes',
      window.document.getElementById('f-preRollSeconds').value === '5' && window.document.getElementById('f-logKeepFiles').value === '2'
        && window.document.getElementById('save').disabled === true);
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
