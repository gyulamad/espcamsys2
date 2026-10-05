'use strict';

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { formatEntry, eventTime, resolveLogConfig, safeToken, DEFAULTS } = require('../../nodejs/camera-relay/lib/logfile');

const T = new Date('2026-10-03T12:00:01.234Z');
const lines = (s) => s.replace(/\n$/, '').split('\n');

test('formatEntry: a camera-reported entry, with every extra', () => {
  const out = formatEntry({
    time: T, level: 'error', sender: 'cam2', ip: '192.168.4.20',
    extras: { uptimeMs: 3621400, heap: 84312, rssi: -71, seq: 42, attempt: 0, lateMs: 300200, fw: 'Oct  3 2026' },
    message: 'Frame capture failed', trace: 'at ESP32_CAM_Recorder.ino:405 loop()',
  });
  assertEqual(lines(out), [
    '2026-10-03T12:00:01.234Z ERROR cam2@192.168.4.20 up=3621.4s heap=84312 rssi=-71 seq=42 late=300.2s fw="Oct  3 2026": Frame capture failed',
    '    at ESP32_CAM_Recorder.ino:405 loop()',
  ]);
  assertTrue(out.endsWith('\n'));
});

test('formatEntry: levels are padded so columns line up', () => {
  assertTrue(formatEntry({ time: T, level: 'INFO', sender: 'x', message: 'm' }).includes('Z INFO  x: m'));
  assertTrue(formatEntry({ time: T, level: 'WARN', sender: 'x', message: 'm' }).includes('Z WARN  x: m'));
});

test('formatEntry: an entry seen by the relay itself says so', () => {
  const out = formatEntry({ time: T, level: 'INFO', sender: 'cam2', ip: '10.0.0.5', via: 'relay', message: 'camera connected' });
  assertEqual(lines(out), ['2026-10-03T12:00:01.234Z INFO  cam2@10.0.0.5 [relay]: camera connected']);
});

test('formatEntry: late= only shows when the entry really was delayed (>= 2s)', () => {
  assertTrue(!formatEntry({ time: T, level: 'INFO', sender: 'c', extras: { lateMs: 1999 }, message: 'm' }).includes('late='));
  assertTrue(formatEntry({ time: T, level: 'INFO', sender: 'c', extras: { lateMs: 2000 }, message: 'm' }).includes('late=2.0s'));
});

test('formatEntry: attempt= only shows for a retried delivery, counted from 1', () => {
  assertTrue(!formatEntry({ time: T, level: 'INFO', sender: 'c', extras: { attempt: 0 }, message: 'm' }).includes('attempt='));
  assertTrue(formatEntry({ time: T, level: 'INFO', sender: 'c', extras: { attempt: 2 }, message: 'm' }).includes('attempt=3'));
});

test('formatEntry: extra message lines and the trace go on indented continuation lines', () => {
  const out = formatEntry({ time: T, level: 'WARN', sender: 'c', message: 'first\nsecond\r\nthird', trace: 'at a.ino:1 f()\nrecent events (oldest first):\n  -3.0s INFO hello\n\n' });
  assertEqual(lines(out), [
    '2026-10-03T12:00:01.234Z WARN  c: first',
    '    | second',
    '    | third',
    '    at a.ino:1 f()',
    '    recent events (oldest first):',
    '      -3.0s INFO hello',
  ]);
});

test('formatEntry: a message can NEVER forge a second log entry', () => {
  const evil = 'x\n2026-01-01T00:00:00.000Z ERROR cam9@6.6.6.6: FORGED\r2026-01-01T00:00:00.000Z ERROR boom';
  const out = formatEntry({ time: T, level: 'INFO', sender: 'cam1', ip: '10.0.0.1', message: evil, trace: evil });
  const headerLike = lines(out).filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
  assertEqual(headerLike.length, 1, 'exactly one line may start like an entry');
  assertTrue(lines(out).slice(1).every((l) => l.startsWith('    ')), 'every continuation line is indented');
});

test('formatEntry: sender / ip / via cannot smuggle spaces or newlines into the header', () => {
  const out = formatEntry({ time: T, level: 'INFO', sender: 'cam 1\nERROR', ip: '1.2.3.4 x', via: 'a]b', message: 'm' });
  assertEqual(lines(out).length, 1);
  assertTrue(/^\S+ INFO  cam_1_ERROR@1\.2\.3\.4_x \[a_b\]: m$/.test(out.trim()), out);
});

test('formatEntry: the firmware id is quoted (it may contain spaces)', () => {
  assertTrue(formatEntry({ time: T, level: 'INFO', sender: 'c', extras: { fw: 'Oct  3 2026 12:00' }, message: 'm' }).includes('fw="Oct  3 2026 12:00"'));
});

test('safeToken: keeps IPv4 / IPv6 style characters', () => {
  assertEqual(safeToken('192.168.4.20'), '192.168.4.20');
  assertEqual(safeToken('fe80::1'), 'fe80::1');
});

test('eventTime: the time an entry HAPPENED = arrival minus its age', () => {
  assertEqual(eventTime(1000000, 300000).getTime(), 700000);
  assertEqual(eventTime(1000000, 0).getTime(), 1000000);
  assertEqual(eventTime(1000000, -5).getTime(), 1000000, 'a negative age is ignored');
  assertEqual(eventTime(1000000, NaN).getTime(), 1000000);
});

test('resolveLogConfig: defaults when nothing is set', () => {
  const r = resolveLogConfig({}, '/relay');
  assertEqual(r.file, path.join('/relay', 'logs', 'camera.log'));
  assertEqual(r.maxBytes, DEFAULTS.maxBytes);
  assertEqual(r.keep, DEFAULTS.keep);
  assertEqual(r.warnings, []);
  assertEqual(resolveLogConfig().keep, DEFAULTS.keep);
});

test('resolveLogConfig: valid values, including numeric strings from env vars; relative paths are relative to the relay folder', () => {
  const r = resolveLogConfig({ file: 'mylogs/c.log', maxBytes: '1048576', keep: '5' }, '/relay');
  assertEqual(r.file, path.resolve('/relay', 'mylogs/c.log'));
  assertEqual(r.maxBytes, 1048576);
  assertEqual(r.keep, 5);
  assertEqual(r.warnings, []);
  assertEqual(resolveLogConfig({ file: '/var/log/cams.log' }, '/relay').file, '/var/log/cams.log');
});

test('resolveLogConfig: unusable values fall back WITH a warning each', () => {
  for (const [key, bad] of [['maxBytes', 100], ['maxBytes', 'lots'], ['maxBytes', -1], ['keep', 0], ['keep', 21], ['keep', 1.5], ['keep', 'x'], ['file', 42], ['file', '   ']]) {
    const r = resolveLogConfig({ [key]: bad }, '/relay');
    assertEqual(r.warnings.length, 1, `${key}=${JSON.stringify(bad)}`);
  }
  assertEqual(resolveLogConfig({ maxBytes: 100 }, '/relay').maxBytes, DEFAULTS.maxBytes);
});

test('resolveLogConfig: null / empty string count as "not set"', () => {
  assertEqual(resolveLogConfig({ file: null, maxBytes: '', keep: undefined }, '/relay').warnings, []);
});

summarize();
