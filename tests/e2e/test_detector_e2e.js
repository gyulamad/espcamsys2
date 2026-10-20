#!/usr/bin/env node
'use strict';
// test_detector_e2e.js — a person detector talks to a REAL server.js over real sockets:
//   the uplink (HTTP Upgrade on the relay's normal port, then length-prefixed messages) ->
//   GET /detectors (numbers, state, reason) and GET /detector/:id/stream (the 96x96 picture as MJPEG).
//
// The failure modes get as much attention as the happy path, because a detector that "does not show
// up" must be explainable without a serial cable: every refusal is an HTTP answer that says why, a
// stream request is answered AT ONCE (it used to hang until the picture came, so PHP timed out with a
// 502 after 10 s and nothing was logged anywhere), and every event lands in the relay's log.
//
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_detector_e2e.js        (exit 0 = all passed)

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dl = require('../../nodejs/camera-relay/lib/detectorlink');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DETECTOR_PORT || 19290);
const PUSH_PORT = Number(process.env.E2E_DETECTOR_PUSH_PORT || 19291);
const KEY = 'e2e-detector-key';
const ID = 'e2e-detector-1';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detector-'));
const logFile = path.join(tmp, 'relay.log');
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(40);
  }
}

function request(method, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${p}`, { method, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, text: out, ms: Date.now() - started }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const fake = require('./fake_detector');
const { JPEG, JPEG2, status, wire, heartbeat } = fake;
const uplink = (id, opts = {}) => fake.uplink(PORT, id, Object.assign({ key: KEY }, opts));

function startRelay(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY,
        SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: logFile, SWITCH_FILE: path.join(tmp, 'switch.json'),
      }, extraEnv),
    });
    let out = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 5000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${PUSH_PORT}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}

// Opens the MJPEG stream; resolves with the head (status + headers) as soon as it arrives, and keeps collecting.
function openStream(id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/detector/${id}/stream`, (res) => {
      const out = { status: res.statusCode, type: res.headers['content-type'], headMs: Date.now() - started, body: () => Buffer.concat(chunks), close: () => req.destroy() };
      res.on('data', (c) => chunks.push(c));
      resolve(out);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.setTimeout(6000, () => req.destroy(new Error('no answer within 6 s')));
  });
}

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay');
    return;
  }
  const relay = await startRelay({ PUSH_IDLE_TIMEOUT_MS: '3000', DETECTOR_NO_PICTURE_WARN_MS: '800' });
  const socks = [];
  try {
    // ── 0. nothing known yet — and a stream request is answered AT ONCE ───────────────────
    let r = await request('GET', '/detectors');
    check('no detector known at first', r.status === 200 && Object.keys(r.json).length === 0);

    r = await request('GET', `/detector/${ID}/stream`);
    check('asking for the picture of a detector that never connected is a quick 404, not a hang',
      r.status === 404 && r.ms < 1500, `status ${r.status} after ${r.ms} ms`);
    check('...whose JSON says why, and that no detector has connected at all',
      !!r.json && r.json.state === 'never' && /no detector called 'e2e-detector-1' has connected/.test(r.json.error) && /no detector has connected at all/.test(r.json.error), JSON.stringify(r.json));
    check('...and the relay logs that the dashboard asked, with what to check',
      !!(await waitFor(() => /WARN  e2e-detector-1@?\S* ?\[relay\]: the dashboard asked for the picture of detector 'e2e-detector-1' but there is none/.test(readLog()), 2000)) &&
      /DETECTOR_ID on the board equals the detector paired with the camera/.test(readLog()), readLog().slice(-600));
    r = await request('GET', '/detector/bad%20id/stream');
    check('an invalid detector id is a 400', r.status === 400);

    // ── 1. the board's first request, when something is wrong: every refusal says why ─────
    let u = await uplink(ID, { key: 'wrong-key-123' });
    check('a wrong key is refused with a 401 whose JSON says so', u.status === 401 && /wrong key/.test(u.body) && /API_KEY/.test(u.body) && /camKey/.test(u.body), u.headText + (u.body || ''));
    check('...and the connection is then closed', !!(await waitFor(() => u.socket.destroyed, 3000)));
    u = await uplink(ID, { key: null });
    check('no key is a 401 that asks for the X-Api-Key header', u.status === 401 && /missing key/.test(u.body) && /X-Api-Key/.test(u.body), u.headText + (u.body || ''));
    u = await uplink(ID, { upgrade: null });
    check('a plain request without the Upgrade headers is a 426 naming the protocol, not a bare 404', u.status === 426 && /Upgrade: espcam-detector\/1/i.test(u.headText) && /Connection: Upgrade/.test(u.body), u.headText + (u.body || ''));
    u = await uplink(ID, { upgrade: 'websocket' });
    check('another protocol is a 426 too', u.status === 426);
    u = await uplink('x', { path: '/detector/bad%20id/uplink' });
    check('an address that is not a detector uplink is a 404 saying what it should be', u.status === 404 && /DETECTOR_ID/.test(u.body), u.headText + (u.body || ''));
    check('refusals are logged with the board\'s address and the reason',
      !!(await waitFor(() => /WARN  e2e-detector-1 \[relay\]: refused a detector uplink request from 127\.0\.0\.1 for "\/detector\/e2e-detector-1\/uplink": HTTP 401 — wrong key/.test(readLog()), 2000)), readLog().slice(-900));
    check('...and neither the wrong key nor the right one is ever written to the log', !readLog().includes('wrong-key-123') && !readLog().includes(KEY));
    r = await request('GET', '/detectors');
    check('refused boards leave no detector behind', Object.keys(r.json).length === 0, JSON.stringify(r.json));

    // ── 2. a good connection ─────────────────────────────────────────────────────────────
    u = await uplink(ID);
    check('the right key and Upgrade get a 101', u.status === 101 && /Upgrade: espcam-detector\/1/.test(u.headText), u.headText);
    const det = u.socket;
    socks.push(det);
    let beat = null; // started once the first numbers have gone out
    check('the relay logs the detector connecting, with its address',
      !!(await waitFor(() => /INFO  e2e-detector-1@127\.0\.0\.1 \[relay\]: detector connected/.test(readLog()), 2000)), readLog().slice(-600));

    r = await request('GET', '/detectors');
    let d = r.json && r.json[ID];
    check('connected but silent so far: listed, not online, with a reason',
      !!d && d.connected === true && d.online === false && d.state === 'offline' && /connected but has not sent anything yet/.test(d.message), JSON.stringify(d));

    r = await request('GET', `/detector/${ID}/stream`);
    check('a stream request now is a quick 503 that says the detector has sent nothing yet',
      r.status === 503 && r.ms < 1500 && /has no picture to show/.test(r.json.error) && /not sent anything yet/.test(r.json.error), `${r.status} ${r.text}`);

    // ── 3. frames flow ──────────────────────────────────────────────────────────────────
    det.write(wire(status(), JPEG));
    beat = heartbeat(det, () => status());
    check('the relay logs the first picture', !!(await waitFor(() => /INFO  e2e-detector-1@127\.0\.0\.1 \[relay\]: detector is sending pictures \(the first: 10 bytes of JPEG\)/.test(readLog()), 2000)), readLog().slice(-500));
    r = await request('GET', '/detectors');
    d = r.json && r.json[ID];
    check('GET /detectors lists it as online with a picture and no message', !!d && d.online === true && d.hasPicture === true && d.state === 'online' && d.message === '' && d.ip === '127.0.0.1', JSON.stringify(d));
    check('its numbers and thresholds come back', !!d && d.report.scene.brightness === 130 && d.report.scene.motionAtLeast === 300 &&
      d.report.person.score === 0.81 && d.report.gpio.high === true && d.report.gpio.pin === 13 && d.report.link.heap === 90000, JSON.stringify(d));
    check('the picture itself is not in the JSON', !!d && d.report.jpeg === undefined && !JSON.stringify(d).includes('/9j') && !JSON.stringify(d).includes('/+A'));
    r = await request('GET', '/status');
    check('a detector is NOT listed as a camera in /status', r.status === 200 && r.json[ID] === undefined);
    r = await request('POST', '/alarm/all');
    check('"alarm all" does not touch the detector', r.status === 200 && !JSON.stringify(r.json).includes(ID), JSON.stringify(r.json));

    const stream = await openStream(ID);
    check('the stream is multipart MJPEG and its head arrives at once', stream.status === 200 && /multipart\/x-mixed-replace/.test(stream.type || '') && stream.headMs < 1500, `${stream.status} ${stream.type} ${stream.headMs} ms`);
    check('it starts with the latest picture', !!(await waitFor(() => stream.body().includes(JPEG), 2000)));
    det.write(wire(status({ scene: { state: 'still', brightness: 131, motion: 2, darkBelow: 40, motionAtLeast: 300, holdS: 10 } }), JPEG2));
    check('...and every picture pushed afterwards follows', !!(await waitFor(() => stream.body().includes(JPEG2), 2000)));
    check('...each framed as an image/jpeg part', /Content-Type: image\/jpeg\r\nContent-Length: 12\r\n\r\n/.test(stream.body().toString('latin1')));
    stream.close();

    // ── 4. what a board on a weak link does to the stream ───────────────────────────────
    beat(); // the heartbeat would land in the middle of the messages written by hand below
    const piece = wire(status(), JPEG);
    for (let i = 0; i < piece.length; i += 7) { det.write(piece.slice(i, i + 7)); await sleep(2); }
    r = await request('GET', '/detectors');
    check('a message arriving in tiny pieces is put back together', r.json[ID].online === true && r.json[ID].report.link.frames === 1, JSON.stringify(r.json[ID]));
    det.write(Buffer.concat([wire(status({ rssi: -70 }), JPEG), wire(status({ rssi: -71 }), JPEG).slice(0, 5)]));
    await sleep(100);
    det.write(wire(status({ rssi: -71 }), JPEG).slice(5));
    check('...also when two messages share a packet with the start of a third', !!(await waitFor(async () => (await request('GET', '/detectors')).json[ID].report.rssi === -71, 2000)));
    beat = heartbeat(det, () => status());

    // ── 5. rubbish from a board that IS authenticated: ignored, logged, the connection survives ──
    det.write(dl.frameMessage(Buffer.from([9, 1, 2, 3])));
    det.write(wire({ hello: 1 }, JPEG));
    det.write(dl.frameMessage(dl.encodeMessage(status(), Buffer.from('not a jpeg at all'))));
    det.write(wire(status(), JPEG2));
    check('an unknown message type is ignored without a word, the next good one is used', !!(await waitFor(async () => (await request('GET', '/detectors')).json[ID].report.rssi === -55, 2000)));
    check('an unusable message is logged with the reason and does not drop the connection',
      !!(await waitFor(() => /WARN  e2e-detector-1@127\.0\.0\.1 \[relay\]: ignored an unusable message from the detector: gpio\.pin, scene\.\* and person\.detectAt\/clearAt must be numbers in range/.test(readLog()), 2000)) && !det.destroyed, readLog().slice(-700));

    // ── 6. a picture that never comes ───────────────────────────────────────────────────
    const mute = await uplink('e2e-nopic');
    socks.push(mute.socket);
    const muteStatus = () => status({ link: { frames: 10, jpegFails: 10, reconnects: 0, heap: 40000 } });
    mute.socket.write(wire(muteStatus(), null));
    const stopMute = heartbeat(mute.socket, muteStatus);
    await sleep(900);
    mute.socket.write(wire(muteStatus(), null));
    r = await request('GET', '/detectors');
    check('numbers without any picture: state "no-picture", saying what the board reports',
      r.json['e2e-nopic'].state === 'no-picture' && r.json['e2e-nopic'].online === true && /10 failed JPEG encodings/.test(r.json['e2e-nopic'].message), JSON.stringify(r.json['e2e-nopic']));
    check('the relay warns that the detector sends no picture, with its own failure count',
      !!(await waitFor(() => /WARN  e2e-nopic@127\.0\.0\.1 \[relay\]: the detector has been connected for \d+s and reports its numbers, but has sent no picture \(it reports 10 failed JPEG encodings/.test(readLog()), 2000)), readLog().slice(-700));
    r = await request('GET', '/detector/e2e-nopic/stream');
    check('and its stream request is a quick 503 with that same reason', r.status === 503 && r.ms < 1500 && /failed JPEG encodings/.test(r.json.error), `${r.status} ${r.text}`);

    // ── 7. a detector id that is NOT the one the dashboard asks for (the classic pairing mistake) ──
    r = await request('GET', '/detector/detector-1/stream');
    check('asking for an id that does not exist lists the detectors that DO',
      r.status === 404 && /detectors seen: e2e-detector-1, e2e-nopic/.test(r.json.error) && JSON.stringify(r.json.known) === JSON.stringify(['e2e-detector-1', 'e2e-nopic']), JSON.stringify(r.json));
    check('...and the relay log carries the same hint',
      !!(await waitFor(() => /the dashboard asked for the picture of detector 'detector-1' but there is none: no detector called 'detector-1' has connected to the relay since it started \(detectors seen: e2e-detector-1, e2e-nopic\)/.test(readLog()), 2000)), readLog().slice(-600));
    r = await request('GET', '/detectors');
    check('asking for a missing detector does not create it', r.json['detector-1'] === undefined);

    // ── 8. the board goes away ──────────────────────────────────────────────────────────
    beat();
    stopMute();
    det.destroy();
    check('the relay logs a detector disconnecting, for how long and how many pictures',
      !!(await waitFor(() => /INFO  e2e-detector-1@127\.0\.0\.1 \[relay\]: detector disconnected after \d+s, \d+ pictures received \(the board closed the connection\)/.test(readLog()), 3000)), readLog().slice(-700));
    r = await request('GET', '/detectors');
    d = r.json[ID];
    check('it is no longer connected, and says how its connection ended', d.connected === false && d.lastDisconnect && /the board closed the connection/.test(d.lastDisconnect.why), JSON.stringify(d));
    await sleep(5400);
    r = await request('GET', '/detectors');
    d = r.json[ID];
    check('after a few seconds of silence it is offline, with the time it was last heard',
      d.state === 'offline' && d.online === false && /last heard \d+ s ago; its connection ended \(the board closed the connection\)/.test(d.message), JSON.stringify(d));
    r = await request('GET', `/detector/${ID}/stream`);
    check('and its stream request is a quick 503 carrying that reason', r.status === 503 && r.ms < 1500 && /last heard/.test(r.json.error), `${r.status} ${r.text}`);

    // ── 9. it comes back ────────────────────────────────────────────────────────────────
    const back = await uplink(ID);
    socks.push(back.socket);
    back.socket.write(wire(status(), JPEG));
    const stopBack = heartbeat(back.socket, () => status());
    check('a reconnecting detector is online again, connected, with a picture and no message',
      !!(await waitFor(async () => { const x = (await request('GET', '/detectors')).json[ID]; return x.online && x.hasPicture && x.connected && x.message === ''; }, 2000)), JSON.stringify((await request('GET', '/detectors')).json[ID]));

    // ── 10. two boards sharing one id ───────────────────────────────────────────────────
    const twin = await uplink(ID);
    socks.push(twin.socket);
    check('a second live connection with the same id is called out', !!(await waitFor(() => /WARN  e2e-detector-1@127\.0\.0\.1 \[relay\]: another connection with the SAME detector id is still sending/.test(readLog()), 2000)), readLog().slice(-700));
    twin.socket.destroy();
    stopBack();
    back.socket.destroy();

    // ── 11. a connection that goes silent is dropped, and the relay says why ───────────
    const quiet = await uplink('e2e-quiet');
    socks.push(quiet.socket);
    check('a connection that sends nothing for the idle timeout is closed by the relay', !!(await waitFor(() => quiet.socket.destroyed, 5500)), 'still open');
    check('...and the log names the reason', !!(await waitFor(() => /WARN  e2e-quiet@127\.0\.0\.1 \[relay\]: detector disconnected after \d+s, 0 pictures received \(no data for 3s\)/.test(readLog()), 2000)), readLog().slice(-500));

    // ── 12. abuse ───────────────────────────────────────────────────────────────────────
    const junk = await uplink('e2e-junk');
    socks.push(junk.socket);
    junk.socket.write(Buffer.from([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]));
    check('a stream whose length prefix is absurd is dropped and logged', !!(await waitFor(() => junk.socket.destroyed, 2000)) &&
      !!(await waitFor(() => /WARN  e2e-junk@127\.0\.0\.1 \[relay\]: dropped the connection: .* \(a corrupt or out-of-step stream/.test(readLog()), 2000)), readLog().slice(-600));
    const rst = await uplink('e2e-reset');
    rst.socket.resetAndDestroy();
    check('a connection reset mid-stream is logged and does not take the relay down',
      !!(await waitFor(() => /e2e-reset@127\.0\.0\.1 \[relay\]: detector disconnected after \d+s, 0 pictures received \(the connection was reset/.test(readLog()), 2000)) && (await request('GET', '/detectors')).status === 200, readLog().slice(-600));

    r = await request('POST', `/detector/${ID}`);
    check('the old per-report POST endpoint is gone (the stream replaced it)', r.status === 404);

    // ── 13. a runaway number of ids is not accepted ────────────────────────────────────
    const many = [];
    for (let i = 0; i < 70; i += 1) {
      const c = await uplink(`e2e-many-${i}`);
      many.push(c);
      if (c.status !== 101) break;
    }
    const refused = many.find((c) => c.status === 503);
    check('the relay stops accepting new detector ids at its limit (64), with a 503 that says so',
      !!refused && /already 64 detectors|knows 64 detectors/.test(refused.body) && (await request('GET', '/detectors')).status === 200, many.map((c) => c.status).join(','));
    many.forEach((c) => c.socket.destroy());
  } finally {
    socks.forEach((s) => { try { s.destroy(); } catch (e) { /* gone */ } });
    relay.kill('SIGTERM');
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
  if (fail > 0) { console.error('--- relay log ---\n' + readLog().slice(-4000)); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
