#!/usr/bin/env node
'use strict';
// test_dashboard_mux_e2e.js — mux.php: the pictures of SEVERAL cameras, of their detectors, and the detectors'
// readings on ONE connection, through a real php -S in front of a fake relay that speaks the mux format
// (nodejs/camera-relay/lib/muxcodec.js).
//   * on unless 'mux_enabled' => false (also when the key is left out), one request carries every camera asked for, pictures intact, as the mux type,
//     and the relay is asked for exactly those cameras, with the relay key
//   * &dets=<camera> brings the picture of the detector paired with it, renamed to the camera (det:<camId>), and
//     &status=1 the readings shaped like detector-status.php ({ camId: status }); the detector's own id never
//     reaches the browser
//   * &rec=1 brings the cameras' recording state (the map status.php answers), untouched
//   * what the page did not ask for is not passed on, whatever the relay sends: other cameras, other detectors,
//     readings nobody asked for, message types it does not know
//   * a browser that leaves frees the relay connection (no leaked PHP worker / relay subscription)
//   * a bad ?cams= (missing, unknown camera, an array), no login, mux not switched on, a relay that is down or
//     that answers with something other than the mux stream (JSON, text/html): each refused plainly, nothing of
//     what the relay said reaches the browser (review F-14)
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
const relay = nodeHttp.createServer((req, res) => {
  fake.urls.push(req.url);
  fake.keys.push(req.headers['x-control-key']);
  if (!req.url.startsWith('/mux?')) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
  if (fake.mode === 'json') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"nope"}'); return; }
  if (fake.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>window.__pwned=1</script>'); return; }
  const query = new URL(req.url, 'http://x').searchParams;
  const cams = query.get('cams').split(',');
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
function writeConfig(dir, { mux, relayPort = RELAY_PORT }) {
  const muxLine = mux === undefined ? '' : `'mux_enabled' => ${mux ? 'true' : 'false'}, `;
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${relayPort}', 'relay_control_key' => '${KEY}', ${muxLine}`
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
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', TMPDIR: phpTmp } });
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
    writeConfig(docroot, { mux: true });
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
    r = await get('/mux.php?cams=camB,camA&dets=camA');
    check('readings only when asked for', (r.messages || []).every((m) => m.type !== enc.TYPE_STATE) && (r.messages || []).some((m) => m.source === 'det:camA'));

    // ── a browser that leaves frees the relay connection ──
    check('the connection to the relay is closed soon after the browser left', await waitFor(() => fake.closed >= 1 && fake.closed >= fake.open), `open ${fake.open}, closed ${fake.closed}`);

    // ── what is refused ──
    r = await get('/mux.php?cams=camA', { auth: false });
    check('no login: 401, no pictures', r.status === 401 && r.messages !== null && r.messages.length === 0, `status ${r.status}`);
    const before = fake.urls.length;
    for (const bad of ['', '?cams=', '?cams=nope', '?cams=camA,nope', '?cams=camA,', '?cams[]=camA',
      '?cams=camA&dets=camB', '?cams=camA&dets=detA', '?cams=camA&dets=nope', '?cams=camA&dets=camA,', '?cams=camA&dets[]=camA', '?cams=camA&status[]=1', '?cams=camA&rec[]=1']) {
      r = await get(`/mux.php${bad}`, { ms: 500 });
      check(`mux.php${bad || ' (no cams)'}: 400, and the relay is not even asked`, r.status === 400 && fake.urls.length === before, `status ${r.status}`);
    }
    for (const mode of ['json', 'html']) {
      fake.mode = mode;
      r = await get('/mux.php?cams=camA', { ms: 500 });
      check(`a relay answering ${mode} instead of the mux stream: 502, none of its words reach the browser`, r.status === 502 && !r.text.includes('__pwned') && !r.text.includes('nope'), `status ${r.status}: ${r.text.slice(0, 80)}`);
    }
    fake.mode = 'mux';
    writeConfig(docroot, { mux: true, relayPort: DEAD_PORT });
    r = await get('/mux.php?cams=camA', { ms: 500 });
    check('a relay that is down: 502', r.status === 502, `status ${r.status}`);
    writeConfig(docroot, { mux: false });
    r = await get('/mux.php?cams=camA', { ms: 500 });
    check('mux_enabled false: 404 (the dashboard uses stream.php)', r.status === 404, `status ${r.status}`);
    writeConfig(docroot, { mux: undefined });
    r = await get('/mux.php?cams=camA', { ms: 500 });
    check('mux_enabled left out: ON, the stream is served', r.status === 200 && r.headers['content-type'] === enc.CONTENT_TYPE, `status ${r.status}`);
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
