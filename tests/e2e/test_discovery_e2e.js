#!/usr/bin/env node
'use strict';
// test_discovery_e2e.js — end-to-end check that a camera can find the relay again by itself: a REAL
// `server.js` process answers on UDP, and the question is asked by the firmware's REAL search code
// (Arduino/*/relay_find_logic.h, compiled into a desktop program by tests/cpp/relay_find_tool.cpp), so the
// C++ and the JavaScript are proven to agree byte for byte over real sockets. Checks:
//   - the relay answers a valid probe with a MAC only the holder of camKey can make, and says so in its log
//   - anything else sent to the port (junk, a probe with a bad nonce, a probe that is too long) gets NO answer
//   - the firmware search finds the relay: from the stored address, and — with the broadcast cut off, as a NAT
//     router does — by sweeping the subnet when SERVER_HOST is a name that does not resolve
//   - the firmware search with the wrong key finds nothing (and so would never store the address)
//   - DISCOVERY_PORT=0 switches the responder off; a taken port does not stop the relay
//
// Own ports, throwaway log/settings files in a temp folder. Core modules + g++. Takes about 15 seconds.
//
// Usage:  node tests/e2e/test_discovery_e2e.js
//         E2E_DISC_PORT=19350 E2E_DISC_PUSH_PORT=19351 E2E_DISC_UDP=19352 node tests/e2e/test_discovery_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const RELAY_DIR = path.join(ROOT, 'nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const TOOL_SRC = path.join(ROOT, 'tests/cpp/relay_find_tool.cpp');
const discovery = require(path.join(RELAY_DIR, 'lib/discovery'));
const PORT = Number(process.env.E2E_DISC_PORT || 19350);
const PUSH_PORT = Number(process.env.E2E_DISC_PUSH_PORT || 19351);
const UDP_PORT = Number(process.env.E2E_DISC_UDP || 19352);
const KEY = 'e2e-discovery-cam-key';

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
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; setTimeout(() => resolve({ child, output: () => out }), 300); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 8s:\n${out}`)); } }, 8000).unref();
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

// Sends one datagram to the relay and returns the answer (or null if none comes within waitMs).
function ask(payload, waitMs = 400, port = UDP_PORT) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch (e) { /* closed */ } resolve(v); } };
    sock.on('message', (m) => finish(m));
    sock.on('error', () => finish(null));
    sock.send(payload, port, '127.0.0.1', (err) => { if (err) finish(null); });
    setTimeout(() => finish(null), waitMs);
  });
}

function runTool(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-disc-'));
  const logFile = path.join(tmp, 'camera.log');
  const baseEnv = { LOG_FILE: logFile, SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json'), DISCOVERY_PORT: String(UDP_PORT) };
  let relay = null;
  let blocker = null;
  try {
    // The firmware's search, compiled as C++11 like the board's toolchain.
    const bin = path.join(tmp, 'relay_find_tool');
    const cc = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-o', bin, TOOL_SRC], { encoding: 'utf8' });
    check('the firmware search compiles as C++11 for the desktop', cc.status === 0, cc.stderr);
    if (cc.status !== 0) return;

    relay = await startRelay(baseEnv);
    check('the relay says it listens for discovery on the UDP port', relay.output().includes(`(discovery) listening on UDP :${UDP_PORT}`), relay.output());

    // ── the relay's side, with raw datagrams ──
    const nonce = '00112233445566ff';
    const reply = await ask(Buffer.from('ESPCAM1?' + nonce));
    check('a valid probe is answered', reply !== null);
    check('the answer is the exact bytes the protocol defines', reply !== null && reply.equals(discovery.buildReply(nonce, KEY)), reply && reply.toString('latin1'));
    check('the answer verifies with the camera key, and only with it', reply !== null && discovery.verifyReply(reply, nonce, KEY) && !discovery.verifyReply(reply, nonce, 'some-other-key'));
    check('the camera key itself is not in the answer', reply !== null && !reply.toString('latin1').includes(KEY));

    const silent = [
      ['junk text', Buffer.from('hello')],
      ['an empty datagram', Buffer.alloc(0)],
      ['a probe with an upper-case nonce', Buffer.from('ESPCAM1?00112233445566FF')],
      ['a probe with a short nonce', Buffer.from('ESPCAM1?0011')],
      ['a probe with something after the nonce', Buffer.from('ESPCAM1?00112233445566ff\n')],
      ['an answer sent as if it were a probe', Buffer.from('ESPCAM1!00112233445566ff')],
      ['a big datagram', Buffer.alloc(1400, 0x41)],
    ];
    for (const [what, buf] of silent) {
      await sleep(120); // the relay limits answers per address; stay under it so only the datagram decides
      check(`${what}: no answer`, (await ask(buf, 250)) === null);
    }
    await sleep(120);
    check('the relay still answers after all that junk', (await ask(Buffer.from('ESPCAM1?' + nonce))) !== null);

    let log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('the relay log says a camera asked where the relay is', /asked where the relay is/.test(log), log.slice(-400));

    // ── the firmware's real search against the real relay ──
    let r = runTool(bin, ['127.0.0.9', KEY, String(UDP_PORT), '127.0.0.250']);
    check('the firmware search finds the relay from a stored address', r.status === 0 && /^FOUND ip=127\./.test(r.out), JSON.stringify(r));

    r = runTool(bin, ['raspberrypi.local', KEY, String(UDP_PORT), '127.0.0.250']);
    check('with a SERVER_HOST that does not resolve, the relay is still found', r.status === 0 && /^FOUND ip=/.test(r.out), JSON.stringify(r));

    // Behind a NAT router a broadcast goes nowhere: only the sweep of the subnet can find the relay.
    r = runTool(bin, ['raspberrypi.local', KEY, String(UDP_PORT), '127.0.0.250', 'nat']);
    check('behind a NAT router (no broadcast), the sweep of the board\'s subnet finds the relay', r.status === 0 && /^FOUND ip=127\./.test(r.out), JSON.stringify(r));
    r = runTool(bin, ['127.0.0.9', 'not-the-key', String(UDP_PORT), '127.0.0.250', 'nat']);
    check('...and with the wrong key even the sweep finds nothing', r.status === 3, JSON.stringify(r));

    r = runTool(bin, ['127.0.0.9', 'not-the-key', String(UDP_PORT), '127.0.0.250']);
    check('the firmware search with the wrong key finds nothing', r.status === 3 && r.out === 'NOT_FOUND', JSON.stringify(r));

    // ── off, and taken ──
    await stopRelay(relay);
    relay = await startRelay(Object.assign({}, baseEnv, { DISCOVERY_PORT: '0' }));
    check('DISCOVERY_PORT=0 switches the responder off (and says so)', /discovery\) is off/.test(relay.output()) && !/listening on UDP/.test(relay.output()), relay.output());
    check('...and nothing answers', (await ask(Buffer.from('ESPCAM1?' + nonce), 400)) === null);
    await stopRelay(relay);

    blocker = dgram.createSocket('udp4');
    await new Promise((res) => blocker.bind(UDP_PORT, '0.0.0.0', res));
    relay = await startRelay(baseEnv);
    await sleep(500);
    const httpUp = await new Promise((res) => {
      const s = net.connect(PORT, '127.0.0.1', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('a taken UDP port does not stop the relay (HTTP still up)', httpUp && relay.child.exitCode === null, relay.output());
    check('...and the relay says discovery stopped', /discovery responder stopped/.test(log) || /discovery responder stopped/.test(relay.output()), relay.output());
  } catch (err) {
    check('the test ran to the end', false, err && err.stack);
  } finally {
    if (blocker) try { blocker.close(); } catch (e) { /* closed */ }
    await stopRelay(relay);
    if (createdTempConfig) try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* busy */ }
  }
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main();
