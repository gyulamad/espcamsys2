#!/usr/bin/env node
'use strict';
// test_dashboard_logout_e2e.js — the dashboard's LOG OUT button, against a REAL PHP server (php -S)
// with a generated config.php. The login is HTTP Basic Auth, held by the browser, so a logout is a
// 401 + login prompt for the same realm (that is what makes a browser forget a saved login). Checks that:
//   - every page that has a header (dashboard, settings, camera settings) carries the button, as a
//     plain POST <form> to logout.php (no JavaScript), and the form's own action works
//   - a logged-in POST the way a real browser sends the button's form (Origin: null, Sec-Fetch-Site: same-origin) gets the 401 + the SAME login prompt header the
//     dashboard's login uses, and a "logged out" page that tells the owner to press Cancel
//   - the answer carries the safe headers and no-store, sets no cookie, and the server keeps no state:
//     logging out many times never locks the owner out (it is not a failed login)
//   - a GET (a link, an <img>, a prefetch) and a POST another website caused are refused (405 / 403)
//     and are NOT answered with a login prompt — they cannot make the browser forget the login
//   - without a login the endpoint is just the normal login prompt, not the logged-out page
//   - each real logout leaves one audit line in the web server's error log, refused ones none
// Needs `php` on PATH (skips if missing). Own port, throwaway dashboard copy, core modules only.
//
// Usage:  node tests/e2e/test_dashboard_logout_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_LOGOUT_PORT || 19430);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass-long' };
const HOST = `127.0.0.1:${PHP_PORT}`;
const PAGES = ['index.php', 'settings-page.php', 'camera-settings-page.php?cam=cam-a', 'all-recordings.php'];

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

function makeDashboard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-logout-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${PHP_PORT + 1}', 'relay_control_key' => '', 'cameras' => [['id' => 'cam-a', 'name' => 'Cam A', 'icon' => '📷']]];\n`);
  return dir;
}

let phpLog = '';
function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', HOST, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { phpLog += d.toString(); });
    child.stderr.on('data', (d) => { phpLog += d.toString(); });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${phpLog}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://${HOST}/`, () => r(true)); q.on('error', () => r(false)); });
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

// One request, the way a browser (or curl) would send it. `kind` picks the headers a browser adds:
//   'form'  - what a real browser sends for the dashboard's own <form> POST: Sec-Fetch-Site: same-origin and
//             "Origin: null" (every page sends Referrer-Policy: no-referrer, which makes browsers send a null Origin)
//   'own'   - a request with a matching Origin + Sec-Fetch-Site: same-origin
//   'curl'  - neither header (curl, old browsers)
//   'xsite' - a form on another website (foreign Origin, Sec-Fetch-Site: cross-site)
function req(method, p, { auth = true, kind = 'form' } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: HOST };
    if (auth) h.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    if (method === 'POST') h['Content-Length'] = 0;
    if (kind === 'form') Object.assign(h, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' });
    if (kind === 'own') Object.assign(h, { Origin: `http://${HOST}`, 'Sec-Fetch-Site': 'same-origin' });
    if (kind === 'xsite') Object.assign(h, { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded' });
    const r = nodeHttp.request(`http://${HOST}/${p}`, { method, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('request timed out')));
    r.end();
  });
}

const safe = (r) => r.headers['x-content-type-options'] === 'nosniff' && r.headers['referrer-policy'] === 'no-referrer'
  && r.headers['content-security-policy'] === "frame-ancestors 'none'" && r.headers['x-frame-options'] === 'DENY'
  && r.headers['cache-control'] === 'no-store';
const detail = (r) => JSON.stringify({ s: r.status, h: r.headers, t: r.text.slice(0, 200) });
const auditLines = () => (phpLog.match(/camdash audit: \S+ logged out/g) || []);

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  let php; const dirs = [];
  try {
    const docroot = makeDashboard();
    dirs.push(docroot);
    php = await startPhp(docroot);

    // ── the button is on every page that has a header ───────────────
    for (const page of PAGES) {
      const r = await req('GET', page);
      const header = (r.text.match(/<header[\s\S]*?<\/header>/) || [''])[0];
      const forms = header.match(/<form class="logout-form" method="post" action="logout\.php">[\s\S]*?<\/form>/g) || [];
      check(`${page}: loads (200) and its header has exactly one LOG OUT form (a POST, no script)`,
        r.status === 200 && forms.length === 1 && /type="submit"/.test(forms[0]) && /LOG OUT/.test(forms[0]) && !/onclick|onsubmit|<script/.test(forms[0]), `status=${r.status} forms=${forms.length}`);
      const action = (forms[0] || '').match(/action="([^"]+)"/);
      const followed = action ? await req('POST', action[1]) : null;
      check(`${page}: the form's own action leads to a working logout (401 + "logged out")`, !!followed && followed.status === 401 && /LOGGED OUT/.test(followed.text), followed ? detail(followed) : 'no action found');
    }

    // ── a real logout ────────────────────────────────────────────────
    const prompt = await req('GET', 'index.php', { auth: false });
    check('the login prompt is a 401 with a Basic challenge', prompt.status === 401 && /^Basic realm="[^"]+"$/.test(prompt.headers['www-authenticate'] || ''), detail(prompt));

    const before = auditLines().length;
    let r = await req('POST', 'logout.php');
    check('POST from the dashboard: 401 with exactly the login prompt\'s challenge (same realm, or the browser keeps the login)',
      r.status === 401 && r.headers['www-authenticate'] === prompt.headers['www-authenticate'], detail(r));
    check('...and an HTML "logged out" page that says to press Cancel',
      /text\/html/.test(r.headers['content-type'] || '') && /LOGGED OUT/.test(r.text) && /Cancel/.test(r.text), detail(r));
    const back = (r.text.match(/<a class="btn" href="([^"]*)">LOG IN AGAIN/) || [])[1];
    check('...whose LOG IN AGAIN link goes to the dashboard folder (".../camdash/"), not to its index.php',
      back !== undefined && new URL(back, 'http://pi.local/camdash/logout.php').pathname === '/camdash/', `href=${back}`);
    const folder = await req('GET', '', { auth: false });
    check('...and that folder address is the dashboard\'s login prompt', folder.status === 401 && folder.headers['www-authenticate'] === prompt.headers['www-authenticate'], detail(folder));
    check('...with the safe headers, no-store, and no cookie (nothing is kept on either side)', safe(r) && !r.headers['set-cookie'], detail(r));
    await sleep(100);
    check('...and one audit line in the error log, naming who logged out', auditLines().length === before + 1 && /camdash audit: e2e-user@127\.0\.0\.1 logged out/.test(phpLog), phpLog.slice(-300));

    r = await req('POST', 'logout.php', { kind: 'own' });
    check('POST with a matching Origin works too', r.status === 401 && /LOGGED OUT/.test(r.text), detail(r));
    r = await req('POST', 'logout.php', { kind: 'curl' });
    check('POST without Origin / Sec-Fetch-Site (curl, old browsers) works the same', r.status === 401 && r.headers['www-authenticate'] === prompt.headers['www-authenticate'] && /LOGGED OUT/.test(r.text), detail(r));

    // ── what must NOT log a browser out ─────────────────────────────
    const logged = auditLines().length;
    r = await req('GET', 'logout.php');
    check('GET (a link, an <img>, a prefetch): 405 with Allow: POST, and NO login prompt', r.status === 405 && r.headers.allow === 'POST' && !r.headers['www-authenticate'] && !/LOGGED OUT/.test(r.text), detail(r));
    check('...still with the safe headers', safe(r), detail(r));
    r = await req('POST', 'logout.php', { kind: 'xsite' });
    check('POST caused by another website (foreign Origin, cross-site): 403, NO login prompt', r.status === 403 && !r.headers['www-authenticate'] && !/LOGGED OUT/.test(r.text), detail(r));
    r = await req('POST', 'logout.php', { kind: 'curl' }).then(() => req('POST', 'logout.php', { kind: 'own' }));
    await sleep(100);
    check('refused requests left no audit line (only the two real logouts since)', auditLines().length === logged + 2, `lines=${auditLines().length} expected=${logged + 2}`);

    // ── without a login it is just the normal login prompt ─────────
    r = await req('POST', 'logout.php', { auth: false });
    check('POST without a login: the normal 401 prompt, not the logged-out page', r.status === 401 && r.headers['www-authenticate'] === prompt.headers['www-authenticate'] && !/LOGGED OUT/.test(r.text) && /Authentication required/.test(r.text), detail(r));

    // ── logging out is not a failed login ────────────────────────────
    for (let i = 0; i < 15; i += 1) await req('POST', 'logout.php');
    r = await req('GET', 'index.php');
    check('15 more logouts in a row never lock the owner out (the guess throttle is not fed)', r.status === 200, detail(r));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  summarize();
}
main();
