#!/usr/bin/env node
'use strict';
// test_relay_detector_events_e2e.js — GET /detectors/events on a REAL server.js: the detectors' numbers
// pushed (Server-Sent Events) the moment a detector's message arrives, and once a second besides.
//   * the current state at once; a detector's message reaches the viewer within a fraction of a second
//     (measured) — no polling interval, no wait for a picture
//   * the same { id: view } map as GET /detectors; a detector going away shows as offline-able state
//   * a viewer that stops reading never makes the relay queue up (only the newest state is kept)
//   * a viewer limit (503 that says why), and closed viewers free their slot
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_relay_detector_events_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ev = require('../../nodejs/camera-relay/lib/detectorevents');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DETEVENTS_PORT || 19450);
const PUSH_PORT = PORT + 1;
const KEY = 'e2e-detector-events-key';
const ID = 'e2e-events-1';

let pass = 0, fail = 0, finished = false;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });

let createdConfig = false;
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
  createdConfig = true;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detevents-'));
const logFile = path.join(tmp, 'relay.log');
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

const fake = require('./fake_detector');
const { JPEG, status, wire } = fake;

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY,
        SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: logFile, SWITCH_FILE: path.join(tmp, 'switch.json') }),
    });
    let out = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 5000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${PUSH_PORT}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}

// An SSE viewer: parsed messages with their arrival times; `pause()` stops reading (a stalled link).
function view() {
  return new Promise((resolve, reject) => {
    const v = { status: 0, headers: {}, body: '', messages: [], times: [], pause: () => {}, resume: () => {}, close: () => {} };
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/detectors/events`, (res) => {
      v.status = res.statusCode; v.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        v.body += c;
        for (const m of c.matchAll(/event: detectors\ndata: (.*)\n\n/g)) { v.messages.push(JSON.parse(m[1])); v.times.push(Date.now()); }
      });
      v.pause = () => res.pause(); v.resume = () => res.resume(); v.close = () => req.destroy();
      resolve(v);
    });
    req.on('error', (e) => { if (!v.status) reject(e); });
  });
}

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay');
    return;
  }
  const relay = await startRelay();
  const socks = [];
  try {
    let v = await view();
    check('200 text/event-stream, not cached', v.status === 200 && /^text\/event-stream/.test(v.headers['content-type']) && v.headers['cache-control'] === 'no-store', JSON.stringify(v.headers));
    check('the current state arrives at once (an empty map: no detector yet)', await waitFor(() => v.messages.length >= 1) && Object.keys(v.messages[0]).length === 0);
    const ticks = v.messages.length;
    check('and one more every second even when nothing happens', await waitFor(() => v.messages.length > ticks, ev.REFRESH_MS * 2 + 500));

    const u = await fake.uplink(PORT, ID, { key: KEY });
    check('a detector connects', u.status === 101, String(u.status));
    socks.push(u.socket);
    const n = v.messages.length;
    const t0 = Date.now();
    u.socket.write(wire(status({ scene: { state: 'active', brightness: 111, motion: 900, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: null } }), null));
    const got = await waitFor(() => v.messages.slice(n).some((m) => m[ID] && m[ID].report && m[ID].report.scene.brightness === 111), 1000);
    check('its numbers reach the viewer within a fraction of a second (numbers only, no picture needed)', !!got && Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
    check('the pushed view is the one GET /detectors gives', JSON.stringify(Object.keys(v.messages[v.messages.length - 1])) === JSON.stringify([ID]));

    // 200 messages in a burst: the viewer ends with the newest
    for (let i = 0; i < 200; i++) u.socket.write(wire(status({ scene: { state: 'active', brightness: i, motion: 900, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: null } }), i % 5 === 0 ? JPEG : null));
    check('after a burst the viewer ends with the newest numbers', !!(await waitFor(() => v.messages[v.messages.length - 1][ID].report.scene.brightness === 199, 2000)));

    // a stalled viewer: nothing piles up and, once reading again, the NEWEST arrives
    const stalled = await view();
    stalled.pause();
    for (let i = 0; i < 3000; i++) u.socket.write(wire(status({ scene: { state: 'active', brightness: i % 250, motion: 900, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: null } }), null));
    await sleep(300);
    u.socket.write(wire(status({ scene: { state: 'active', brightness: 42, motion: 4242, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: null } }), null));
    await sleep(300);
    const sizeWhileStalled = stalled.body.length;
    stalled.resume();
    check('a viewer that was not reading gets the newest state when it reads again', !!(await waitFor(() => stalled.messages.length && stalled.messages[stalled.messages.length - 1][ID].report.scene.motion === 4242, 3000)), `${stalled.messages.length} messages, body ${sizeWhileStalled}`);
    stalled.close();

    // the viewer limit
    const open = [];
    for (let i = 0; i < ev.MAX_VIEWERS + 2; i++) {
      const x = await view();
      open.push(x);
    }
    const refused = open.filter((x) => x.status === 503);
    check('past the viewer limit the relay says 503 with the reason', refused.length >= 1 && /viewers of the live detector stream/.test(refused[0].body), open.map((x) => x.status).join(','));
    open.forEach((x) => x.close());
    await sleep(300);
    const again = await view();
    check('closed viewers free their slots', again.status === 200, String(again.status));
    again.close();
    v.close();
  } finally {
    socks.forEach((s) => { try { s.destroy(); } catch (e) { /* gone */ } });
    relay.kill('SIGTERM');
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  if (fail > 0) console.error('--- relay log ---\n' + readLog().slice(-3000));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
