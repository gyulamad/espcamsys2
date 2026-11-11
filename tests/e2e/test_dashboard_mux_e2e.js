#!/usr/bin/env node
'use strict';
// test_dashboard_mux_e2e.js — mux.php: the pictures of SEVERAL cameras, of their detectors, and the detectors'
// readings on ONE connection, through a real php -S in front of a fake relay that speaks the mux format
// (nodejs/camera-relay/lib/muxcodec.js).
//   * always on (the old 'mux_enabled' switch is gone: a leftover 'mux_enabled' => false in config.php changes nothing),
//     one request carries every camera asked for, pictures intact, as the mux type, and the relay is asked for exactly
//     those cameras, with the relay key
//   * &dets=<camera> brings the picture of the detector paired with it, renamed to the camera (det:<camId>), and
//     &status=1 the readings shaped like detector-status.php ({ camId: status }); the detector's own id never
//     reaches the browser
//   * &rec=1 brings the cameras' recording state (the map status.php answers), untouched
//   * what the page did not ask for is not passed on, whatever the relay sends: other cameras, other detectors,
//     readings nobody asked for, message types it does not know
//   * a browser that leaves frees the relay connection (no leaked PHP worker / relay subscription)
//   * cams is optional (a page with every picture hidden still wants the readings and recording state), but a request
//     asking for nothing is a 400, as is a bad ?cams= (unknown camera, an array), no login, a relay that is down, that
//     redirects, that predates GET /mux or that answers with something other than the mux stream (JSON, text/html): each
//     refused plainly with 502, nothing of what the relay said reaches the browser (review F-14)
//   * every such 502 leaves a "mux.php:" line in the web server's error log saying why (unreachable / redirect / old
//     relay), at most once per kind of problem however often the browser retries, and never with the relay key in it
// Core modules only; skips if php is missing.
//   node tests/e2e/test_dashboard_mux_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const enc = require('../../nodejs/camera-relay/lib/muxcodec');
const dec = require('../../php/cameras/js/mux-codec');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_MUX_PORT || 19470);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const DEAD_PORT = BASE + 2;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';
const PERIOD_MS = 100;
const CAMERA_STATUS = JSON.stringify({ camA: { recording: true, recordingEndAt: 1234, recordingCount: 7, recordingOff: null } });
// What the browser gets: the same map, shaped by CamLogic::shapeCameraStatuses, which adds the checked Wi-Fi and device
// readings (null for a camera that sent none).
const CAMERA_STATUS_SHAPED = JSON.stringify({ camA: { recording: true, recordingEndAt: 1234, recordingCount: 7, recordingOff: null, wifi: null, device: null } });

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(25); }
}

// A picture that says whose it is (its third byte) and which one it is (the fourth).
const picture = (camIndex, n) => Buffer.from([0xff, 0xd8, camIndex, n, 0xff, 0xd9]);

const fake = { mode: 'mux', urls: [], keys: [], open: 0, closed: 0 };
let phpLog = '';   // what php -S wrote to its error log (stderr)
const relay = nodeHttp.createServer((req, res) => {
  fake.urls.push(req.url);
  fake.keys.push(req.headers['x-control-key']);
  if (!req.url.startsWith('/mux?')) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
  if (fake.mode === 'old') { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<pre>Cannot GET /mux</pre>'); return; }   // a relay that predates GET /mux
  if (fake.mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return; }
  if (fake.mode === 'json') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"nope"}'); return; }
  if (fake.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>window.__pwned=1</script>'); return; }
  const query = new URL(req.url, 'http://x').searchParams;
  const cams = query.get('cams') ? query.get('cams').split(',') : [];
  const dets = query.get('dets') ? query.get('dets').split(',') : [];
  res.writeHead(200, { 'Content-Type': enc.CONTENT_TYPE });
  fake.open += 1;
  res.write(enc.encodeHeartbeat());
  let n = 0;
  const readings = { detA: { online: true, state: 'online', hasPicture: true, connected: true, ageMs: 5, message: '', report: { fw: 'e2e' } } };
  const timer = setInterval(() => {
    n += 1;
    cams.forEach((id, i) => res.write(enc.encodeFrame(enc.cameraSource(id), picture(i, n))));
    dets.forEach((id, i) => res.write(enc.encodeFrame(enc.detectorSource(id), picture(20 + i, n))));
    // what the page did not ask for (a relay that says more than it was asked, or a spoofed one): must not get through
    res.write(enc.encodeFrame('cam:camZ', picture(30, n)));
    res.write(enc.encodeFrame('det:rogue', picture(31, n)));
    const unknownType = Buffer.from(enc.encodeFrame('x:y', Buffer.from([1])));
    unknownType[5] = 99;
    res.write(unknownType);
    res.write(enc.encodeState(enc.STATE_DETECTORS, Buffer.from(JSON.stringify(readings))));
    res.write(enc.encodeState(enc.STATE_CAMERAS, Buffer.from(CAMERA_STATUS)));
  }, PERIOD_MS);
  req.on('close', () => { clearInterval(timer); fake.closed += 1; });
});

let phpTmp, docroot;
function writeConfig(dir, { relayPort = RELAY_PORT, extra = '' } = {}) {
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${relayPort}', 'relay_control_key' => '${KEY}', ${extra}`
    + `'cameras' => [['id' => 'camA', 'name' => 'A', 'detector' => 'detA'], ['id' => 'camB', 'name' => 'B']]];\n`);
}
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mux-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', TMPDIR: phpTmp } });
    child.stderr.on('data', (c) => { phpLog += c.toString(); });
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

const BASIC = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
// GETs a page for `ms`, then leaves. The body is decoded as mux messages when the answer says it is the mux type.
function get(page, { ms = 1200, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth ? { Authorization: BASIC, 'X-Requested-With': 'camdash', 'Sec-Fetch-Site': 'same-origin' } : {};
    const req = nodeHttp.get({ host: '127.0.0.1', port: PHP_PORT, path: page, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      const done = () => {
        req.destroy();
        const body = Buffer.concat(chunks);
        const isMux = (res.headers['content-type'] || '') === enc.CONTENT_TYPE;
        let messages = [];
        try { if (isMux) { const p = dec.createParser(); messages = p.push(new Uint8Array(body)); } } catch (e) { messages = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: body.toString('utf8'), messages });
      };
      res.on('end', done);
      setTimeout(done, ms);
    });
    req.on('error', reject);
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php;
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mux-tmp-'));
    docroot = makeDashboard();
    writeConfig(docroot);
    php = await startPhp(docroot);

    // ── one connection, several cameras ──
    let r = await get('/mux.php?cams=camB,camA');
    check('mux.php answers 200 with exactly the mux type, not sniffable', r.status === 200 && r.headers['content-type'] === enc.CONTENT_TYPE && r.headers['x-content-type-options'] === 'nosniff', JSON.stringify(r.headers));
    check('the relay was asked for exactly those cameras, in that order, with the relay key', fake.urls[0] === '/mux?cams=camB%2CcamA' && fake.keys[0] === KEY, `${fake.urls[0]} / ${fake.keys[0]}`);
    const frames = (r.messages || []).filter((m) => m.type === enc.TYPE_FRAME);
    const of = (src) => frames.filter((m) => m.source === src);
    check('the one response is a valid mux stream with a heartbeat first', r.messages !== null && r.messages.length > 0 && r.messages[0].type === enc.TYPE_HEARTBEAT, JSON.stringify(r.messages && r.messages.slice(0, 2)));
    check('pictures of BOTH cameras arrive on it, several each, intact and in order', of('cam:camA').length >= 5 && of('cam:camB').length >= 5
      && of('cam:camB').every((m, i) => m.payload.length === 6 && m.payload[2] === 0 && m.payload[3] === i + 1)
      && of('cam:camA').every((m) => m.payload[2] === 1), `${of('cam:camA').length} / ${of('cam:camB').length}`);

    check('nothing the page did not ask for gets through: no other camera, no detector, no readings, no unknown type',
      r.messages !== null && r.messages.every((m) => (m.type === enc.TYPE_HEARTBEAT && m.source === '') || (m.type === enc.TYPE_FRAME && (m.source === 'cam:camA' || m.source === 'cam:camB'))),
      JSON.stringify([...new Set((r.messages || []).map((m) => `${m.type} ${m.source}`))]));

    // ── detector pictures and readings ──
    const urlsBefore = fake.urls.length;
    r = await get('/mux.php?cams=camB,camA&dets=camA&status=1');
    check('the relay is asked for the detector by ITS id, and for the readings', fake.urls[urlsBefore] === '/mux?cams=camB%2CcamA&dets=detA&status=1', fake.urls[urlsBefore]);
    const all = r.messages || [];
    const detPics = all.filter((m) => m.type === enc.TYPE_FRAME && m.source === 'det:camA');
    check("the detector's pictures arrive named after its CAMERA, intact", detPics.length >= 5 && detPics.every((m) => m.payload.length === 6 && m.payload[2] === 20), `${detPics.length}`);
    const readings = all.filter((m) => m.type === enc.TYPE_STATE && m.source === enc.STATE_DETECTORS);
    const shaped = readings.length ? JSON.parse(Buffer.from(readings[0].payload).toString('utf8')) : null;
    check('the readings arrive shaped like detector-status.php: by camera id, with the detector named in them',
      readings.length >= 1 && shaped && JSON.stringify(Object.keys(shaped)) === '["camA"]' && shaped.camA.detector === 'detA' && shaped.camA.state === 'online' && shaped.camA.report.fw === 'e2e', JSON.stringify(shaped));
    check("the detector's own id and everything unasked-for stay behind",
      all.every((m) => m.source !== 'det:detA' && m.source !== 'det:rogue' && m.source !== 'cam:camZ' && m.type !== 99), JSON.stringify([...new Set(all.map((m) => `${m.type} ${m.source}`))]));
    r = await get('/mux.php?cams=camA&rec=1');
    const recState = (r.messages || []).filter((m) => m.type === enc.TYPE_STATE);
    check('&rec=1: the recording state of the cameras arrives (shaped like status.php), and only that kind of readings',
      r.status === 200 && fake.urls[fake.urls.length - 1] === '/mux?cams=camA&rec=1' && recState.length >= 1
      && recState.every((m) => m.source === enc.STATE_CAMERAS && Buffer.from(m.payload).toString('utf8') === CAMERA_STATUS_SHAPED), JSON.stringify(recState.map((m) => m.source)));
    // no cameras asked for: the readings and the recording state still flow, and the relay is asked for just those
    r = await get('/mux.php?status=1&rec=1');
    const noCams = r.messages || [];
    check('&status=1&rec=1 without cams: 200, the relay is asked with no cams parameter, and no picture is sent',
      r.status === 200 && fake.urls[fake.urls.length - 1] === '/mux?status=1&rec=1' && noCams.some((m) => m.source === enc.STATE_DETECTORS)
      && noCams.some((m) => m.source === enc.STATE_CAMERAS) && noCams.every((m) => m.type !== enc.TYPE_FRAME), fake.urls[fake.urls.length - 1]);
    r = await get('/mux.php?rec=1');
    check('?rec=1 alone: 200 and only the recording state', r.status === 200 && fake.urls[fake.urls.length - 1] === '/mux?rec=1'
      && (r.messages || []).some((m) => m.source === enc.STATE_CAMERAS) && (r.messages || []).every((m) => m.type !== enc.TYPE_FRAME && m.source !== enc.STATE_DETECTORS));
    r = await get('/mux.php?dets=camA');
    check('?dets=camA alone: 200 and the detector\'s picture (renamed to the camera)', r.status === 200 && fake.urls[fake.urls.length - 1] === '/mux?dets=detA'
      && (r.messages || []).some((m) => m.source === 'det:camA'));
    r = await get('/mux.php?cams=camB,camA&dets=camA');
    check('readings only when asked for', (r.messages || []).every((m) => m.type !== enc.TYPE_STATE) && (r.messages || []).some((m) => m.source === 'det:camA'));

    // ── a browser that leaves frees the relay connection ──
    check('the connection to the relay is closed soon after the browser left', await waitFor(() => fake.closed >= 1 && fake.closed >= fake.open), `open ${fake.open}, closed ${fake.closed}`);

    // ── what is refused ──
    r = await get('/mux.php?cams=camA', { auth: false });
    check('no login: 401, no pictures', r.status === 401 && r.messages !== null && r.messages.length === 0, `status ${r.status}`);
    const before = fake.urls.length;
    for (const bad of ['', '?cams=', '?status=0', '?status=yes', '?rec=true', '?cams=nope', '?cams=camA,nope', '?cams=camA,', '?cams[]=camA',
      '?cams=camA&dets=camB', '?cams=camA&dets=detA', '?cams=camA&dets=nope', '?cams=camA&dets=camA,', '?cams=camA&dets[]=camA', '?cams=camA&status[]=1', '?cams=camA&rec[]=1']) {
      r = await get(`/mux.php${bad}`, { ms: 500 });
      check(`mux.php${bad || ' (nothing asked for)'}: 400, and the relay is not even asked`, r.status === 400 && fake.urls.length === before, `status ${r.status}`);
    }
    // ── a relay that cannot give the mux stream: 502 for the browser, the reason in the error log ──
    const muxLines = (what) => phpLog.split('\n').filter((l) => l.includes('camdash: mux.php: ') && l.includes(what));
    const refusals = [
      ['json', 'HTTP 400 and not the mux stream'],
      ['html', 'HTTP 200 and not the mux stream'],
      ['old', 'HTTP 404 and not the mux stream'],
      ['redirect', 'redirect (HTTP 302)'],
    ];
    for (const [mode, line] of refusals) {
      fake.mode = mode;
      r = await get('/mux.php?cams=camA', { ms: 500 });
      check(`a relay answering ${mode} instead of the mux stream: 502, none of its words reach the browser`, r.status === 502 && !r.text.includes('__pwned') && !r.text.includes('nope') && !r.text.includes('Cannot GET'), `status ${r.status}: ${r.text.slice(0, 80)}`);
      check(`...and the error log says why (${mode})`, await waitFor(() => muxLines(line).length === 1), phpLog.slice(-400));
    }
    check('the redirect was not followed (the relay key is never sent elsewhere): the relay was asked once', fake.urls.filter((u) => u.startsWith('/mux?cams=camA')).length >= 1 && !fake.urls.some((u) => u.includes('elsewhere')));
    fake.mode = 'old';
    for (let k = 0; k < 3; k++) await get('/mux.php?cams=camA', { ms: 300 });
    check('asking again and again does not flood the error log (once per 5 minutes per kind of problem)', muxLines('HTTP 404 and not the mux stream').length === 1, String(muxLines('HTTP 404 and not the mux stream').length));
    check('...and an old relay is told to be updated first', muxLines('HTTP 404')[0].includes('older than this dashboard') && muxLines('HTTP 404')[0].includes('relay first'));
    fake.mode = 'mux';
    writeConfig(docroot, { relayPort: DEAD_PORT });
    r = await get('/mux.php?cams=camA', { ms: 500 });
    check('a relay that is down: 502', r.status === 502 && r.text === 'Could not connect to the relay', `status ${r.status}: ${r.text}`);
    check('...and the error log says it could not be reached (with PHP\'s reason, for the log only)', await waitFor(() => muxLines('could not reach the relay for GET /mux').length === 1) && !r.text.includes('127.0.0.1'), phpLog.slice(-400));
    check('no line of the error log carries the relay key', !phpLog.includes(KEY));

    // ── the old switch is gone: a leftover 'mux_enabled' => false in config.php changes nothing ──
    writeConfig(docroot, { extra: "'mux_enabled' => false, " });
    r = await get('/mux.php?cams=camA', { ms: 500 });
    check("a leftover 'mux_enabled' => false is ignored: the stream is served", r.status === 200 && r.headers['content-type'] === enc.CONTENT_TYPE, `status ${r.status}`);
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (php) { php.removeAllListeners('exit'); php.kill('SIGKILL'); }
    try { relay.close(); relay.closeAllConnections && relay.closeAllConnections(); } catch (e) { /* closed */ }
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
