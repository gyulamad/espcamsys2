#!/usr/bin/env node
'use strict';

// test_ai_alarm_e2e.js — end-to-end check of the AI-alarm command channel
// (plans/AI_ALARM_IMPLEMENTATION_PLAN.md §7 step 1), against a REAL
// `server.js` process and a REAL TCP socket — not the pure functions
// tests/node/test_protocol.js already covers in isolation. Deliberately
// doesn't `require()` anything from lib/ or server.js: it behaves like an
// independent camera would, so it actually catches wiring mistakes a unit
// test can't (wrong bytes on the wire, the two channels colliding, the
// relay not restarting cleanly, etc).
//
// No test framework or third-party dependency — just core `net`/`child_
// process`/`fs`, same philosophy as the rest of this repo's tests (see
// run_tests.sh). Safe to run repeatedly and on a machine with no config.js
// yet (a temporary one is created and removed again) or with a real one
// already in place (left untouched — every value this test needs is
// overridden via env vars when spawning the relay, so it never depends on
// or interferes with whatever's actually in config.js, and it always runs
// on its own ports, never the real 8080/8081).
//
// Usage:
//   node tests/e2e/test_ai_alarm_e2e.js
//   E2E_PORT=19090 E2E_PUSH_PORT=19091 node tests/e2e/test_ai_alarm_e2e.js   (if the defaults collide with something already running)
//
// Exit code: 0 if every check passed, 1 otherwise (same convention as
// every other suite run_tests.sh runs).

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');

const TEST_PORT = Number(process.env.E2E_PORT || 19090);
const TEST_PUSH_PORT = Number(process.env.E2E_PUSH_PORT || 19091);
const TEST_CAM_KEY = 'e2e-test-key';
const TEST_CAM_ID = 'e2e-test-cam';

const READY_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 10000;

const CONTROL_BYTE_PAUSE = 0x00;
const CONTROL_BYTE_RESUME = 0x01;
const COMMAND_FRAME_TAG = 0x02;

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

function summarize() {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

// `server.js` does `require('./config')` unconditionally, so it needs
// *some* config.js to exist to even start. If the repo doesn't have one
// yet (fresh checkout, CI), write a throwaway one just so the relay can
// boot, and remove it again afterward. If one already exists (a real
// deployment), it's left completely alone — this test overrides every
// value it actually needs via env vars instead.
let createdTempConfig = false;
function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.writeFileSync(
    CONFIG_PATH,
    "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n"
  );
  createdTempConfig = true;
  console.log('(no config.js found — wrote a temporary throwaway one for this test run)');
}
function cleanupTempConfig() {
  if (createdTempConfig) {
    try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* already gone, fine */ }
  }
}

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(TEST_PORT),
        PUSH_PORT: String(TEST_PUSH_PORT),
        CAM_KEY: TEST_CAM_KEY,
      }),
    });

    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(`raw push) listening on :${TEST_PUSH_PORT}`)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    child.on('exit', (code) => {
      // Only a failure if this fires before we ever resolved (i.e. it
      // crashed on startup instead of coming up) — a normal shutdown
      // later, once we've already resolved, is expected and fine.
      reject(new Error(`relay exited early (code ${code}) before it reported ready:\n${output}`));
    });

    const timer = setTimeout(() => {
      reject(new Error(`relay didn't report ready within ${READY_TIMEOUT_MS}ms. Output so far:\n${output}`));
    }, READY_TIMEOUT_MS);
  });
}

// Talks to the push socket exactly like a real camera's first few moments
// would: connect, authenticate, then collect + decode whatever the relay
// sends back, the same tag-based framing drainDownstream() (logic.h)
// implements on the device side.
function talkToRelay() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TEST_PUSH_PORT, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const controlBytes = [];
    const commandPayloads = [];
    let connectionDropped = false;

    socket.on('connect', () => {
      socket.write(`${TEST_CAM_ID}\t${TEST_CAM_KEY}\n`);
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 1) break;
        const tag = buf[0];
        if (tag === CONTROL_BYTE_PAUSE || tag === CONTROL_BYTE_RESUME) {
          controlBytes.push(tag);
          buf = buf.slice(1);
          continue;
        }
        if (tag === COMMAND_FRAME_TAG) {
          if (buf.length < 3) break;
          const len = buf.readUInt16BE(1);
          if (buf.length < 3 + len) break;
          commandPayloads.push(buf.slice(3, 3 + len).toString('utf8'));
          buf = buf.slice(3 + len);
          continue;
        }
        buf = buf.slice(1); // unrecognized — skip defensively, same as the device does
      }
    });

    socket.on('close', () => { connectionDropped = true; });
    socket.on('error', (err) => reject(err));

    // Give the relay's on-auth sendControlByte()/sendAiAlarmCommand() a
    // moment to arrive, then push one fake length-prefixed frame — same
    // shape a real JPEG push uses — to confirm the new relay->device
    // traffic hasn't broken parsing of the pre-existing device->relay
    // frame direction on the same socket.
    setTimeout(() => {
      const fakeJpeg = Buffer.from('not-a-real-jpeg-but-same-shape');
      const lenPrefix = Buffer.alloc(4);
      lenPrefix.writeUInt32BE(fakeJpeg.length, 0);
      socket.write(Buffer.concat([lenPrefix, fakeJpeg]));

      setTimeout(() => {
        socket.end();
        resolve({ controlBytes, commandPayloads, connectionDropped });
      }, 300);
    }, 500);
  });
}

async function main() {
  const overallTimer = setTimeout(() => {
    console.error('[FAIL] overall test timed out');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref ? overallTimer.unref() : null;

  ensureConfigExists();
  let relay;
  try {
    relay = await startRelay();
  } catch (err) {
    check('relay starts up and reports ready', false, err.message);
    summarize();
    cleanupTempConfig();
    return;
  }
  check('relay starts up and reports ready', true);

  try {
    const { controlBytes, commandPayloads, connectionDropped } = await talkToRelay();

    check(
      'sends the existing control byte on connect (0x01 = resume, fresh camera defaults enabled)',
      controlBytes.length >= 1 && controlBytes[0] === CONTROL_BYTE_RESUME,
      `got control bytes: ${JSON.stringify(controlBytes)}`
    );

    check(
      'sends exactly one AI-alarm command frame on connect',
      commandPayloads.length === 1,
      `got ${commandPayloads.length} command frame(s): ${JSON.stringify(commandPayloads)}`
    );

    if (commandPayloads.length >= 1) {
      let parsed = null;
      let parseError = null;
      try { parsed = JSON.parse(commandPayloads[0]); } catch (e) { parseError = e.message; }

      check('command frame payload is valid JSON', parsed !== null, parseError);

      if (parsed !== null) {
        // Shape/type checks only — not the exact current no-op values,
        // since step 2+ of the plan makes these genuinely dynamic. If you
        // need to confirm the literal current no-op values too, they're
        // printed below for a human to eyeball.
        check(
          'command frame has a boolean ai_enabled field',
          typeof parsed.ai_enabled === 'boolean',
          `ai_enabled was: ${JSON.stringify(parsed.ai_enabled)}`
        );
        check(
          'command frame has a numeric live_peek_until_epoch field',
          typeof parsed.live_peek_until_epoch === 'number',
          `live_peek_until_epoch was: ${JSON.stringify(parsed.live_peek_until_epoch)}`
        );
        console.log(`  (received command payload: ${commandPayloads[0]})`);
      }
    }

    check(
      'push socket stays open after a normal frame is sent (new command channel did not break frame parsing)',
      !connectionDropped,
      'the relay closed the connection — it should not have for a well-formed frame'
    );
  } catch (err) {
    check('talked to the relay over its push socket', false, err.message);
  } finally {
    relay.kill('SIGTERM');
    setTimeout(() => { try { relay.kill('SIGKILL'); } catch (e) { /* already dead */ } }, 1000).unref();
    clearTimeout(overallTimer);
    cleanupTempConfig();
    summarize();
  }
}

main();
