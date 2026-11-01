'use strict';

// test_diskspace.js — the relay's free-space check (lib/diskspace.js): reading `df` and statfs answers,
// never throwing on a failed read, and deciding whether the free space is below the minimum.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ds = require('../../nodejs/camera-relay/lib/diskspace');

const DF_OK = 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/mmcblk0p2    29758000 24000000   4194304      86% /\n';
const MIB = 1024 * 1024;

// ── parseDfFreeBytes ────────────────────────────────────────────────

test('parseDfFreeBytes: takes the Available column (in KiB) and returns bytes', () => {
  assertEqual(ds.parseDfFreeBytes(DF_OK), 4194304 * 1024);
});

test('parseDfFreeBytes: a filesystem name or mount point with spaces does not shift the columns', () => {
  const text = 'Filesystem 1024-blocks Used Available Capacity Mounted on\nmy usb disk 1000 400 600 40% /media/my usb disk\n';
  assertEqual(ds.parseDfFreeBytes(text), 600 * 1024);
});

test('parseDfFreeBytes: no space left is zero, not unknown', () => {
  assertEqual(ds.parseDfFreeBytes('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1000 1000 0 100% /\n'), 0);
});

test('parseDfFreeBytes: anything that is not a df table is null', () => {
  for (const bad of [undefined, null, 42, {}, '', '   ', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n',
    'df: /nope: No such file or directory', 'Filesystem a b c d e\n/dev/x one two three four% /\n']) {
    assertEqual(ds.parseDfFreeBytes(bad), null, JSON.stringify(bad));
  }
});

test('parseDfFreeBytes: a number too large to be exact is null rather than a wrong answer', () => {
  assertEqual(ds.parseDfFreeBytes('H\n/dev/x 1 1 99999999999999999999 1% /\n'), null);
});

// ── freeBytesFromStatfs ─────────────────────────────────────────────

test('freeBytesFromStatfs: what a normal user may still use (bavail x bsize)', () => {
  assertEqual(ds.freeBytesFromStatfs({ bavail: 1000, bfree: 5000, bsize: 4096 }), 4096000);
  assertEqual(ds.freeBytesFromStatfs({ bavail: 0, bsize: 4096 }), 0);
});

test('freeBytesFromStatfs: junk is null', () => {
  for (const bad of [undefined, null, 'x', 5, {}, { bavail: 'a', bsize: 4096 }, { bavail: -1, bsize: 4096 }, { bavail: 1 }]) {
    assertEqual(ds.freeBytesFromStatfs(bad), null, JSON.stringify(bad));
  }
});

// ── buildStorageView ────────────────────────────────────────────────

test('buildStorageView: low only when the free space is BELOW the minimum', () => {
  assertEqual(ds.buildStorageView(999 * MIB, 1000), { known: true, freeMB: 999, minFreeMB: 1000, low: true });
  assertEqual(ds.buildStorageView(1000 * MIB, 1000), { known: true, freeMB: 1000, minFreeMB: 1000, low: false });
  assertEqual(ds.buildStorageView(5000 * MIB, 1000).low, false);
});

test('buildStorageView: a minimum of 0 switches the warning off, even on an empty disk', () => {
  assertEqual(ds.buildStorageView(0, 0), { known: true, freeMB: 0, minFreeMB: 0, low: false });
});

test('buildStorageView: free MB is rounded DOWN, and the comparison uses exact bytes', () => {
  const justUnder = 1000 * MIB - 1;
  assertEqual(ds.buildStorageView(justUnder, 1000), { known: true, freeMB: 999, minFreeMB: 1000, low: true });
});

test('buildStorageView: an unreadable disk is unknown and never a warning', () => {
  assertEqual(ds.buildStorageView(null, 1000), { known: false, minFreeMB: 1000, low: false });
});

// ── readFreeBytes (the part that asks the system) ───────────────────

(async () => {
  const calls = [];
  const execOk = (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(DF_OK); };

  const viaDf = await ds.readFreeBytes('/srv/rec', { execFile: execOk });
  test('readFreeBytes: without statfs it runs `df -Pk <dir>` (no shell, the folder is one argument)', () => {
    assertEqual(viaDf, 4194304 * 1024);
    assertEqual(calls, [['df', ['-Pk', '/srv/rec']]]);
  });

  const viaStatfs = await ds.readFreeBytes('/srv/rec', { statfs: () => Promise.resolve({ bavail: 10, bsize: 512 }), execFile: () => { throw new Error('must not run df'); } });
  test('readFreeBytes: with statfs available it does not run df', () => {
    assertEqual(viaStatfs, 5120);
  });

  const folder = '/tmp/a folder; rm -rf $HOME';
  calls.length = 0;
  await ds.readFreeBytes(folder, { execFile: execOk });
  test('readFreeBytes: a folder name is never interpreted — it stays one argument', () => {
    assertEqual(calls[0][1], ['-Pk', folder]);
  });

  const failedDf = await ds.readFreeBytes('/x', { execFile: () => Promise.reject(new Error('df not found')) });
  const failedStatfs = await ds.readFreeBytes('/x', { statfs: () => Promise.reject(new Error('EIO')) });
  const throwsSync = await ds.readFreeBytes('/x', { execFile: () => { throw new Error('spawn failed'); } });
  const garbage = await ds.readFreeBytes('/x', { execFile: () => Promise.resolve('what?') });
  test('readFreeBytes: every failure is null, never an exception', () => {
    assertEqual([failedDf, failedStatfs, throwsSync, garbage], [null, null, null, null]);
  });

  const nearlyFull = 'H\n/dev/x 29000000 28900000 100000 99% /\n'; // ~97 MiB free
  const chain = ds.buildStorageView(await ds.readFreeBytes('/x', { execFile: () => Promise.resolve(nearlyFull) }), 1024);
  test('readFreeBytes + buildStorageView: the whole chain flags a nearly full disk', () => {
    assertTrue(chain.low === true && chain.freeMB === 97, JSON.stringify(chain));
  });

  summarize();
})();
