#!/usr/bin/env node
'use strict';
// test_dashboard_detector_events_e2e.js — detector-events.php, the PUSH stream of the detectors' numbers,
// on a REAL PHP server in front of a fake relay (core modules only, so it runs without the relay's npm
// packages; the real relay's side is in test_relay_detector_events_e2e.js).
//   * needs the dashboard login; 404 when no camera has a detector
//   * streams text/event-stream: the current state at once, then every push the moment the relay sends it
//     (the delay is measured), shaped per CAMERA id like detector-status.php; the control key goes to the relay
//   * unpaired / hostile relay data does not leak through, garbage messages are skipped, the stream goes on
//   * relay too old (404), wrong content type, or down: a plain HTTP error that says so (EventSource then
//     falls back to polling), with a line in the error log, and none of the relay's text or address
//   * a browser that goes away closes the relay connection too (no leaked workers)
// Own ports, throwaway dashboard copy. Needs `php` (skips if missing).
//   node tests/e2e/test_dashboard_detector_events_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_EVENTS_PORT || 19440);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

// ── the fake relay ──
const view = (extra = {}) => Object.assign({ state: 'online', online: true, hasPicture: true, connected: true, ageMs: 5, pictureAgeMs: 5, ip: '10.0.0.7', message: '', report: null }, extra);
const sse = (obj) => `event: detectors\ndata: ${JSON.stringify(obj)}\n\n`;
const seen = [];
let mode = 'ok';                 // ok | old | html | down-after-headers
const viewers = new Set();       // open relay-side responses
let viewerClosed = 0;
function relayHandler(req, res) {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url !== '/detectors/events') { res.writeHead(404); res.end(); return; }
  if (mode === 'old') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found SECRET-RELAY-TEXT"}'); return; }
  if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>alert("RELAY-HTML")</script>'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.write(sse({ detA: view({ ageMs: 1 }), stranger: view() }));
  viewers.add(res);
  req.on('close', () => { viewers.delete(res); viewerClosed++; });
}
const pushAll = (text) => { for (const v of viewers) v.write(text); };

// ── dashboard ──
let docroot, phpTmp, phpLog = '';
function makeDashboard(withDetector) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-events-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [['id' => 'camA', 'name' => 'A', 'icon' => 'x'${withDetector ? ", 'detector' => 'detA'" : ''}]]];\n`);
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6', TMPDIR: phpTmp } });
    child.stdout.on('data', (d) => { phpLog += d; });
    child.stderr.on('data', (d) => { phpLog += d; });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    (async () => {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL'); reject(new Error('php -S not ready in 5s'));
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

// Opens the stream like a browser's EventSource and collects the parsed messages. close() ends it.
function open(p = '/detector-events.php', { auth = true } = {}) {
  const headers = { Host: `127.0.0.1:${PHP_PORT}`, 'X-Requested-With': 'camdash', 'Sec-Fetch-Site': 'same-origin', Accept: 'text/event-stream' };
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
  return new Promise((resolve, reject) => {
    const s = { status: 0, headers: {}, raw: '', messages: [], times: [], close: () => {} };
    const req = nodeHttp.request({ host: '127.0.0.1', port: PHP_PORT, path: p, method: 'GET', headers }, (res) => {
      s.status = res.statusCode; s.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        s.raw += c;
        for (const m of c.matchAll(/event: detectors\ndata: (.*)\n\n/g)) { try { s.messages.push(JSON.parse(m[1])); s.times.push(Date.now()); } catch (e) { /* not ours */ } }
      });
      s.done = new Promise((r) => res.on('end', r).on('close', r));
      s.close = () => req.destroy();
      resolve(s);
    });
    req.on('error', (e) => { if (!s.status) reject(e); });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; const relay = nodeHttp.createServer(relayHandler);
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-events-tmp-'));

    // no camera has a detector
    docroot = makeDashboard(false);
    php = await startPhp(docroot);
    let s = await open();
    check('no camera with a detector: 404 and the relay is not even asked', s.status === 404 && seen.length === 0, `status=${s.status}`);
    await stopProc(php); fs.rmSync(docroot, { recursive: true, force: true });

    docroot = makeDashboard(true);
    php = await startPhp(docroot);
    s = await open('/detector-events.php', { auth: false });
    check('needs the dashboard login', s.status === 401 && seen.length === 0, `status=${s.status}`);

    // the stream
    s = await open();
    check('200 text/event-stream, not cached, not buffered', s.status === 200 && /^text\/event-stream/.test(s.headers['content-type']) && s.headers['cache-control'] === 'no-store' && s.headers['x-accel-buffering'] === 'no', JSON.stringify(s.headers));
    check('the browser is told how soon to reconnect', await waitFor(() => s.raw.startsWith('retry: 1000\n\n')), s.raw.slice(0, 40));
    check('the relay gets the control key', seen.length === 1 && seen[0].headers['x-control-key'] === KEY);
    check('the current state arrives at once, shaped per CAMERA id', await waitFor(() => s.messages.length >= 1) && s.messages[0].camA && s.messages[0].camA.detector === 'detA' && s.messages[0].camA.state === 'online');
    check('a detector no camera is paired with is not forwarded', !s.raw.includes('stranger'));

    const before = s.messages.length;
    const t0 = Date.now();
    pushAll(sse({ detA: view({ ageMs: 2, report: { scene: { brightness: 77 } } }) }));
    check('a push reaches the browser within a fraction of a second', await waitFor(() => s.messages.length > before, 1000) && Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);

    // a burst: the newest state always arrives
    pushAll(Array.from({ length: 50 }, (_, i) => sse({ detA: view({ ageMs: 100 + i }) })).join(''));
    check('after a burst of pushes the NEWEST state is what the browser ends up with', await waitFor(() => s.messages[s.messages.length - 1].camA.ageMs === 149, 1500), JSON.stringify(s.messages.slice(-1)));

    // garbage between good messages
    const n = s.messages.length;
    pushAll('event: detectors\ndata: not json\n\n: a comment\n\n' + sse({ detA: view({ ageMs: 777 }) }));
    check('garbage is skipped and the stream goes on', await waitFor(() => s.messages.length > n && s.messages[s.messages.length - 1].camA.ageMs === 777, 1500));
    pushAll(sse({ detA: view({ state: 'offline', online: false, message: 'last heard 9 s ago' }) }));
    check('an offline state passes through with its message', await waitFor(() => s.messages[s.messages.length - 1].camA.state === 'offline' && /last heard/.test(s.messages[s.messages.length - 1].camA.message), 1500));

    // the browser goes away -> the relay connection closes
    // (the real relay pushes at least once a second; PHP notices the browser has gone when it next writes)
    const ticker = setInterval(() => pushAll(sse({ detA: view() })), 200);
    const closedBefore = viewerClosed;
    s.close();
    check('closing the browser connection closes the relay connection too', await waitFor(() => viewerClosed > closedBefore && viewers.size === 0, 4000), `closed=${viewerClosed - closedBefore} open=${viewers.size}`);
    clearInterval(ticker);

    // relay failures: plain HTTP errors
    for (const f of fs.readdirSync(phpTmp)) if (f.startsWith('camdash-log-')) fs.rmSync(path.join(phpTmp, f), { force: true });
    phpLog = '';
    mode = 'old';
    s = await open();
    check('relay too old (404): a 502 JSON that says to update it, none of the relay\'s text', s.status === 502 && /may be older than this dashboard/.test(s.raw) && !s.raw.includes('SECRET-RELAY-TEXT'), `${s.status} ${s.raw.slice(0, 200)}`);
    await sleep(150);
    check('...and the error log says why', /detector-events\.php: the relay answered GET \/detectors\/events with HTTP 404/.test(phpLog), phpLog.slice(-300));
    mode = 'html';
    s = await open();
    check('relay answering 200 text/html is refused, its markup not passed on', s.status === 502 && !s.raw.includes('RELAY-HTML'), `${s.status} ${s.raw.slice(0, 120)}`);
    await new Promise((r) => relay.close(r));
    for (const f of fs.readdirSync(phpTmp)) if (f.startsWith('camdash-log-')) fs.rmSync(path.join(phpTmp, f), { force: true });
    s = await open();
    if (s.done) await s.done;   // wait for the body to arrive (review: pre-existing race, exposed by the throttle-file delay)
    check('relay down: a quick 502 without the relay\'s address', s.status === 502 && !s.raw.includes(`${RELAY_PORT}`) && /cannot reach the relay/.test(s.raw), `${s.status} ${s.raw.slice(0, 160)}`);
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    try { relay.close(); } catch (e) { /* closed */ }
    for (const v of viewers) v.destroy();
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
