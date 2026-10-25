#!/usr/bin/env node
'use strict';
// test_deploy_e2e.js — F-07: deploy.sh puts the dashboard where INSTALL.md and apache/camdash.conf
// expect it (/var/www/camdash, not the default site's /var/www/html/camdash that answers on the LAN),
// without ever losing the owner's config.php. Runs the REAL script against throwaway folders
// (CAMDASH_DIR / CAMDASH_LEGACY_DIR). Checks that:
//   - the pages, lib/ and .htaccess are copied; stale control.php and config.php.bak are removed
//   - an existing config.php at the old location is carried over (copied, the old one stays), and an
//     existing config.php at the new location is never overwritten
//   - config.php becomes mode 640 (and owned by www-data when run as root)
//   - a leftover old folder is reported loudly; without one there is no such warning
//   - a missing config.php is said out loud
//
// Usage:  node tests/e2e/test_deploy_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}

function deploy(dest, legacy) {
  const r = spawnSync('bash', [path.join(ROOT, 'deploy.sh')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CAMDASH_DIR: dest, CAMDASH_LEGACY_DIR: legacy } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-deploy-'));
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

const base = tmp();
try {
  // ── 1. fresh install, nothing old around ──
  let dest = path.join(base, 'new1');
  let legacy = path.join(base, 'old-none');
  let r = deploy(dest, legacy);
  check('deploy.sh succeeds', r.status === 0, r.out);
  check('the pages and lib/ are copied', fs.existsSync(path.join(dest, 'index.php')) && fs.existsSync(path.join(dest, 'lib/Logic.php')) && fs.existsSync(path.join(dest, 'auth.php')));
  check('.htaccess is copied (the vhost does not depend on it, but it is the second lock)', fs.existsSync(path.join(dest, '.htaccess')));
  check('no config.php is invented — and the owner is told to create one', !fs.existsSync(path.join(dest, 'config.php')) && /no .*config\.php yet/.test(r.out), r.out);
  check('no warning about an old folder when there is none', !/WARNING the old copy/.test(r.out), r.out);

  // ── 2. upgrade from the old location ──
  dest = path.join(base, 'new2');
  legacy = path.join(base, 'old2');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.php'), '<?php return ["auth_user" => "keep-me"];\n');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'config.php.bak'), 'SECRET\n');
  fs.writeFileSync(path.join(dest, 'control.php'), '<?php // stale\n');
  r = deploy(dest, legacy);
  check('config.php is carried over from the old location', fs.readFileSync(path.join(dest, 'config.php'), 'utf8').includes('keep-me'), r.out);
  check('...as a copy: the old one is still there (nothing is lost)', fs.existsSync(path.join(legacy, 'config.php')));
  check('a leftover config.php.bak and the retired control.php are removed', !fs.existsSync(path.join(dest, 'config.php.bak')) && !fs.existsSync(path.join(dest, 'control.php')));
  check('config.php is mode 640 (not readable by other users)', mode(path.join(dest, 'config.php')) === '640', mode(path.join(dest, 'config.php')));
  check('the old folder is reported as a leftover that Apache\'s default site would serve', /WARNING the old copy .* still exists/.test(r.out) && /rm -rf/.test(r.out), r.out);

  // ── 3. an existing config at the new location is never overwritten ──
  dest = path.join(base, 'new3');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'config.php'), '<?php return ["auth_user" => "already-here"];\n');
  r = deploy(dest, legacy);
  check('an existing config.php at the new location is not overwritten', fs.readFileSync(path.join(dest, 'config.php'), 'utf8').includes('already-here'), r.out);
  r = deploy(dest, legacy);
  check('running it twice is safe', r.status === 0 && fs.readFileSync(path.join(dest, 'config.php'), 'utf8').includes('already-here'));

  // ── 4. owner (only when allowed to chown, i.e. as root) ──
  if (process.getuid && process.getuid() === 0 && spawnSync('id', ['www-data'], { stdio: 'ignore' }).status === 0) {
    const owner = spawnSync('stat', ['-c', '%U', path.join(dest, 'config.php')], { encoding: 'utf8' }).stdout.trim();
    check('config.php is owned by www-data (the settings page can rewrite it)', owner === 'www-data', owner);
  } else {
    console.log('SKIP: owner check (needs root and a www-data user)');
  }

  // ── 5. the script itself ──
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  check('the default destination is the INSTALL.md / vhost folder', /DEST="\$\{CAMDASH_DIR:-\/var\/www\/camdash\}"/.test(src));
  check('the default site folder is no longer a destination', !/cp .* \/var\/www\/html\/camdash/.test(src));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount === 0 ? 0 : 1;
