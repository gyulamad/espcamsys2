'use strict';

const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');
const {
  DEFAULT_PRE_ROLL_SECONDS,
  DEFAULT_PRE_ROLL_MAX_BYTES,
  resolvePreRollConfig,
  PreRollBuffer,
} = require('../../nodejs/camera-relay/lib/preroll');

const jpg = (n, fill = 1) => Buffer.alloc(n, fill);
const tsList = (frames) => frames.map((f) => f.ts);

// ── resolvePreRollConfig ─────────────────────────────────────────────

test('resolvePreRollConfig: nothing configured -> defaults, no warnings', () => {
  const r = resolvePreRollConfig({});
  assertEqual(r.seconds, DEFAULT_PRE_ROLL_SECONDS);
  assertEqual(r.seconds, 5);
  assertEqual(r.maxBytes, DEFAULT_PRE_ROLL_MAX_BYTES);
  assertEqual(r.warnings, []);
  assertEqual(resolvePreRollConfig().seconds, 5); // no argument at all
});

test('resolvePreRollConfig: accepts valid values, including numeric strings from env vars', () => {
  assertEqual(resolvePreRollConfig({ seconds: 8 }).seconds, 8);
  assertEqual(resolvePreRollConfig({ seconds: '3.5' }).seconds, 3.5);
  assertEqual(resolvePreRollConfig({ maxBytes: '1048576' }).maxBytes, 1048576);
  assertEqual(resolvePreRollConfig({ seconds: 8, maxBytes: 2000000 }).warnings, []);
});

test('resolvePreRollConfig: 0 seconds is valid and means "disabled"', () => {
  const r = resolvePreRollConfig({ seconds: 0 });
  assertEqual(r.seconds, 0);
  assertEqual(r.warnings, []);
});

test('resolvePreRollConfig: unusable seconds fall back to the default WITH a warning', () => {
  for (const bad of [-1, 61, 'abc', NaN, Infinity, {}]) {
    const r = resolvePreRollConfig({ seconds: bad });
    assertEqual(r.seconds, 5, `seconds=${String(bad)}`);
    assertEqual(r.warnings.length, 1, `seconds=${String(bad)} should warn`);
  }
});

test('resolvePreRollConfig: unusable maxBytes fall back to the default WITH a warning', () => {
  for (const bad of [0, -5, 100, 'lots', NaN]) {
    const r = resolvePreRollConfig({ maxBytes: bad });
    assertEqual(r.maxBytes, DEFAULT_PRE_ROLL_MAX_BYTES, `maxBytes=${String(bad)}`);
    assertEqual(r.warnings.length, 1, `maxBytes=${String(bad)} should warn`);
  }
});

test('resolvePreRollConfig: null / empty string count as "not set"', () => {
  assertEqual(resolvePreRollConfig({ seconds: null, maxBytes: '' }).warnings, []);
  assertEqual(resolvePreRollConfig({ seconds: '' }).seconds, 5);
});

// ── PreRollBuffer: windowing ─────────────────────────────────────────

test('PreRollBuffer keeps only the last N seconds', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  for (let t = 0; t <= 10000; t += 100) b.push(jpg(10), t);
  const pre = b.preRollFor(10000);
  assertEqual(pre[0].ts, 5000);
  assertEqual(pre[pre.length - 1].ts, 10000);
  assertEqual(pre.length, 51); // 5.0s .. 10.0s inclusive at 10 fps
});

test('PreRollBuffer.preRollFor anchors the START of the window to the trigger time', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  for (let t = 0; t <= 10000; t += 1000) b.push(jpg(10), t);
  // buffer holds 5000..10000. A trigger stamped 8000 (e.g. a detection time older than "now")
  // wants 3000.. but only 5000.. still exists; everything up to the newest frame is included so
  // the live frames that follow attach with no gap and no duplicate.
  assertEqual(tsList(b.preRollFor(8000)), [5000, 6000, 7000, 8000, 9000, 10000]);
  // a later trigger drops older frames from the front
  assertEqual(tsList(b.preRollFor(10000)), [5000, 6000, 7000, 8000, 9000, 10000]);
  assertEqual(tsList(b.preRollFor(12000)), [7000, 8000, 9000, 10000]);
});

test('PreRollBuffer.preRollFor returns [] when the buffer is empty or too old to matter', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  assertEqual(b.preRollFor(1000), []);
  b.push(jpg(10), 1000);
  assertEqual(b.preRollFor(60000), []); // camera went quiet long ago — don't glue that onto a new clip
});

test('PreRollBuffer.preRollFor can exclude footage already recorded (afterTs)', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  for (let t = 1000; t <= 6000; t += 1000) b.push(jpg(10), t);
  assertEqual(tsList(b.preRollFor(6000, 3000)), [4000, 5000, 6000]); // strictly after 3000
  assertEqual(tsList(b.preRollFor(6000)), [1000, 2000, 3000, 4000, 5000, 6000]);
});

// ── PreRollBuffer: bounds ────────────────────────────────────────────

test('PreRollBuffer enforces the byte cap', () => {
  const b = new PreRollBuffer({ seconds: 60, maxBytes: 100 });
  for (let i = 0; i < 20; i++) b.push(jpg(30), i * 10);
  assertTrue(b.stats.bytes <= 100, `bytes=${b.stats.bytes}`);
  assertEqual(b.stats.bytes, b.preRollFor(190).reduce((n, f) => n + f.jpeg.length, 0));
  // newest frames survive, oldest are dropped
  const kept = b.preRollFor(190);
  assertEqual(kept[kept.length - 1].ts, 190);
});

test('PreRollBuffer enforces the frame-count cap', () => {
  const b = new PreRollBuffer({ seconds: 60, maxFrames: 3 });
  for (let t = 10; t <= 50; t += 10) b.push(jpg(1), t);
  assertEqual(tsList(b.preRollFor(50)), [30, 40, 50]);
});

test('PreRollBuffer never lets timestamps go backwards', () => {
  const b = new PreRollBuffer({ seconds: 60 });
  assertEqual(b.push(jpg(1), 100), 100);
  assertEqual(b.push(jpg(1), 90), 100, 'a backwards timestamp is clamped and the filed ts returned');
  assertEqual(b.push(jpg(1), 110), 110);
  assertEqual(tsList(b.preRollFor(110)), [100, 100, 110]);
});

// ── PreRollBuffer: ownership / isolation ─────────────────────────────

test('PreRollBuffer stores its own copy of each frame', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  const frame = jpg(4, 7);
  b.push(frame, 1000);
  frame.fill(9); // caller reuses / mutates its buffer afterwards
  assertEqual(Array.from(b.preRollFor(1000)[0].jpeg), [7, 7, 7, 7]);
});

test('PreRollBuffer does not pin a larger parent buffer (stores a compact copy)', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  const parent = Buffer.alloc(1024 * 1024, 5);
  b.push(parent.slice(100, 110), 1000); // 10-byte view into a 1 MiB buffer
  const stored = b.preRollFor(1000)[0].jpeg;
  assertEqual(stored.length, 10);
  assertEqual(stored.buffer.byteLength < 1024 * 1024, true, 'stored copy must not share the 1 MiB backing store');
  assertEqual(b.stats.bytes, 10);
});

test('PreRollBuffer.preRollFor returns a snapshot, unaffected by later pushes/evictions', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  b.push(jpg(5), 1000);
  const snap = b.preRollFor(1000);
  b.push(jpg(5), 20000); // evicts the 1000 frame from the buffer
  assertEqual(snap.length, 1);
  assertEqual(b.stats.frames, 1);
});

test('PreRollBuffer with 0 seconds stores nothing but still returns the timestamp', () => {
  const b = new PreRollBuffer({ seconds: 0 });
  assertEqual(b.push(jpg(5), 1234), 1234);
  assertEqual(b.stats.frames, 0);
  assertEqual(b.preRollFor(1234), []);
});

test('PreRollBuffer rejects a negative window', () => {
  assertThrows(() => new PreRollBuffer({ seconds: -1 }));
});

// ── stats ────────────────────────────────────────────────────────────

test('PreRollBuffer.stats reports frames, bytes, buffered span and window', () => {
  const b = new PreRollBuffer({ seconds: 5 });
  assertEqual(b.stats, { frames: 0, bytes: 0, bufferedSeconds: 0, windowSeconds: 5 });
  b.push(jpg(10), 1000);
  b.push(jpg(20), 3500);
  assertEqual(b.stats, { frames: 2, bytes: 30, bufferedSeconds: 2.5, windowSeconds: 5 });
});

summarize();
