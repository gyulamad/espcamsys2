#!/usr/bin/env node
'use strict';
// test_dashboard_detector_e2e.js — the person-detector row of the dashboard, through a real PHP
// server (php -S) and the real relay (server.js), with a fake detector on the uplink:
//   * index.php shows the detector row (picture + value fields + the overlay that says WHY it is not
//     showing) ONLY for a camera that has a 'detector' in config.php
//   * detector-status.php returns the detector's numbers keyed by CAMERA id — and for a detector that
//     is not showing, a state and a reason in words
//   * detector-stream.php pipes the detector's MJPEG picture, and when there is none it answers AT ONCE
//     with why (it used to hang for 10 s and end in a bare 502 with nothing logged anywhere)
//   * the web server's error log gets a line for it (throttled), so it is explainable from there too
//   * both need the dashboard login
// Skips (exit 0) when php is missing. Own ports, temp copy of the dashboard, core modules only.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fake = require('./fake_detector');
const { JPEG, JPEG2, status, wire, heartbeat } = fake;

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PHP_PORT = Number(process.env.E2E_DDET_PORT || 19310);
const RELAY_PORT = Number(process.env.E2E_DDET_RELAY_PORT || 19311);
const PUSH_PORT = Number(process.env.E2E_DDET_PUSH_PORT || 19312);
const OLD_RELAY_PORT = Number(process.env.E2E_DDET_OLD_RELAY_PORT || 19313);
const PHP2_PORT = Number(process.env.E2E_DDET_PHP2_PORT || 19314);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const KEY = 'e2e-key';

let pass = 0, fail = 0, finished = false;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {   // the relay writes its log asynchronously
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await sleep(40);
  }
}

function get(port, p, { auth = true, until } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers = auth ? { Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64') } : {};
    const req = nodeHttp.get(`http://127.0.0.1:${port}${p}`, { headers }, (res) => {
      const chunks = [];
      const done = () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started });
      res.on('data', (c) => {
        chunks.push(c);
        if (until && until(Buffer.concat(chunks))) { req.destroy(); done(); }
      });
      res.on('end', done);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.setTimeout(15000, () => req.destroy(new Error('timeout ' + p)));
  });
}
const dash = (p, o) => get(PHP_PORT, p, o);

function writeDashboard(dir, relayPort) {
  fs.mkdirSync(dir);
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${relayPort}', 'cameras' => [` +
    `['id' => 'camA', 'name' => 'A', 'icon' => 'x', 'detector' => 'det-A'], ['id' => 'camB', 'name' => 'B', 'icon' => 'y'], ['id' => 'camC', 'name' => 'C', 'icon' => 'z', 'detector' => 'det-C']]];\n`);
}

async function waitUntilAnswers(url, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const up = await new Promise((r) => { const q = nodeHttp.get(url, () => r(true)); q.on('error', () => r(false)); });
    if (up) return;
    if (Date.now() - t0 > ms) throw new Error(url + ' not ready');
    await sleep(150);
  }
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed'); finished = true; return; }
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) { check('relay dependencies are installed', false, 'run "npm install" in nodejs/camera-relay'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ddet-'));
  const dashDir = path.join(tmp, 'dash');
  const dashDir2 = path.join(tmp, 'dash2');
  writeDashboard(dashDir, RELAY_PORT);
  writeDashboard(dashDir2, OLD_RELAY_PORT);

  let createdConfig = false;
  if (!fs.existsSync(CONFIG_PATH)) { fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n"); createdConfig = true; }

  const relayLog = path.join(tmp, 'r.log');
  const readRelayLog = () => { try { return fs.readFileSync(relayLog, 'utf8'); } catch (e) { return ''; } };
  const relay = spawn('node', ['server.js'], { cwd: RELAY_DIR, env: Object.assign({}, process.env, { PORT: String(RELAY_PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SETTINGS_FILE: path.join(tmp, 's.json'), LOG_FILE: relayLog, SWITCH_FILE: path.join(tmp, 'sw.json'), DETECTOR_NO_PICTURE_WARN_MS: '800' }), stdio: 'ignore' });

  // The web server's error log: php -S writes error_log() lines to its stderr. The throttle's marker files
  // go to the temp directory, so each run gets its own (otherwise a rerun within 5 minutes would stay silent).
  let phpErr = '';
  const phpEnv = Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4', TMPDIR: tmp });
  const php = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dashDir], { stdio: ['ignore', 'ignore', 'pipe'], env: phpEnv });
  php.stderr.on('data', (c) => { phpErr += c; });
  const php2 = spawn('php', ['-S', `127.0.0.1:${PHP2_PORT}`, '-t', dashDir2], { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, phpEnv, { PHP_CLI_SERVER_WORKERS: '2' }) });
  let php2Err = '';
  php2.stderr.on('data', (c) => { php2Err += c; });
  // A relay from before the detector uplink existed: it answers every address with an HTML 404.
  const oldRelay = nodeHttp.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(`<!DOCTYPE html><pre>Cannot GET ${req.url}</pre>`); }).listen(OLD_RELAY_PORT, '127.0.0.1');

  const socks = [];
  try {
    await waitUntilAnswers(`http://127.0.0.1:${RELAY_PORT}/detectors`);
    await waitUntilAnswers(`http://127.0.0.1:${PHP_PORT}/`);
    await waitUntilAnswers(`http://127.0.0.1:${PHP2_PORT}/`);

    check('detector-status.php needs the dashboard login', (await dash('/detector-status.php', { auth: false })).status === 401);
    check('detector-stream.php needs the dashboard login', (await dash('/detector-stream.php?cam=camA', { auth: false })).status === 401);

    const page = (await dash('/index.php')).text;
    check('camera with a detector gets the detector row', page.includes('id="det-camA"') && page.includes('detector-stream.php?cam=camA'));
    check('the row has the value fields (brightness, motion, human, alarm pin, board info)',
      ['detbright-camA', 'detmotion-camA', 'detperson-camA', 'detpin-camA', 'detgate-camA', 'detinfo-camA'].every((i) => page.includes(`id="${i}"`)));
    check('...and the overlay that says why the picture is not showing', page.includes('id="dettitle-camA"') && page.includes('id="detwhy-camA"'));
    check('a camera without detector gets no row', !page.includes('id="det-camB"') && !page.includes('detector-stream.php?cam=camB'));

    // ── 1. what the dashboard saw in the field: no detector has ever connected ──────────────────
    let r = await dash('/detector-stream.php?cam=camA');
    check('the picture of a detector that never connected is a quick 404, not a 10 s hang ending in a bare 502',
      r.status === 404 && r.ms < 3000, `${r.status} after ${r.ms} ms`);
    check('...with a text saying why, naming the detector', /^text\/plain/.test(r.type || '') && r.text === "The person detector of A: no detector called 'det-A' has connected to the relay since it started (no detector has connected at all)", r.text);
    check('...and the web server\'s error log has a line for it',
      /camdash: detector-stream\.php: HTTP 404: The person detector of A: no detector called 'det-A' has connected/.test(phpErr), phpErr.slice(-500));
    check('...and the relay\'s log says the dashboard asked',
      await waitFor(() => /the dashboard asked for the picture of detector 'det-A' but there is none/.test(readRelayLog())), readRelayLog().slice(-400));
    const logLines = (phpErr.match(/camdash: detector-stream\.php/g) || []).length;
    await dash('/detector-stream.php?cam=camA');
    await dash('/detector-stream.php?cam=camA');
    check('asking again and again does not flood the error log (once per 5 minutes per detector)', (phpErr.match(/camdash: detector-stream\.php/g) || []).length === logLines, phpErr.slice(-600));

    r = await dash('/detector-status.php');
    let j = JSON.parse(r.text);
    check('detector-status.php: paired cameras are "never" with numbers absent; unpaired camera absent',
      r.status === 200 && Object.keys(j).sort().join() === 'camA,camC' && j.camA.state === 'never' && j.camA.online === false && j.camA.report === null && j.camA.detector === 'det-A', r.text);
    check('...and say why, in words the dashboard prints on the picture', /has not heard from a detector called 'det-A'/.test(j.camA.message), j.camA.message);

    // ── 2. the classic mistake: the board's DETECTOR_ID differs from the one paired in config.php ──
    const typo = await fake.uplink(RELAY_PORT, 'det-a', { key: KEY });   // 'det-a' instead of 'det-A'
    socks.push(typo.socket);
    typo.socket.write(wire(status(), JPEG));
    const stopTypo = heartbeat(typo.socket, () => status());
    await sleep(300);
    j = JSON.parse((await dash('/detector-status.php')).text);
    check('a detector connecting under another id is called out as a likely typo', j.camA.state === 'never' && /does hear 'det-a', which no camera here is paired with/.test(j.camA.message) && /mistyped/.test(j.camA.message), j.camA.message);
    r = await dash('/detector-stream.php?cam=camA');
    check('...and the stream error lists the detectors the relay does see', r.status === 404 && /detectors seen: det-a/.test(r.text), r.text);
    stopTypo(); typo.socket.destroy();

    // ── 3. the detector connects as it should and pushes pictures ─────────────────────────────
    const up = await fake.uplink(RELAY_PORT, 'det-A', { key: KEY });
    check('the detector opens its uplink', up.status === 101);
    socks.push(up.socket);
    up.socket.write(wire(status({ scene: { state: 'active', brightness: 111, motion: 777, darkBelow: 40, motionAtLeast: 300, holdS: 10 }, person: { score: 0.9, detectAt: 0.6, clearAt: 0.5, detected: true } }), JPEG));
    const stopA = heartbeat(up.socket, () => status());
    await sleep(200);
    r = await dash('/detector-status.php');
    j = JSON.parse(r.text);
    check('detector-status.php shows its numbers under the CAMERA id', j.camA.state === 'online' && j.camA.online === true && j.camA.hasPicture === true && j.camA.message === '' &&
      j.camA.report.scene.brightness === 111 && j.camA.report.scene.motionAtLeast === 300 && j.camA.report.person.score === 0.9 && j.camA.report.gpio.high === true && j.camA.report.gpio.pin === 13, r.text);
    check('...with where the board is and how it is doing', j.camA.ip === '127.0.0.1' && j.camA.report.rssi === -55 && j.camA.report.link.heap === 90000 && j.camA.report.fw === 'e2e', JSON.stringify(j.camA));
    check('the other paired camera is still "never"', j.camC.state === 'never' && j.camC.online === false);

    const picture = dash('/detector-stream.php?cam=camA', { until: (b) => b.includes(JPEG) && b.includes(JPEG2) });
    await sleep(300);
    up.socket.write(wire(status(), JPEG2));
    r = await picture;
    check('detector-stream.php pipes the detector pictures as MJPEG, the latest first and every new one after it', r.status === 200 && /multipart\/x-mixed-replace/.test(r.type || '') && r.body.includes(JPEG) && r.body.includes(JPEG2), `${r.status} ${r.type}`);
    check('a camera without a detector gets 404 from detector-stream.php', (await dash('/detector-stream.php?cam=camB')).status === 404);
    check('an unknown camera gets 404 from detector-stream.php', (await dash('/detector-stream.php?cam=nope')).status === 404);

    // ── 4. numbers arrive but no picture ───────────────────────────────────────────────────────
    const nopic = await fake.uplink(RELAY_PORT, 'det-C', { key: KEY });
    socks.push(nopic.socket);
    const nopicStatus = () => status({ link: { frames: 30, jpegFails: 30, reconnects: 0, heap: 30000 } });
    nopic.socket.write(wire(nopicStatus(), null));
    const stopC = heartbeat(nopic.socket, nopicStatus);
    await sleep(300);
    j = JSON.parse((await dash('/detector-status.php')).text);
    check('numbers without a picture: state "no-picture", online, with the board\'s own count of failures', j.camC.state === 'no-picture' && j.camC.online === true && j.camC.hasPicture === false && /30 failed JPEG encodings/.test(j.camC.message), JSON.stringify(j.camC));
    r = await dash('/detector-stream.php?cam=camC');
    check('...and its picture request is a quick 503 with the same reason', r.status === 503 && r.ms < 3000 && /The person detector of C: .*30 failed JPEG encodings/.test(r.text), `${r.status} ${r.text}`);
    stopC(); nopic.socket.destroy();

    // ── 5. the board goes away ─────────────────────────────────────────────────────────────────
    stopA(); up.socket.destroy();
    await sleep(5600);
    j = JSON.parse((await dash('/detector-status.php')).text);
    check('after a few seconds of silence it is offline, saying for how long and how its connection ended', j.camA.state === 'offline' && j.camA.online === false && /last heard \d+ s ago; its connection ended \(the board closed the connection\)/.test(j.camA.message), j.camA.message);
    check('...and the numbers on the dashboard are still the last ones received, for the stale display', j.camA.report && j.camA.report.scene.brightness === 130);
    r = await dash('/detector-stream.php?cam=camA');
    check('...and its picture request is a quick 503 carrying that reason', r.status === 503 && r.ms < 3000 && /The person detector of A: detector 'det-A' has no picture to show: last heard/.test(r.text), `${r.status} ${r.text}`);

    // ── 6. the relay itself is down ─────────────────────────────────────────────────────────────
    relay.kill('SIGTERM');
    await sleep(500);
    r = await dash('/detector-status.php');
    check('relay down: detector-status.php is a 502 JSON that says so', r.status === 502 && /cannot reach the relay/.test(JSON.parse(r.text).error), `${r.status} ${r.text}`);
    check('...and the error log has the reason PHP got', /camdash: detector-status\.php: could not reach the relay for GET \/detectors \(.*refused/i.test(phpErr), phpErr.slice(-500));
    r = await dash('/detector-stream.php?cam=camA');
    check('relay down: detector-stream.php is a quick 502 with the reason', r.status === 502 && r.ms < 3000 && /^Could not reach the relay to get the picture of the person detector of A \(.*refused/i.test(r.text), `${r.status} ${r.text}`);

    // ── 7. a relay that is older than this dashboard ────────────────────────────────────────────
    r = await get(PHP2_PORT, '/detector-stream.php?cam=camA');
    check('an old relay (HTML 404): the stream request says the relay is probably too old', r.status === 502 && /HTTP 404 without a reason/.test(r.text) && /older than this dashboard/.test(r.text), `${r.status} ${r.text}`);
    r = await get(PHP2_PORT, '/detector-status.php');
    check('...and so does the status request', r.status === 502 && /may be older than this dashboard/.test(JSON.parse(r.text).error), `${r.status} ${r.text}`);
    check('...with a line in that web server\'s error log', /detector-status\.php: the relay answered GET \/detectors with HTTP 404 and something that is not JSON/.test(php2Err), php2Err.slice(-500));
  } finally {
    socks.forEach((s) => { try { s.destroy(); } catch (e) { /* gone */ } });
    relay.kill('SIGTERM'); php.kill('SIGTERM'); php2.kill('SIGTERM'); oldRelay.close();
    await sleep(200);
    if (createdConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    if (fail > 0) { console.error('--- php stderr ---\n' + phpErr.slice(-2500) + '\n--- relay log ---\n' + readRelayLog().slice(-2500)); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ }
  }
}

main().catch((e) => check('test ran without an exception', false, e.stack || String(e))).finally(() => {
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
