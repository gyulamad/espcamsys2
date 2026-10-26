#!/usr/bin/env node
'use strict';
// test_deploy_e2e.js — deploy.sh puts the dashboard in ONE place, /var/www/html/camdash (where it has
// always gone), and never makes a second folder. Runs the REAL script against throwaway folders
// (CAMDASH_DIR / CAMDASH_STRAY_DIR). Checks that:
//   - the pages, lib/ and .htaccess are copied; a stale control.php and config.php.bak are removed
//   - config.php is never created or changed by the script (the owner's login is never touched)
//   - config.php becomes mode 640 (and owned by www-data when run as root)
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
let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}

function deploy(dest, stray) {
  const r = spawnSync('bash', [path.join(ROOT, 'deploy.sh')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CAMDASH_DIR: dest, CAMDASH_STRAY_DIR: stray } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-deploy-'));
try {
  // ── 1. fresh install ──
  let dest = path.join(base, 'html-camdash');
  let stray = path.join(base, 'no-such-stray');
  let r = deploy(dest, stray);
  check('deploy.sh succeeds', r.status === 0, r.out);
  check('the pages and lib/ are copied', fs.existsSync(path.join(dest, 'index.php')) && fs.existsSync(path.join(dest, 'lib/Logic.php')) && fs.existsSync(path.join(dest, 'auth.php')));
  check('.htaccess is copied', fs.existsSync(path.join(dest, '.htaccess')));
  check('no config.php is invented — and the owner is told to create one', !fs.existsSync(path.join(dest, 'config.php')) && /no .*config\.php yet/.test(r.out), r.out);
  check('no note about a stray folder when there is none', !/stray/.test(r.out), r.out);
  check('exactly one folder was created (no second copy anywhere)', fs.readdirSync(base).sort().join(',') === 'html-camdash', fs.readdirSync(base).join(','));

  // ── 2. an update of a working install ──
  dest = path.join(base, 'live');
  fs.mkdirSync(dest, { recursive: true });
  const myConfig = '<?php return ["auth_user" => "keep-me", "auth_pass" => "my-secret-pass"];\n';
  fs.writeFileSync(path.join(dest, 'config.php'), myConfig, { mode: 0o644 });
  fs.writeFileSync(path.join(dest, 'config.php.bak'), 'SECRET\n');
  fs.writeFileSync(path.join(dest, 'control.php'), '<?php // stale\n');
  fs.writeFileSync(path.join(dest, 'index.php'), '<?php // OLD\n');
  r = deploy(dest, stray);
  check('the pages are updated', !fs.readFileSync(path.join(dest, 'index.php'), 'utf8').includes('// OLD'), r.out);
  check('config.php is byte-for-byte what the owner had (never overwritten)', fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === myConfig);
  check('a leftover config.php.bak and the retired control.php are removed', !fs.existsSync(path.join(dest, 'config.php.bak')) && !fs.existsSync(path.join(dest, 'control.php')));
  check('config.php is mode 640 (not readable by other users)', mode(path.join(dest, 'config.php')) === '640', mode(path.join(dest, 'config.php')));
  check('with a config present there is no "create one" note', !/no .*config\.php yet/.test(r.out), r.out);
  r = deploy(dest, stray);
  check('running it twice is safe and changes nothing in config.php', r.status === 0 && fs.readFileSync(path.join(dest, 'config.php'), 'utf8') === myConfig);
  if (process.getuid && process.getuid() === 0 && spawnSync('id', ['www-data'], { stdio: 'ignore' }).status === 0) {
    const owner = spawnSync('stat', ['-c', '%U', path.join(dest, 'config.php')], { encoding: 'utf8' }).stdout.trim();
    check('config.php is owned by www-data (the settings page can rewrite it)', owner === 'www-data', owner);
  } else {
    console.log('SKIP: owner check (needs root and a www-data user)');
  }

  // ── 3. the stray second folder ──
  stray = path.join(base, 'stray-copy');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'config.php'), '<?php // stray\n');
  r = deploy(dest, stray);
  check('a stray second folder is pointed out', /NOTE .*stray-copy exists/.test(r.out) && /stray copy an earlier version/.test(r.out), r.out);
  check('...with the commands to find out which folder Apache serves, before deleting', /DocumentRoot/.test(r.out) && /sites-enabled/.test(r.out) && /rm -rf .*stray-copy/.test(r.out), r.out);
  check('...and the script itself deletes nothing and does not use it', fs.existsSync(path.join(stray, 'config.php')) && fs.readFileSync(path.join(stray, 'config.php'), 'utf8') === '<?php // stray\n');
  r = deploy(stray, stray);
  check('no note when the stray folder IS the destination', !/NOTE .*exists/.test(r.out), r.out);

  // ── 4. the script itself ──
  const src = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  check('the default destination is /var/www/html/camdash, as it always was', /DEST="\$\{CAMDASH_DIR:-\/var\/www\/html\/camdash\}"/.test(src));
  check('the script copies only into $DEST (no other folder is ever a target)', !/\bcp\b[^\n]*\/var\/www\/camdash\b/.test(src) && !/\bmkdir\b[^\n]*\/var\/www\/camdash\b/.test(src));
  check('apache/camdash-protect.conf protects the very same default folder', /^Define CAMDASH_DIR \/var\/www\/html\/camdash$/m.test(fs.readFileSync(path.join(ROOT, 'apache/camdash-protect.conf'), 'utf8')));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount === 0 ? 0 : 1;
