#!/usr/bin/env node
'use strict';
// test_apache_hardening_e2e.js — F-06 / F-07 / F-17: the Apache configuration SHIPPED in apache/
// (camdash.conf + camdash-hardening.conf), run on a REAL Apache with mod_php in front of a copy of
// the dashboard. The shipped files are used as they are, only the folder, port and log paths are
// swapped for throwaway ones. Checks that:
//   - the security headers are on every answer: the page, the 401 login prompt, 403 and 404 pages
//   - Apache does not announce its version, and TRACE is refused
//   - lib/, config.php, example.config.php, config.php.bak (and other copies/backups of it),
//     editor leftovers and dot-files answer 403 and never leak their content — with NO .htaccess in
//     the folder, so it is the vhost doing it (AllowOverride None)
//   - folder listings are off (a folder without index answers 403, no "Index of")
//   - a recording keeps its own "private, no-cache" (the vhost only fills Cache-Control when empty)
//   - the dashboard still works through it (login, page, JSON endpoint)
// Needs apache2 + mod_php on this machine (skips if missing). Own ports, core modules only.
//
// Usage:  node tests/e2e/test_apache_hardening_e2e.js
// Exit code: 0 if every check passed (or Apache/PHP is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const DASH_SRC = path.join(ROOT, 'php/cameras');
const PORT = Number(process.env.E2E_APACHE_PORT || 19360);
const RELAY_PORT = Number(process.env.E2E_APACHE_RELAY_PORT || 19361);
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const SECRET = 'TOP-SECRET-CONTENT-12345';
const MP4_NAME = 'cam-a-20260101-000000.mp4';

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

function findApache() {
  for (const bin of ['apache2', '/usr/sbin/apache2', 'httpd', '/usr/sbin/httpd']) {
    if (spawnSync(bin, ['-v'], { stdio: 'ignore' }).status === 0) return bin;
  }
  return null;
}
function modDir() {
  return ['/usr/lib/apache2/modules', '/usr/lib64/httpd/modules', '/usr/lib/httpd/modules'].find((d) => fs.existsSync(d)) || null;
}
function findPhpModule(dir) {
  return fs.readdirSync(dir).find((f) => /^libphp[\d.]*\.so$/.test(f) || /^mod_php[\d.]*\.so$/.test(f)) || null;
}

// A throwaway dashboard folder, WITHOUT .htaccess (the vhost has to do the work alone).
function makeDocroot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-apache-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, '.htaccess'), { force: true });
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷']]];\n// ${SECRET}\n`);
  for (const leftover of ['config.php.bak', 'config.php.orig', 'config.php~', 'config.php.swp', '.env', 'notes.md', 'deploy.sh']) {
    fs.writeFileSync(path.join(dir, leftover), SECRET + '\n');
  }
  fs.writeFileSync(path.join(dir, 'lib', 'secret.txt'), SECRET + '\n');
  fs.mkdirSync(path.join(dir, 'emptydir'));
  fs.chmodSync(dir, 0o755);
  spawnSync('chmod', ['-R', 'a+rX', dir]);
  return dir;
}

// The shipped files, with only the paths and the port swapped.
function builtinModules(apache) {
  const out = spawnSync(apache, ['-l'], { encoding: 'utf8' }).stdout || '';
  return new Set((out.match(/mod_[a-z0-9_]+\.c/g) || []).map((m) => m.replace(/^mod_|\.c$/g, '')));
}
function makeApacheConf(apache, docroot, work, modules, phpModule) {
  const vhost = fs.readFileSync(path.join(ROOT, 'apache/camdash.conf'), 'utf8')
    .replace(/\/var\/www\/camdash/g, docroot)
    .replace('<VirtualHost 127.0.0.1:80>', `<VirtualHost 127.0.0.1:${PORT}>`);
  const hardening = fs.readFileSync(path.join(ROOT, 'apache/camdash-hardening.conf'), 'utf8');
  const builtin = builtinModules(apache);   // some builds have e.g. log_config / unixd compiled in
  const mods = ['mpm_prefork', 'authz_core', 'authz_host', 'dir', 'mime', 'headers', 'log_config', 'unixd', 'alias', 'autoindex']
    .filter((m) => !builtin.has(m))
    .map((m) => `LoadModule ${m}_module ${modules}/mod_${m}.so`);
  const conf = [
    `ServerRoot "${work}"`, `PidFile "${work}/apache.pid"`, `Listen 127.0.0.1:${PORT}`,
    'User www-data', 'Group www-data', `Define APACHE_LOG_DIR ${work}`,
    ...mods, `LoadModule php_module ${modules}/${phpModule}`,
    'TypesConfig /etc/mime.types',
    'LogFormat "%h %l %u %t \\"%r\\" %>s %b" combined',
    `ErrorLog ${work}/error.log`,
    '<FilesMatch "\\.php$">\n  SetHandler application/x-httpd-php\n</FilesMatch>',
    '<Directory />\n  AllowOverride None\n  Require all denied\n</Directory>',
    hardening, vhost,
  ].join('\n');
  const file = path.join(work, 'apache.conf');
  fs.writeFileSync(file, conf);
  return file;
}

function startFakeRelay() {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      if (req.url.startsWith('/recordings/cam-a/') && req.url.endsWith('.mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        res.end(Buffer.from('not-really-a-video'));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end('[]');
      }
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

function request(method, urlPath, { auth = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    const req = nodeHttp.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

function hasSecurityHeaders(r) {
  const h = r.headers;
  return h['x-content-type-options'] === 'nosniff'
    && h['referrer-policy'] === 'no-referrer'
    && (h['content-security-policy'] || '') === "frame-ancestors 'none'"
    && h['x-frame-options'] === 'DENY'
    && !/,/.test(h['x-content-type-options'] + h['referrer-policy'] + h['content-security-policy'].replace(/'none'/, '') + h['x-frame-options']);   // each exactly once
}
const secHeaderDetail = (r) => JSON.stringify({ s: r.status, h: r.headers });

async function main() {
  const apache = findApache();
  const modules = modDir();
  const phpModule = modules && findPhpModule(modules);
  if (!apache || !modules || !phpModule || spawnSync('id', ['www-data'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: apache2 with mod_php (and the www-data user) is not installed — cannot run Apache.');
    finished = true;
    return;
  }
  let child; let relay; let docroot; let work;
  try {
    relay = await startFakeRelay();
    docroot = makeDocroot();
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-apache-work-')));
    fs.chmodSync(work, 0o755);
    const confFile = makeApacheConf(apache, docroot, work, modules, phpModule);
    const syntax = spawnSync(apache, ['-f', confFile, '-t'], { encoding: 'utf8' });
    check('the shipped Apache config passes configtest', syntax.status === 0, (syntax.stdout || '') + (syntax.stderr || ''));
    if (syntax.status !== 0) throw new Error('config invalid');

    child = spawn(apache, ['-f', confFile, '-X'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let apacheOut = '';
    child.stdout.on('data', (d) => { apacheOut += d; });
    child.stderr.on('data', (d) => { apacheOut += d; });
    const started = Date.now();
    let up = false;
    while (Date.now() - started < 8000 && !up) {
      up = await new Promise((r) => { const q = nodeHttp.get({ host: '127.0.0.1', port: PORT, path: '/' }, () => r(true)); q.on('error', () => r(false)); });
      if (!up) await sleep(150);
    }
    check('Apache starts with the shipped config', up, apacheOut.slice(-500));
    if (!up) throw new Error('apache did not start');

    // ── the dashboard works through it ──
    let r = await request('GET', '/');
    check('GET / without a login -> 401 (the login prompt)', r.status === 401 && /Basic/.test(r.headers['www-authenticate'] || ''), secHeaderDetail(r));
    check('...and the 401 already carries the security headers', hasSecurityHeaders(r), secHeaderDetail(r));
    r = await request('GET', '/', { auth: true });
    check('GET / with the login -> 200 dashboard page', r.status === 200 && r.text.length > 1000, `status=${r.status}`);
    check('the page has the security headers and Cache-Control: no-store', hasSecurityHeaders(r) && r.headers['cache-control'] === 'no-store', secHeaderDetail(r));
    r = await request('GET', '/status.php', { auth: true });
    check('a JSON endpoint answers and is no-store too', r.status === 200 && r.headers['cache-control'] === 'no-store' && hasSecurityHeaders(r), secHeaderDetail(r));
    r = await request('GET', `/recordings.php?cam=cam-a&play=${MP4_NAME}`, { auth: true });
    check('a recording plays (200) with its own "private, no-cache", not no-store', r.status === 200 && r.headers['cache-control'] === 'private, no-cache' && r.text === 'not-really-a-video', secHeaderDetail(r));
    check('...and still has the security headers', hasSecurityHeaders(r), secHeaderDetail(r));

    // ── version disclosure, TRACE ──
    check('Server header is just "Apache" (no version, no OS, no PHP)', r.headers.server === 'Apache' && !r.headers['x-powered-by'], `server=${r.headers.server} xpb=${r.headers['x-powered-by']}`);
    r = await request('GET', '/nope-does-not-exist.html', { auth: true });
    check('a 404 page has the security headers and no version signature', r.status === 404 && hasSecurityHeaders(r) && !/Apache\/\d|Server at/.test(r.text), secHeaderDetail(r) + r.text.slice(0, 200));
    r = await request('TRACE', '/', { auth: true });
    check('TRACE is refused', r.status === 405 || r.status === 403, `status=${r.status}`);

    // ── files that must never be served (and no .htaccess in the folder to do it) ──
    check('the test folder really has no .htaccess', !fs.existsSync(path.join(docroot, '.htaccess')));
    const denied = ['/lib/', '/lib/Logic.php', '/lib/secret.txt', '/config.php', '/example.config.php', '/config.php.bak',
      '/config.php.orig', '/config.php~', '/config.php.swp', '/.env', '/notes.md', '/deploy.sh'];
    for (const p of denied) {
      r = await request('GET', p, { auth: true });
      check(`${p} -> 403, content never leaks (even with a valid login)`, r.status === 403 && !r.text.includes(SECRET) && !/Index of/.test(r.text), `status=${r.status}`);
    }
    r = await request('GET', '/emptydir/', { auth: true });
    check('a folder without an index page gives no listing (403)', r.status === 403 && !/Index of/.test(r.text), `status=${r.status} ${r.text.slice(0, 120)}`);
    r = await request('GET', '/config.php.bak');
    check('...and the backup is refused without a login too', r.status === 403 && !r.text.includes(SECRET), `status=${r.status}`);
    check('denied pages carry the security headers', hasSecurityHeaders(r), secHeaderDetail(r));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (child && child.exitCode === null) {
      child.removeAllListeners('exit');
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 3000); });
    }
    if (relay) relay.close();
    for (const d of [docroot, work]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
  summarize();
}
main();
