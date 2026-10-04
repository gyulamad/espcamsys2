#!/usr/bin/env node
'use strict';
// test_alarm_settings_e2e.js — end-to-end check of the "alarm recording
// length is set from the dashboard, not hardcoded in the camera sketch"
// fix, against a REAL `server.js` process over real HTTP.
//
// The bug this guards against: an alarm used to record for the sketch's
// hardcoded ALARM_RECORD_SECONDS (60) no matter what the dashboard was set
// to. Now the camera just calls POST /alarm/:id and the relay applies the
// stored setting (alarmRecordSeconds). The pure
// validation logic is unit tested in tests/node/test_settings.js; this
// checks the wiring those can't: the HTTP routes, the real recording
// timing the relay produces, persistence across a relay restart, etc.
//
// Like the other e2e test, it behaves like an independent client (no
// require() of lib/ or server.js), runs on its own ports (never the real
// 8080/8081), and never touches a real settings.json — the relay is told
// to use a throwaway settings file via the SETTINGS_FILE env var. A
// temporary config.js is created only if none exists, and removed again.
//
// No third-party dependency — core modules only.
//
// Usage:
//   node tests/e2e/test_alarm_settings_e2e.js
//   E2E_SETTINGS_PORT=19190 E2E_SETTINGS_PUSH_PORT=19191 node tests/e2e/test_alarm_settings_e2e.js
//
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const RECORDINGS_DIR = path.join(RELAY_DIR, 'recordings');

const PORT = Number(process.env.E2E_SETTINGS_PORT || 19190);
const PUSH_PORT = Number(process.env.E2E_SETTINGS_PUSH_PORT || 19191);
const BASE = `http://127.0.0.1:${PORT}`;
const CAM_KEY = 'e2e-settings-key';

// Unique camera ids so cleanup can never touch real cameras' recordings.
const CAM_A = 'e2e-alarm-cam-a';
const CAM_B = 'e2e-alarm-cam-b';
const CAM_ALL = 'e2e-alarm-cam-all';
const TEST_CAMS = [CAM_A, CAM_B, CAM_ALL];

const TOLERANCE_MS = 1500; // allowed drift between the requested and measured durations
const READY_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 30000;

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
  }
}
let finished = false; // set once the run reaches its summary
// If the process ever ends WITHOUT reaching the summary (an awaited promise that
// never settles lets Node quit quietly with exit code 0), that must read as a
// failure, not a pass.
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
});
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const within = (actual, expected) => Math.abs(actual - expected) <= TOLERANCE_MS;

// server.js requires ./config unconditionally — create a throwaway one if
// the repo has none yet, remove it afterwards, leave a real one alone.
let createdTempConfig = false;
function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
  createdTempConfig = true;
  console.log('(no config.js found — wrote a temporary throwaway one for this test run)');
}

// Alarm recordings create recordings/<camId>/ — only remove the ones that
// belong to this test (and didn't exist before it ran).
const preExistingRecDirs = new Set();
function noteExistingRecDirs() {
  for (const id of TEST_CAMS) {
    if (fs.existsSync(path.join(RECORDINGS_DIR, id))) preExistingRecDirs.add(id);
  }
}
function removeDir(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true }); // Node 14.14+
    else if (fs.existsSync(dir)) fs.rmdirSync(dir, { recursive: true }); // older Node
  } catch (e) { /* already gone */ }
}
function cleanup(settingsFile) {
  if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  for (const id of TEST_CAMS) {
    if (preExistingRecDirs.has(id)) continue;
    removeDir(path.join(RECORDINGS_DIR, id));
  }
  for (const f of [settingsFile, settingsFile + '.tmp']) {
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
  }
  try { fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true }); } catch (e) { /* gone */ } // the temp folder that held it
}

function startRelay(settingsFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PUSH_PORT: String(PUSH_PORT),
        CAM_KEY,
        SETTINGS_FILE: settingsFile,
      }),
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in ${READY_TIMEOUT_MS}ms. Output:\n${output}`)); }
    }, READY_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes(`raw push) listening on :${PUSH_PORT}`)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`relay exited early (code ${code}):\n${output}`)); }
    });
  });
}

function stopRelay(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(); // a child ended by a signal has exitCode null
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } }, 1500).unref();
  });
}

// Plain core-`http` request helper (no global fetch, which only exists on
// Node 18+), so this test runs on any Node version the relay itself does.
function http(method, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      BASE + pathAndQuery,
      { method, headers: { 'Content-Length': 0 } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(data); } catch (e) { /* non-JSON body */ }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`request timed out: ${method} ${pathAndQuery}`)));
    req.end();
  });
}
const get = (p) => http('GET', p);
const post = (p) => http('POST', p);

async function main() {
  const overallTimer = setTimeout(() => {
    console.error('[FAIL] overall test timed out');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref();

  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-settings-')), 'settings.json');
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false,
      `run "npm install" in ${RELAY_DIR} first (the relay needs express)`);
    summarize();
    return;
  }
  ensureConfigExists();
  noteExistingRecDirs();

  let relay;
  try {
    relay = await startRelay(settingsFile);
  } catch (err) {
    check('relay starts up and reports ready', false, err.message);
    cleanup(settingsFile);
    summarize();
    return;
  }
  check('relay starts up and reports ready', true);

  try {
    // ── Defaults ──────────────────────────────────────────────────────
    let r = await get('/settings');
    check('fresh relay reports the default record length (60s) and the read-only pre-roll length',
      r.status === 200 && r.body && r.body.alarmRecordSeconds === 60 && r.body.preRollSeconds === 5
        && !('alarmPowerSeconds' in r.body),
      JSON.stringify(r));

    // ── Saving settings (the dashboard's field: 10s record) ──────────
    r = await post('/settings?alarmRecordSeconds=10');
    check('POST /settings saves the value and returns it (plus the read-only pre-roll)',
      r.status === 200 && r.body.alarmRecordSeconds === 10 && r.body.preRollSeconds === 5,
      JSON.stringify(r));

    r = await get('/settings');
    check('GET /settings returns what was saved',
      r.body.alarmRecordSeconds === 10, JSON.stringify(r.body));

    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { /* checked below */ }
    check('settings are written to the settings file',
      stored && stored.alarmRecordSeconds === 10 && !('preRollSeconds' in stored), JSON.stringify(stored));

    // ── Validation: bad input is rejected and changes nothing ─────────
    for (const [label, q] of [
      ['zero', 'alarmRecordSeconds=0'],
      ['too large', 'alarmRecordSeconds=99999'],
      ['the retired power setting', 'alarmPowerSeconds=20'],
      ['pre-roll (read-only, comes from config.js)', 'preRollSeconds=9'],
      ['non-numeric', 'alarmRecordSeconds=abc'],
      ['no fields at all', ''],
    ]) {
      r = await post('/settings' + (q ? '?' + q : ''));
      check(`POST /settings rejects ${label} with 400`, r.status === 400, JSON.stringify(r));
    }
    r = await get('/settings');
    check('rejected updates left the stored settings unchanged',
      r.body.alarmRecordSeconds === 10 && r.body.preRollSeconds === 5, JSON.stringify(r.body));

    // ── THE BUG: alarm must use the stored 10s/20s, not 60s ───────────
    r = await post(`/alarm/${CAM_A}`);
    check('POST /alarm/:id succeeds and starts a recording',
      r.status === 200 && r.body && r.body.recording === true && r.body.extended === false, JSON.stringify(r));

    if (r.body && r.body.startedAt) {
      const startedAt = Date.parse(r.body.startedAt);
      const recordMs = Date.parse(r.body.endAt) - startedAt;
      check('alarm recording length is the stored 10s (NOT the old hardcoded 60s)',
        within(recordMs, 10000), `recording lasts ${recordMs}ms`);
    }

    // Even if a client still sends a duration, the relay must ignore it.
    const cleanB = await post(`/alarm/${CAM_B}?seconds=60`);
    if (cleanB.body && cleanB.body.startedAt) {
      const ms = Date.parse(cleanB.body.endAt) - Date.parse(cleanB.body.startedAt);
      check('a duration sent by the client is ignored — stored setting wins',
        within(ms, 10000), `recording lasts ${ms}ms`);
    } else {
      check('a duration sent by the client is ignored — stored setting wins', false, JSON.stringify(cleanB));
    }

    // ── Status reflects the alarm recording ───────────────────────────
    r = await get('/status');
    check('/status shows the alarm-started recording',
      r.body && r.body[CAM_A] && r.body[CAM_A].recording === true, JSON.stringify(r.body && r.body[CAM_A]));

    // ── Repeat alarm extends instead of starting a second recording ───
    r = await post(`/alarm/${CAM_A}`);
    check('a repeat alarm during a recording extends it',
      r.status === 200 && r.body.extended === true, JSON.stringify(r));

    // ── Changing the settings applies to the NEXT alarm ───────────────
    await post('/settings?alarmRecordSeconds=5');
    r = await post(`/alarm/${CAM_ALL}`);
    if (r.body && r.body.startedAt) {
      const startedAt = Date.parse(r.body.startedAt);
      const recordMs = Date.parse(r.body.endAt) - startedAt;
      check('after changing settings, the next alarm uses the new record length (5s)',
        within(recordMs, 5000), `recording lasts ${recordMs}ms`);
    } else {
      check('after changing settings, the next alarm uses the new record length (5s)', false, JSON.stringify(r));
    }

    // ── /alarm/all hits every camera the relay knows about ────────────
    r = await post('/alarm/all');
    const ids = r.body && Array.isArray(r.body.cameras) ? r.body.cameras.map((c) => c.id) : [];
    check('POST /alarm/all triggers every known camera',
      r.status === 200 && [CAM_A, CAM_B, CAM_ALL].every((id) => ids.includes(id)), JSON.stringify(ids));

    // ── Persistence: settings survive a relay restart ─────────────────
    await post('/settings?alarmRecordSeconds=10');
    await stopRelay(relay);
    relay = await startRelay(settingsFile);
    r = await get('/settings');
    check('settings survive a relay restart',
      r.body && r.body.alarmRecordSeconds === 10, JSON.stringify(r.body));

    // ── Corrupt settings file must not stop the relay from starting ───
    await stopRelay(relay);
    fs.writeFileSync(settingsFile, '{ this is not json');
    relay = await startRelay(settingsFile);
    r = await get('/settings');
    check('a corrupt settings file falls back to defaults instead of crashing the relay',
      r.status === 200 && r.body.alarmRecordSeconds === 60, JSON.stringify(r));
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    await stopRelay(relay);
    clearTimeout(overallTimer);
    cleanup(settingsFile);
    summarize();
  }
}

main();
