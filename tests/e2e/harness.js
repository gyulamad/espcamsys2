'use strict';
// harness.js — what an end-to-end test needs besides its own checks, in one place: the pass/fail reporter, waiting,
// one HTTP request helper, starting and stopping a child process (the relay) and a PHP dashboard on a throwaway copy of the
// dashboard folder. Core modules only. Used by test_logs_tail_e2e.js and test_dashboard_ota_logs_e2e.js; the older
// end-to-end tests carry their own copies and can move over one at a time.
//
//   const { createReporter, httpRequest, startProcess, stopProcess } = require('./harness');
//   const t = createReporter();
//   t.check('it works', cond, detail);
//   t.finish();                       // prints the tally, sets the exit code

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reporter: check() counts and prints; finish() prints the tally and sets the exit code (0 only if nothing failed);
// crash(err) is a failed check for an unexpected error. A test that ends without finish() fails: it never reached its end.
function createReporter() {
  let pass = 0;
  let fail = 0;
  let finished = false;
  process.on('exit', () => {
    if (!finished) {
      console.error('[FAIL] the test ended without finishing (no summary was reached)');
      process.exitCode = 1;
    }
  });
  const reporter = {
    check(name, cond, detail) {
      if (cond) { pass += 1; console.log(`[PASS] ${name}`); }
      else { fail += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
    },
    crash(err) { reporter.check('the test run completed without an unexpected error', false, err && err.stack ? err.stack : String(err)); },
    skip(why) { finished = true; console.log(`SKIP: ${why}`); },
    finish() { finished = true; console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail === 0 ? 0 : 1; },
  };
  return reporter;
}

// Calls fn() until it returns something truthy (which is returned), or null after timeoutMs.
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

// One HTTP request -> { status, headers, text, json } (json is null when the body is not JSON).
function httpRequest({ host = '127.0.0.1', port, method = 'GET', path: urlPath, headers = {}, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host, port, path: urlPath, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

// Starts a child process and resolves { child, output() } when ready(output so far) is true; rejects if it exits first
// or is not ready in time.
function startProcess({ command, args = [], cwd, env, ready, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: Object.assign({}, process.env, env) });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && ready(out)) { settled = true; resolve({ child, output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`${command} exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`${command} not ready in ${timeoutMs / 1000}s:\n${out}`)); } }, timeoutMs).unref();
  });
}

// Stops a child (or { child }) politely, then hard; resolves when it is gone. Nothing to stop is fine.
function stopProcess(handle) {
  return new Promise((resolve) => {
    const child = handle && handle.child ? handle.child : handle;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

// ── a PHP dashboard ────────────────────────────────────────────────────

const phpInstalled = () => spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0;

// A copy of the dashboard folder in a temp folder, with a config.php of the test's own (the PHP source of the file).
function makeDashboardCopy(srcDir, configPhp) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dash-')));
  spawnSync('cp', ['-r', `${srcDir}/.`, dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'), configPhp);
  return dir;
}

// `php -S` on a port, serving docroot with its own temp folder; resolves the child once it answers.
async function startPhpServer({ port, docroot, tmpDir }) {
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', docroot], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', TMPDIR: tmpDir } });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const up = await waitFor(async () => {
    if (exited) throw new Error('php -S exited early');
    try { await httpRequest({ port, path: '/', timeoutMs: 1000 }); return true; } catch (e) { return false; }
  }, 5000);
  if (!up) { child.kill('SIGKILL'); throw new Error('php -S not ready in 5s'); }
  return child;
}

module.exports = { createReporter, sleep, waitFor, httpRequest, startProcess, stopProcess, phpInstalled, makeDashboardCopy, startPhpServer };
