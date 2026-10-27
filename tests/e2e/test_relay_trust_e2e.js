#!/usr/bin/env node
'use strict';
// test_relay_trust_e2e.js — F-12 / F-14 / F-15 / F-16 / F-20: the small input and output checks of the
// dashboard, on a REAL PHP server in front of a hostile fake relay that says whatever it likes.
//   F-14  live streams: only a picture stream is passed on — a relay saying text/html, svg or a made-up
//         boundary gets a 502 and none of its text; a real MJPEG stream passes with its boundary intact
//   F-14  recordings: only ONE plain byte range is passed to the relay; Content-Range / Content-Length /
//         Accept-Ranges are passed back only if they look right; a made-up status (600, 204 with a body
//         type...) is not repeated to the browser
//   F-16  ?cam[]=x and friends answer 400, not a PHP crash (500), and nothing reaches the relay
//   F-15  a trailing newline in a recording name is refused
//   F-12  recording OFF for more than a week is refused; the number the relay gets is the checked one
//   F-20  when the relay cannot be reached, the browser is not told the relay's address; the log is
// Needs `php` on PATH (skips if missing). Own ports, throwaway dashboard copy, core modules only.
//
// Usage:  node tests/e2e/test_relay_trust_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const crypto = require('crypto');
const fs = require('fs');
const nodeHttp = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_TRUST_PORT || 19400);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';
const FILE = 'cam-a-20260101-000000.mp4';

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

// ── the hostile relay: its mood is set by the test ──
const seen = [];                       // every request that reached it
let mode = {};                         // what it answers right now
function relayHandler(req, res) {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  const u = req.url.split('?')[0];
  if (u.startsWith('/stream/') || /^\/detector\/[^/]+\/stream$/.test(u)) {
    res.writeHead(200, { 'Content-Type': mode.streamType || 'multipart/x-mixed-replace; boundary=frame' });
    res.end(mode.streamBody || '--frame\r\nContent-Type: image/jpeg\r\n\r\nJPEGDATA\r\n');
    return;
  }
  if (/^\/recordings\/[^/]+\/[^/]+\.mp4$/.test(u) && req.method === 'GET') {
    res.writeHead(mode.playStatus || 200, mode.playHeaders || { 'Content-Type': 'video/mp4', 'Content-Length': '8', 'Accept-Ranges': 'bytes' });
    res.end(mode.playBody || 'FAKEMP4!');
    return;
  }
  if (/^\/record\//.test(u) || /^\/recording\//.test(u)) {
    res.writeHead(mode.jsonStatus || 200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
}

let docroot;
let phpLog = '';
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-trust-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷', 'detector' => 'det-a']]];\n`);
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.stdout.on('data', (d) => { phpLog += d; });
    child.stderr.on('data', (d) => { phpLog += d; });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
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

// The dashboard's own page talking to PHP (header + same Origin), like a browser would. Raw path, so
// odd characters (%0A, [] ...) reach PHP exactly as written.
function dash(method, pathAndQuery, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64'),
      Host: `127.0.0.1:${PHP_PORT}`, 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin',
      ...extraHeaders,
    };
    if (method !== 'GET') headers['Content-Length'] = 0;
    const req = nodeHttp.request({ host: '127.0.0.1', port: PHP_PORT, path: '/' + pathAndQuery, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on('error', (e) => reject(new Error(`${method} /${pathAndQuery}: ${e.message}`)));
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}
const relayCalls = () => seen.length;
const lastSeen = () => seen[seen.length - 1];

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  let php; let relay;
  try {
    relay = nodeHttp.createServer(relayHandler);
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    docroot = makeDashboard();
    php = await startPhp(docroot);

    // ── F-14: live streams ──
    for (const [label, url] of [['stream.php', 'stream.php?cam=cam-a'], ['detector-stream.php', 'detector-stream.php?cam=cam-a']]) {
      mode = {};
      let r = await dash('GET', url);
      check(`${label}: a real motion-JPEG stream passes, with its boundary intact`, r.status === 200 && r.headers['content-type'] === 'multipart/x-mixed-replace; boundary=frame' && r.text.includes('JPEGDATA'), `status=${r.status} ct=${r.headers['content-type']} ${r.text.slice(0, 80)}`);
      mode = { streamType: 'multipart/x-mixed-replace;boundary="my-boundary_1"' };
      r = await dash('GET', url);
      check(`${label}: a quoted boundary is passed on rebuilt, plain`, r.status === 200 && r.headers['content-type'] === 'multipart/x-mixed-replace; boundary=my-boundary_1', r.headers['content-type']);
      for (const bad of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/javascript', 'application/xhtml+xml', 'multipart/x-mixed-replace; boundary=<script>alert(1)</script>']) {
        mode = { streamType: bad, streamBody: '<html><script>window.__pwned=1</script>RELAYTEXT</html>' };
        r = await dash('GET', url);
        check(`${label}: a relay that says "${bad.slice(0, 40)}" is refused (502), none of its text or type is passed on`, r.status === 502 && !/RELAYTEXT|__pwned|<script/.test(r.text) && !/svg|javascript|xhtml|multipart/.test(r.headers['content-type'] || ''), `status=${r.status} ct=${r.headers['content-type']} ${r.text.slice(0, 100)}`);
      }
    }
    mode = {};

    // ── F-14: recordings — Range, headers, status ──
    const play = `recordings.php?cam=cam-a&play=${FILE}`;
    let before = relayCalls();
    let r = await dash('GET', play, { Range: 'bytes=0-3' });
    check('a plain byte range is passed on to the relay', r.status === 200 && lastSeen().headers.range === 'bytes=0-3', JSON.stringify(lastSeen().headers));
    for (const bad of ['bytes=0-1,5-9', 'bytes=abc', 'bytes=-', 'bytes=5-2', 'items=0-5', 'bytes=0-99999999999999999', 'bytes=0-5; evil']) {
      before = relayCalls();
      r = await dash('GET', play, { Range: bad });
      check(`an odd Range "${bad}" is NOT passed on (the whole file is served)`, r.status === 200 && relayCalls() === before + 1 && lastSeen().headers.range === undefined, JSON.stringify(lastSeen().headers));
    }
    mode = { playStatus: 206, playBody: 'FAKE', playHeaders: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/8', 'Content-Length': '4', 'Accept-Ranges': 'bytes' } };
    r = await dash('GET', play, { Range: 'bytes=0-3' });
    check('well-formed Content-Range / Content-Length / Accept-Ranges come back (206)', r.status === 206 && r.headers['content-range'] === 'bytes 0-3/8' && r.headers['accept-ranges'] === 'bytes', JSON.stringify(r.headers));
    mode = { playStatus: 200, playHeaders: { 'Content-Type': 'video/mp4', 'Content-Range': '<script>alert(1)</script>', 'Content-Length': '8', 'Accept-Ranges': 'everything' } };
    r = await dash('GET', play);
    check('a malformed Content-Range / Accept-Ranges from the relay is dropped', r.headers['content-range'] === undefined && r.headers['accept-ranges'] === undefined && !/script/i.test(JSON.stringify(r.headers)), JSON.stringify(r.headers));
    check('...and the browser is told it is a video, whatever the relay said', r.headers['content-type'] === 'video/mp4' && r.headers['x-content-type-options'] === 'nosniff', JSON.stringify(r.headers));
    for (const st of [600, 101]) {
      mode = { playStatus: st, playHeaders: { 'Content-Type': 'text/html' } };
      r = await dash('GET', play);
      check(`a made-up relay status ${st} on a recording is not repeated (502)`, r.status === 502, `status=${r.status}`);
    }
    mode = { jsonStatus: 600 };
    r = await dash('POST', `record.php?cam=cam-a&stop=1`);
    check('a made-up relay status on a JSON call is not repeated either (502)', r.status === 502, `status=${r.status} ${r.text.slice(0, 100)}`);
    mode = { jsonStatus: 409 };
    r = await dash('POST', `record.php?cam=cam-a&stop=1`);
    check('(control) a real error status such as 409 still is passed on', r.status === 409, `status=${r.status}`);
    mode = {};

    // ── F-16: array parameters ──
    before = relayCalls();
    const arrays = [
      ['stream.php?cam[]=x', 'GET'], ['stream.php?cam[a]=x', 'GET'], ['detector-stream.php?cam[]=x', 'GET'],
      ['recordings.php?cam[]=x', 'GET'], [`recordings.php?cam=cam-a&play[]=${FILE}`, 'GET'], [`recordings.php?cam=cam-a&download[]=${FILE}`, 'GET'],
      [`recordings.php?cam=cam-a&delete[]=${FILE}`, 'POST'], [`recordings.php?cam=cam-a&seen[]=${FILE}`, 'POST'], ['recordings.php?cam=cam-a&deleteAll[]=1', 'POST'],
      ['record.php?cam[]=x', 'GET'], ['record.php?cam=cam-a&stop[]=1', 'POST'], ['record.php?cam=cam-a&seconds[]=5', 'POST'],
    ];
    for (const [url, method] of arrays) {
      r = await dash(method, url);
      check(`${method} ${url} -> 400, not a crash`, r.status === 400 && !/Fatal|TypeError|Stack trace|Uncaught/i.test(r.text), `status=${r.status} ${r.text.slice(0, 120)}`);
    }
    check('...and none of them reached the relay', relayCalls() === before);
    check('...and PHP logged no fatal error', !/Fatal error|Uncaught|TypeError/.test(phpLog), phpLog.slice(-300));
    r = await dash('POST', 'recording-switch.php?scope=camera&cam=cam-a&action=off&minutes[]=5');
    check('recording-switch with minutes[]=5 -> 400, not a crash', r.status === 400 && !/Fatal|TypeError/.test(r.text), `status=${r.status} ${r.text.slice(0, 100)}`);

    // ── F-15: a trailing newline ──
    before = relayCalls();
    for (const [url, method] of [[`recordings.php?cam=cam-a&play=${FILE}%0A`, 'GET'], [`recordings.php?cam=cam-a&download=${FILE}%0A`, 'GET'], [`recordings.php?cam=cam-a&delete=${FILE}%0A`, 'POST'], [`recordings.php?cam=cam-a&seen=${FILE}%0A`, 'POST']]) {
      r = await dash(method, url);
      check(`${method} ${url.replace('%0A', '<newline>')} is refused (400)`, r.status === 400, `status=${r.status} ${r.text.slice(0, 80)}`);
    }
    r = await dash('GET', 'stream.php?cam=cam-a%0A');
    check('a camera id with a trailing newline is not found (404)', r.status === 404, `status=${r.status}`);
    check('...and none of it reached the relay', relayCalls() === before);

    // ── F-12: recording OFF for at most a week ──
    const sw = (minutes) => dash('POST', `recording-switch.php?scope=camera&cam=cam-a&action=off&minutes=${minutes}`);
    for (const bad of ['10081', '99999999', '999999999999', '1e3', 'abc']) {
      before = relayCalls();
      r = await sw(bad);
      check(`recording OFF for ${bad} minutes is refused (400) and never reaches the relay`, r.status === 400 && relayCalls() === before && /10080/.test(r.text), `status=${r.status} ${r.text.slice(0, 120)}`);
    }
    for (const [sent, got] of [['10080', 'minutes=10080'], ['60', 'minutes=60'], ['-15', 'minutes=-15'], ['0', 'minutes=0'], ['%20007%20', 'minutes=7']]) {
      r = await sw(sent);
      check(`recording OFF for "${decodeURIComponent(sent)}" is accepted, and the relay gets ${got}`, r.status === 200 && lastSeen().url.endsWith('?' + got), `status=${r.status} relay saw ${lastSeen().url}`);
    }
    r = await dash('POST', 'recording-switch.php?scope=camera&cam=cam-a&action=on');
    check('(control) ON still works with no minutes', r.status === 200 && !lastSeen().url.includes('minutes'), `status=${r.status} ${lastSeen().url}`);
    r = await dash('POST', `record.php?cam=cam-a&seconds=3601`);
    check('(control) a manual recording still caps at 3600 seconds', r.status === 400);

    // ── F-20: the relay is unreachable: the browser is not told where it lives ──
    await new Promise((resolve) => relay.close(resolve));   // port closed: "connection refused"
    // log_throttled() writes the same line only once per 5 minutes, using a marker file in the temp folder:
    // clear the ones this test can hit, so an earlier run cannot hide the line we look for
    for (const status of [502, 503, 504]) fs.rmSync(path.join(os.tmpdir(), 'camdash-log-' + crypto.createHash('sha1').update(`detector-stream:det-a:${status}`).digest('hex')), { force: true });
    phpLog = '';
    const addr = `127.0.0.1:${RELAY_PORT}`;
    for (const url of ['detector-stream.php?cam=cam-a', 'stream.php?cam=cam-a', 'recordings.php?cam=cam-a', 'status.php', 'record.php?cam=cam-a']) {
      r = await dash('GET', url);
      check(`${url}: relay down -> an error, and the page never mentions the relay's address or PHP's internals`, r.status >= 500 && !r.text.includes(addr) && !r.text.includes(String(RELAY_PORT)) && !/fopen|failed to open stream|http:\/\//i.test(r.text), `status=${r.status} ${r.text.slice(0, 160)}`);
    }
    r = await dash('GET', 'detector-stream.php?cam=cam-a');
    check('...but the detector page still says WHY in words (the reason, not the address)', r.status === 502 && /\(Connection refused\)/.test(r.text), `status=${r.status} ${r.text}`);
    await sleep(200);
    check('...but the details are in the error log, where the owner looks', phpLog.includes(addr) || /Connection refused/i.test(phpLog), phpLog.slice(-400));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    try { relay.close(); } catch (e) { /* already closed */ }
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
  }
  summarize();
}
main();
