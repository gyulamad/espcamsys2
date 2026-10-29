#!/usr/bin/env node
'use strict';
// test_apache_hardening_e2e.js — F-06 / F-17: the Apache configuration SHIPPED in apache/
// (camdash-protect.conf, camdash-hardening.conf, the optional camdash-ssl.conf and the certificate
// script), run on a REAL Apache with mod_php. The setup is the one a Pi really has: an ordinary site
// serving a web root (like Debian's default site), the dashboard in its camdash/ sub-folder, and the
// shipped protect snippet switched on with nothing else changed. The shipped files are used as they
// are; only the folder, ports, certificate and log paths are swapped for throwaway ones. The whole
// suite below runs against every way in:
//   - plain HTTP through 127.0.0.1 (what Tor and the Pi itself use)
//   - plain HTTP through the machine's NON-loopback address (what the LAN uses) — the dashboard must
//     answer there: it is meant to be used from the LAN
//   - HTTPS (the OPTIONAL site), through the same non-loopback address, with the certificate made by
//     apache/make-selfsigned-cert.sh
// and checks that:
//   - the rest of the site is left exactly as it was (the snippet protects only the dashboard folder)
//   - the security headers are on every answer: the page, the 401 login prompt, 403 and 404 pages
//   - Apache does not announce its version, and TRACE is refused
//   - lib/, data/ (the settings saved on the dashboard), config.php, example.config.php, config.php.bak (and other copies/backups of it),
//     editor leftovers and dot-files answer 403 and never leak their content — with NO .htaccess in
//     the folder, so it is the snippet doing it (AllowOverride None)
//   - folder listings are off inside the dashboard (a folder without index answers 403, no "Index of")
//   - a recording keeps its own "private, no-cache" (Apache only touches the security headers)
//   - the dashboard still works through it (login, page, JSON endpoint)
//   - HTTPS: TLS 1.2+ only, the certificate carries the names it was made for, no HSTS header
//   - the certificate script: key mode 0600, right names, refuses to overwrite without --force,
//     refuses anything that is not a host name or address
// Needs apache2 + mod_php on this machine (skips if missing); the HTTPS part also needs mod_ssl and
// openssl (skipped with a note if missing). Own ports, core modules only.
//
// Usage:  node tests/e2e/test_apache_hardening_e2e.js
// Exit code: 0 if every check passed (or Apache/PHP is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const nodeHttps = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const DASH_SRC = path.join(ROOT, 'php/cameras');
const PORT = Number(process.env.E2E_APACHE_PORT || 19360);
const RELAY_PORT = Number(process.env.E2E_APACHE_RELAY_PORT || 19361);
const TLS_PORT = Number(process.env.E2E_APACHE_TLS_PORT || 19362);
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

// A throwaway web root with the dashboard in its camdash/ folder, WITHOUT .htaccess (the Apache
// snippet has to do the work alone). Returns { siteRoot, docroot } (docroot = the dashboard folder).
function makeDocroot() {
  const siteRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-apache-')));
  const dir = path.join(siteRoot, 'camdash');
  fs.mkdirSync(dir);
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, '.htaccess'), { force: true });
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷']]];\n// ${SECRET}\n`);
  for (const leftover of ['config.php.bak', 'config.php.orig', 'config.php~', 'config.php.swp', '.env', 'notes.md', 'deploy.sh']) {
    fs.writeFileSync(path.join(dir, leftover), SECRET + '\n');
  }
  fs.writeFileSync(path.join(dir, 'lib', 'secret.txt'), SECRET + '\n');
  // the settings saved on the dashboard (login, control key ...) live here once deploy.sh has run
  fs.mkdirSync(path.join(dir, 'data'));
  for (const f of ['settings.json', 'settings.lock', 'settings.json.tmpabc123', 'notes.txt']) fs.writeFileSync(path.join(dir, 'data', f), SECRET + '\n');
  fs.mkdirSync(path.join(dir, 'emptydir'));
  // the rest of the site: a page, and a folder with no index (Debian's default site lists those)
  fs.writeFileSync(path.join(siteRoot, 'index.html'), '<html>It works</html>\n');
  fs.mkdirSync(path.join(siteRoot, 'other'));
  fs.writeFileSync(path.join(siteRoot, 'other', 'file.txt'), 'plain file\n');
  fs.chmodSync(siteRoot, 0o755);
  spawnSync('chmod', ['-R', 'a+rX', siteRoot]);
  return { siteRoot, docroot: dir };
}

function builtinModules(apache) {
  const out = spawnSync(apache, ['-l'], { encoding: 'utf8' }).stdout || '';
  return new Set((out.match(/mod_[a-z0-9_]+\.c/g) || []).map((m) => m.replace(/^mod_|\.c$/g, '')));
}

// The shipped files, with only the paths and the ports swapped. ssl = { certDir } or null.
function makeApacheConf(apache, site, work, modules, phpModule, ssl) {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'apache', f), 'utf8');
  // an ordinary site like Debian's default one: a web root that is open, directory listings on
  const defaultSite = [
    `<VirtualHost *:${PORT}>`, '  ServerName localhost', `  DocumentRoot ${site.siteRoot}`, '</VirtualHost>',
    `<Directory ${site.siteRoot}>\n  Options Indexes FollowSymLinks\n  AllowOverride None\n  Require all granted\n</Directory>`,
  ].join('\n');
  // the shipped snippet, switched on (a2enconf = included globally), pointed at the test folder
  const protect = read('camdash-protect.conf').replace('Define CAMDASH_DIR /var/www/html/camdash', `Define CAMDASH_DIR ${site.docroot}`);
  const sslVhost = ssl
    ? read('camdash-ssl.conf').replace('<VirtualHost *:443>', `<VirtualHost *:${TLS_PORT}>`).replace('DocumentRoot /var/www/html', `DocumentRoot ${site.siteRoot}`).replace(/\/etc\/ssl\/camdash/g, ssl.certDir)
    : '';
  const hardening = read('camdash-hardening.conf');
  const builtin = builtinModules(apache);   // some builds have e.g. log_config / unixd compiled in
  const wanted = ['mpm_prefork', 'authz_core', 'authz_host', 'dir', 'mime', 'headers', 'log_config', 'unixd', 'alias', 'autoindex']
    .concat(ssl ? ['socache_shmcb', 'ssl'] : []);
  const mods = wanted.filter((m) => !builtin.has(m)).map((m) => `LoadModule ${m}_module ${modules}/mod_${m}.so`);
  const conf = [
    `ServerRoot "${work}"`, `PidFile "${work}/apache.pid"`,
    `Listen ${PORT}`,   // every address, like the real ports.conf: the LAN must be able to reach it
    ...(ssl ? [`Listen ${TLS_PORT}`] : []),
    'User www-data', 'Group www-data', `Define APACHE_LOG_DIR ${work}`,
    ...mods, `LoadModule php_module ${modules}/${phpModule}`,
    'TypesConfig /etc/mime.types', 'DirectoryIndex index.php index.html',
    'LogFormat "%h %l %u %t \\"%r\\" %>s %b" combined',
    `ErrorLog ${work}/error.log`,
    '<FilesMatch "\\.php$">\n  SetHandler application/x-httpd-php\n</FilesMatch>',
    '<Directory />\n  AllowOverride None\n  Require all denied\n</Directory>',
    hardening, protect, defaultSite, sslVhost,
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

// where: { host, port, tls }
function request(method, urlPath, { auth = false, where = { host: '127.0.0.1', port: PORT, tls: false } } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    const mod = where.tls ? nodeHttps : nodeHttp;
    const req = mod.request({ host: where.host, port: where.port, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
      // read the TLS details now: the socket is let go once the response ends
      const tlsInfo = where.tls ? { protocol: res.socket.getProtocol(), cert: res.socket.getPeerCertificate() } : null;
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, tlsInfo }));
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

// The first address of this machine that is not loopback — what a LAN client would use. Null if none.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

// Everything the dashboard must do and refuse, through one way in.
async function suite(label, where) {
  // every path below is relative to the dashboard folder, which lives at /camdash/ of the site
  const q = (method, urlPath, o = {}) => request(method, '/camdash' + urlPath, { ...o, where });
  const site = (urlPath) => request('GET', urlPath, { where });
  const n = (name) => `[${label}] ${name}`;
  // the snippet protects the dashboard folder and nothing else
  let r = await site('/');
  check(n('the rest of the site is untouched: its web root page is still served'), r.status === 200 && /It works/.test(r.text), `status=${r.status}`);
  r = await site('/other/');
  check(n('...a folder outside the dashboard still lists its files, as before'), r.status === 200 && /Index of/.test(r.text), `status=${r.status}`);
  r = await site('/other/file.txt');
  check(n('...and gets none of the dashboard\'s headers'), r.status === 200 && !r.headers['x-frame-options'] && !r.headers['content-security-policy'], JSON.stringify(r.headers));
  r = await q('GET', '/');
  check(n('GET / without a login -> 401 (the login prompt)'), r.status === 401 && /Basic/.test(r.headers['www-authenticate'] || ''), secHeaderDetail(r));
  check(n('...and the 401 already carries the security headers'), hasSecurityHeaders(r), secHeaderDetail(r));
  r = await q('GET', '/', { auth: true });
  check(n('GET / with the login -> 200 dashboard page'), r.status === 200 && r.text.length > 1000, `status=${r.status}`);
  check(n('the page has the security headers and Cache-Control: no-store'), hasSecurityHeaders(r) && r.headers['cache-control'] === 'no-store', secHeaderDetail(r));
  r = await q('GET', '/status.php', { auth: true });
  check(n('a JSON endpoint answers and is no-store too'), r.status === 200 && r.headers['cache-control'] === 'no-store' && hasSecurityHeaders(r), secHeaderDetail(r));
  r = await q('GET', `/recordings.php?cam=cam-a&play=${MP4_NAME}`, { auth: true });
  check(n('a recording plays (200) with its own "private, no-cache", not no-store'), r.status === 200 && r.headers['cache-control'] === 'private, no-cache' && r.text === 'not-really-a-video', secHeaderDetail(r));
  check(n('...and still has the security headers'), hasSecurityHeaders(r), secHeaderDetail(r));

  check(n('Server header is just "Apache" (no version, no OS, no PHP)'), r.headers.server === 'Apache' && !r.headers['x-powered-by'], `server=${r.headers.server} xpb=${r.headers['x-powered-by']}`);
  r = await q('GET', '/nope-does-not-exist.html', { auth: true });
  check(n('a 404 page has the security headers and no version signature'), r.status === 404 && hasSecurityHeaders(r) && !/Apache\/\d|Server at/.test(r.text), secHeaderDetail(r) + r.text.slice(0, 200));
  r = await q('TRACE', '/', { auth: true });
  check(n('TRACE is refused'), r.status === 405 || r.status === 403, `status=${r.status}`);

  const denied = ['/lib/', '/lib/Logic.php', '/lib/secret.txt', '/config.php', '/example.config.php', '/config.php.bak',
    '/config.php.orig', '/config.php~', '/config.php.swp', '/.env', '/notes.md', '/deploy.sh',
    '/data/', '/data/settings.json', '/data/settings.lock', '/data/settings.json.tmpabc123', '/data/notes.txt'];
  for (const p of denied) {
    r = await q('GET', p, { auth: true });
    check(n(`${p} -> 403, content never leaks (even with a valid login)`), r.status === 403 && !r.text.includes(SECRET) && !/Index of/.test(r.text), `status=${r.status}`);
  }
  r = await q('GET', '/emptydir/', { auth: true });
  check(n('a folder without an index page gives no listing (403)'), r.status === 403 && !/Index of/.test(r.text), `status=${r.status} ${r.text.slice(0, 120)}`);
  r = await q('GET', '/config.php.bak');
  check(n('the backup is refused without a login too'), r.status === 403 && !r.text.includes(SECRET), `status=${r.status}`);
  check(n('denied pages carry the security headers'), hasSecurityHeaders(r), secHeaderDetail(r));
}

// The certificate script, in a throwaway folder (CAMDASH_CERT_DIR).
function certScript(certDir, args, extraEnv = {}) {
  return spawnSync('bash', [path.join(ROOT, 'apache/make-selfsigned-cert.sh'), ...args], { encoding: 'utf8', env: { ...process.env, CAMDASH_CERT_DIR: certDir, ...extraEnv } });
}
const modeOf = (f) => (fs.statSync(f).mode & 0o777).toString(8);
function certText(certDir) {
  return spawnSync('openssl', ['x509', '-in', path.join(certDir, 'camdash.crt'), '-noout', '-text'], { encoding: 'utf8' }).stdout || '';
}

function staticChecks() {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const noComments = (t) => t.replace(/^\s*#.*$/gm, '');
  const protect = read('apache/camdash-protect.conf');
  const ssl = read('apache/camdash-ssl.conf');
  const install = read('INSTALL.md');
  check('there is NO new virtual host for the dashboard: the existing site keeps serving it (nothing is disabled)', !/<VirtualHost/.test(noComments(protect)) && !fs.existsSync(path.join(ROOT, 'apache/camdash.conf')) && !fs.existsSync(path.join(ROOT, 'apache/camdash-common.conf')));
  check('the protect snippet covers the folder deploy.sh copies to, set by ONE Define line', /^Define CAMDASH_DIR \/var\/www\/html\/camdash$/m.test(protect) && (noComments(protect).match(/\/var\/www\//g) || []).length === 1);
  check('the snippet denies data/ (the settings saved on the dashboard) to everyone', /<Directory \$\{CAMDASH_DIR\}\/data>\s*Require all denied/.test(protect));
  check('the snippet still denies lib/, config files, dot-files and sets the headers', /<Directory \$\{CAMDASH_DIR\}\/lib>/.test(protect) && /config\\\.php/.test(protect) && /X-Content-Type-Options/.test(protect) && /\^\\\./.test(protect));
  check('the optional HTTPS site is on every address, port 443, TLS 1.2 and 1.3 only, no HSTS', /<VirtualHost \*:443>/.test(ssl) && /SSLProtocol -all \+TLSv1\.2 \+TLSv1\.3/.test(ssl) && !/Strict-Transport-Security/i.test(noComments(ssl)));
  check('the HTTPS site serves the same web root as the default site', /DocumentRoot \/var\/www\/html$/m.test(ssl));
  check('INSTALL.md does not tell the owner to disable the default site, bind to localhost, or use another folder', !/a2dissite 000-default/.test(install) && !/Listen 127\.0\.0\.1/.test(install) && !/should NOT answer at all/.test(install) && !/cd \/var\/www\/camdash\n/.test(install));
  check('deploy.sh knows nothing about vhosts or listening addresses', !/beyond localhost|a2dissite|a2ensite|Listen /.test(read('deploy.sh')));
}

function certChecks() {
  if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: openssl is not installed — the certificate script cannot be tested.');
    return null;
  }
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cert-'));
  let r = certScript(certDir, ['raspberrypi', 'raspberrypi.local', '192.0.2.2']);
  check('the certificate script succeeds', r.status === 0 && /SHA-256 fingerprint/.test(r.stdout) && /sha256 Fingerprint=/i.test(r.stdout), r.stdout + r.stderr);
  check('the private key is mode 600, the certificate readable', modeOf(path.join(certDir, 'camdash.key')) === '600' && modeOf(path.join(certDir, 'camdash.crt')) === '644', `${modeOf(path.join(certDir, 'camdash.key'))} ${modeOf(path.join(certDir, 'camdash.crt'))}`);
  const text = certText(certDir);
  check('the certificate carries every name and address it was made for', /DNS:raspberrypi\b/.test(text) && /DNS:raspberrypi\.local/.test(text) && /IP Address:192\.0\.2\.2/.test(text), text.slice(text.indexOf('Alternative'), text.indexOf('Alternative') + 200));
  check('it is a server certificate, not a CA', /CA:FALSE/.test(text) && /TLS Web Server Authentication/.test(text));
  const notAfter = spawnSync('openssl', ['x509', '-in', path.join(certDir, 'camdash.crt'), '-noout', '-enddate'], { encoding: 'utf8' }).stdout.replace('notAfter=', '');
  const days = (new Date(notAfter) - Date.now()) / 86400000;
  check('it is valid for about 825 days', days > 820 && days < 826, String(days));
  const keyBefore = fs.readFileSync(path.join(certDir, 'camdash.key'), 'utf8');
  r = certScript(certDir, ['other.local']);
  check('a second run does NOT overwrite the certificate (needs --force)', r.status !== 0 && /--force/.test(r.stderr) && fs.readFileSync(path.join(certDir, 'camdash.key'), 'utf8') === keyBefore, r.stderr);
  r = certScript(certDir, ['--force', 'other.local']);
  check('--force replaces it, with the new name', r.status === 0 && /DNS:other\.local/.test(certText(certDir)) && fs.readFileSync(path.join(certDir, 'camdash.key'), 'utf8') !== keyBefore, r.stdout + r.stderr);
  check('no temporary files are left behind', fs.readdirSync(certDir).sort().join(',') === 'camdash.crt,camdash.key', fs.readdirSync(certDir).join(','));
  const bad = ['a;b', '$(touch /tmp/pwned)', '-bad', 'bad name', 'a,b', 'x:443', 'has\nnewline', '`id`', "a'b"];
  for (const b of bad) {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cert-bad-'));
    r = certScript(d2, [b]);
    check(`the script refuses ${JSON.stringify(b)}`, r.status !== 0 && !fs.existsSync(path.join(d2, 'camdash.crt')) && !fs.existsSync('/tmp/pwned'), r.stdout + r.stderr);
    fs.rmSync(d2, { recursive: true, force: true });
  }
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cert-noarg-'));
  r = certScript(d3, []);
  check('without arguments it uses this machine\'s host name', r.status === 0 && new RegExp('DNS:' + os.hostname().replace(/\./g, '\\.')).test(certText(d3)), r.stdout + r.stderr);
  fs.rmSync(d3, { recursive: true, force: true });
  return certDir;
}

async function main() {
  const apache = findApache();
  const modules = modDir();
  const phpModule = modules && findPhpModule(modules);
  if (!apache || !modules || !phpModule || spawnSync('id', ['www-data'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: apache2 with mod_php (and the www-data user) is not installed — cannot run Apache.');
    finished = true;
    return;
  }
  const lan = lanAddress();
  let child; let relay; let site = null; let work; let certDir = null;
  try {
    staticChecks();
    certDir = certChecks();
    // the certificate the HTTPS part uses: made for the LAN address, so the certificate test below is meaningful
    let ssl = null;
    if (certDir && fs.existsSync(path.join(modules, 'mod_ssl.so')) || certDir && builtinModules(apache).has('ssl')) {
      fs.rmSync(certDir, { recursive: true, force: true });
      certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cert-apache-'));
      const mk = certScript(certDir, ['raspberrypi.local', ...(lan ? [lan] : []), '127.0.0.1']);
      if (mk.status === 0) { spawnSync('chmod', ['a+rx', certDir]); ssl = { certDir }; }
    } else {
      console.log('SKIP: mod_ssl or openssl is missing — the HTTPS vhost is not run.');
    }

    relay = await startFakeRelay();
    site = makeDocroot();
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-apache-work-')));
    fs.chmodSync(work, 0o755);
    const confFile = makeApacheConf(apache, site, work, modules, phpModule, ssl);
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
    check('the test folder really has no .htaccess (the snippet has to do the work alone)', !fs.existsSync(path.join(site.docroot, '.htaccess')));

    await suite('HTTP via 127.0.0.1 (Tor, the Pi itself)', { host: '127.0.0.1', port: PORT, tls: false });
    if (lan) {
      await suite(`HTTP via ${lan} (the LAN)`, { host: lan, port: PORT, tls: false });
    } else {
      console.log('SKIP: this machine has no non-loopback address — "reachable from the LAN" cannot be tested.');
    }
    if (ssl) {
      const tlsHost = lan || '127.0.0.1';
      await suite(`HTTPS via ${tlsHost} (optional vhost)`, { host: tlsHost, port: TLS_PORT, tls: true });
      const r = await request('GET', '/camdash/', { auth: true, where: { host: tlsHost, port: TLS_PORT, tls: true } });
      const protocol = r.tlsInfo.protocol;
      check('HTTPS negotiates TLS 1.2 or 1.3', protocol === 'TLSv1.2' || protocol === 'TLSv1.3', protocol);
      // What the server presents, read by OpenSSL itself (Node's own certificate object comes back without
      // the names on older Node versions, so the test does not depend on it).
      const shown = spawnSync('openssl', ['s_client', '-connect', `${tlsHost}:${TLS_PORT}`], { input: '', encoding: 'utf8', timeout: 8000 });
      const pem = ((shown.stdout || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/) || [])[0];
      const served = pem ? (spawnSync('openssl', ['x509', '-noout', '-text'], { input: pem, encoding: 'utf8' }).stdout || '') : '';
      const sanAt = served.indexOf('Alternative Name');
      check('the certificate Apache serves carries the names it was made for', /DNS:raspberrypi\.local/.test(served) && (!lan || served.includes('IP Address:' + lan)), sanAt >= 0 ? served.slice(sanAt, sanAt + 200) : `no certificate received: ${((shown.stdout || '') + (shown.stderr || '')).slice(0, 200)}`);
      check('no HSTS header is sent (a self-signed certificate must stay click-through-able)', !r.headers['strict-transport-security'], JSON.stringify(r.headers));
      // Old TLS: a client that is willing to speak it (security level 0), so a refusal is the SERVER's doing.
      const old = (v) => spawnSync('openssl', ['s_client', '-connect', `${tlsHost}:${TLS_PORT}`, v, '-cipher', 'DEFAULT:@SECLEVEL=0'], { input: '', encoding: 'utf8', timeout: 8000 });
      const probe = old('-tls1_1');
      const probeOut = (probe.stdout || '') + (probe.stderr || '');
      const modern = spawnSync('openssl', ['s_client', '-connect', `${tlsHost}:${TLS_PORT}`, '-tls1_2'], { input: '', encoding: 'utf8', timeout: 8000 });
      check('(control) a TLS 1.2 client does connect with openssl s_client', /Protocol\s*:\s*TLSv1\.2/.test((modern.stdout || '') + (modern.stderr || '')), ((modern.stdout || '') + (modern.stderr || '')).slice(-200));
      // A real TLS 1.1 session reads "New, TLSv1.1, Cipher is <name>"; a refusal reads "New, (NONE)" plus the
      // server's protocol_version alert (number 70). ("Protocol : TLSv1.1" alone only echoes what the client asked for.)
      const got11 = /New, TLSv1\.1, Cipher is (?!\(NONE\))/.test(probeOut);
      check('TLS 1.1 is refused on this machine (modern OpenSSL refuses it by default anyway; the SSLProtocol line, checked above, is what guarantees it elsewhere)', !got11 && /alert number 70|alert protocol version/.test(probeOut), probeOut.slice(-300));
      const plain = await request('GET', '/camdash/', { auth: true, where: { host: tlsHost, port: PORT, tls: false } });
      check('plain HTTP keeps working next to HTTPS (HTTPS is optional, not forced)', plain.status === 200, `status=${plain.status}`);
    }
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (child && child.exitCode === null) {
      child.removeAllListeners('exit');
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 3000); });
    }
    if (relay) relay.close();
    for (const d of [site && site.siteRoot, work, certDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  }
  summarize();
}
main();
