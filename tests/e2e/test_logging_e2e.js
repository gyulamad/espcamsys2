#!/usr/bin/env node
'use strict';
// test_logging_e2e.js — end-to-end check of the relay's logging, against a
// REAL `server.js` process, real HTTP and real TCP, reading the real log file
// back from disk.
//
// Cameras no longer have a serial monitor attached, so they POST their errors
// and debug info to the relay's /log endpoint, and the relay writes them —
// together with what it observes itself — into one plain-text file. This
// checks that:
//   - /log is authenticated (no key / wrong key -> 401, nothing written;
//     the key may be in the X-Api-Key header or ?key=), and that a rejected
//     client can't flood the log with rejections
//   - an accepted entry lands in the file with level, camera id, the SENDER'S
//     IP ADDRESS, the camera's uptime/heap/signal, message and trace, filed
//     under the time it HAPPENED (a camera that retried 5 minutes later still
//     gets the right timestamp)
//   - nothing a camera sends can forge a log line
//   - bad bodies are answered clearly (400 / 413), not with an HTML error page
//   - the relay logs what it sees itself: camera connected/disconnected (with
//     IP), a rejected connection, two boards sharing one camera id, start/stop
//   - the file rotates and cannot grow without bound
//   - an unusable log location never stops the relay from running
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway
// log/settings files in a temp folder, nothing written into the real logs/ or
// recordings/ folders. Core modules only. Takes a few seconds.
//
// Usage:  node tests/e2e/test_logging_e2e.js
//         E2E_LOG_PORT=19310 E2E_LOG_PUSH_PORT=19311 node tests/e2e/test_logging_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_LOG_PORT || 19310);
const PUSH_PORT = Number(process.env.E2E_LOG_PUSH_PORT || 19311);
const KEY = 'e2e-log-key';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
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

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-logging-switch-${process.pid}.json`) }, env),
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
// Stops a child and resolves when it is gone; safe on one that already ended (a signal-killed
// child has exitCode null — signalCode must be checked too, or this would wait forever).
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

// An HTTP request with optional headers and a JSON (or raw string) body.
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== null) {
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const postLog = (body, headers) => request('POST', '/log', { headers: Object.assign({ 'X-Api-Key': KEY }, headers), body });

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const lines = (s) => s.split('\n').filter((l) => l !== '');
const headerLines = (s) => lines(s).filter((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(l));
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

// A camera on the raw push port: "<id>\t<key>\n" then frames — here it never sends frames, only connects.
function pushCamera(id, key) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PUSH_PORT, '127.0.0.1', () => { sock.write(`${id}\t${key}\n`); resolve(sock); });
    sock.on('error', () => {});
    sock.on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    summarize();
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-logging-'));
  const settingsFile = path.join(tmp, 'settings.json');
  const logFile = path.join(tmp, 'logs', 'camera.log');
  let relay;
  const socks = [];
  try {
    // ── 1. authentication ───────────────────────────────────────────
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile });
    const entry = (over) => Object.assign({ seq: 1, level: 'ERROR', ageMs: 0, uptimeMs: 3621400, heap: 84312, rssi: -71, message: 'Frame capture failed', trace: 'at ESP32_CAM_Recorder.ino:405 loop()' }, over);
    const batch = (entries, over) => Object.assign({ camera: 'e2e-logcam', fw: 'Oct  3 2026', attempt: 0, dropped: 0, entries }, over);

    let r = await request('POST', '/log', { body: batch([entry()]) });
    check('POST /log with NO key is refused (401)', r.status === 401, JSON.stringify(r));
    r = await request('POST', '/log', { headers: { 'X-Api-Key': 'wrong' }, body: batch([entry({ message: 'SECRET-ONE' })]) });
    check('POST /log with a WRONG key is refused (401)', r.status === 401, JSON.stringify(r));
    r = await request('POST', '/log?key=wrong', { body: batch([entry()]) });
    check('...also when the wrong key is in ?key=', r.status === 401);
    await sleep(150);
    check('a refused request writes nothing of what it carried', !readLog(logFile).includes('SECRET-ONE'));
    check('...but the rejection itself is logged, once (not once per attempt), with the sender\'s address',
      headerLines(readLog(logFile)).filter((l) => l.includes('rejected a POST /log from 127.0.0.1')).length === 1,
      readLog(logFile));

    r = await postLog(batch([entry({ message: 'via header' })]));
    check('POST /log with the key in the X-Api-Key header is accepted', r.status === 200 && r.json.ok === true && r.json.accepted === 1, JSON.stringify(r));
    r = await request('POST', `/log?key=${KEY}`, { body: batch([entry({ message: 'via query' })]) });
    check('...and so is the key in ?key= (same convention as /upload)', r.status === 200, JSON.stringify(r));

    // ── 2. what ends up in the file ─────────────────────────────────
    const t0 = Date.now();
    r = await postLog(batch([
      entry({ seq: 41, level: 'WARN', message: 'first of three', ageMs: 300000, trace: '' }),
      entry({ seq: 42, level: 'ERROR', message: 'second\nwith a second line', ageMs: 299000,
        trace: 'at ESP32_CAM_Recorder.ino:405 loop()\nrecent events (oldest first):\n  -12.3s INFO push connection established' }),
      entry({ seq: 43, level: 'debug', message: 'third', ageMs: 0, trace: '' }),
    ], { attempt: 2, dropped: 7 }));
    const t1 = Date.now();
    check('a batch of three entries is accepted', r.status === 200 && r.json.accepted === 3, JSON.stringify(r));
    const log = readLog(logFile);
    const second = lines(log).findIndex((l) => l.includes('second'));
    check('an entry carries level, camera id, the SENDER\'S IP, uptime, heap, signal and sequence number',
      /ERROR e2e-logcam@127\.0\.0\.1 up=3621\.4s heap=84312 rssi=-71 seq=42 attempt=3 late=299\.0s fw="Oct  3 2026": second/.test(log), log);
    check('multi-line messages and the trace go on indented continuation lines',
      lines(log).slice(second + 1, second + 5).join('|') === '    | with a second line|    at ESP32_CAM_Recorder.ino:405 loop()|    recent events (oldest first):|      -12.3s INFO push connection established',
      lines(log).slice(second, second + 6).join('\n'));
    const m = /^(\S+) WARN  e2e-logcam@127\.0\.0\.1 .*seq=41 .*: first of three/m.exec(log);
    const when = m ? Date.parse(m[1]) : NaN;
    check('the entry is filed under when it HAPPENED (received time minus its age), not when it arrived',
      m && when >= t0 - 300000 - 1500 && when <= t1 - 300000 + 1500, `stamp=${m && m[1]} expected≈${new Date(t1 - 300000).toISOString()}`);
    check('entries keep their order', log.indexOf('first of three') < log.indexOf('second') && log.indexOf('second') < log.indexOf('third'));
    check('"debug" in any case is accepted', /DEBUG e2e-logcam@127\.0\.0\.1 .*: third/.test(log));
    check('a camera that lost entries before delivery gets a warning saying how many',
      /WARN  e2e-logcam@127\.0\.0\.1 \[relay\]: the camera reports 7 log entries were lost/.test(log), log);

    // ── 3. a camera cannot forge log lines ──────────────────────────
    const before = headerLines(readLog(logFile)).length;
    r = await postLog(batch([entry({
      message: 'innocent\n2026-01-01T00:00:00.000Z ERROR cam9@6.6.6.6: FORGED ENTRY\r2026-01-01T00:00:00.000Z INFO x: forged too',
      trace: '2026-01-01T00:00:00.000Z ERROR cam9@6.6.6.6: FORGED TRACE',
    })], { camera: 'e2e-logcam' }));
    const after = headerLines(readLog(logFile));
    check('a message full of fake log lines produces exactly ONE entry', r.status === 200 && after.length === before + 1, `before=${before} after=${after.length}`);
    check('...and none of the forged text starts a line', !after.some((l) => l.includes('FORGED')));

    // ── 4. bad requests are answered clearly ────────────────────────
    r = await request('POST', '/log', { headers: { 'X-Api-Key': KEY }, body: '{ this is not json' });
    check('a body that is not JSON gets a 400 with a JSON error, not an HTML page', r.status === 400 && r.json && typeof r.json.error === 'string', JSON.stringify(r));
    r = await postLog({ camera: 'bad id!', entries: [entry()] });
    check('an unsafe camera id gets a 400', r.status === 400, JSON.stringify(r));
    r = await postLog({ camera: 'e2e-logcam', entries: [] });
    check('an empty entries list gets a 400', r.status === 400, JSON.stringify(r));
    r = await postLog({ camera: 'e2e-logcam', entries: [{ level: 'ERROR' }] });
    check('entries without a message get a 400', r.status === 400, JSON.stringify(r));
    r = await postLog(batch([entry({ message: 'x'.repeat(60 * 1024) })]));
    check('a request over the 32 KB limit gets a 413', r.status === 413 && r.json && typeof r.json.error === 'string', JSON.stringify(r).slice(0, 200));
    r = await postLog(batch([entry({ message: 'good one' }), { level: 'INFO' }, entry({ message: 'another good one' })]));
    check('unusable entries are skipped and counted, the good ones are kept',
      r.status === 200 && r.json.accepted === 2 && r.json.rejected === 1 && readLog(logFile).includes('another good one'), JSON.stringify(r));

    // ── 5. what the relay observes itself ───────────────────────────
    const camA = await pushCamera('e2e-obscam', KEY);
    socks.push(camA);
    check('the relay logs a camera connecting, with its address',
      !!(await waitFor(() => /INFO  e2e-obscam@127\.0\.0\.1 \[relay\]: camera connected/.test(readLog(logFile)), 2000)), readLog(logFile).slice(-600));

    const camB = await pushCamera('e2e-obscam', KEY); // a second board with the SAME id
    socks.push(camB);
    check('two boards sharing one camera id are called out',
      !!(await waitFor(() => /WARN  e2e-obscam@127\.0\.0\.1 \[relay\]: another connection with the SAME camera id/.test(readLog(logFile)), 2000)), readLog(logFile).slice(-800));

    const bad = await pushCamera('e2e-badcam', 'not-the-key');
    socks.push(bad);
    check('a connection with the wrong key is refused and logged with its address',
      !!(await waitFor(() => /rejected a push connection from 127\.0\.0\.1: wrong key/.test(readLog(logFile)), 2000)), readLog(logFile).slice(-800));
    check('...and the wrong key itself is never written to the log', !readLog(logFile).includes('not-the-key') && !readLog(logFile).includes(KEY));

    camA.destroy();
    camB.destroy();
    check('the relay logs a camera disconnecting, and for how long it was connected',
      !!(await waitFor(() => /camera disconnected after \d+s/.test(readLog(logFile)), 3000)), readLog(logFile).slice(-800));

    // ── 6. the relay's own lifecycle ────────────────────────────────
    check('the relay logs that it started', /INFO  relay: relay started \(pid \d+, node v/.test(readLog(logFile)));
    await stopRelay(relay);
    check('...and that it was stopped on purpose', /INFO  relay: relay stopping \(SIGTERM\)/.test(readLog(logFile)), readLog(logFile).slice(-300));

    // ── 7. rotation ─────────────────────────────────────────────────
    const rotFile = path.join(tmp, 'rot', 'camera.log');
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: rotFile, LOG_MAX_BYTES: '65536', LOG_KEEP_FILES: '1' });
    // (each message is capped at 2000 characters by the relay, so ~4 KB per request; 40 requests ≈ 160 KB >> the 64 KiB limit)
    for (let i = 0; i < 40; i++) {
      const rr = await postLog(batch([entry({ message: `bulk-${String(i).padStart(2, '0')} ` + 'x'.repeat(1900), seq: i }), entry({ message: `bulk-${String(i).padStart(2, '0')}b ` + 'y'.repeat(1900), seq: i })]));
      if (rr.status !== 200) check('bulk logging stays accepted', false, JSON.stringify(rr).slice(0, 200));
    }
    const sizes = [rotFile, rotFile + '.1', rotFile + '.2'].map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1));
    check('the log file rotates to camera.log.1 when it reaches the size limit', sizes[1] > 0, JSON.stringify(sizes));
    check('...keeps only the configured number of old files', sizes[2] === -1, JSON.stringify(sizes));
    check('...and no file exceeds the limit, so the disk cannot fill up', sizes[0] <= 65536 && sizes[1] <= 65536, JSON.stringify(sizes));
    check('...the newest entries are in the live file', readLog(rotFile).includes('bulk-39b'));
    await stopRelay(relay);

    // ── 8. an unusable log location never stops the relay ───────────
    const blocker = path.join(tmp, 'a-file');
    fs.writeFileSync(blocker, 'x');
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: path.join(blocker, 'sub', 'camera.log') }); // folder cannot be created
    check('the relay still starts when its log location is unusable (and says file logging is off)',
      relay.output().includes('file logging is OFF'), relay.output());
    r = await postLog(batch([entry()]));
    check('/log then answers 503 so the camera keeps its entries and retries later', r.status === 503, JSON.stringify(r));
    r = await request('GET', '/status');
    check('...and the rest of the relay keeps working', r.status === 200, JSON.stringify(r));
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    for (const s of socks) s.destroy();
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
