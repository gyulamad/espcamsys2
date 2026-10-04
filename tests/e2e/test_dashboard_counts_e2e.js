#!/usr/bin/env node
'use strict';
// test_dashboard_counts_e2e.js — checks that each camera's FILES button already
// shows its recording count in the page the server sends on FIRST LOAD:
//
//     📼 FILES (3)
//
// with no click and no JavaScript involved. It requests the real dashboard
// page from a real PHP server (php -S) and reads the button text straight out
// of the returned HTML — so the number can only have come from the server
// writing it into the page, not from the browser's background status polling
// (which is a separate path that can be slow, or fail, or hit a relay that
// doesn't report counts).
//
// Three situations, because the relay a dashboard talks to isn't always the
// newest version:
//   1. a CURRENT relay (the real server.js): counts come from its /status
//   2. an OLDER relay (simulated): its /status has no counts, so the page
//      falls back to each camera's file list, which every version has
//   3. NO relay reachable: the page must still load promptly, with plain
//      "FILES" buttons rather than hanging or showing wrong numbers
//
// Needs `php` on PATH (skips with a message if it isn't — run_tests.sh
// already requires it for the PHP unit tests) and `npm install` having been
// run in nodejs/camera-relay/. Runs on its own ports, copies the dashboard to
// a temp folder with a throwaway config (your real config.php is never read
// or touched), and cleans up everything it creates. Core modules only.
//
// Usage:  node tests/e2e/test_dashboard_counts_e2e.js
//         E2E_DASH_PORT=19300 E2E_DASH_RELAY_PORT=19301 E2E_DASH_PUSH_PORT=19302 E2E_DASH_FAKE_PORT=19303 node ...
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const RECORDINGS_DIR = path.join(RELAY_DIR, 'recordings');

const PHP_PORT = Number(process.env.E2E_DASH_PORT || 19300);
const RELAY_PORT = Number(process.env.E2E_DASH_RELAY_PORT || 19301);
const PUSH_PORT = Number(process.env.E2E_DASH_PUSH_PORT || 19302);
const FAKE_PORT = Number(process.env.E2E_DASH_FAKE_PORT || 19303);
const DEAD_PORT = Number(process.env.E2E_DASH_DEAD_PORT || 19304); // nothing listens here

const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const CAMS = ['e2e-dash-a', 'e2e-dash-b', 'e2e-dash-c'];
const FILES_ON_DISK = { 'e2e-dash-a': 3, 'e2e-dash-b': 0, 'e2e-dash-c': 1 };

let passCount = 0;
let failCount = 0;
let finished = false; // set once the run reaches its summary (or deliberately skips)
// Safety net: if the process ever ends WITHOUT reaching the summary (an
// awaited promise that never settles lets Node quit quietly with exit code
// 0), that must read as a failure, not a pass.
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dashboard (php -S) ──────────────────────────────────────────────
function makeDashboard(relayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dash-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const cams = CAMS.map((id) => `['id' => '${id}', 'name' => '${id}', 'icon' => '📷']`).join(', ');
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => '${relayUrl}', 'cameras' => [${cams}]];\n`);
  return dir;
}

function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${out}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => {
          const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true));
          q.on('error', () => r(false));
        });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error(`php -S not ready in 5s: ${out}`));
    })();
  });
}
// Stops a child process and resolves once it is gone. Safe to call on one that
// has already stopped: a child ended by a SIGNAL has exitCode === null (its
// signalCode is set instead), so both must be checked — otherwise this would
// wait forever for an 'exit' event that already happened.
function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 1500);
  });
}

// GET the dashboard page with Basic Auth; returns { status, html, ms }.
function fetchPage() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const auth = Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    const req = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/index.php`, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { html += c; });
      res.on('end', () => resolve({ status: res.statusCode, html, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('page request timed out')));
  });
}
// The text on a camera's FILES button, as it appears in the raw HTML.
function filesLabel(html, id) {
  const m = new RegExp(`id="files-btn-${id}"[^>]*>([^<]*)</button>`).exec(html);
  return m ? m[1].trim() : null;
}

// ── a simulated OLDER relay: /status without counts, plain file lists ─
function startOldRelay() {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/status') {
        const out = {};
        for (const id of CAMS) out[id] = { lastSeen: null, recording: false, recordingStartedAt: null, recordingEndAt: null };
        return res.end(JSON.stringify(out)); // note: no recordingCount, like a relay from before counts existed
      }
      const m = /^\/recordings\/([^/]+)$/.exec(req.url);
      if (m && FILES_ON_DISK[m[1]] !== undefined) {
        const n = FILES_ON_DISK[m[1]];
        return res.end(JSON.stringify(Array.from({ length: n }, (_, i) => ({ filename: `${m[1]}_${i}.mp4`, sizeBytes: 100 }))));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(FAKE_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ── the real relay ──────────────────────────────────────────────────
let createdTempConfig = false;
function startRelay(settingsFile) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(RELAY_PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: 'e2e-key', SETTINGS_FILE: settingsFile }),
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes(`raw push) listening on :${PUSH_PORT}`)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`relay exited early (code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`relay not ready in 5s: ${out}`)), 5000).unref();
  });
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot render the dashboard page.');
    finished = true;
    return;
  }
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    summarize();
    return;
  }

  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dash-set-')), 'settings.json');
  const preexisting = new Set(CAMS.filter((id) => fs.existsSync(path.join(RECORDINGS_DIR, id))));
  const procs = [];
  const dirs = [];
  let oldRelay;
  try {
    // Footage on disk for the real relay: a has 3 clips (+ a recording-in-progress folder and a stray file
    // that must NOT be counted), b has none, c has 1.
    for (const id of CAMS) {
      const d = path.join(RECORDINGS_DIR, id);
      if (preexisting.has(id)) continue;
      if (FILES_ON_DISK[id] > 0) fs.mkdirSync(d, { recursive: true });
      for (let i = 0; i < FILES_ON_DISK[id]; i++) fs.writeFileSync(path.join(d, `${id}_${i}.mp4`), 'x');
    }
    fs.mkdirSync(path.join(RECORDINGS_DIR, 'e2e-dash-a', '.tmp_2026-01-01T00-00-00-000Z'), { recursive: true });
    fs.writeFileSync(path.join(RECORDINGS_DIR, 'e2e-dash-a', 'notes.txt'), 'x');

    // ── 1. a CURRENT relay ──────────────────────────────────────────
    const relay = await startRelay(settingsFile);
    procs.push(relay);
    let docroot = makeDashboard(`http://127.0.0.1:${RELAY_PORT}`);
    dirs.push(docroot);
    let php = await startPhp(docroot);
    procs.push(php);

    let page = await fetchPage();
    check('(current relay) the dashboard page loads', page.status === 200, `status=${page.status}`);
    check('(current relay) the first-load HTML already says "FILES (3)" for the camera with 3 clips',
      filesLabel(page.html, 'e2e-dash-a') === '📼 FILES (3)', `got ${JSON.stringify(filesLabel(page.html, 'e2e-dash-a'))}`);
    check('(current relay) ...and "FILES (1)" / "FILES (0)" for the others',
      filesLabel(page.html, 'e2e-dash-c') === '📼 FILES (1)' && filesLabel(page.html, 'e2e-dash-b') === '📼 FILES (0)',
      `c=${JSON.stringify(filesLabel(page.html, 'e2e-dash-c'))} b=${JSON.stringify(filesLabel(page.html, 'e2e-dash-b'))}`);
    check('(current relay) a recording in progress (.tmp_ folder) and stray files are not counted', filesLabel(page.html, 'e2e-dash-a') === '📼 FILES (3)');

    // The opened file list must be one long area on the page itself, not a box with its own scrollbar
    // (hard to use on touch devices) — so its CSS rule must set no height limit and no overflow.
    const rule = (sel) => { const m = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(page.html.replace(/\/\*[\s\S]*?\*\//g, '')); return m ? m[1] : null; };
    const panelCss = rule('.files-panel');
    check('the file list panel has no height limit or scrollbar (shows every file in one long area)',
      panelCss !== null && !/max-height|overflow|(^|[;\s])height\s*:/.test(panelCss), JSON.stringify(panelCss));
    const gridCss = rule('.grid');
    check('cards keep their own height, so one long list does not stretch the neighbouring cards',
      gridCss !== null && /align-items\s*:\s*start/.test(gridCss), JSON.stringify(gridCss));

    // The number follows what is on disk — a reload after a delete shows the new count.
    fs.rmSync(path.join(RECORDINGS_DIR, 'e2e-dash-a', 'e2e-dash-a_0.mp4'));
    page = await fetchPage();
    check('(current relay) a reload after one clip is deleted shows the new count',
      filesLabel(page.html, 'e2e-dash-a') === '📼 FILES (2)', `got ${JSON.stringify(filesLabel(page.html, 'e2e-dash-a'))}`);
    await stopProc(relay);
    await stopProc(php);

    // ── 2. an OLDER relay: /status has no counts -> fall back to the file lists ─
    oldRelay = await startOldRelay();
    docroot = makeDashboard(`http://127.0.0.1:${FAKE_PORT}`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    procs.push(php);
    page = await fetchPage();
    check('(older relay) the first-load HTML still shows every count, via the file lists',
      filesLabel(page.html, 'e2e-dash-a') === '📼 FILES (3)' && filesLabel(page.html, 'e2e-dash-b') === '📼 FILES (0)'
        && filesLabel(page.html, 'e2e-dash-c') === '📼 FILES (1)',
      CAMS.map((id) => `${id}=${JSON.stringify(filesLabel(page.html, id))}`).join(' '));
    await stopProc(php);
    oldRelay.close();
    oldRelay = null;

    // ── 3. NO relay reachable: the page must still load, promptly, with no numbers ─
    docroot = makeDashboard(`http://127.0.0.1:${DEAD_PORT}`);
    dirs.push(docroot);
    php = await startPhp(docroot);
    procs.push(php);
    page = await fetchPage();
    check('(relay down) the page still loads', page.status === 200, `status=${page.status}`);
    check('(relay down) buttons show plain "FILES" — no wrong numbers',
      CAMS.every((id) => filesLabel(page.html, id) === '📼 FILES'),
      CAMS.map((id) => `${id}=${JSON.stringify(filesLabel(page.html, id))}`).join(' '));
    check('(relay down) it does not hang waiting once per camera', page.ms < 4000, `${page.ms}ms`);
    await stopProc(php);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    for (const p of procs) await stopProc(p);
    if (oldRelay) oldRelay.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    for (const id of CAMS) if (!preexisting.has(id)) fs.rmSync(path.join(RECORDINGS_DIR, id), { recursive: true, force: true });
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true }); // the temp folder holding the throwaway settings file
    summarize();
  }
}

main();
