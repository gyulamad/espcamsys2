#!/usr/bin/env node
'use strict';
// test_system_settings_e2e.js — end-to-end check of the settings page's backend: a REAL relay
// (server.js, supervised by this test the way systemd would: it is started again when it exits
// with the restart code) behind a REAL PHP dashboard (php -S) with a generated config.php.
//
// Relay, directly (X-Control-Key):
//   - needs the control key; secrets are never sent back; bad values are refused and change nothing
//   - the alarm length applies at once (no restart); other settings are saved and flagged "restart"
//   - /restart makes the relay exit and come back, now running with the saved values
//   - a relay that nothing would restart refuses /restart (409) instead of dying
//   - a damaged settings file cannot stop the relay from starting
// Dashboard (system-settings.php):
//   - needs the login and the dashboard's own request header
//   - one save can change relay settings AND config.php; the relay is restarted and the answer
//     comes only once it is back
//   - settings that disconnect the cameras need an explicit confirm
//   - rotating the control key, and moving the relay's port, keep the dashboard working
//     (config.php follows), and config.php keeps its cameras
//   - a wrong relay address is refused before anything is saved
//
// Needs `php` on PATH (skips with a message if not). Own ports, throwaway folders. Core modules only.
//
// Usage:  node tests/e2e/test_system_settings_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_SRC = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_SYSSET_PORT || 19400);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const PUSH_PORT = BASE + 2;
const RELAY2_PORT = BASE + 3;
const PUSH2_PORT = BASE + 4;
const NEW_RELAY_PORT = BASE + 5;
const CAM_KEY = 'e2e-camera-key-0001';
const CONTROL = 'e2e-control-key-0001';
const RESTART_CODE = 75;

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

if (spawnSync('php', ['-v']).error) {
  console.log('php not found on PATH — skipping the settings end-to-end test');
  finished = true;
  process.exit(0);
}

// ── a throwaway copy of the relay, with its own config.js (so nothing is overridden by env vars) ──
function makeRelayDir(tmp, name, port, pushPort) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('cp', ['-r', path.join(RELAY_SRC, 'lib'), path.join(RELAY_SRC, 'server.js'), path.join(RELAY_SRC, 'package.json'), dir]);
  fs.symlinkSync(path.join(RELAY_SRC, 'node_modules'), path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'config.js'),
    `module.exports = { port: ${port}, pushPort: ${pushPort}, camKey: '${CAM_KEY}', controlKey: '${CONTROL}', preRollSeconds: 5 };\n`);
  return dir;
}

// Runs a relay; with `supervised`, starts it again whenever it exits with the restart code (what systemd's
// Restart=on-failure does) and counts the restarts.
function runRelay(dir, port, supervised) {
  const state = { child: null, restarts: 0, stopping: false, output: '' };
  const env = Object.assign({}, process.env);
  delete env.INVOCATION_ID; delete env.pm_id; delete env.RELAY_SUPERVISED;
  for (const k of ['PORT', 'PUSH_PORT', 'CAM_KEY', 'CONTROL_KEY', 'SETTINGS_FILE', 'LOG_FILE', 'PREROLL_SECONDS', 'SWITCH_FILE']) delete env[k];
  if (supervised) env.RELAY_SUPERVISED = '1';
  const launch = () => {
    const child = spawn('node', ['server.js'], { cwd: dir, env });
    state.child = child;
    child.stdout.on('data', (d) => { state.output += d.toString(); });
    child.stderr.on('data', (d) => { state.output += d.toString(); });
    child.on('exit', (code) => {
      state.lastExit = code;
      if (supervised && code === RESTART_CODE && !state.stopping) { state.restarts += 1; setTimeout(launch, 300); }
    });
  };
  launch();
  state.stop = () => new Promise((resolve) => {
    state.stopping = true;
    const c = state.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('exit', () => resolve());
    c.kill('SIGTERM');
    setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(); }, 2000);
  });
  state.port = port;
  return state;
}
async function waitUp(port, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${port}/status`, (res) => { res.resume(); r(res.statusCode === 200); }); q.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

// ── HTTP ──
function http(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== null) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    else if (method === 'POST') h['Content-Length'] = 0;
    const req = nodeHttp.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const relayReq = (port, method, p, key, body) => http(port, method, p, { headers: key ? { 'X-Control-Key': key } : {}, body });

let AUTH = { user: 'dash-user', pass: 'dash-pass-0001' };
function dash(method, p, { auth = true, ajax = true, body } = {}) {
  const headers = {};
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
  if (ajax) headers['X-Requested-With'] = 'camdash';
  return http(PHP_PORT, method, `/${p}`, { headers, body });
}
const field = (json, key) => (json && json.fields || []).find((f) => f.key === key);

function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    (async () => { if (await waitUp(PHP_PORT, 1)) { /* noop */ } const t0 = Date.now(); while (Date.now() - t0 < 5000) { const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, (res) => { res.resume(); r(true); }); q.on('error', () => r(false)); }); if (ok) return resolve(child); await sleep(100); } reject(new Error('php -S not ready')); })();
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sysset-'));
  let relay = null; let relay2 = null; let php = null;
  try {
    // ════════ the relay on its own ════════
    const relayDir = makeRelayDir(tmp, 'relay', RELAY_PORT, PUSH_PORT);
    relay = runRelay(relayDir, RELAY_PORT, true);
    check('the relay starts', await waitUp(RELAY_PORT));

    check('reading the settings needs the control key', (await relayReq(RELAY_PORT, 'GET', '/system-settings')).status === 401);
    check('a wrong control key is refused', (await relayReq(RELAY_PORT, 'GET', '/system-settings', 'nope')).status === 401);
    check('the CAMERA key is not the control key', (await relayReq(RELAY_PORT, 'GET', '/system-settings', CAM_KEY)).status === 401);
    check('saving needs the control key', (await relayReq(RELAY_PORT, 'POST', '/system-settings', null, { preRollSeconds: 9 })).status === 401);
    check('restarting needs the control key', (await relayReq(RELAY_PORT, 'POST', '/restart')).status === 401);

    const g1 = await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL);
    check('with the key the settings come back', g1.status === 200 && Array.isArray(g1.json.fields) && g1.json.fields.length >= 10, g1.text.slice(0, 200));
    check('the relay reports it is supervised', g1.json.supervised === true);
    check('secrets are NEVER sent back', !g1.text.includes(CAM_KEY) && !g1.text.includes(CONTROL) && field(g1.json, 'camKey').isSet === true);
    check('values come from config.js', field(g1.json, 'port').value === RELAY_PORT && field(g1.json, 'port').source === 'config.js');
    check('defaults are shown for what config.js does not set', field(g1.json, 'logKeepFiles').value === 2 && field(g1.json, 'logKeepFiles').source === 'default');

    const bad = await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { preRollSeconds: 5, pushPort: 'x' });
    check('a bad value is refused', bad.status === 400 && /pushPort/.test(bad.json.error), bad.text);
    check('…and nothing was saved', !fs.existsSync(path.join(relayDir, 'system-settings.json')));
    check('an unknown setting is refused', (await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { nope: 1 })).status === 400);
    check('equal ports are refused', (await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { port: PUSH_PORT })).status === 400);

    const alarm = await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { alarmRecordSeconds: 30 });
    check('the alarm length is saved with no restart needed', alarm.status === 200 && alarm.json.restartRequired === false && alarm.json.changed[0] === 'alarmRecordSeconds', alarm.text);
    check('…and applies at once (GET /settings)', (await http(RELAY_PORT, 'GET', '/settings')).json.alarmRecordSeconds === 30);
    check('…without writing the system settings file', !fs.existsSync(path.join(relayDir, 'system-settings.json')));

    const same = await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { port: RELAY_PORT, camKey: '' });
    check('re-sending the current values changes nothing and needs no restart', same.status === 200 && same.json.changed.length === 0 && same.json.restartRequired === false);

    const pre = await relayReq(RELAY_PORT, 'POST', '/system-settings', CONTROL, { preRollSeconds: 12 });
    check('a startup setting is saved and flagged as needing a restart', pre.status === 200 && pre.json.restartRequired === true, pre.text);
    check('it is stored next to server.js', JSON.parse(fs.readFileSync(path.join(relayDir, 'system-settings.json'), 'utf8')).preRollSeconds === 12);
    check('config.js itself is never rewritten', fs.readFileSync(path.join(relayDir, 'config.js'), 'utf8').includes('preRollSeconds: 5'));
    check('the relay keeps running the OLD value until restarted', field((await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).json, 'preRollSeconds').value === 12 && /Pre-roll: every recording starts with the last 5s/.test(relay.output));

    const rs = await relayReq(RELAY_PORT, 'POST', '/restart', CONTROL);
    check('/restart is accepted (202)', rs.status === 202, rs.text);
    check('the relay comes back (restarted by its supervisor)', (await sleep(600), await waitUp(RELAY_PORT)) && relay.restarts === 1, `restarts=${relay.restarts}`);
    check('it exited with the restart code (non-zero, so systemd restarts it)', relay.lastExit === RESTART_CODE);
    const g2 = await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL);
    check('after the restart it runs with the saved value', field(g2.json, 'preRollSeconds').source === 'settings' && /Pre-roll: every recording starts with the last 12s/.test(relay.output));
    check('the alarm length survived the restart', field(g2.json, 'alarmRecordSeconds').value === 30);
    await sleep(200);
    const logText = fs.readFileSync(path.join(relayDir, 'logs', 'camera.log'), 'utf8');
    check('the log names what changed — never the values of keys', /system settings changed by .*preRollSeconds/.test(logText) && /restart requested/.test(logText));

    // a relay nothing would restart must refuse, not die
    relay2 = runRelay(makeRelayDir(tmp, 'relay2', RELAY2_PORT, PUSH2_PORT), RELAY2_PORT, false);
    await waitUp(RELAY2_PORT);
    const no = await relayReq(RELAY2_PORT, 'POST', '/restart', CONTROL);
    check('an unsupervised relay refuses to restart (409) …', no.status === 409 && /by hand/.test(no.json.error), no.text);
    check('… and is still running', await waitUp(RELAY2_PORT, 1500));
    check('it reports that it is not supervised', (await relayReq(RELAY2_PORT, 'GET', '/system-settings', CONTROL)).json.supervised === false);

    // a damaged settings file must not stop the relay from starting
    await relay2.stop();
    const dir2 = path.join(tmp, 'relay2');
    fs.writeFileSync(path.join(dir2, 'system-settings.json'), '{"preRollSeconds": 999, "port": 1');
    relay2 = runRelay(dir2, RELAY2_PORT, false);
    check('a damaged settings file does not stop the relay', await waitUp(RELAY2_PORT));
    check('config.js is used instead, with a warning', field((await relayReq(RELAY2_PORT, 'GET', '/system-settings', CONTROL)).json, 'preRollSeconds').value === 5 && /not valid JSON/.test(relay2.output));
    await relay2.stop();
    fs.writeFileSync(path.join(dir2, 'system-settings.json'), '{"preRollSeconds": 999, "logKeepFiles": 4}');
    relay2 = runRelay(dir2, RELAY2_PORT, false);
    await waitUp(RELAY2_PORT);
    const g3 = (await relayReq(RELAY2_PORT, 'GET', '/system-settings', CONTROL)).json;
    check('an invalid saved value is skipped, the valid ones are kept', field(g3, 'preRollSeconds').value === 5 && field(g3, 'logKeepFiles').value === 4);
    await relay2.stop();

    // ════════ through the dashboard ════════
    const dashDir = path.join(tmp, 'dash');
    fs.mkdirSync(dashDir);
    spawnSync('cp', ['-r', DASH_SRC + '/.', dashDir]);
    const writeConfig = (o) => fs.writeFileSync(path.join(dashDir, 'config.php'),
      `<?php return ['auth_user' => '${o.user}', 'auth_pass' => '${o.pass}', 'relay_url' => 'http://127.0.0.1:${o.port}', 'relay_control_key' => '${o.key}', 'cameras' => [['id' => 'e2e-cam-a', 'name' => "Bob's door", 'icon' => '🚪'], ['id' => 'e2e-cam-b', 'name' => 'Yard', 'icon' => '🌿']]];\n`);
    writeConfig({ user: AUTH.user, pass: AUTH.pass, port: RELAY_PORT, key: CONTROL });
    php = await startPhp(dashDir);
    const cfg = () => fs.readFileSync(path.join(dashDir, 'config.php'), 'utf8');

    check('the page needs the login', (await dash('GET', 'settings-page.php', { auth: false })).status === 401);
    const pageRes = await dash('GET', 'settings-page.php');
    check('the settings page loads', pageRes.status === 200 && /SETTINGS/.test(pageRes.text) && /system-settings\.php/.test(pageRes.text));
    check('the dashboard has a settings button', /href="settings-page\.php"/.test((await dash('GET', 'index.php')).text));
    check('the API needs the login', (await dash('GET', 'system-settings.php', { auth: false })).status === 401);
    check('the API needs the dashboard\'s own header', (await dash('GET', 'system-settings.php', { ajax: false })).status === 403);
    check('saving needs it too', (await dash('POST', 'system-settings.php', { ajax: false, body: { values: { preRollSeconds: 6 } } })).status === 403);

    const d1 = await dash('GET', 'system-settings.php');
    check('the API returns the relay\'s and the dashboard\'s settings together', d1.status === 200 && field(d1.json, 'port') && field(d1.json, 'auth_user') && field(d1.json, 'relay_url'), d1.text.slice(0, 200));
    check('the dashboard\'s own settings show their values', field(d1.json, 'auth_user').value === 'dash-user' && field(d1.json, 'relay_url').value === `http://127.0.0.1:${RELAY_PORT}`);
    check('NO secret reaches the browser (keys, password)', !d1.text.includes(CONTROL) && !d1.text.includes(CAM_KEY) && !d1.text.includes(AUTH.pass) && field(d1.json, 'auth_pass').isSet === true);
    check('it says config.php is writable', d1.json.configWritable === true);

    check('garbage in the body is refused', (await dash('POST', 'system-settings.php', { body: 'nope' })).status === 400);
    check('non-plain values are refused', (await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: [1] } } })).status === 400);

    // ── F-09: the dashboard must not be able to point the relay at files and folders ──
    const PATH_KEYS = ['logFile', 'deviceSettingsDir', 'firmwareDir', 'switchFile'];
    const OK_KEYS = ['alarmRecordSeconds', 'preRollSeconds', 'preRollMaxBytes', 'port', 'pushPort', 'camKey', 'controlKey', 'logMaxBytes', 'logKeepFiles'];
    check('the settings page is not offered the file and folder paths (no logFile, no Folders group)', PATH_KEYS.every((k) => !field(d1.json, k)) && !d1.json.fields.some((f) => f.group === 'Folders'), d1.json.fields.map((f) => f.key).join(','));
    check('...but still gets every setting it may change', OK_KEYS.every((k) => field(d1.json, k)), d1.json.fields.map((f) => f.key).join(','));
    const relayDirect = (await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).json;
    check('(control) the relay itself still has those four settings', PATH_KEYS.every((k) => field(relayDirect, k)));
    const relayView = async () => JSON.stringify((await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).json.fields);
    const viewBefore = await relayView();
    const jsonBefore = fs.existsSync(path.join(relayDir, 'system-settings.json')) ? fs.readFileSync(path.join(relayDir, 'system-settings.json'), 'utf8') : '';
    for (const [k, v] of [['switchFile', '/etc/passwd'], ['firmwareDir', '/'], ['deviceSettingsDir', '../../..'], ['logFile', '/etc/cron.d/camdash']]) {
      const r = await dash('POST', 'system-settings.php', { body: { values: { [k]: v } } });
      check(`${k} = ${v} cannot be saved from the dashboard (400, names the setting)`, r.status === 400 && r.json && r.json.error.includes(k) && /nothing was saved/.test(r.json.error), r.text);
    }
    const mixed = await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: 20, switchFile: '/tmp/evil.json' } } });
    check('a path hidden among valid settings stops the WHOLE save', mixed.status === 400, mixed.text);
    const unknown = await dash('POST', 'system-settings.php', { body: { values: { somethingTheRelayMayGainLater: 1 } } });
    check('a setting that is not on the allow-list is refused too', unknown.status === 400 && /unknown setting/.test(unknown.json.error), unknown.text);
    check('the relay\'s own view of ALL its settings is unchanged after every attempt', (await relayView()) === viewBefore);
    check('...and no settings file was written or changed', (fs.existsSync(path.join(relayDir, 'system-settings.json')) ? fs.readFileSync(path.join(relayDir, 'system-settings.json'), 'utf8') : '') === jsonBefore);
    const okSave = await dash('POST', 'system-settings.php', { body: { values: { alarmRecordSeconds: 31 } } });
    check('(control) a normal setting still saves through the dashboard', okSave.status === 200 && okSave.json.ok === true, okSave.text);
    await dash('POST', 'system-settings.php', { body: { values: { alarmRecordSeconds: 30 } } });

    const badRelay = await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: 'x', auth_user: 'changed-user' } } });
    check('a value the relay refuses is reported, and nothing is saved anywhere', badRelay.status === 400 && /preRollSeconds/.test(badRelay.json.error) && cfg().includes('dash-user') && !cfg().includes('changed-user'), badRelay.text);
    const badDash = await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: 7, auth_pass: 'short' } } });
    check('a bad dashboard value stops the whole save BEFORE the relay saves', badDash.status === 400 && field((await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).json, 'preRollSeconds').value === 12, badDash.text);
    const deadUrl = await dash('POST', 'system-settings.php', { body: { values: { relay_url: `http://127.0.0.1:${BASE + 9}` } } });
    check('a relay address nothing answers at is refused, so it cannot lock the dashboard out', deadUrl.status === 400 && cfg().includes(`${RELAY_PORT}`), deadUrl.text);
    check('a malformed relay address is refused', (await dash('POST', 'system-settings.php', { body: { values: { relay_url: 'not a url' } } })).status === 400);

    // alarm: no restart
    const before = relay.restarts;
    const a = await dash('POST', 'system-settings.php', { body: { values: { alarmRecordSeconds: 45 } } });
    check('the alarm length saves without restarting the relay', a.status === 200 && a.json.restart === 'not-needed' && relay.restarts === before, a.text);

    // relay + dashboard in one save, with a restart
    const one = await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: 7, logKeepFiles: 3, auth_user: 'new-user', auth_pass: 'new-pass-0002' } } });
    check('one save can change relay AND dashboard settings', one.status === 200 && one.json.ok === true, one.text);
    check('the answer comes after the relay restarted and is back', one.json.restart === 'done' && relay.restarts === before + 1, one.text);
    check('it tells the page the login changed', one.json.relogin === true);
    check('the relay runs the new values', /last 7s/.test(relay.output) && field((await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).json, 'logKeepFiles').value === 3);
    check('config.php has the new login, and still has every camera', /new-user/.test(cfg()) && /new-pass-0002/.test(cfg()) && /e2e-cam-a/.test(cfg()) && cfg().includes("Bob\\'s door") && /e2e-cam-b/.test(cfg()));
    check('the old login no longer works', (await dash('GET', 'system-settings.php')).status === 401);
    AUTH = { user: 'new-user', pass: 'new-pass-0002' };
    check('the new login works', (await dash('GET', 'system-settings.php')).status === 200);
    check('no config.php.bak is left in the web folder (it would be served to anyone)', !fs.existsSync(path.join(dashDir, 'config.php.bak')));

    // settings that disconnect cameras need a confirm
    const r0 = relay.restarts;
    const unconfirmed = await dash('POST', 'system-settings.php', { body: { values: { camKey: 'another-camera-key-9' } } });
    check('changing the camera key needs a confirm (409)', unconfirmed.status === 409 && relay.restarts === r0, unconfirmed.text);
    const unconfirmedPort = await dash('POST', 'system-settings.php', { body: { values: { pushPort: PUSH_PORT + 20 } } });
    check('so does the camera push port', unconfirmedPort.status === 409);
    const camChange = await dash('POST', 'system-settings.php', { body: { values: { camKey: 'another-camera-key-9' }, confirm: true } });
    check('confirmed, the camera key changes and the relay restarts', camChange.status === 200 && camChange.json.restart === 'done' && camChange.json.breaking[0] === 'camKey', camChange.text);

    // rotating the control key
    const NEW_CONTROL = 'e2e-control-key-ROTATED';
    const rot = await dash('POST', 'system-settings.php', { body: { values: { controlKey: NEW_CONTROL } } });
    check('the control key can be rotated from the page', rot.status === 200 && rot.json.restart === 'done', rot.text);
    check('the dashboard\'s copy followed (config.php)', cfg().includes(NEW_CONTROL));
    check('the relay now wants the new key, not the old', (await relayReq(RELAY_PORT, 'GET', '/system-settings', CONTROL)).status === 401 && (await relayReq(RELAY_PORT, 'GET', '/system-settings', NEW_CONTROL)).status === 200);
    check('the dashboard still works after the rotation', (await dash('GET', 'system-settings.php')).status === 200);
    check('a too-short control key is refused', (await dash('POST', 'system-settings.php', { body: { values: { controlKey: 'short' } } })).status === 400);

    // moving the relay's port
    const mv = await dash('POST', 'system-settings.php', { body: { values: { port: NEW_RELAY_PORT } } });
    check('the relay\'s port can be moved; the relay answers on the new one', mv.status === 200 && mv.json.restart === 'done' && await waitUp(NEW_RELAY_PORT), mv.text);
    check('the dashboard\'s relay address followed, so it keeps finding the relay', cfg().includes(`127.0.0.1:${NEW_RELAY_PORT}`) && (await dash('GET', 'system-settings.php')).status === 200);
    check('the old port is closed', !(await waitUp(RELAY_PORT, 700)));
    check('the dashboard page itself still works', (await dash('GET', 'index.php')).status === 200);

    // the relay down: the dashboard says so
    await relay.stop();
    const down = await dash('GET', 'system-settings.php');
    check('with the relay down the page gets a clear 502', down.status === 502, down.text);
    const downPost = await dash('POST', 'system-settings.php', { body: { values: { preRollSeconds: 8 } } });
    check('saving with the relay down fails clearly and saves nothing', downPost.status === 502 && !/ 8/.test(cfg()), downPost.text);
  } catch (err) {
    check('the test ran without an unexpected error', false, err && err.stack);
  } finally {
    if (php) php.kill('SIGKILL');
    if (relay) await relay.stop();
    if (relay2) await relay2.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  summarize();
}

main();
