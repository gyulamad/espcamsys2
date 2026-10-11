#!/usr/bin/env node
'use strict';
// test_push_connection_e2e.js — end-to-end check of how the relay treats a
// camera's raw push connection when the WiFi is bad.
//
// On a weak WiFi link a camera gives up on a stalled connection and
// reconnects, but the old connection often dies without a goodbye (a half-open
// TCP connection) and the relay keeps it. The relay used to answer that with a
// false "another connection with the SAME camera id" warning and keep the
// ghost for ever. This checks that:
//   - a camera that reconnects while its old connection has gone quiet is NOT
//     reported as an id clash; the leftover is closed and the new connection
//     delivers frames
//   - a second sender that is really active (the old connection delivered data
//     a moment ago) IS still reported, and both connections are left alone
//   - a connection that goes completely silent is dropped after
//     PUSH_IDLE_TIMEOUT_MS, while one that keeps trickling bytes is not
//   - a connection that never says who it is is dropped after PUSH_AUTH_TIMEOUT_MS
//
// Own ports, a throwaway log; core modules only.
//
// Usage:  node tests/e2e/test_push_connection_e2e.js
//         E2E_PUSHCONN_PORT=19340 E2E_PUSHCONN_PUSH_PORT=19341 node ...
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_PUSHCONN_PORT || 19340);
const PUSH_PORT = Number(process.env.E2E_PUSHCONN_PUSH_PORT || 19341);
const KEY = 'e2e-pushconn-key';
const JPEG = fs.readFileSync(path.join(RELAY_DIR, 'testimage.jpg'));

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
async function waitFor(fn, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-pushconn-switch-${process.pid}.json`) }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve({ child, output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 5s:\n${out}`)); } }, 5000).unref();
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    nodeHttp.get(`http://127.0.0.1:${PORT}${urlPath}`, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    }).on('error', reject);
  });
}

// A camera on the raw push port. `closed()` says whether the relay has closed its end.
function connectCamera(id, key = KEY) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PUSH_PORT, '127.0.0.1', () => {
      const cam = { sock, isClosed: false, closed: () => cam.isClosed };
      sock.on('close', () => { cam.isClosed = true; });
      sock.on('data', () => {}); // the relay's greeting bytes
      sock.write(`${id}\t${key}\n`);
      resolve(cam);
    });
    sock.on('error', () => {});
    sock.on('error', reject);
  });
}
function sendFrame(cam) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(JPEG.length, 0);
  cam.sock.write(Buffer.concat([header, JPEG]));
}
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    summarize();
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pushconn-'));
  const settingsFile = path.join(tmp, 'settings.json');
  const logFile = path.join(tmp, 'camera.log');
  let relay;
  const cams = [];
  try {
    // ── 1. the same board reconnects after its old connection went quiet ──
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile });
    const old = await connectCamera('e2e-flaky');
    cams.push(old);
    sendFrame(old);
    await sleep(2400); // quiet for longer than the relay's "still live" window

    const fresh = await connectCamera('e2e-flaky');
    cams.push(fresh);
    check('the stale old connection is closed by the relay',
      !!(await waitFor(() => old.closed(), 2000)));
    check('...and the reconnect is explained, not reported as an id clash',
      !!(await waitFor(() => /INFO  e2e-flaky@127\.0\.0\.1 \[relay\]: the camera reconnected — closed its previous connection/.test(readLog(logFile)), 2000))
      && !readLog(logFile).includes('SAME camera id'), readLog(logFile));
    check('...and the new connection stays open', !fresh.closed());
    await sleep(200);
    check('closing the leftover is not logged as the camera disconnecting', !/camera disconnected/.test(readLog(logFile)), readLog(logFile));

    sendFrame(fresh);
    const seen = await waitFor(async () => {
      const r = await getJson('/status');
      return r.json && r.json['e2e-flaky'] && r.json['e2e-flaky'].lastSeen ? r : null;
    }, 3000);
    check('frames from the new connection are accepted', !!seen);
    for (const c of cams.splice(0)) c.sock.destroy();

    // ── 2. two boards really sending at once are still reported ───────────
    const boardA = await connectCamera('e2e-twins');
    cams.push(boardA);
    sendFrame(boardA);
    const boardB = await connectCamera('e2e-twins'); // a moment later: boardA is still live
    cams.push(boardB);
    check('a second board with the same id, while the first is sending, is called out with the sender\'s address',
      !!(await waitFor(() => /WARN  e2e-twins@127\.0\.0\.1 \[relay\]: another connection with the SAME camera id is still sending frames \(from 127\.0\.0\.1, last data \d+\.\ds ago\)/.test(readLog(logFile)), 2000)), readLog(logFile));
    await sleep(300);
    check('...and neither connection is cut off', !boardA.closed() && !boardB.closed());
    for (const c of cams.splice(0)) c.sock.destroy();
    await stopRelay(relay);

    // ── 3. silent connections are dropped, trickling ones are not ─────────
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile, PUSH_IDLE_TIMEOUT_MS: '1000', PUSH_AUTH_TIMEOUT_MS: '1000' });
    const trickler = await connectCamera('e2e-trickle');
    const silent = await connectCamera('e2e-silent');
    cams.push(trickler, silent);
    // One frame sent a byte at a time, like a link too weak to carry it any faster: ~2.8 s, far past the 1 s limit.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(JPEG.length, 0);
    trickler.sock.write(header);
    for (let i = 0; i < 7; i++) { await sleep(400); trickler.sock.write(JPEG.slice(i, i + 1)); }
    check('a connection that goes completely silent is dropped', silent.closed());
    check('...and the reason is in the log', /WARN  e2e-silent@127\.0\.0\.1 \[relay\]: camera disconnected after \d+s \(no data for 1s\)/.test(readLog(logFile)), readLog(logFile));
    check('a connection that keeps trickling bytes (a very slow link) is kept', !trickler.closed());

    // ── 4. a connection that never introduces itself is dropped ───────────
    const mute = await new Promise((resolve, reject) => {
      const sock = net.connect(PUSH_PORT, '127.0.0.1', () => {
        const m = { isClosed: false, sock };
        sock.on('close', () => { m.isClosed = true; });
        resolve(m);
      });
      sock.on('error', () => {});
      sock.on('error', reject);
    });
    cams.push({ sock: mute.sock });
    check('a connection that never sends its first line is dropped',
      !!(await waitFor(() => mute.isClosed, 3000)));
    check('...and logged', /rejected a push connection from 127\.0\.0\.1: no first line within 1s/.test(readLog(logFile)), readLog(logFile));
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    for (const c of cams) c.sock.destroy();
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
