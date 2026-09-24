#!/usr/bin/env node
'use strict';

// test_recording_prebuffer_e2e.js — end-to-end check of step 5's
// rolling pre-buffer (plans/AI_ALARM_IMPLEMENTATION_PLAN.md §5.3), against
// a REAL `server.js` process, a REAL TCP push socket, and REAL `ffmpeg`.
// Unlike tests/node/test_frameBuffer.js (the pure trim-logic in
// isolation), this proves the buffer is actually wired into
// startRecording() end to end: frames pushed *before* the /record/:id
// call show up in the final .mp4, not just frames pushed after it.
//
// Same philosophy as test_ai_alarm_e2e.js: no test framework/third-party
// dependency, its own isolated ports (override via E2E2_PORT/
// E2E2_PUSH_PORT if the defaults collide), never touches a real
// config.js. Requires `ffmpeg`/`ffprobe` on PATH (see INSTALL.md) — same
// hard requirement finalizeRecording() itself has; this test fails
// clearly rather than silently skipping if they're missing, same
// "untestable feature counts as a failure" philosophy run_tests.sh's own
// header states for g++/gdb/node/php.
//
// Usage:
//   node tests/e2e/test_recording_prebuffer_e2e.js

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const TEST_IMAGE_PATH = path.join(RELAY_DIR, 'testimage.jpg');

const TEST_PORT = Number(process.env.E2E2_PORT || 19092);
const TEST_PUSH_PORT = Number(process.env.E2E2_PUSH_PORT || 19093);
const TEST_CAM_KEY = 'e2e-prebuffer-test-key';
const TEST_CAM_ID = 'e2e-prebuffer-cam';
const PRE_BUFFER_SECONDS = 2; // deterministic value for this test run, via env override — see server.js

const READY_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 30000; // generous: real ffmpeg encode is part of this

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

function httpPost(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: TEST_PORT, path: urlPath, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* leave null */ }
          resolve({ statusCode: res.statusCode, body, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(condition, timeoutMs, stepMs = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (condition() || Date.now() - start >= timeoutMs) {
        resolve(condition());
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

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
        ROLLING_PRE_BUFFER_SECONDS: String(PRE_BUFFER_SECONDS), // deterministic, see server.js's env override
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
      reject(new Error(`relay exited early (code ${code}) before it reported ready:\n${output}`));
    });

    const timer = setTimeout(() => {
      reject(new Error(`relay didn't report ready within ${READY_TIMEOUT_MS}ms. Output so far:\n${output}`));
    }, READY_TIMEOUT_MS);
  });
}

function connectAsCamera() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TEST_PUSH_PORT, '127.0.0.1');
    socket.on('connect', () => {
      socket.write(`${TEST_CAM_ID}\t${TEST_CAM_KEY}\n`);
      // Ignore whatever the relay sends back (control byte / AI command
      // frame) — this test only cares about the frame-push direction and
      // the resulting recording, not the command channel (already covered
      // by test_ai_alarm_e2e.js).
      setTimeout(() => resolve(socket), 300);
    });
    socket.on('error', (err) => reject(err));
  });
}

function pushRealJpegFrame(socket, jpegBytes) {
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(jpegBytes.length, 0);
  socket.write(Buffer.concat([lenPrefix, jpegBytes]));
}

async function main() {
  const overallTimer = setTimeout(() => {
    console.error('[FAIL] overall test timed out');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref ? overallTimer.unref() : null;

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch (err) {
    check('ffmpeg/ffprobe available on PATH (see INSTALL.md)', false, err.message);
    summarizeAndExit();
    return;
  }
  check('ffmpeg/ffprobe available on PATH', true);

  const jpegBytes = fs.readFileSync(TEST_IMAGE_PATH);

  ensureConfigExists();
  let relay;
  try {
    relay = await startRelay();
  } catch (err) {
    check('relay starts up and reports ready', false, err.message);
    summarizeAndExit();
    return;
  }
  check('relay starts up and reports ready', true);

  let socket;
  const recDir = path.join(RELAY_DIR, 'recordings', TEST_CAM_ID);
  try {
    socket = await connectAsCamera();

    // Push frames steadily *before* any recording is requested — these
    // should end up in cam.frameBuffer and, per §5.3, get prepended to
    // whatever recording starts next. At ~10 frames/sec for slightly
    // longer than PRE_BUFFER_SECONDS, the buffer should end up holding
    // roughly PRE_BUFFER_SECONDS * 10 frames once trimmed.
    const PUSH_INTERVAL_MS = 100;
    const PRE_ROLL_PUSH_COUNT = Math.round((PRE_BUFFER_SECONDS * 1000) / PUSH_INTERVAL_MS) + 5; // a bit more than the window so trimming actually kicks in
    for (let i = 0; i < PRE_ROLL_PUSH_COUNT; i++) {
      pushRealJpegFrame(socket, jpegBytes);
      await sleep(PUSH_INTERVAL_MS);
    }

    // Now trigger a short recording — same endpoint the dashboard's
    // RECORD button and the ESP32 sketch's triggerAlarmRecording() call.
    const recordResp = await httpPost(`/record/${TEST_CAM_ID}?seconds=1`);
    check('record request accepted', recordResp.statusCode === 200 && recordResp.json && recordResp.json.recording === true,
      `status=${recordResp.statusCode} body=${recordResp.body}`);

    // Push a couple more "live" frames during the 1s recording window.
    for (let i = 0; i < 3; i++) {
      pushRealJpegFrame(socket, jpegBytes);
      await sleep(PUSH_INTERVAL_MS);
    }

    // Wait for the recording to stop (its own 1s timer) and ffmpeg to
    // finish (the .tmp_ directory disappears once finalizeRecording()'s
    // ffmpeg process exits cleanly).
    const tempDirGone = await waitUntil(() => {
      if (!fs.existsSync(recDir)) return false;
      const entries = fs.readdirSync(recDir);
      return entries.some((e) => e.endsWith('.mp4')) && !entries.some((e) => e.startsWith('.tmp_'));
    }, 10000);
    check('recording finished and encoded within the timeout', tempDirGone,
      fs.existsSync(recDir) ? `dir contents: ${JSON.stringify(fs.readdirSync(recDir))}` : 'recordings dir never appeared');

    if (tempDirGone) {
      const mp4Name = fs.readdirSync(recDir).find((e) => e.endsWith('.mp4'));
      const mp4Path = path.join(recDir, mp4Name);

      const probeOut = execFileSync('ffprobe', [
        '-v', 'error',
        '-count_frames',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames',
        '-of', 'csv=p=0',
        mp4Path,
      ]).toString().trim();
      const frameCount = parseInt(probeOut, 10);

      // The key assertion: the encoded clip must contain noticeably more
      // frames than just the 3 "live" pushes made after /record was
      // called — proving the pre-roll frames pushed *before* the trigger
      // actually made it into the recording, not just frames that arrived
      // after. Threshold of 5 (not exactly 3) leaves slack for timing
      // jitter around the trim window while still clearly failing if the
      // pre-buffer wiring were removed (which would land at exactly 3).
      check(
        'recorded clip contains more frames than just the post-trigger pushes (pre-roll was prepended)',
        Number.isFinite(frameCount) && frameCount > 5,
        `ffprobe reported ${probeOut} frames (raw), parsed as ${frameCount}`
      );
    }
  } catch (err) {
    check('no unexpected error during the test', false, err.stack || err.message);
  }

  if (socket) socket.destroy();
  if (relay) relay.kill();
  clearTimeout(overallTimer);
  cleanupTempConfig();
  // Best-effort cleanup of the recording this test produced, so repeat
  // runs don't accumulate files or trip on a leftover .mp4 from a
  // previous run when picking `mp4Name` above.
  try { fs.rmSync(recDir, { recursive: true, force: true }); } catch (e) { /* fine */ }

  summarizeAndExit();
}

function summarizeAndExit() {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main();
