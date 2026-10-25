#!/usr/bin/env node
'use strict';
// test_dashboard_login_e2e.js — F-03 / F-04: the dashboard login, on a REAL PHP server.
//   F-04: while config.php holds an empty, template ("change-me") or too short login the dashboard
//         answers 503 — also for a request that sends NO login or an EMPTY one (which used to match
//         an empty config) — and shows nothing.
//   F-03: after 10 wrong logins in a row every attempt is refused (429 + Retry-After), even with the
//         right password; 40 guesses fired in parallel get at most 10 real answers; a right login
//         clears the counter; old failures are forgotten; every wrong login is logged (without the
//         password); asking the browser for a login (no credentials) is not counted as a failure.
// Needs `php` on PATH (skips if missing). Own ports, throwaway dashboard copies, core modules only.
//
// Usage:  node tests/e2e/test_dashboard_login_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const crypto = require('crypto');
const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PORT = Number(process.env.E2E_LOGIN_PORT || 19350);
const GOOD = { user: 'owner', pass: 'a-good-long-password' };

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
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A throwaway copy of the dashboard with the given login in config.php.
function makeDashboard(user, pass) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-login-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => ${JSON.stringify(user)}, 'auth_pass' => ${JSON.stringify(pass)}, 'relay_url' => 'http://127.0.0.1:1', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷']]];\n`);
  return dir;
}
const stateFile = (dir) => path.join(os.tmpdir(), 'camdash-login-' + crypto.createHash('sha1').update(dir).digest('hex') + '.json');
const readState = (dir) => { try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); } catch (e) { return null; } };

let phpLog = '';
function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    // several workers, so the parallel-guesses check really runs in parallel
    const child = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '8' } });
    child.stdout.on('data', (d) => { phpLog += d.toString(); });
    child.stderr.on('data', (d) => { phpLog += d.toString(); });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${phpLog}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PORT}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error('php -S not ready in 5s'));
    })();
  });
}
function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 1500);
  });
}

// creds: null = send no Authorization header at all; {user, pass} otherwise (empty strings allowed).
function get(creds) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (creds) headers.Authorization = 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
    const req = nodeHttp.get(`http://127.0.0.1:${PORT}/index.php`, { headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}
const wrong = (n) => ({ user: GOOD.user, pass: 'wrong-guess-' + n });

// Runs one dashboard instance, then stops it and removes its files.
async function withDashboard(user, pass, fn) {
  const dir = makeDashboard(user, pass);
  fs.rmSync(stateFile(dir), { force: true });
  phpLog = '';
  let php;
  try {
    php = await startPhp(dir);
    await fn(dir);
  } finally {
    await stopProc(php);
    fs.rmSync(stateFile(dir), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  try {
    // ── F-04: unsafe logins in config.php switch the dashboard off ──
    const unsafe = [
      ['an empty username and password', '', ''],
      ['an empty password', 'owner', ''],
      ['the template login change-me / change-me', 'change-me', 'change-me'],
      ['the template password', 'owner', 'change-me'],
      ['a password shorter than 8 characters', 'owner', 'short'],
    ];
    for (const [label, user, pass] of unsafe) {
      await withDashboard(user, pass, async () => {
        let r = await get(null);
        check(`${label}: no login sent -> 503, not a login prompt`, r.status === 503 && !r.headers['www-authenticate'], `status=${r.status}`);
        r = await get({ user: '', pass: '' });
        check(`${label}: an EMPTY login does not get in -> 503`, r.status === 503, `status=${r.status}`);
        r = await get({ user, pass });
        check(`${label}: even the configured login is refused -> 503`, r.status === 503 && !/Camera|<html/i.test(r.text), `status=${r.status}`);
        check(`${label}: the reason is in the error log, not on the page`, phpLog.includes('camdash: the dashboard is switched off') && !/template|shorter|empty/i.test(r.text), phpLog.slice(-200));
      });
    }

    await withDashboard(GOOD.user, GOOD.pass, async (dir) => {
      // ── normal behaviour is unchanged ──
      let r = await get(null);
      check('a good config: no login sent -> 401 with a login prompt', r.status === 401 && /Basic/.test(r.headers['www-authenticate'] || ''), `status=${r.status}`);
      r = await get({ user: '', pass: '' });
      check('a good config: an empty login -> 401', r.status === 401, `status=${r.status}`);
      r = await get(GOOD);
      check('a good config: the right login gets the dashboard (200)', r.status === 200, `status=${r.status}`);
      check('asking for a login and the right login are not failures (no counter)', !readState(dir) || readState(dir).fails === 0, JSON.stringify(readState(dir)));

      // ── guessing: 9 failures are free, the 10th locks ──
      for (let i = 1; i <= 9; i++) {
        r = await get(wrong(i));
        if (r.status !== 401) check(`wrong guess ${i} -> 401`, false, `status=${r.status}`);
      }
      check('9 wrong logins in a row are all answered 401', readState(dir) && readState(dir).fails === 9, JSON.stringify(readState(dir)));
      r = await get(GOOD);
      check('...and a right login then still works and clears the counter', r.status === 200 && readState(dir).fails === 0, `status=${r.status} ${JSON.stringify(readState(dir))}`);

      for (let i = 1; i <= 9; i++) await get(wrong(i));
      r = await get(wrong(10));
      check('the 10th wrong login in a row is answered 401 (and starts the lock)', r.status === 401, `status=${r.status}`);
      r = await get(wrong(11));
      check('the next guess is refused 429 with Retry-After', r.status === 429 && Number(r.headers['retry-after']) > 0 && Number(r.headers['retry-after']) <= 15, `status=${r.status} ra=${r.headers['retry-after']}`);
      r = await get(GOOD);
      check('during the lock even the RIGHT password is refused (429) — a guess cannot be told apart', r.status === 429, `status=${r.status}`);
      r = await get(null);
      check('during the lock a request with no login still just gets the prompt (401)', r.status === 401, `status=${r.status}`);

      // ── the lock ends and a right login works again ──
      await sleep(16000);
      r = await get(GOOD);
      check('after the lock ran out the right login works again', r.status === 200, `status=${r.status}`);
      check('...and the counter is cleared', readState(dir).fails === 0 && readState(dir).lockUntil === 0, JSON.stringify(readState(dir)));

      // ── a wrong guess right after the lock extends it (doubles) ──
      const now = Math.floor(Date.now() / 1000);
      fs.writeFileSync(stateFile(dir), JSON.stringify({ fails: 10, last: now - 20, lockUntil: now - 5 }));
      r = await get(wrong('again'));
      const st = readState(dir);
      check('a wrong guess after a lock runs out locks again, for longer (30 s)', r.status === 401 && st.fails === 11 && st.lockUntil - now >= 28 && st.lockUntil - now <= 31, `status=${r.status} ${JSON.stringify(st)}`);

      // ── old failures are forgotten ──
      fs.writeFileSync(stateFile(dir), JSON.stringify({ fails: 9, last: now - 4000, lockUntil: 0 }));
      r = await get(wrong('late'));
      check('failures older than an hour are forgotten (no lock on the next wrong one)', r.status === 401 && readState(dir).fails === 1, JSON.stringify(readState(dir)));

      // ── garbage in the state file does not break or open anything ──
      fs.writeFileSync(stateFile(dir), 'this is not json {{{');
      r = await get(wrong('junk'));
      check('a corrupt state file is treated as empty (wrong login still 401)', r.status === 401, `status=${r.status}`);
      r = await get(GOOD);
      check('...and the right login works', r.status === 200, `status=${r.status}`);

      // ── logging ──
      check('every wrong login is in the error log with the user and address', /camdash: failed login for user "owner" from 127\.0\.0\.1 \(\d+ in a row/.test(phpLog), phpLog.slice(-400));
      check('...the lock is logged too', /locked for \d+s/.test(phpLog));
      check('...and no password (right or wrong) is ever logged', !phpLog.includes(GOOD.pass) && !phpLog.includes('wrong-guess'), phpLog.slice(-300));
    });

    // ── parallel guesses cannot slip past the counter ──
    await withDashboard(GOOD.user, GOOD.pass, async (dir) => {
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => get(wrong(i))));
      const n401 = results.filter((x) => x.status === 401).length;
      const n429 = results.filter((x) => x.status === 429).length;
      check('40 guesses fired at once: exactly 10 get a real answer, the rest are refused', n401 === 10 && n429 === 30, `401=${n401} 429=${n429}`);
      const logged = (phpLog.match(/camdash: failed login/g) || []).length;
      check('...and only those 10 were logged (the refused ones cost nothing)', logged === 10, `logged=${logged}`);
    });
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  }
  summarize();
}
main();
