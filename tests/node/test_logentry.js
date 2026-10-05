'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { cleanText, normalizeLevel, parseLogBatch, LIMITS } = require('../../nodejs/camera-relay/lib/logentry');

const good = (over = {}) => Object.assign({
  camera: 'cam2', fw: 'Oct  3 2026', attempt: 0, dropped: 0,
  entries: [{ seq: 1, level: 'ERROR', ageMs: 1500, uptimeMs: 99000, heap: 120000, rssi: -71, message: 'boom', trace: 'at x.ino:1 f()' }],
}, over);

// ── cleanText ──
test('cleanText: strips control characters but keeps newlines and tabs', () => {
  assertEqual(cleanText('a\u0000b\u0007c\td\ne\u007Ff', 100), 'abc\td\nef');
});
test('cleanText: normalises CRLF / CR to LF, and removes unicode line separators', () => {
  assertEqual(cleanText('a\r\nb\rc\u2028d\u2029e', 100), 'a\nb\ncde');
});
test('cleanText: caps the length and marks the cut', () => {
  const out = cleanText('x'.repeat(50), 20);
  assertEqual(out.length, 20);
  assertTrue(out.endsWith('...'));
});
test('cleanText: non-strings become empty', () => {
  assertEqual(cleanText(undefined, 10), '');
  assertEqual(cleanText(42, 10), '');
  assertEqual(cleanText({}, 10), '');
});

// ── normalizeLevel ──
test('normalizeLevel: accepts any case, WARNING, and falls back to INFO', () => {
  assertEqual(normalizeLevel('error'), 'ERROR');
  assertEqual(normalizeLevel(' Warn '), 'WARN');
  assertEqual(normalizeLevel('warning'), 'WARN');
  assertEqual(normalizeLevel('debug'), 'DEBUG');
  assertEqual(normalizeLevel('FATAL'), 'INFO');
  assertEqual(normalizeLevel(undefined), 'INFO');
  assertEqual(normalizeLevel(5), 'INFO');
});

// ── parseLogBatch ──
test('parseLogBatch: a complete valid batch', () => {
  const r = parseLogBatch(good());
  assertTrue(r.ok);
  assertEqual(r.rejected, 0);
  assertEqual(r.batch.camera, 'cam2');
  assertEqual(r.batch.fw, 'Oct  3 2026');
  assertEqual(r.batch.entries[0], { seq: 1, level: 'ERROR', ageMs: 1500, uptimeMs: 99000, heap: 120000, rssi: -71, message: 'boom', trace: 'at x.ino:1 f()' });
});

test('parseLogBatch: optional fields default sensibly', () => {
  const r = parseLogBatch({ camera: 'cam1', entries: [{ message: 'hi' }] });
  assertTrue(r.ok);
  assertEqual(r.batch.entries[0], { seq: null, level: 'INFO', ageMs: 0, uptimeMs: null, heap: null, rssi: null, message: 'hi', trace: '' });
  assertEqual(r.batch.attempt, 0);
  assertEqual(r.batch.dropped, 0);
  assertEqual(r.batch.fw, '');
});

test('parseLogBatch: a negative RSSI is fine, a non-integer number is "not provided"', () => {
  const r = parseLogBatch({ camera: 'c', entries: [{ message: 'm', rssi: -90, heap: 1.5, uptimeMs: -3 }] });
  assertEqual(r.batch.entries[0].rssi, -90);
  assertEqual(r.batch.entries[0].heap, null);
  assertEqual(r.batch.entries[0].uptimeMs, null);
});

test('parseLogBatch: an absurd age is treated as unknown (0), not trusted', () => {
  const r = parseLogBatch({ camera: 'c', entries: [{ message: 'm', ageMs: LIMITS.maxAgeMs + 1 }, { message: 'n', ageMs: -5 }] });
  assertEqual(r.batch.entries.map((e) => e.ageMs), [0, 0]);
});

test('parseLogBatch: rejects bodies that are not an object', () => {
  for (const bad of [null, undefined, 'x', 5, [], [{ message: 'a' }]]) {
    assertEqual(parseLogBatch(bad).ok, false, JSON.stringify(bad));
  }
});

test('parseLogBatch: rejects a missing or unsafe camera id', () => {
  for (const camera of [undefined, '', 'a b', '../x', 'cam/1', 'x'.repeat(65), 7, 'ca\nm']) {
    assertEqual(parseLogBatch(good({ camera })).ok, false, JSON.stringify(camera));
  }
});

test('parseLogBatch: rejects empty / missing / oversized entries lists', () => {
  assertEqual(parseLogBatch(good({ entries: [] })).ok, false);
  assertEqual(parseLogBatch(good({ entries: undefined })).ok, false);
  assertEqual(parseLogBatch(good({ entries: 'x' })).ok, false);
  const many = Array.from({ length: LIMITS.entriesPerBatch + 1 }, () => ({ message: 'm' }));
  assertEqual(parseLogBatch(good({ entries: many })).ok, false);
});

test('parseLogBatch: skips unusable entries and counts them, keeps the good ones', () => {
  const r = parseLogBatch(good({ entries: [{ message: 'ok' }, { message: '' }, { level: 'ERROR' }, null, 'str', { message: 'ok2' }] }));
  assertTrue(r.ok);
  assertEqual(r.rejected, 4);
  assertEqual(r.batch.entries.map((e) => e.message), ['ok', 'ok2']);
});

test('parseLogBatch: when NO entry is usable the whole batch is an error', () => {
  assertEqual(parseLogBatch(good({ entries: [{ message: '' }, {}] })).ok, false);
});

test('parseLogBatch: message text is cleaned and capped; the firmware id cannot contain a newline', () => {
  const r = parseLogBatch(good({ fw: 'a\nb', entries: [{ message: 'x\u0000y\r\nz'.padEnd(LIMITS.message + 100, 'q') }] }));
  assertEqual(r.batch.fw, 'a b');
  assertEqual(r.batch.entries[0].message.length, LIMITS.message);
  assertTrue(!/\u0000|\r/.test(r.batch.entries[0].message));
});

test('parseLogBatch: attempt / dropped are whole non-negative numbers, else 0', () => {
  const r = parseLogBatch(good({ attempt: 3, dropped: 12 }));
  assertEqual([r.batch.attempt, r.batch.dropped], [3, 12]);
  const r2 = parseLogBatch(good({ attempt: -1, dropped: 'many' }));
  assertEqual([r2.batch.attempt, r2.batch.dropped], [0, 0]);
});

// The EXACT body the firmware's appendBatchJson() produces for this entry — the same literal is pinned
// by tests/cpp/test_remote_log.cpp (json_batch_exact_shape). Each side is tested on its own, so this
// shared string is what stops them drifting apart (a renamed field would otherwise pass every test and
// fail on a real camera).
test('parseLogBatch accepts exactly what the firmware sends (contract with tests/cpp/test_remote_log.cpp)', () => {
  const firmwareBody = '{"camera":"cam2","fw":"Oct  3 2026","attempt":2,"dropped":5,"entries":['
    + '{"seq":7,"level":"ERROR","ageMs":5000,"uptimeMs":9000,"heap":84312,"rssi":-71,'
    + '"message":"Frame capture failed","trace":"at a.ino:405 loop()"}]}';
  const r = parseLogBatch(JSON.parse(firmwareBody));
  assertTrue(r.ok);
  assertEqual(r.rejected, 0);
  assertEqual(r.batch, {
    camera: 'cam2', fw: 'Oct  3 2026', attempt: 2, dropped: 5,
    entries: [{ seq: 7, level: 'ERROR', ageMs: 5000, uptimeMs: 9000, heap: 84312, rssi: -71, message: 'Frame capture failed', trace: 'at a.ino:405 loop()' }],
  });
});

summarize();
