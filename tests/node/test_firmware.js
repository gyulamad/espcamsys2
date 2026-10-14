'use strict';

// Unit tests for lib/firmware.js — what the relay may publish as firmware and how
// it keeps track of the devices that poll. The HTTP side is in
// tests/e2e/test_ota_e2e.js.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const fw = require('../../nodejs/camera-relay/lib/firmware');

const image = (n, magic) => { const b = Buffer.alloc(n, 7); b[0] = magic === undefined ? 0xE9 : magic; return b; };

test('isType: only the two sketch types', () => {
  assertEqual(fw.isType('recorder'), true);
  assertEqual(fw.isType('detector'), true);
  for (const bad of ['Recorder', '../recorder', '', undefined, 3]) assertEqual(fw.isType(bad), false, String(bad));
});

test('isId: the camera-id rule, nothing that could leave the folder', () => {
  for (const ok of ['cam1', 'cam2-human', 'x'.repeat(64)]) assertEqual(fw.isId(ok), true, ok);
  for (const bad of ['', '..', '.x', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'cam1\n', null]) assertEqual(fw.isId(bad), false, String(bad));
});

test('isVersion: git describe output is fine, a "+" or a path is not', () => {
  for (const ok of ['f5959f7', 'v1.2-3-gabcdef0-dirty.t1760000000', 'dev', 'a'.repeat(64)]) assertEqual(fw.isVersion(ok), true, ok);
  for (const bad of ['', 'a+b', '../x', 'a b', 'a'.repeat(65), 'x\n', undefined]) assertEqual(fw.isVersion(bad), false, String(bad));
});

test('cleanToken: hints from a board are cleaned and cut, never refused', () => {
  assertEqual(fw.cleanToken('md5_failed', 40), 'md5_failed');
  assertEqual(fw.cleanToken('bad value\n;x', 40), 'bad_value__x');
  assertEqual(fw.cleanToken('x'.repeat(100), 10), 'xxxxxxxxxx');
  assertEqual(fw.cleanToken(undefined, 10), '');
  assertEqual(fw.cleanToken(['a'], 10), '');
});

test('checkImage: accepts an ESP32 app image of a plausible size', () => {
  assertEqual(fw.checkImage(image(1500000)), { ok: true });
  assertEqual(fw.checkImage(image(fw.MIN_IMAGE_BYTES)), { ok: true });
  assertEqual(fw.checkImage(image(fw.MAX_IMAGE_BYTES)), { ok: true });
});

test('checkImage: refuses a wrong first byte, a tiny or huge body, and a non-buffer', () => {
  assertTrue(!fw.checkImage(image(1500000, 0x3C)).ok);
  assertTrue(/0xE9/.test(fw.checkImage(image(1500000, 0x3C)).error));
  assertTrue(/too small/.test(fw.checkImage(image(fw.MIN_IMAGE_BYTES - 1)).error));
  assertTrue(/too large/.test(fw.checkImage(image(fw.MAX_IMAGE_BYTES + 1)).error));
  assertTrue(!fw.checkImage('text').ok);
  assertTrue(!fw.checkImage(Buffer.alloc(0)).ok);
  assertTrue(!fw.checkImage(undefined).ok);
});

test('md5Hex / makeMeta: the md5 is of the exact bytes', () => {
  assertEqual(fw.md5Hex(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
  const b = image(200000);
  const m = fw.makeMeta('f5959f7', b, Date.UTC(2026, 9, 14, 12, 0, 0));
  assertEqual(m, { version: 'f5959f7', md5: fw.md5Hex(b), size: 200000, uploadedAt: '2026-10-14T12:00:00.000Z' });
});

test('parseMeta: reads back what makeMeta wrote; anything else is "nothing published"', () => {
  const m = fw.makeMeta('abc123', image(200000), 0);
  assertEqual(fw.parseMeta(JSON.stringify(m)), m);
  for (const bad of ['', 'not json', 'null', '[]', '{}',
    JSON.stringify(Object.assign({}, m, { version: 'a b' })),
    JSON.stringify(Object.assign({}, m, { md5: 'XYZ' })),
    JSON.stringify(Object.assign({}, m, { size: 0 })),
    JSON.stringify(Object.assign({}, m, { size: 1.5 }))]) {
    assertEqual(fw.parseMeta(bad), null, bad);
  }
});

test('versionReply: version and md5, one per line', () => {
  assertEqual(fw.versionReply({ version: 'abc', md5: '0'.repeat(32) }), `abc\n${'0'.repeat(32)}\n`);
});

test('binFile / metaFile: <dir>/<type>.bin and .json', () => {
  assertEqual(fw.binFile('/fw', 'recorder'), path.join('/fw', 'recorder.bin'));
  assertEqual(fw.metaFile('/fw', 'detector'), path.join('/fw', 'detector.json'));
});

// ── the device table ────────────────────────────────────────────────────

test('DeviceTable: the first poll is logged once, polls that change nothing are quiet', () => {
  const t = new fw.DeviceTable();
  const first = t.report('recorder', 'cam1', 'aaa', '', 1000);
  assertEqual(first.length, 1);
  assertEqual(first[0].level, 'INFO');
  assertTrue(first[0].message.includes('cam1') && first[0].message.includes('aaa'));
  assertEqual(t.report('recorder', 'cam1', 'aaa', '', 61000), []);
  assertEqual(t.report('recorder', 'cam1', 'aaa', '', 121000), []);
});

test('DeviceTable: a new running version is logged with the old one', () => {
  const t = new fw.DeviceTable();
  t.report('recorder', 'cam1', 'aaa', '', 1000);
  const ev = t.report('recorder', 'cam1', 'bbb', '', 2000);
  assertEqual(ev, [{ level: 'INFO', message: 'cam1 now runs bbb (was aaa)' }]);
});

test('DeviceTable: a failure the board reports is a WARN with the reason', () => {
  const t = new fw.DeviceTable();
  t.report('detector', 'cam2-human', 'aaa', '', 1000);
  const ev = t.report('detector', 'cam2-human', 'aaa', 'md5_failed', 2000);
  assertEqual(ev, [{ level: 'WARN', message: 'cam2-human firmware update failed: md5_failed' }]);
});

test('DeviceTable: the same id under two types is two devices', () => {
  const t = new fw.DeviceTable();
  t.report('recorder', 'cam1', 'aaa', '', 1000);
  assertEqual(t.report('detector', 'cam1', 'aaa', '', 1000).length, 1);
  assertEqual(t.statusText({ recorder: null, detector: null }, 2000).trim().split('\n').length, 2);
});

test('DeviceTable: stays bounded', () => {
  const t = new fw.DeviceTable();
  for (let i = 0; i < 1100; i += 1) t.report('recorder', `c${i}`, 'x', '', i);
  assertTrue(t.devices.size <= 1000);
});

test('statusText: updated / pending / offline / nothing-published, tab separated', () => {
  const t = new fw.DeviceTable();
  const now = 1000000;
  t.report('recorder', 'cam1', 'new', '', now - 5000);        // runs the target
  t.report('recorder', 'cam2', 'old', '', now - 30000);       // behind, but recently seen
  t.report('recorder', 'cam3', 'old', '', now - 11 * 60000);  // behind and gone quiet
  t.report('detector', 'cam4', 'old', '', now - 1000);        // nothing published for detectors
  const lines = t.statusText({ recorder: { version: 'new' }, detector: null }, now).trim().split('\n').map((l) => l.split('\t'));
  assertEqual(lines[0], ['cam1', 'recorder', 'new', 'new', 'updated', '5s', '-']);
  assertEqual(lines[1], ['cam2', 'recorder', 'new', 'old', 'pending', '30s', '-']);
  assertEqual(lines[2], ['cam3', 'recorder', 'new', 'old', 'offline', '660s', '-']);
  assertEqual(lines[3], ['cam4', 'detector', '-', 'old', 'nothing-published', '1s', '-']);
});

test('statusText: the last error shows while the update is outstanding, not after it worked', () => {
  const t = new fw.DeviceTable();
  t.report('recorder', 'cam1', 'old', 'http_404', 1000);
  assertEqual(t.statusText({ recorder: { version: 'new' } }, 2000).split('\t')[6].trim(), 'http_404');
  t.report('recorder', 'cam1', 'new', '', 3000);
  assertEqual(t.statusText({ recorder: { version: 'new' } }, 4000).trim().split('\t')[6], '-');
});

test('statusText: empty table is empty text', () => {
  assertEqual(new fw.DeviceTable().statusText({}, 1), '');
});

summarize();
