#!/usr/bin/env node
'use strict';
// test_relay_mux_e2e.js — GET /mux on a REAL server.js: the pictures of several cameras on one connection.
//   * the cameras asked for are checked (missing, invalid, repeated, too many: 400 that says why)
//   * a heartbeat comes at once and then on its own; a picture reaches the viewer within a fraction of a second,
//     intact, tagged with its camera; cameras that were not asked for do not come
//   * a viewer that connects later gets each camera's last picture at once
//   * ?rec=1 brings the recording state of every camera (what GET /status answers) every 2 s, from one shared round
//   * detectors: ?dets= brings their pictures (as det:<id>, also from a detector that connects after the viewer asked),
//     ?status=1 the readings of every detector once a second and on every change; neither is sent unasked; a detector
//     the relay never heard from is said in the log and costs nothing
//   * a viewer that stops reading never makes the relay queue up: it gets fewer pictures, the NEWEST one among them
//   * a viewer limit (503 that says why), and closed viewers free their slot
//   * with a controlKey set, /mux needs it like /stream does
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_relay_mux_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const codec = require('../../nodejs/camera-relay/lib/muxcodec');
const feed = require('../../nodejs/camera-relay/lib/muxfeed');
const fakeDetector = require('./fake_detector');
const decoder = require('../../php/cameras/js/mux-codec');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_MUX_RELAY_PORT || 19480);
const CAM_KEY = 'e2e-mux-camera-key';
const CONTROL_KEY = 'e2e-mux-control-key';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mux-relay-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

function startRelay(port, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(port), PUSH_PORT: String(port + 1), CAM_KEY,
        SETTINGS_FILE: path.join(tmp, `settings-${port}.json`), LOG_FILE: path.join(tmp, `relay-${port}.log`), SWITCH_FILE: path.join(tmp, `switch-${port}.json`) }, env),
    });
    let out = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 5000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${port + 1}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}

// A camera pushing one picture over the relay's HTTP upload; the picture says which one it is (encoded
// in bytes 4 and 5, after the 3-byte JPEG magic FF D8 FF that NODE-011's isJpeg() check requires).
const picture = (n, size = 8) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, n >> 8, n & 255]), Buffer.alloc(size - 7, 1), Buffer.from([0xff, 0xd9])]);
function upload(port, cam, jpeg) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host: '127.0.0.1', port, method: 'POST', path: `/upload/${cam}?key=${CAM_KEY}`, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(jpeg);
  });
}

// A /mux viewer: messages as they are decoded, with arrival times; pause() stops reading (a stalled link).
function view(port, query, headers = {}) {
  return new Promise((resolve, reject) => {
    const v = { status: 0, headers: {}, text: '', messages: [], times: [], pause: () => {}, resume: () => {}, close: () => {} };
    const parser = decoder.createParser();
    const req = nodeHttp.get({ host: '127.0.0.1', port, path: `/mux${query}`, headers }, (res) => {
      v.status = res.statusCode; v.headers = res.headers;
      const isMux = res.headers['content-type'] === codec.CONTENT_TYPE;
      res.on('data', (c) => {
        if (!isMux) { v.text += c.toString('utf8'); return; }
        for (const m of parser.push(new Uint8Array(c))) { v.messages.push(m); v.times.push(Date.now()); }
      });
      v.pause = () => res.pause(); v.resume = () => res.resume(); v.close = () => req.destroy();
      resolve(v);
    });
    req.on('error', (e) => { if (!v.status) reject(e); });
  });
}
const framesOf = (v, id) => v.messages.filter((m) => m.type === codec.TYPE_FRAME && m.source === `cam:${id}`);
const numberOf = (m) => (m.payload[3] << 8) | m.payload[4];
const detFrames = (v, id) => v.messages.filter((m) => m.type === codec.TYPE_FRAME && m.source === `det:${id}`);
const states = (v) => v.messages.filter((m) => m.type === codec.TYPE_STATE && m.source === codec.STATE_DETECTORS);
const readings = (m) => JSON.parse(Buffer.from(m.payload).toString('utf8'));

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay');
    return;
  }
  const relay = await startRelay(PORT, { READ_KEY_REQUIRED: '0' });  // no controlKey here: reads are refused unless this opts out
  const keyed = await startRelay(PORT + 2, { CONTROL_KEY });
  const viewers = [];
  try {
    // ── what is refused ──
    for (const [what, query] of [['no cams', ''], ['an empty list', '?cams='], ['an invalid id', '?cams=a/b'], ['an empty entry', '?cams=cam-a,'],
      ['a repeated parameter', '?cams=cam-a&cams=cam-b'], ['too many cameras', '?cams=' + Array.from({ length: 65 }, (_, i) => `c${i}`).join(',')]]) {
      const v = await view(PORT, query);
      let body = {}; try { body = JSON.parse(v.text); } catch (e) { /* not JSON */ }
      check(`${what}: 400 saying why, nothing streamed`, v.status === 400 && typeof body.error === 'string' && v.messages.length === 0, `status ${v.status} ${v.text}`);
      v.close();
    }

    // ── one viewer, two cameras ──
    check('a camera can push before anyone watches', await upload(PORT, 'mux-a', picture(1)) === 200);
    const v = await view(PORT, '?cams=mux-a,mux-b');
    viewers.push(v);
    check('200, the mux type, not cached, not sniffable', v.status === 200 && v.headers['content-type'] === codec.CONTENT_TYPE && v.headers['cache-control'] === 'no-store' && v.headers['x-content-type-options'] === 'nosniff', JSON.stringify(v.headers));
    check('a heartbeat arrives at once, then the last picture camera a pushed', await waitFor(() => v.messages.length >= 2)
      && v.messages[0].type === codec.TYPE_HEARTBEAT && v.messages[1].source === 'cam:mux-a' && numberOf(v.messages[1]) === 1, JSON.stringify(v.messages.slice(0, 2).map((m) => [m.type, m.source])));
    const t0 = Date.now();
    await upload(PORT, 'mux-b', picture(2, 4000));
    await upload(PORT, 'mux-a', picture(3));
    await upload(PORT, 'mux-c', picture(4));
    check('pictures of both cameras arrive intact, each tagged with its camera', await waitFor(() => framesOf(v, 'mux-b').length >= 1 && framesOf(v, 'mux-a').length >= 2)
      && framesOf(v, 'mux-b')[0].payload.length === 4000 && numberOf(framesOf(v, 'mux-b')[0]) === 2 && numberOf(framesOf(v, 'mux-a')[1]) === 3);
    check('...within a fraction of a second of being pushed', v.times[v.times.length - 1] - t0 < 1000, `${v.times[v.times.length - 1] - t0} ms`);
    check('a camera that was not asked for does not come', framesOf(v, 'mux-c').length === 0 && !v.messages.some((m) => m.source === 'cam:mux-c'));
    const beats = v.messages.filter((m) => m.type === codec.TYPE_HEARTBEAT).length;
    check('and a heartbeat comes on its own when nothing happens', await waitFor(() => v.messages.filter((m) => m.type === codec.TYPE_HEARTBEAT).length > beats, feed.HEARTBEAT_MS + 1500));

    // ── a later viewer ──
    const late = await view(PORT, '?cams=mux-c,mux-a');
    viewers.push(late);
    check('a viewer that comes later gets the last picture of each camera at once', await waitFor(() => framesOf(late, 'mux-c').length === 1 && framesOf(late, 'mux-a').length === 1)
      && numberOf(framesOf(late, 'mux-c')[0]) === 4 && numberOf(framesOf(late, 'mux-a')[0]) === 3);

    // ── detectors: pictures and readings on the same connection ──
    const dv = await view(PORT, '?cams=mux-a&dets=mux-det,mux-late,mux-ghost&status=1');
    viewers.push(dv);
    check('before any detector has connected there is nothing to send but the (empty) readings',
      await waitFor(() => states(dv).length >= 1) && Object.keys(readings(states(dv)[0])).length === 0 && detFrames(dv, 'mux-det').length === 0);
    const up = await fakeDetector.uplink(PORT, 'mux-det', { key: CAM_KEY });
    check('a detector connects', up.status === 101, `status ${up.status}`);
    up.socket.write(fakeDetector.wire(fakeDetector.status(), fakeDetector.JPEG));
    check('its picture arrives as det:<its id>, byte for byte, though it connected AFTER the viewer asked',
      await waitFor(() => detFrames(dv, 'mux-det').length >= 1) && Buffer.from(detFrames(dv, 'mux-det')[0].payload).equals(fakeDetector.JPEG));
    check('the readings follow it at once: the detector is listed, with its report', await waitFor(() => states(dv).some((m) => {
      const r = readings(m)['mux-det'];
      return r && r.report && r.report.fw === 'e2e';
    })));
    const lateUp = await fakeDetector.uplink(PORT, 'mux-late', { key: CAM_KEY });
    lateUp.socket.write(fakeDetector.wire(fakeDetector.status(), fakeDetector.JPEG2));
    check('a second detector that connects later is picked up too', await waitFor(() => detFrames(dv, 'mux-late').length >= 1)
      && Buffer.from(detFrames(dv, 'mux-late')[0].payload).equals(fakeDetector.JPEG2));
    const countBefore = states(dv).length;
    check('the readings are sent once a second even when nothing changes (their ages keep moving)', await waitFor(() => states(dv).length >= countBefore + 2, 3500), `${states(dv).length - countBefore} new`);
    check('a detector that never connected is said in the log, once', await waitFor(() => /asked for the picture of detector 'mux-ghost'/.test(fs.readFileSync(path.join(tmp, `relay-${PORT}.log`), 'utf8')))
      && (fs.readFileSync(path.join(tmp, `relay-${PORT}.log`), 'utf8').match(/asked for the picture of detector 'mux-ghost'/g) || []).length === 1);
    const plain = await view(PORT, '?cams=mux-a');
    viewers.push(plain);
    up.socket.write(fakeDetector.wire(fakeDetector.status(), fakeDetector.JPEG));
    await sleep(1500);
    check('a viewer that asked for neither gets neither pictures nor readings of detectors', states(plain).length === 0 && !plain.messages.some((m) => m.source.startsWith('det:')));
    for (const [what, query] of [['dets with an invalid id', '?cams=mux-a&dets=a/b'], ['dets with an empty entry', '?cams=mux-a&dets=d1,'], ['a repeated dets', '?cams=mux-a&dets=d1&dets=d2'],
      ['too many detectors', '?cams=mux-a&dets=' + Array.from({ length: 65 }, (_, i) => `d${i}`).join(',')]]) {
      const bad = await view(PORT, query);
      check(`${what}: 400`, bad.status === 400, `status ${bad.status}`);
      bad.close();
    }
    // __proto__ is refused by the id check (400); the other names every object has (constructor, toString) pass it and
    // must be just detectors nobody has heard of: no crash, the stream runs.
    const proto = await view(PORT, '?cams=mux-a&dets=__proto__');
    check('a detector id __proto__ is refused: 400', proto.status === 400, `status ${proto.status}`);
    proto.close();
    const ghosts = await view(PORT, '?cams=mux-a&dets=constructor,toString');
    viewers.push(ghosts);
    check('a detector id like constructor is just a detector nobody has heard of (no crash, the stream runs)', ghosts.status === 200 && await waitFor(() => ghosts.messages.length >= 1));
    up.socket.destroy();
    lateUp.socket.destroy();

    // ── the cameras' recording state ──
    const rv = await view(PORT, '?cams=mux-a&rec=1');
    viewers.push(rv);
    const recStates = (x) => x.messages.filter((m) => m.type === codec.TYPE_STATE && m.source === codec.STATE_CAMERAS);
    check('the recording state arrives at once: every camera the relay knows, as GET /status answers it',
      await waitFor(() => recStates(rv).length >= 1, 4000) && readings(recStates(rv)[0])['mux-a'] !== undefined
      && typeof readings(recStates(rv)[0])['mux-a'].recording === 'boolean' && typeof readings(recStates(rv)[0])['mux-a'].recordingCount === 'number',
      JSON.stringify(recStates(rv).slice(0, 1).map(readings)));
    check('...and again every few seconds, so a changed state shows up without anyone asking', await waitFor(() => recStates(rv).length >= 2, 4500), `${recStates(rv).length} so far`);
    const statusAnswer = await new Promise((resolve) => nodeHttp.get({ host: '127.0.0.1', port: PORT, path: '/status' }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(JSON.parse(body)));
    }));
    check('it is the same map GET /status answers', Object.keys(readings(recStates(rv)[0])).sort().join() === Object.keys(statusAnswer).sort().join());
    check('a viewer that did not ask for it is not sent it', recStates(plain).length === 0);

    // ── a viewer that cannot keep up ──
    const slow = await view(PORT, '?cams=mux-slow');
    viewers.push(slow);
    await waitFor(() => slow.messages.length >= 1);
    slow.pause();
    const SENT = 100;
    for (let n = 1; n <= SENT; n++) await upload(PORT, 'mux-slow', picture(n, 400 * 1024));
    slow.resume();
    check('a stalled viewer is not queued up for: it got fewer pictures than were sent, and the newest among them',
      await waitFor(() => framesOf(slow, 'mux-slow').some((m) => numberOf(m) === SENT), 8000)
      && framesOf(slow, 'mux-slow').length < SENT, `${framesOf(slow, 'mux-slow').length} of ${SENT}`);

    // ── the viewer limit ──
    viewers.forEach((x) => x.close());
    viewers.length = 0;
    await sleep(200);
    const crowd = [];
    for (let i = 0; i < feed.MAX_VIEWERS; i++) crowd.push(await view(PORT, '?cams=mux-a'));
    const extra = await view(PORT, '?cams=mux-a');
    let body = {}; try { body = JSON.parse(extra.text); } catch (e) { /* not JSON */ }
    check(`viewer ${feed.MAX_VIEWERS + 1} is refused with 503 that says why`, crowd.every((x) => x.status === 200) && extra.status === 503 && /viewers/.test(body.error || ''), `status ${extra.status} ${extra.text}`);
    crowd[0].close();
    const retry = await waitFor(async () => { const x = await view(PORT, '?cams=mux-a'); if (x.status === 200) return x; x.close(); return null; });
    check('a closed viewer frees its slot', !!retry);
    crowd.forEach((x) => x.close());
    if (retry) retry.close();

    // ── the read key ──
    let k = await view(PORT + 2, '?cams=mux-a');
    check('with a controlKey set, no key: 401', k.status === 401, `status ${k.status}`);
    k.close();
    k = await view(PORT + 2, '?cams=mux-a', { 'X-Control-Key': CONTROL_KEY });
    check('with the key: 200 and a stream', k.status === 200 && await waitFor(() => k.messages.length >= 1));
    k.close();
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    viewers.forEach((x) => x.close());
    relay.kill('SIGKILL');
    keyed.kill('SIGKILL');
    if (createdConfig) fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => {
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
