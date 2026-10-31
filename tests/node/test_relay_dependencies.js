'use strict';

// test_relay_dependencies.js — the relay's locked dependencies must not go back to versions with known advisories
// (security review R-05, `npm audit` on the Express 5.2.1 tree). Offline: it reads package-lock.json only, so it
// cannot replace `npm audit` (new advisories appear every week — run that now and then), but it catches the
// lockfile quietly being regenerated or reverted to the versions that were vulnerable.
//   body-parser 2.0.0 - 2.3.0   high      denial of service (trailing bytes after a compressed body)  -> 2.4.0
//   proxy-addr  1.1.0 - 2.0.7   critical  IP spoofing with a trust-proxy misconfiguration             -> 2.0.8
//   qs          6.7.0 - 6.16.0  moderate                                                              -> 6.17.0

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const LOCK = path.join(__dirname, '..', '..', 'nodejs', 'camera-relay', 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));

const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10));
// -1, 0 or 1, like a comparator
function compareVersions(a, b) {
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
// every copy of a package in the lockfile (a package can be installed more than once, nested)
function versionsOf(name) {
  return Object.keys(lock.packages || {})
    .filter((p) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`))
    .map((p) => lock.packages[p].version);
}

test('compareVersions: orders versions the way semver does', () => {
  assertEqual(compareVersions('2.3.0', '2.4.0'), -1);
  assertEqual(compareVersions('2.4.0', '2.4.0'), 0);
  assertEqual(compareVersions('2.10.0', '2.4.0'), 1);
  assertEqual(compareVersions('6.17.1', '6.17.0'), 1);
  assertEqual(compareVersions('2.0.7', '2.0.8'), -1);
});

for (const [name, fixedIn] of [['body-parser', '2.4.0'], ['proxy-addr', '2.0.8'], ['qs', '6.17.0']]) {
  test(`package-lock.json: every copy of ${name} is ${fixedIn} or newer`, () => {
    const versions = versionsOf(name);
    assertTrue(versions.length > 0, `${name} is not in the lockfile at all (is the test reading the right file?)`);
    for (const v of versions) assertTrue(compareVersions(v, fixedIn) >= 0, `${name} ${v} is older than ${fixedIn}, which has a known advisory — run: npm audit fix`);
  });
}

test('package-lock.json: express is still the 5.x line the relay is written for', () => {
  const v = versionsOf('express');
  assertTrue(v.length === 1 && v[0].startsWith('5.'), JSON.stringify(v));
});

summarize();
