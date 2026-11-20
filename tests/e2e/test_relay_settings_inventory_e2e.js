#!/usr/bin/env node
'use strict';
// test_relay_settings_inventory_e2e.js — F-29 T6a on a REAL relay (server.js, supervised by this test the way systemd
// would: started again when it exits with the restart code): every value the relay uses is a row of the settings
// store, an empty store changes nothing, and each row can be changed through POST /system-settings.
//
//   - an empty store: the relay shows every row at today's value, never from the environment, no secret in the answer
//   - a locked row (the programs the relay runs) is refused, and nothing is saved
//   - values from config.js-only blocks (person check, notifications) and the environment-only switches are saved
//   - a value that is read each time (maxAlarmRecordings) counts at once, with no restart
//   - a value read at startup (relayHsts) counts after the restart — and then the header is really there
//   - the environment still wins over the store, and then the row is read-only
//
// Needs node only (core modules). Own ports (E2E_RELAYSET_PORT and the next one up), throwaway folders.
//
// Usage:  node tests/e2e/test_relay_settings_inventory_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_SRC = path.join(__dirname, '../../nodejs/camera-relay');
const PORT = Number(process.env.E2E_RELAYSET_PORT || 19500);
const PUSH_PORT = PORT + 1;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a throwaway copy of the relay with its own minimal config.js ──
function makeRelayDir(tmp) {
  const dir = path.join(tmp, 'relay');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('cp', ['-r', path.join(RELAY_SRC, 'lib'), path.join(RELAY_SRC, 'server.js'), path.join(RELAY_SRC, 'package.json'), dir]);
  fs.symlinkSync(path.join(RELAY_SRC, 'node_modules'), path.join(dir, 'node_modules'));
  // discoveryPort 0: the UDP responder is off, so this test never takes a port another relay may hold
  fs.writeFileSync(path.join(dir, 'config.js'),
    `module.exports = { port: ${PORT}, pushPort: ${PUSH_PORT}, camKey: '${CAM_KEY}', controlKey: '${CONTROL}', discoveryPort: 0 };\n`);
  return dir;
}

// Runs the relay; `supervised` starts it again whenever it exits with the restart code. `extraEnv` is added to a clean environment.
function runRelay(dir, { supervised = false, extraEnv = {} } = {}) {
  const state = { child: null, restarts: 0, stopping: false, output: '' };
  const env = Object.assign({}, process.env);
  delete env.INVOCATION_ID; delete env.pm_id; delete env.RELAY_SUPERVISED;
  for (const k of ['PORT', 'PUSH_PORT', 'CAM_KEY', 'CONTROL_KEY', 'SETTINGS_FILE', 'SYSTEM_SETTINGS_FILE', 'LOG_FILE', 'SWITCH_FILE', 'RELAY_HSTS', 'RELAY_BIND',
    'READ_KEY_REQUIRED', 'ALLOW_KEYLESS_ALARM', 'MAX_ALARM_RECORDINGS', 'LOOPWATCH', 'DISCOVERY_PORT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) delete env[k];
  if (supervised) env.RELAY_SUPERVISED = '1';
  Object.assign(env, extraEnv);
  const launch = () => {
    const child = spawn('node', ['server.js'], { cwd: dir, env });
    state.child = child;
    child.stdout.on('data', (d) => { state.output += d.toString(); });
    child.stderr.on('data', (d) => { state.output += d.toString(); });
    child.on('exit', (code) => {
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
  return state;
}

function http(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (payload !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    else if (method === 'POST') h['Content-Length'] = 0;
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json, text: data }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const asControl = (method, p, body) => http(method, p, { headers: { 'X-Control-Key': CONTROL }, body });
const alarm = (id) => http('POST', `/alarm/${id}`, { headers: { 'X-Api-Key': CAM_KEY } });
const fieldOf = (json, key) => (json && json.fields || []).find((f) => f.key === key);

async function waitUp(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await http('GET', '/status'); if (r.status === 200 || r.status === 401) return true; } catch (e) { /* not yet */ }
    await sleep(150);
  }
  return false;
}
async function waitRestarted(relay, before, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (relay.restarts > before && await waitUp(500)) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-relayset-'));
  let relay = null;
  try {
    const dir = makeRelayDir(tmp);
    const store = path.join(dir, 'system-settings.json');
    relay = runRelay(dir, { supervised: true });
    check('the relay starts with an empty store and a minimal config.js', await waitUp());

    // ── an empty store changes nothing ──
    const g0 = await asControl('GET', '/system-settings');
    const fields = g0.json && g0.json.fields || [];
    // 55 = the 23 rows that were settings before F-29 T6a, the 31 that were moved into the store then,
    // and apacheErrorLog, added in F-30 (the Apache log the OTA & LOGS page shows).
    check('every row is offered (55: the 23 that were settings, the 31 that were not, and apacheErrorLog from F-30)', g0.status === 200 && fields.length === 55, `got ${fields.length}`);
    check('no row comes from the environment, and no store file was written by reading', fields.every((f) => !f.envOverride && f.source !== 'environment') && !fs.existsSync(store));
    check('a moved row shows the value it always had', [['maxAlarmRecordings', 16], ['authMaxFailures', 10], ['authLockSeconds', 60], ['authLockMaxSeconds', 900], ['restartCooldownMs', 30000],
      ['pushIdleTimeoutMs', 60000], ['detectorViewMinutes', 10], ['personScanStride', 1], ['notifyCooldownSeconds', 60], ['storageReminderHours', 24]]
      .every(([k, v]) => { const f = fieldOf(g0.json, k); return f && f.value === v && f.default === v && f.source === 'default'; }));
    check('…and the switches', [['relayHsts', false], ['allowKeylessAlarm', false], ['readKeyRequired', true], ['loopWatch', true], ['telegramEnabled', true], ['personScanAuto', true]]
      .every(([k, v]) => fieldOf(g0.json, k).value === v));
    check('every row says its tier, and which need a restart', fields.every((f) => ['basic', 'advanced', 'expert'].includes(f.tier) && typeof f.restart === 'boolean'));
    check('the locked rows are marked locked', ['personScanPython', 'personScanScript', 'alarmSoundPlayer'].every((k) => fieldOf(g0.json, k).locked === true));
    check('the Telegram token is a secret: never sent back, only whether it is set', fieldOf(g0.json, 'telegramBotToken').isSet === false && !('value' in fieldOf(g0.json, 'telegramBotToken')));
    check('no HSTS header by default (the old behaviour)', (await http('GET', '/status')).headers['strict-transport-security'] === undefined);

    // ── a locked row is refused ──
    const evil = await asControl('POST', '/system-settings', { personScanPython: '/tmp/evil', alarmSoundPlayer: ['sh', '-c', 'x'] });
    check('a locked row cannot be changed from the API', evil.status === 400 && /locked/.test(evil.json.error), evil.text);
    check('…and nothing was saved', !fs.existsSync(store));
    check('a bad value for a moved row is refused', (await asControl('POST', '/system-settings', { personScanAction: 'erase' })).status === 400);
    check('two rows that must agree are checked together', (await asControl('POST', '/system-settings', { authLockSeconds: 500, authLockMaxSeconds: 100 })).status === 400);

    // ── a value read each time counts at once ──
    const cap = await asControl('POST', '/system-settings', { maxAlarmRecordings: 1 });
    check('maxAlarmRecordings is saved with no restart needed', cap.status === 200 && cap.json.restartRequired === false && cap.json.changed[0] === 'maxAlarmRecordings', cap.text);
    check('the first alarm starts a recording', (await alarm('camA')).status === 200);
    const refused = await alarm('camB');
    check('the second is refused at the cap that was just saved', refused.status === 503 && /cap 1\)/.test(refused.json.error), refused.text);
    await asControl('POST', '/system-settings', { maxAlarmRecordings: 2 });
    check('raising it counts at once, without a restart', (await alarm('camB')).status === 200 && relay.restarts === 0);

    // ── values from config.js-only blocks and the environment-only switches ──
    const batch = await asControl('POST', '/system-settings', {
      personScanAction: 'delete', personScanStride: 3, personScanModel: 'models/other.onnx', alarmSoundTimeoutSeconds: 12,
      telegramEnabled: 'false', telegramChatId: '123456, -1001234567890', footageBaseUrl: 'http://pi.local/camdash/', notifyCooldownSeconds: 5, storageReminderHours: 0,
      relayHsts: 'true', authMaxFailures: 5, detectorViewMinutes: 20,
    });
    check('a batch of them is saved and needs a restart', batch.status === 200 && batch.json.restartRequired === true && batch.json.changed.length === 12, batch.text);
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
    check('they are in the store, in the form the code reads', saved.personScanAction === 'delete' && saved.telegramChatId === '123456,-1001234567890' && saved.footageBaseUrl === 'http://pi.local/camdash' && saved.relayHsts === true && saved.maxAlarmRecordings === 2);
    check('config.js is never rewritten', !fs.readFileSync(path.join(dir, 'config.js'), 'utf8').includes('personScan'));
    check('the relay keeps the old value until it restarts', (await http('GET', '/status')).headers['strict-transport-security'] === undefined);

    // ── after the restart ──
    const r = await asControl('POST', '/restart');
    check('the relay accepts a restart', r.status === 202);
    check('it comes back', await waitRestarted(relay, 0));
    const g1 = await asControl('GET', '/system-settings');
    check('the saved values are now what the relay shows, from the store', [['personScanAction', 'delete'], ['personScanStride', 3], ['telegramEnabled', false], ['telegramChatId', '123456,-1001234567890'],
      ['footageBaseUrl', 'http://pi.local/camdash'], ['relayHsts', true], ['authMaxFailures', 5], ['maxAlarmRecordings', 2]]
      .every(([k, v]) => { const f = fieldOf(g1.json, k); return f && f.value === v && f.source === 'settings'; }));
    check('a startup value now really applies: the HSTS header is sent', (await http('GET', '/status')).headers['strict-transport-security'] !== undefined);
    check('a locked row is still the config.js / default value', fieldOf(g1.json, 'personScanPython').value === 'python3' && fieldOf(g1.json, 'personScanPython').source === 'default');

    // ── the environment still wins ──
    await relay.stop();
    relay = runRelay(dir, { extraEnv: { RELAY_HSTS: '0', MAX_ALARM_RECORDINGS: '5' } });
    check('the relay starts with the variables set', await waitUp());
    check('RELAY_HSTS=0 beats the stored true: no header', (await http('GET', '/status')).headers['strict-transport-security'] === undefined);
    const g2 = await asControl('GET', '/system-settings');
    const hsts = fieldOf(g2.json, 'relayHsts');
    check('the row shows the variable that decides it', hsts.value === false && hsts.source === 'environment' && hsts.envOverride === true && hsts.envName === 'RELAY_HSTS');
    check('…and MAX_ALARM_RECORDINGS decides the cap', fieldOf(g2.json, 'maxAlarmRecordings').value === 5 && fieldOf(g2.json, 'maxAlarmRecordings').source === 'environment');
    const blocked = await asControl('POST', '/system-settings', { relayHsts: 'true' });
    check('such a row cannot be changed from here', blocked.status === 400 && /RELAY_HSTS/.test(blocked.json.error), blocked.text);
    check('sending back what is shown is not an error', (await asControl('POST', '/system-settings', { relayHsts: 'false', maxAlarmRecordings: '5' })).json.changed.length === 0);
  } finally {
    if (relay) await relay.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((err) => { console.error(`[FAIL] ${err && err.stack || err}`); finished = true; process.exitCode = 1; });
