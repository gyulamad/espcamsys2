#!/usr/bin/env node
'use strict';
// test_detector_e2e.js — a person detector talks to a REAL server.js over real sockets:
//   the uplink (HTTP Upgrade on the relay's normal port, then length-prefixed messages) ->
//   GET /detectors (numbers, state, reason) and GET /mux?dets= (the 96x96 picture, on the one live connection).
//
// The failure modes get as much attention as the happy path, because a detector that "does not show
// up" must be explainable without a serial cable: every refusal is an HTTP answer that says why, a
// viewer asking for a picture is answered AT ONCE (it used to hang until the picture came, so PHP timed out
// with a 502 after 10 s and nothing was logged anywhere; the mux answers with a heartbeat, and the relay's log
// says why no picture comes), and every event lands in the relay's log.
//
// Own ports (never 8080/8081), throwaway log/settings files, core modules only.
//   node tests/e2e/test_detector_e2e.js        (exit 0 = all passed)

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dl = require('../../nodejs/camera-relay/lib/detectorlink');
const muxViewer = require('./mux_viewer');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_DETECTOR_PORT || 19290);
const PUSH_PORT = Number(process.env.E2E_DETECTOR_PUSH_PORT || 19291);
const KEY = 'e2e-detector-key';
const CONTROL_KEY = 'e2e-detector-control-key';   // (review NODE-H2): reads need the control key now
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

// (review NODE-H2): reads need the control key now. The test's request helper
// adds X-Control-Key to every request unless the caller overrides headers.
function request(method, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const finalHeaders = Object.assign({ 'X-Control-Key': CONTROL_KEY }, headers);
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${p}`, { method, headers: finalHeaders }, (res) => {
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
        PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, CONTROL_KEY,
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

// Opens the mux for the pictures of the detectors `ids` (a comma-separated list): resolves as soon as the head
// arrives (headMs says how long that took), and keeps collecting what comes.
async function openPicture(ids) {
  const started = Date.now();
  const v = await muxViewer.view(PORT, `?dets=${ids}`, { 'X-Control-Key': CONTROL_KEY });
  v.headMs = Date.now() - started;
  return v;
}
const hasPicture = (v, id, jpeg) => muxViewer.detFrames(v, id).some((m) => muxViewer.sameBytes(m, jpeg));
const countInLog = (re) => (readLog().match(new RegExp(re.source, 'g')) || []).length;

// Ends a connection the way a power cut or a crashed router does: with a TCP RST, not a FIN. Node 16.17+
// has socket.resetAndDestroy(), but this has to run on older Node too, so it uses what works everywhere:
// a socket closed while it still holds UNREAD incoming data makes the kernel send an RST. The socket is
// paused before it connects so Node never reads the relay's answer (the 101) out of the kernel; the relay
// has written it by the time it logs the connection, which is what is waited for (not a fixed delay, so a
// slow machine cannot close the socket before the answer is there and turn the RST into a plain FIN).
async function resetLikeAPowerCut(id) {
  const s = fake.net.connect(PORT, '127.0.0.1');
  s.pause();
  s.on('error', () => { /* the reset may be reported here too */ });
  await new Promise((resolve, reject) => {
    s.on('connect', resolve);
    s.on('close', () => reject(new Error('the relay closed the connection')));
    setTimeout(() => reject(new Error('no connection to the relay')), 3000).unref();
  });
  s.write(`GET /detector/${id}/uplink HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: ${dl.PROTOCOL}\r\nX-Api-Key: ${KEY}\r\n\r\n`);
  const accepted = await waitFor(() => new RegExp(`${id}@127\\.0\\.0\\.1 \\[relay\\]: detector connected`).test(readLog()), 4000);
  if (!accepted) throw new Error('the relay never accepted the connection');
  await sleep(100);
  s.destroy();
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

    let v = await openPicture(ID);
    check('asking for the picture of a detector that never connected is answered at once with the mux, not a hang',
      v.status === 200 && v.headers['content-type'] === muxViewer.CONTENT_TYPE && v.headMs < 1500 && !!(await waitFor(() => v.messages.length > 0, 1500)) && v.messages[0].type === muxViewer.codec.TYPE_HEARTBEAT,
      `status ${v.status} after ${v.headMs} ms`);
    check('...and no picture comes', muxViewer.detFrames(v, ID).length === 0);
    check('...and the relay logs that somebody asked, saying that no detector has connected at all and what to check',
      !!(await waitFor(() => /WARN  e2e-detector-1@?\S* ?\[relay\]: the dashboard asked for the picture of detector 'e2e-detector-1' but there is none: no detector called 'e2e-detector-1' has connected to the relay since it started \(no detector has connected at all\)/.test(readLog()), 2000)) &&
      /DETECTOR_ID on the board equals the detector paired with the camera/.test(readLog()), readLog().slice(-600));
    v.close();
    v = await openPicture('bad%20id');
    check('an invalid detector id is a 400 that says why, nothing streamed', v.status === 400 && /invalid id/.test(v.text) && v.messages.length === 0, `${v.status} ${v.text}`);
    v.close();

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

    const early = await openPicture(ID);   // asks before the first picture: it must get that picture the moment it exists
    check('a viewer of its picture is still answered at once, with nothing to show yet',
      early.status === 200 && early.headMs < 1500 && muxViewer.detFrames(early, ID).length === 0, `${early.status} after ${early.headMs} ms`);
    check('...and the relay logs the reason: the detector has sent nothing yet',
      !!(await waitFor(() => /WARN  e2e-detector-1@127\.0\.0\.1 \[relay\]: the dashboard asked for the picture of detector 'e2e-detector-1' but there is none: detector 'e2e-detector-1' has no picture to show: the detector connected but has not sent anything yet/.test(readLog()), 2000)), readLog().slice(-600));
    const asked = countInLog(/there is none: detector 'e2e-detector-1' has no picture to show/);
    (await openPicture(ID)).close();
    await sleep(200);
    check('...but asking again in the same state is not logged again (once per 5 minutes per detector and state)',
      asked === 1 && countInLog(/there is none: detector 'e2e-detector-1' has no picture to show/) === 1, `logged ${countInLog(/there is none: detector 'e2e-detector-1' has no picture to show/)} times`);

    // ── 3. frames flow ──────────────────────────────────────────────────────────────────
    det.write(wire(status(), JPEG));
    beat = heartbeat(det, () => status());
    check('the relay logs the first picture', !!(await waitFor(() => /INFO  e2e-detector-1@127\.0\.0\.1 \[relay\]: detector is sending pictures \(the first: 10 bytes of JPEG\)/.test(readLog()), 2000)), readLog().slice(-500));
    r = await request('GET', '/detectors');
    d = r.json && r.json[ID];
    check('GET /detectors lists it as online with a picture and no message', !!d && d.online === true && d.hasPicture === true && d.state === 'online' && d.message === '' && d.ip === '127.0.0.1', JSON.stringify(d));
    check('its numbers and thresholds come back', !!d && d.report.scene.brightness === 130 && d.report.scene.motionAtLeast === 300 &&
      JSON.stringify(d.report.scene.area) === JSON.stringify({ x0: 10, y0: 20, x1: 60, y1: 90 }) &&
      d.report.person.score === 0.81 && d.report.gpio.high === true && d.report.gpio.pin === 13 && d.report.link.heap === 90000, JSON.stringify(d));
    check('the picture itself is not in the JSON', !!d && d.report.jpeg === undefined && !JSON.stringify(d).includes('/9j') && !JSON.stringify(d).includes('/+A'));
    r = await request('GET', '/status');
    check('a detector is NOT listed as a camera in /status', r.status === 200 && r.json[ID] === undefined);
    r = await request('POST', '/alarm/all', { headers: { 'X-Api-Key': KEY, 'X-Control-Key': '' } });
    check('"alarm all" does not touch the detector', r.status === 200 && !JSON.stringify(r.json).includes(ID), JSON.stringify(r.json));

    check('the viewer that asked BEFORE the first picture gets it the moment it arrives', !!(await waitFor(() => hasPicture(early, ID, JPEG), 2000)));
    early.close();
    const stream = await openPicture(ID);
    check('the mux head arrives at once', stream.status === 200 && stream.headers['content-type'] === muxViewer.CONTENT_TYPE && stream.headMs < 1500, `${stream.status} ${stream.headMs} ms`);
    check('it starts with the latest picture', !!(await waitFor(() => hasPicture(stream, ID, JPEG), 2000)));
    det.write(wire(status({ scene: { state: 'still', brightness: 131, motion: 2, darkBelow: 40, motionAtLeast: 300, holdS: 10 } }), JPEG2));
    check('...and every picture pushed afterwards follows, byte for byte', !!(await waitFor(() => hasPicture(stream, ID, JPEG2), 2000)));
    check('...each a whole picture tagged with the detector (det:<id>), and nothing else but heartbeats',
      stream.messages.every((m) => m.type === muxViewer.codec.TYPE_HEARTBEAT || (m.type === muxViewer.codec.TYPE_FRAME && m.source === `det:${ID}`)), JSON.stringify(stream.messages.map((m) => [m.type, m.source])));
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
    v = await openPicture('e2e-nopic');
    check('and a viewer of its picture is answered at once with nothing to show', v.status === 200 && v.headMs < 1500 && muxViewer.detFrames(v, 'e2e-nopic').length === 0, `${v.status} after ${v.headMs} ms`);
    check('...the relay log carrying that same reason',
      !!(await waitFor(() => /WARN  e2e-nopic@127\.0\.0\.1 \[relay\]: the dashboard asked for the picture of detector 'e2e-nopic' but there is none: detector 'e2e-nopic' has no picture to show: the numbers arrive but there is no picture: the board reports 10 failed JPEG encodings/.test(readLog()), 2000)), readLog().slice(-600));
    v.close();

    // ── 7. a detector id that is NOT the one the dashboard asks for (the classic pairing mistake) ──
    v = await openPicture('detector-1');
    check('asking for an id that does not exist is answered at once too', v.status === 200 && v.headMs < 1500, `${v.status} after ${v.headMs} ms`);
    check('...and the relay log lists the detectors that DO exist',
      !!(await waitFor(() => /the dashboard asked for the picture of detector 'detector-1' but there is none: no detector called 'detector-1' has connected to the relay since it started \(detectors seen: e2e-detector-1, e2e-nopic\)/.test(readLog()), 2000)), readLog().slice(-600));
    v.close();
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
    v = await openPicture(ID);
    check('and a viewer of its picture is still answered at once', v.status === 200 && v.headMs < 1500, `${v.status} after ${v.headMs} ms`);
    v.close();

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
    await resetLikeAPowerCut('e2e-reset');
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
