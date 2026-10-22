#!/usr/bin/env node
'use strict';
// test_detector_firmware_e2e.js — the person detector's REAL uplink code against the REAL relay.
//
// The firmware's connection logic (Arduino/ESP32_CAM_TFLite_Person/report_logic.h, UplinkSession) is
// compiled into a desktop program (tests/cpp/uplink_client_tool.cpp, as C++11 like the board's
// toolchain) that talks to a real server.js over a real TCP socket. The unit tests prove the state
// machine against fakes, and test_detector_e2e.js proves the relay against hand-built messages; this
// proves the two meet: that what the firmware WRITES is what the relay READS (the HTTP Upgrade
// handshake, the length-prefixed frames, the JSON numbers, a real JPEG passing through untouched), and
// that for every answer the relay can give — or fail to give — the board logs a line that says what is
// wrong and what to do. Those lines are what an installer reads when a detector "does not show up".
//
// Needs g++ (like the rest of the C++ tests); skips (exit 0) without it. Own ports, throwaway files.
//   node tests/e2e/test_detector_firmware_e2e.js

const fs = require('fs');
const net = require('net');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const RELAY_DIR = path.join(ROOT, 'nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const TOOL_SRC = path.join(ROOT, 'tests/cpp/uplink_client_tool.cpp');
const JPEG_HEADER = path.join(ROOT, 'tests/cpp/uplink_test_jpeg.h');
const PORT = Number(process.env.E2E_FWDET_PORT || 19330);
const PUSH_PORT = Number(process.env.E2E_FWDET_PUSH_PORT || 19331);
const STUB_BASE = Number(process.env.E2E_FWDET_STUB_BASE || 19340);
const KEY = 'e2e-fw-key';

let pass = 0, fail = 0, finished = false;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

// The JPEG the tool sends, read back out of the header that embeds it.
function embeddedJpeg() {
  const text = fs.readFileSync(JPEG_HEADER, 'utf8');
  const bytes = [...text.matchAll(/0x([0-9a-f]{2})/g)].map((m) => parseInt(m[1], 16));
  return Buffer.from(bytes);
}

function getJson(p, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }); } catch (e) { resolve({ status: res.statusCode, json: null, text: out }); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// Collects the MJPEG stream for `ms` and returns the pictures (Buffers) it carried.
function collectPictures(id, ms) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/detector/${id}/stream`, (res) => {
      res.on('data', (c) => chunks.push(c));
      setTimeout(() => {
        req.destroy();
        const body = Buffer.concat(chunks);
        const pics = [];
        let pos = 0;
        for (;;) {
          const h = body.indexOf('Content-Length: ', pos, 'latin1');
          if (h < 0) break;
          const eol = body.indexOf('\r\n\r\n', h, 'latin1');
          if (eol < 0) break;
          const len = Number(body.toString('latin1', h + 16, body.indexOf('\r\n', h, 'latin1')));
          if (eol + 4 + len > body.length) break;
          pics.push(body.slice(eol + 4, eol + 4 + len));
          pos = eol + 4 + len;
        }
        resolve({ status: res.statusCode, pictures: pics });
      }, ms);
    });
    req.on('error', () => resolve({ status: 0, pictures: [] }));
  });
}

let relayLogFile = null;
const readRelayLog = () => { try { return fs.readFileSync(relayLogFile, 'utf8'); } catch (e) { return ''; } };

function startRelay(tmp) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY,
        SETTINGS_FILE: path.join(tmp, 'settings.json'), LOG_FILE: relayLogFile, SWITCH_FILE: path.join(tmp, 'switch.json'),
        DETECTOR_NO_PICTURE_WARN_MS: '800',
      }),
    });
    let out = '';
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready:\n' + out)); } }, 6000);
    const on = (c) => { out += c; if (!done && out.includes(`raw push) listening on :${PUSH_PORT}`)) { done = true; clearTimeout(t); resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${out}`)); } });
  });
}

// Runs the desktop tool. `.out` fills as it prints; `.done` resolves when it has exited.
function runTool(bin, args) {
  const child = spawn(bin, args.map(String));
  const t = { out: '', child, done: null };
  child.stdout.on('data', (c) => { t.out += c; });
  child.stderr.on('data', (c) => { t.out += c; });
  t.done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.has = (re) => re.test(t.out);
  t.stats = () => { const m = /STATS streaming=(\d) attempts=(\d+) frames=(\d+) jpegFails=(\d+) reconnects=(\d+)/.exec(t.out); return m ? { streaming: m[1] === '1', attempts: +m[2], frames: +m[3], jpegFails: +m[4], reconnects: +m[5] } : null; };
  return t;
}

// A server that is NOT the relay, for the answers a relay can fail to give.
function stub(port, onConnection) {
  return new Promise((resolve) => {
    const s = net.createServer(onConnection);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function main() {
  if (spawnSync('g++', ['--version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: g++ is not installed'); finished = true; return; }
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) { check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fwdet-'));
  relayLogFile = path.join(tmp, 'relay.log');
  const bin = path.join(tmp, 'uplink_client_tool');
  const build = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-pedantic', '-o', bin, TOOL_SRC], { encoding: 'utf8' });
  check('the firmware\'s uplink code compiles as C++11 (the ESP32 toolchain\'s dialect) into the desktop tool', build.status === 0, build.stderr);
  if (build.status !== 0) return;

  let createdConfig = false;
  if (!fs.existsSync(CONFIG_PATH)) { fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n"); createdConfig = true; }

  let relay = null;
  const stubs = [];
  const tools = [];
  try {
    const expectedJpeg = embeddedJpeg();
    check('the embedded test picture is a real JPEG', expectedJpeg.length > 500 && expectedJpeg[0] === 0xff && expectedJpeg[1] === 0xd8 && expectedJpeg[expectedJpeg.length - 1] === 0xd9);

    // ═══ Phase 1: one relay, several boards at once ═══════════════════════════════════════════
    relay = await startRelay(tmp);

    // Things that are NOT the relay, each on its own port: what the board sees when SERVER_HOST:HTTP_PORT is wrong.
    stubs.push(await stub(STUB_BASE, (s) => { s.on('error', () => {}); s.on('data', () => s.destroy()); }));      // closes without a word: a relay that predates the uplink
    stubs.push(await stub(STUB_BASE + 1, (s) => { s.on('error', () => {}); s.on('data', () => { const b = '<!DOCTYPE html><pre>Cannot GET /detector/x/uplink</pre>'; s.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: ${b.length}\r\nConnection: close\r\n\r\n${b}`); }); })); // an HTML 404 (a proxy that dropped the Upgrade headers)
    stubs.push(await stub(STUB_BASE + 2, (s) => { s.on('error', () => {}); s.write('SSH-2.0-OpenSSH_9.2p1 Debian\r\n\r\n'); s.on('data', () => {}); }));       // another service entirely
    stubs.push(await stub(STUB_BASE + 3, (s) => { s.on('error', () => {}); s.on('data', () => {}); }));                                                              // accepts and never answers

    const good = runTool(bin, ['127.0.0.1', PORT, 'fw-good', KEY, 7, '--fps', 10]);
    const wrongKey = runTool(bin, ['127.0.0.1', PORT, 'fw-wrongkey', 'not-the-key', 4]);
    const noJpeg = runTool(bin, ['127.0.0.1', PORT, 'fw-nopic', KEY, 5, '--no-jpeg']);
    const oldRelay = runTool(bin, ['127.0.0.1', STUB_BASE, 'fw-old', KEY, 3]);
    const html404 = runTool(bin, ['127.0.0.1', STUB_BASE + 1, 'fw-404', KEY, 3]);
    const notHttp = runTool(bin, ['127.0.0.1', STUB_BASE + 2, 'fw-ssh', KEY, 3]);
    const silent = runTool(bin, ['127.0.0.1', STUB_BASE + 3, 'fw-silent', KEY, 7]);
    tools.push(good, wrongKey, noJpeg, oldRelay, html404, notHttp, silent);

    // ── the good board ──
    const online = await waitFor(async () => { const d = (await getJson('/detectors')).json['fw-good']; return d && d.online && d.hasPicture ? d : null; }, 5000);
    check('the firmware\'s uplink is accepted by the relay and the detector comes online with a picture', !!online, JSON.stringify((await getJson('/detectors')).json));
    const d1 = (await getJson('/detectors')).json['fw-good'];
    await sleep(400);
    const d2 = (await getJson('/detectors')).json['fw-good'];
    check('the numbers the firmware builds are the numbers the relay shows (readings, thresholds, pin, board)',
      !!d1 && d1.report.fw === 'desktop-tool' && d1.report.ip === '10.1.2.3' && d1.report.rssi === -61 && d1.report.gpio.pin === 13 &&
      d1.report.scene.darkBelow === 40 && d1.report.scene.motionAtLeast === 300 && d1.report.scene.holdS === 10 && d1.report.scene.state === 'active' &&
      d1.report.person.detectAt === 0.6 && d1.report.person.clearAt === 0.5 && d1.report.link.heap === 77777, JSON.stringify(d1 && d1.report));
    check('the relay sees the board\'s address as the connection\'s (not the one the board claims)', !!d1 && d1.ip === '127.0.0.1' && d1.connected === true);
    check('they are live: uptime and the frame counter move between two looks', !!d1 && !!d2 && d2.report.uptimeMs > d1.report.uptimeMs && d2.report.link.frames > d1.report.link.frames, `${d1 && d1.report.link.frames} -> ${d2 && d2.report.link.frames}`);
    check('the brightness / motion / score vary frame to frame (a synthetic loop, so tests can tell frames apart)', !!d1 && !!d2 && (d1.report.scene.brightness !== d2.report.scene.brightness || d1.report.scene.motion !== d2.report.scene.motion));

    const stream = await collectPictures('fw-good', 1500);
    check('the MJPEG stream carries pictures at about the rate the firmware was told (10 per second)', stream.status === 200 && stream.pictures.length >= 6 && stream.pictures.length <= 20, `${stream.status}, ${stream.pictures.length} pictures`);
    check('every picture is the firmware\'s JPEG, byte for byte', stream.pictures.length > 0 && stream.pictures.every((p) => Buffer.compare(p, expectedJpeg) === 0), `${stream.pictures.length} pictures, first ${stream.pictures[0] && stream.pictures[0].length} bytes`);

    // ── the board with the wrong key ──
    await wrongKey.done;
    check('wrong key: the board logs the relay\'s refusal, with the cause and the fix (read from the relay\'s real JSON)',
      wrongKey.has(/LOG WARN the relay at 127\.0\.0\.1:19330 refused the uplink \(HTTP 401\): wrong key: API_KEY on the board must equal camKey in the relay's config\.js — retrying in 2 s/), wrongKey.out);
    check('...tries again with growing delays, never giving up', (wrongKey.stats() || {}).attempts >= 2 && wrongKey.has(/retrying in 4 s/), wrongKey.out);
    check('...and never logs the key', !wrongKey.has(/not-the-key/));
    const all = (await getJson('/detectors')).json;
    check('...and the relay knows nothing of it', all['fw-wrongkey'] === undefined);
    check('...except in its log, which says who was refused and why', !!(await waitFor(() => /WARN  fw-wrongkey \[relay\]: refused a detector uplink request from 127\.0\.0\.1 for "\/detector\/fw-wrongkey\/uplink": HTTP 401 — wrong key/.test(readRelayLog()), 2000)), readRelayLog().slice(-500));

    // ── the board whose JPEG encoder fails ──
    await noJpeg.done;
    check('JPEG failure: the board logs it and keeps sending the numbers', noJpeg.has(/LOG WARN could not encode the 96x96 frame as JPEG — sending the readings without a picture/) && (noJpeg.stats() || {}).jpegFails > 5 && (noJpeg.stats() || {}).streaming, noJpeg.out.slice(0, 600));
    // (read the relay's view while the board is still connected: it has just exited, so ask it quickly — the view stays for a few seconds)
    const np = (await getJson('/detectors')).json['fw-nopic'];
    check('JPEG failure: the relay lists it as "no-picture" and says how many encodings failed', !!np && np.state === 'no-picture' && np.online === true && /failed JPEG encodings/.test(np.message), JSON.stringify(np));
    const npStream = await getJson('/detector/fw-nopic/stream');
    check('...and the picture request is a quick 503 with that reason, not a hang', npStream.status === 503 && /failed JPEG encodings/.test(npStream.json.error), JSON.stringify(npStream));
    check('...and the relay\'s log warns that the detector sends numbers but no picture', !!(await waitFor(() => /WARN  fw-nopic@127\.0\.0\.1 \[relay\]: the detector has been connected for \d+s and reports its numbers, but has sent no picture \(it reports \d+ failed JPEG encodings/.test(readRelayLog()), 2000)), readRelayLog().slice(-700));

    // ── the boards that reach something that is not the relay ──
    await oldRelay.done;
    check('a relay that hangs up on the upgrade (one that predates it): the board says so and what to update',
      oldRelay.has(/LOG WARN the relay at 127\.0\.0\.1:19340 hung up without answering the uplink request — a relay older than this firmware does that: update nodejs\/camera-relay — retrying in 2 s/), oldRelay.out);
    await html404.done;
    check('an HTML 404 (a proxy that dropped the Upgrade headers, or an old relay): the board names the likely cause',
      html404.has(/LOG WARN the relay at 127\.0\.0\.1:19341 answered HTTP 404 \(Not Found\) — probably a relay older than this firmware: update and restart nodejs\/camera-relay/), html404.out);
    await notHttp.done;
    check('another service on the port (not HTTP): the board quotes what it got and suspects the port',
      notHttp.has(/LOG WARN the relay at 127\.0\.0\.1:19342 did not answer like a web server \(not HTTP: 'SSH-2\.0-OpenSSH_9\.2p1 De'\) — is HTTP_PORT really the relay's HTTP port\?/), notHttp.out);
    await silent.done;
    check('a server that accepts and never answers: the board gives up after 5 s and says what that usually means',
      silent.has(/LOG WARN the relay at 127\.0\.0\.1:19343 did not answer the uplink request within 5 s — wrong HTTP_PORT, or a relay older than this firmware \(update nodejs\/camera-relay\) — retrying in 2 s/), silent.out);

    // ── back to the good board, which has finished its run ──
    await good.done;
    const gs = good.stats();
    check('the good board\'s own log: link up, first picture, and the relay told the log it is reachable',
      good.has(/LOG INFO uplink to the relay at 127\.0\.0\.1:19330 is up \(attempt 1\): sending 96x96 pictures and readings as 'fw-good', up to 10 pictures\/s/) &&
      good.has(new RegExp(`LOG INFO first picture sent to the relay \\(${expectedJpeg.length} bytes of JPEG\\)`)) && (good.out.match(/REACHABLE/g) || []).length === 1, good.out.slice(0, 700));
    check('...and it sent roughly 10 pictures a second for 7 s without failing once', gs && gs.frames >= 30 && gs.frames <= 80 && gs.jpegFails === 0 && gs.reconnects === 0, JSON.stringify(gs));
    check('the relay logged the detector connecting and the first picture', /INFO  fw-good@127\.0\.0\.1 \[relay\]: detector connected/.test(readRelayLog()) && new RegExp(`INFO  fw-good@127\\.0\\.0\\.1 \\[relay\\]: detector is sending pictures \\(the first: ${expectedJpeg.length} bytes of JPEG\\)`).test(readRelayLog()), readRelayLog().slice(-800));
    check('...and, when the board exited, that it closed the connection (a clean close is noticed at once)',
      !!(await waitFor(() => /INFO  fw-good@127\.0\.0\.1 \[relay\]: detector disconnected after \d+s, \d+ pictures received \(the board closed the connection\)/.test(readRelayLog()), 3000)), readRelayLog().slice(-700));

    // ═══ Phase 2: the relay restarts while the board runs (every deploy ends like this) ════════════════
    const survivor = runTool(bin, ['127.0.0.1', PORT, 'fw-survivor', KEY, 16, '--fps', 10]);
    tools.push(survivor);
    await waitFor(async () => { const d = (await getJson('/detectors')).json['fw-survivor']; return d && d.online && d.hasPicture; }, 5000);
    await sleep(800);
    relay.kill('SIGTERM');
    await waitFor(() => relay.exitCode !== null || relay.signalCode !== null, 4000);
    await sleep(500);
    relay = await startRelay(tmp);
    const back = await waitFor(async () => { try { const d = (await getJson('/detectors')).json['fw-survivor']; return d && d.online && d.hasPicture ? d : null; } catch (e) { return null; } }, 12000);
    check('relay restarted under a running board: the board reconnects by itself and the picture is back', !!back, survivor.out.slice(0, 900));
    check('...its log says the link was lost, why, and that it reconnected',
      survivor.has(/LOG WARN lost the connection to the relay at 127\.0\.0\.1:19330 after \d+s \(the relay closed the connection\); it had carried \d+ pictures — reconnecting/) && survivor.has(/is up \(attempt \d+\)/) && (survivor.out.match(/REACHABLE/g) || []).length >= 2, survivor.out.slice(0, 900));
    check('...and the readings it sends afterwards report the lost connection', !!back && back.report.link.reconnects >= 1, JSON.stringify(back && back.report.link));
    await survivor.done;
    check('...it ends up streaming, with the reconnect counted', (survivor.stats() || {}).streaming === true && (survivor.stats() || {}).reconnects >= 1, JSON.stringify(survivor.stats()));
    relay.kill('SIGTERM');
    await waitFor(() => relay.exitCode !== null || relay.signalCode !== null, 4000);

    // ═══ Phase 3: the board is up BEFORE the relay (a slow Pi after a power cut) ═══════════════════════
    const early = runTool(bin, ['127.0.0.1', PORT, 'fw-early', KEY, 10, '--fps', 10]);
    tools.push(early);
    await sleep(3000);
    relay = await startRelay(tmp);
    await early.done;
    check('relay down when the board boots: it logs why it cannot connect and keeps trying with backoff',
      early.has(/LOG WARN could not reach the relay at 127\.0\.0\.1:19330: connect failed: Connection refused — retrying in 2 s/) && early.has(/retrying in 4 s/), early.out.slice(0, 600));
    check('...and connects as soon as the relay is there (within its next retry)', (early.stats() || {}).streaming === true && (early.stats() || {}).attempts >= 3 && (early.stats() || {}).frames > 10, JSON.stringify(early.stats()));
  } finally {
    tools.forEach((t) => { try { t.child.kill('SIGKILL'); } catch (e) { /* gone */ } });
    stubs.forEach((s) => { try { s.close(); } catch (e) { /* gone */ } });
    if (relay) relay.kill('SIGTERM');
    await sleep(200);
    if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    if (fail > 0) console.error('--- relay log ---\n' + readRelayLog().slice(-3000));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
