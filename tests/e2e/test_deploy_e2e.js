#!/usr/bin/env node
'use strict';
// test_deploy_e2e.js — deploy.sh puts the dashboard in ONE place, /var/www/html/camdash (where it has
// always gone), and never makes a second folder. Runs the REAL script inside its own throwaway copy of
// the repo (so the developer's own php/cameras/config.php, which is gitignored and may well exist, can
// never change the result), against throwaway destination folders (CAMDASH_DIR / CAMDASH_STRAY_DIR).
// Works as root and as a normal user. Checks that:
//   - the pages, lib/ and .htaccess are copied; a stale control.php and config.php.bak are removed
//   - a config.php already in the web folder is left alone when the repo has none
//   - a config.php kept in php/cameras/ is copied along, as the script always did — and when that
//     REPLACES a different one the owner is told first (settings saved on the dashboard would be lost)
//   - as root: the data/ folder is made (mode 700, owned by www-data, never served) and config.php becomes
//     READ-ONLY for the web server (owner root, group www-data, mode 640); settings saved on the dashboard
//     (data/settings.json) are never touched by a deploy, and the owner is told which of them win over
//     config.php. As a normal user: nothing is changed and the owner is told to use sudo
//   - a missing config.php is said out loud
//   - a stray second folder (what an earlier version of the script made) is pointed out, with how to
//     check which folder is live before deleting it — and no such note when there is none
//   - the default destination is /var/www/html/camdash, and the script mentions no other folder as a target
//
// Usage:  node tests/e2e/test_deploy_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_WWW_DATA = spawnSync('id', ['www-data'], { stdio: 'ignore' }).status === 0;
let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}

// A copy of what deploy.sh looks at: itself and php/cameras/ (+ lib/). repoConfig = text of a
// php/cameras/config.php, or null for none.
function makeRepo(base, name, repoConfig) {
  const repo = path.join(base, name);
  fs.mkdirSync(path.join(repo, 'php'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'deploy.sh'), path.join(repo, 'deploy.sh'));
  spawnSync('cp', ['-r', path.join(ROOT, 'php/cameras'), path.join(repo, 'php/cameras')]);
  fs.rmSync(path.join(repo, 'php/cameras/config.php'), { force: true });
  if (repoConfig !== null) fs.writeFileSync(path.join(repo, 'php/cameras/config.php'), repoConfig);
  return repo;
}
function deploy(repo, dest, stray) {
  const r = spawnSync('bash', ['./deploy.sh'], { cwd: repo, encoding: 'utf8', env: { ...process.env, CAMDASH_DIR: dest, CAMDASH_STRAY_DIR: stray } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-deploy-'));
try {
  const noStray = path.join(base, 'no-such-stray');

  // ── 1. fresh install, no config anywhere ──
  let repo = makeRepo(base, 'repo1', null);
  let dest = path.join(base, 'html-camdash');
  let r = deploy(repo, dest, noStray);
  check('deploy.sh succeeds', r.status === 0, r.out);
  check('the pages and lib/ are copied', fs.existsSync(path.join(dest, 'index.php')) && fs.existsSync(path.join(dest, 'lib/Logic.php')) && fs.existsSync(path.join(dest, 'auth.php')));
  check('.htaccess is copied', fs.existsSync(path.join(dest, '.htaccess')));
  check('no config.php is invented — and the owner is told to create one', !fs.existsSync(path.join(dest, 'config.php')) && /no .*config\.php yet/.test(r.out), r.out);
  check('no note about a stray folder when there is none', !/stray/.test(r.out), r.out);
  if (IS_ROOT && HAS_WWW_DATA) {
    check('as root: the data/ folder is made, mode 700, with a deny file', fs.statSync(path.join(dest, 'data')).isDirectory() && mode(path.join(dest, 'data')) === '700' && fs.existsSync(path.join(dest, 'data/.htaccess')));
  } else {
    check('as a normal user: no data/ folder is made', !fs.existsSync(path.join(dest, 'data')));
  }
  check('exactly one destination folder was created (no second copy anywhere)', fs.readdirSync(base).filter((n) => !n.startsWith('repo')).sort().join(',') === 'html-camdash', fs.readdirSync(base).join(','));

  // ── 2. an update of a working install; the repo has no config.php ──
  dest = path.join(base, 'live');
  fs.mkdirSync(dest, { recursive: true });
  const myConfig = '<?php return ["auth_user" => "keep-me", "auth_pass" => "my-secret-pass"];\n';
  fs.writeFileSync(path.join(dest, 'config.php'), myConfig, { mode: 0o644 });
  fs.chmodSync(path.join(dest, 'config.php'), 0o644);
  fs.writeFileSync(path.join(dest, 'config.php.bak'), 'SECRET\n');
  fs.writeFileSync(path.join(dest, 'control.php'), '<?php // stale\n');
  fs.writeFileSync(path.join(dest, 'index.php'), '<?php // OLD\n');
  r = deploy(repo, dest, noStray);
  check('the pages are updated', !fs.readFileSync(path.join(dest, 'index.php'), 'utf8').includes('// OLD'), r.out);
  check('the web folder\'s config.php is byte-for-byte what the owner had (the repo has none to replace it)', fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === myConfig);
  check('a leftover config.php.bak and the retired control.php are removed', !fs.existsSync(path.join(dest, 'config.php.bak')) && !fs.existsSync(path.join(dest, 'control.php')));
  if (IS_ROOT && HAS_WWW_DATA) {
    check('as root: config.php is mode 640 (not readable by other users)', mode(path.join(dest, 'config.php')) === '640', mode(path.join(dest, 'config.php')));
    const who = spawnSync('stat', ['-c', '%U:%G', path.join(dest, 'config.php')], { encoding: 'utf8' }).stdout.trim();
    check('as root: config.php belongs to root, group www-data: READ-ONLY for the web server', who === 'root:www-data', who);
    const dwho = spawnSync('stat', ['-c', '%U %a', path.join(dest, 'data')], { encoding: 'utf8' }).stdout.trim();
    check('as root: data/ belongs to www-data, mode 700 (the only place the web server may write)', dwho === 'www-data 700', dwho);
    check('as root: the owner is told config.php is read-only and where settings are saved', /read-only for the web server/.test(r.out) && /data\/settings\.json/.test(r.out), r.out);
    check('as root: no "use sudo" note', !/not run as root/.test(r.out), r.out);
    // settings saved on the dashboard are never touched by a deploy, and the owner is told what they override
    fs.writeFileSync(path.join(dest, 'data/settings.json'), '{\n    "auth_pass": "saved-on-dashboard",\n    "cameras": [\n        {\n            "id": "x"\n        }\n    ]\n}\n');
    const savedBefore = fs.readFileSync(path.join(dest, 'data/settings.json'), 'utf8');
    r = deploy(repo, dest, noStray);
    check('as root: a deploy never touches data/settings.json', fs.readFileSync(path.join(dest, 'data/settings.json'), 'utf8') === savedBefore);
    check('...and tells the owner which settings saved on the dashboard win over config.php', /win over config\.php for: auth_pass cameras/.test(r.out), r.out);
    fs.rmSync(path.join(dest, 'data/settings.json'), { force: true });
  } else {
    check('as a normal user: the file mode is left alone (640 on a file you own would lock the web server out)', mode(path.join(dest, 'config.php')) === '644', mode(path.join(dest, 'config.php')));
    check('as a normal user: the owner is told to run it with sudo, and nothing failed noisily', /not run as root/.test(r.out) && !/Operation not permitted/.test(r.out) && r.status === 0, r.out);
    check('as a normal user: no data/ folder is made, so the dashboard keeps saving into config.php as before', !fs.existsSync(path.join(dest, 'data')));
  }
  check('with a config present there is no "create one" note', !/no .*config\.php yet/.test(r.out), r.out);
  r = deploy(repo, dest, noStray);
  check('running it twice is safe and changes nothing in config.php', r.status === 0 && fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === myConfig);

  // ── 3. the repo keeps its own config.php (gitignored): copied along, as it always was ──
  const repoConfig = '<?php return ["auth_user" => "from-repo", "auth_pass" => "repo-secret-pass"];\n';
  repo = makeRepo(base, 'repo3', repoConfig);
  r = deploy(repo, dest, noStray);
  check('a config.php kept in php/cameras/ is copied along, as the script always did', fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === repoConfig, r.out);
  r = deploy(repo, dest, noStray);
  check('...and when both are the same there is no warning', !/differs from/.test(r.out), r.out);
  fs.writeFileSync(path.join(dest, 'config.php'), '<?php return ["auth_user" => "hand-edited-in-the-web-folder"];\n');
  r = deploy(repo, dest, noStray);
  if (fs.existsSync(path.join(dest, 'data'))) {
    check('...with the data/ folder, replacing config.php loses nothing (what the dashboard saved is in data/), so there is no warning', !/differs from/.test(r.out) && fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === repoConfig, r.out);
    fs.rmSync(path.join(dest, 'data'), { recursive: true, force: true });   // back to the old way, to see the warning
  }
  fs.writeFileSync(path.join(dest, 'config.php'), '<?php return ["auth_user" => "saved-on-the-dashboard"];\n');
  r = deploy(repo, dest, noStray);
  check('...in the old way (no data/), when it REPLACES a different one the owner is warned that dashboard-saved settings are lost', /php\/cameras\/config\.php differs from .*config\.php and replaces it/.test(r.out) && /Settings saved on the dashboard/.test(r.out), r.out);
  const fresh = path.join(base, 'fresh-dest');
  r = deploy(repo, fresh, noStray);
  check('...no warning on a first deploy (nothing is replaced)', !/differs from/.test(r.out) && fs.readFileSync(path.join(fresh, 'config.php'), 'utf8') === repoConfig, r.out);

  // ── 4. the stray second folder ──
  repo = makeRepo(base, 'repo4', null);
  const stray = path.join(base, 'stray-copy');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'config.php'), '<?php // stray\n');
  r = deploy(repo, dest, stray);
  check('a stray second folder is pointed out', /NOTE .*stray-copy exists/.test(r.out) && /stray copy an earlier version/.test(r.out), r.out);
  check('...with the commands to find out which folder Apache serves, before deleting', /DocumentRoot/.test(r.out) && /sites-enabled/.test(r.out) && /rm -rf .*stray-copy/.test(r.out), r.out);
  check('...and the script itself deletes nothing and does not use it', fs.existsSync(path.join(stray, 'config.php')) && fs.readFileSync(path.join(stray, 'config.php'), 'utf8') === '<?php // stray\n');
  r = deploy(repo, stray, stray);
  check('no note when the stray folder IS the destination', !/NOTE .*exists/.test(r.out), r.out);

  // ── 5. the script itself ──
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  check('the default destination is /var/www/html/camdash, as it always was', /DEST="\$\{CAMDASH_DIR:-\/var\/www\/html\/camdash\}"/.test(src));
  check('the script copies only into $DEST (no other folder is ever a target)', !/\bcp\b[^\n]*\/var\/www\/camdash\b/.test(src) && !/\bmkdir\b[^\n]*\/var\/www\/camdash\b/.test(src));
  check('apache/camdash-protect.conf protects the very same default folder', /^Define CAMDASH_DIR \/var\/www\/html\/camdash$/m.test(fs.readFileSync(path.join(ROOT, 'apache/camdash-protect.conf'), 'utf8')));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount === 0 ? 0 : 1;
