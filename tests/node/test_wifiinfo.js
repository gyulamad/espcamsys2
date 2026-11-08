'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const w = require('../../nodejs/camera-relay/lib/wifiinfo');

// ── cleanSsid ─────────────────────────────────────────────────────────────

test('cleanSsid: an ordinary network name is kept as it is', () => {
  assertEqual(w.cleanSsid('HomeNet'), 'HomeNet');
  assertEqual(w.cleanSsid('Café Wi-Fi 5G'), 'Café Wi-Fi 5G');
});

test('cleanSsid: not a string, or empty -> null', () => {
  for (const v of [undefined, null, 5, {}, [], true, '']) assertEqual(w.cleanSsid(v), null);
});

test('cleanSsid: the limit is 32 BYTES, not 32 characters', () => {
  assertEqual(w.cleanSsid('a'.repeat(32)), 'a'.repeat(32));
  assertEqual(w.cleanSsid('a'.repeat(33)), null);
  assertEqual(w.cleanSsid('é'.repeat(16)), 'é'.repeat(16)); // 32 bytes
  assertEqual(w.cleanSsid('é'.repeat(17)), null);           // 34 bytes
});

test('cleanSsid: control characters are refused (they could forge log lines)', () => {
  for (const v of ['a\nb', 'a\rb', 'a\0b', 'a\x1bb', 'a\x7fb', '\tx']) assertEqual(w.cleanSsid(v), null);
});

test('cleanSsid: markup is kept as TEXT (the dashboard shows it with textContent, never as HTML)', () => {
  assertEqual(w.cleanSsid('<img src=x>'), '<img src=x>');
});

// ── cleanRssi ─────────────────────────────────────────────────────────────

test('cleanRssi: whole dBm from -127 to -1', () => {
  assertEqual(w.cleanRssi(-61), -61);
  assertEqual(w.cleanRssi(-127), -127);
  assertEqual(w.cleanRssi(-1), -1);
});

test('cleanRssi: 0 (not connected), positive, too low, fractions and non-numbers -> null', () => {
  for (const v of [0, 5, -128, -61.5, NaN, Infinity, '-61', null, undefined]) assertEqual(w.cleanRssi(v), null);
});

// ── parseReading ──────────────────────────────────────────────────────────

test('parseReading: both halves usable -> the reading', () => {
  assertEqual(w.parseReading('HomeNet', -61), { ssid: 'HomeNet', rssi: -61 });
});

test('parseReading: either half unusable -> null (half a reading says nothing true)', () => {
  assertEqual(w.parseReading('HomeNet', 0), null);
  assertEqual(w.parseReading(null, -61), null);
  assertEqual(w.parseReading('', -61), null);
});

// ── parseQueryReading ─────────────────────────────────────────────────────

test('parseQueryReading: the signal comes as text and must be a plain integer', () => {
  assertEqual(w.parseQueryReading('HomeNet', '-61'), { ssid: 'HomeNet', rssi: -61 });
});

test('parseQueryReading: what Number() would accept but a device never sends is refused', () => {
  for (const v of ['0x10', '1e1', ' -5', '-5 ', '--5', '', '-', '-61.5', '-12345', undefined, ['-61'], -61]) {
    assertEqual(w.parseQueryReading('HomeNet', v), null);
  }
});

test('parseQueryReading: a repeated ?ssid= (an array) is refused', () => {
  assertEqual(w.parseQueryReading(['a', 'b'], '-61'), null);
});

// ── describe / remember ───────────────────────────────────────────────────

test('describe: nothing stored -> null', () => {
  assertEqual(w.describe(null, 5000), null);
  assertEqual(w.describe(undefined, 5000), null);
});

test('describe: a stored reading with its age', () => {
  assertEqual(w.describe({ ssid: 'HomeNet', rssi: -61, at: 1000 }, 4000), { ssid: 'HomeNet', rssi: -61, ageMs: 3000 });
});

test('describe: a reading from the future (clock step) is age 0, never negative', () => {
  assertEqual(w.describe({ ssid: 'a', rssi: -50, at: 9000 }, 1000).ageMs, 0);
});

test('describe: stale after STALE_MS, still fresh exactly at it', () => {
  const stored = { ssid: 'a', rssi: -50, at: 0 };
  assertTrue(w.describe(stored, w.STALE_MS) !== null, 'fresh at the limit');
  assertEqual(w.describe(stored, w.STALE_MS + 1), null);
});

test('remember: a new reading replaces the old and is stamped with the time', () => {
  assertEqual(w.remember({ ssid: 'old', rssi: -80, at: 1 }, { ssid: 'new', rssi: -50 }, 99), { ssid: 'new', rssi: -50, at: 99 });
});

test('remember: nothing usable keeps what was there (and null stays null)', () => {
  const kept = { ssid: 'old', rssi: -80, at: 1 };
  assertEqual(w.remember(kept, null, 99), kept);
  assertEqual(w.remember(undefined, null, 99), null);
});

summarize();
