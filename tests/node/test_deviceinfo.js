'use strict';

// test_deviceinfo.js — nodejs/camera-relay/lib/deviceinfo.js: what the relay knows about a camera's board
// (address, connection time, firmware, uptime, free memory) and how it is kept and shaped for the dashboard.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const D = require('../../nodejs/camera-relay/lib/deviceinfo');

const entry = (over) => Object.assign({ ageMs: 0, uptimeMs: null, heap: null }, over);
const liveSocket = { destroyed: false };

// ── fromLogBatch ──────────────────────────────────────────────────────────

test('fromLogBatch: firmware of the batch, uptime and heap of the newest entry', () => {
  const batch = { fw: 'abc123', entries: [entry({ ageMs: 5000, uptimeMs: 1000, heap: 90000 }), entry({ ageMs: 100, uptimeMs: 5900, heap: 80000 })] };
  assertEqual(D.fromLogBatch(batch), { fw: 'abc123', uptimeMs: 6000, heap: 80000 });
});

test('fromLogBatch: the uptime is as of the moment the batch arrived (entry uptime + how long ago it happened)', () => {
  assertEqual(D.fromLogBatch({ fw: '', entries: [entry({ ageMs: 20000, uptimeMs: 10000 })] }).uptimeMs, 30000);
});

test('fromLogBatch: uptime and heap are each taken from the newest entry that has them', () => {
  const batch = { fw: '', entries: [entry({ ageMs: 10, uptimeMs: 500 }), entry({ ageMs: 50, heap: 70000 })] };
  assertEqual(D.fromLogBatch(batch), { fw: null, uptimeMs: 510, heap: 70000 });
});

test('fromLogBatch: nothing usable -> all null; a negative heap is no reading', () => {
  assertEqual(D.fromLogBatch({ fw: '', entries: [entry({})] }), { fw: null, uptimeMs: null, heap: null });
  assertEqual(D.fromLogBatch({ fw: '', entries: [entry({ heap: -5 })] }).heap, null);
  for (const bad of [null, undefined, {}, { entries: 'x' }]) assertEqual(D.fromLogBatch(bad).uptimeMs, null);
});

// ── remember ──────────────────────────────────────────────────────────────

test('remember: stamps a sample with its arrival time', () => {
  assertEqual(D.remember(null, { fw: 'a', uptimeMs: 10, heap: 5 }, 1000), { fw: 'a', uptimeMs: 10, heap: 5, at: 1000 });
});

test('remember: no sample keeps what was known (or null)', () => {
  const prev = { fw: 'a', uptimeMs: 10, heap: 5, at: 1 };
  assertEqual(D.remember(prev, null, 9), prev);
  assertEqual(D.remember(undefined, null, 9), null);
});

test('remember: a sample without firmware keeps the known firmware; a new one replaces it', () => {
  const prev = { fw: 'old', uptimeMs: 10, heap: 5, at: 1 };
  assertEqual(D.remember(prev, { fw: null, uptimeMs: 20, heap: 6 }, 5).fw, 'old');
  assertEqual(D.remember(prev, { fw: 'new', uptimeMs: 20, heap: 6 }, 5).fw, 'new');
});

test('remember: a sample with a new uptime but no heap does not leave an old heap standing as current', () => {
  const prev = { fw: 'a', uptimeMs: 10, heap: 5, at: 1 };
  assertEqual(D.remember(prev, { fw: null, uptimeMs: 20, heap: null }, 7), { fw: 'a', uptimeMs: 20, heap: null, at: 7 });
});

test('remember: a firmware-only sample does not make old measurements look new', () => {
  const prev = { fw: 'a', uptimeMs: 10, heap: 5, at: 1 };
  assertEqual(D.remember(prev, { fw: 'b', uptimeMs: null, heap: null }, 99), { fw: 'b', uptimeMs: 10, heap: 5, at: 1 });
  assertEqual(D.remember(null, { fw: 'b', uptimeMs: null, heap: null }, 99), { fw: 'b', uptimeMs: null, heap: null, at: 99 });
});

// ── describe ──────────────────────────────────────────────────────────────

test('describe: a camera nobody knows anything about -> null', () => {
  assertEqual(D.describe({}, false, 1000), null);
  assertEqual(D.describe({ ip: null, socket: null, connectedAt: 0, device: null }, true, 1000), null);
});

test('describe: address, connection time and what the log said; the uptime runs on from the report', () => {
  const cam = { ip: '192.168.1.50', socket: liveSocket, connectedAt: 4000, device: { fw: 'abc', uptimeMs: 60000, heap: 81920, at: 5000 } };
  assertEqual(D.describe(cam, true, 8000), { ip: '192.168.1.50', connectedForMs: 4000, fw: 'abc', uptimeMs: 63000, heapBytes: 81920 });
});

test('describe: a camera that is not sending has no uptime or memory "now", but keeps its address and firmware', () => {
  const cam = { ip: '10.0.0.7', socket: null, connectedAt: 4000, device: { fw: 'abc', uptimeMs: 60000, heap: 81920, at: 5000 } };
  assertEqual(D.describe(cam, false, 8000), { ip: '10.0.0.7', connectedForMs: null, fw: 'abc', uptimeMs: null, heapBytes: null });
});

test('describe: a destroyed socket is not a connection', () => {
  const cam = { ip: '10.0.0.7', socket: { destroyed: true }, connectedAt: 4000, device: null };
  assertEqual(D.describe(cam, true, 8000).connectedForMs, null);
});

test('describe: a report older than STALE_MS gives no uptime or memory, but the firmware stays', () => {
  const cam = { ip: null, socket: null, connectedAt: 0, device: { fw: 'abc', uptimeMs: 1, heap: 2, at: 0 } };
  assertEqual(D.describe(cam, true, D.STALE_MS), { ip: null, connectedForMs: null, fw: 'abc', uptimeMs: 1 + D.STALE_MS, heapBytes: 2 });
  assertEqual(D.describe(cam, true, D.STALE_MS + 1), { ip: null, connectedForMs: null, fw: 'abc', uptimeMs: null, heapBytes: null });
});

test('describe: an address that is not an IP address is not passed on; the clock going back never gives a negative time', () => {
  assertEqual(D.describe({ ip: 'evil<script>', device: null }, true, 1), null);
  const cam = { ip: '::1', socket: liveSocket, connectedAt: 5000, device: { fw: null, uptimeMs: 10, heap: 1, at: 5000 } };
  const v = D.describe(cam, true, 1000);
  assertTrue(v.connectedForMs === 0 && v.uptimeMs === 10, JSON.stringify(v));
});

summarize();
