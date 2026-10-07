'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { DEFAULT_OFF_MINUTES, MAX_OFF_MINUTES, parseMinutes, RecordingSwitch, describeOff } = require('../../nodejs/camera-relay/lib/recswitch');

const NOW = 1_000_000_000_000;
const MIN = 60000;

// ── parseMinutes ──
test('parseMinutes: nothing given means the 60-minute default', () => {
  assertEqual(DEFAULT_OFF_MINUTES, 60);
  for (const v of [undefined, null, '']) assertEqual(parseMinutes(v), { ok: true, minutes: 60 }, String(v));
});

test('parseMinutes: a positive whole number is that many minutes (number or numeric string)', () => {
  assertEqual(parseMinutes(30), { ok: true, minutes: 30 });
  assertEqual(parseMinutes('30'), { ok: true, minutes: 30 });
  assertEqual(parseMinutes(' 15 '), { ok: true, minutes: 15 });
  assertEqual(parseMinutes(MAX_OFF_MINUTES), { ok: true, minutes: MAX_OFF_MINUTES });
});

test('parseMinutes: 0 or a negative number means "forever" (minutes: 0)', () => {
  for (const v of [0, '0', -1, '-1', '-60', -99999]) assertEqual(parseMinutes(v), { ok: true, minutes: 0 }, String(v));
});

test('parseMinutes: anything that is not a whole number is an error', () => {
  for (const v of ['abc', '1.5', 1.5, '1e3', '5 min', {}, [], true, NaN, Infinity, '0x10']) {
    assertEqual(parseMinutes(v).ok, false, JSON.stringify(v));
  }
});

test('parseMinutes: an absurdly large number is an error that points at "forever"', () => {
  const r = parseMinutes(MAX_OFF_MINUTES + 1);
  assertEqual(r.ok, false);
  assertTrue(/0/.test(r.error));
});

// ── the switch ──
test('every camera records by default', () => {
  const sw = new RecordingSwitch();
  assertEqual(sw.offState('cam1', NOW), null);
  assertEqual(sw.offIds(NOW), []);
});

test('turnOff for N minutes: OFF until exactly N minutes from now', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 60, NOW);
  assertEqual(sw.offState('cam1', NOW), { until: NOW + 60 * MIN });
  assertEqual(sw.offState('cam1', NOW + 60 * MIN - 1), { until: NOW + 60 * MIN }, 'still OFF 1 ms before the end');
  assertEqual(sw.offState('cam1', NOW + 60 * MIN), null, 'ON exactly when the time is up');
});

test('turnOff with 0 minutes: OFF forever, until explicitly turned ON', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 0, NOW);
  assertEqual(sw.offState('cam1', NOW), { until: null });
  assertEqual(sw.offState('cam1', NOW + 400 * 24 * 60 * MIN), { until: null }, 'still OFF a year later');
  assertEqual(sw.turnOn('cam1'), true);
  assertEqual(sw.offState('cam1', NOW), null);
});

test('cameras are independent of each other', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 0, NOW);
  assertEqual(sw.offState('cam2', NOW), null);
  sw.turnOff('cam2', 5, NOW);
  sw.turnOn('cam1');
  assertEqual(sw.offState('cam1', NOW), null, 'cam1 is back ON');
  assertTrue(sw.offState('cam2', NOW) !== null, 'cam2 is untouched');
});

test('the "all cameras" button is just every known camera set one by one — each can then be changed alone', () => {
  const sw = new RecordingSwitch();
  const known = ['cam1', 'cam2', 'cam3'];
  for (const id of known) sw.turnOff(id, 60, NOW);
  assertEqual(sw.offIds(NOW), ['cam1', 'cam2', 'cam3']);
  sw.turnOn('cam2');
  assertEqual(sw.offIds(NOW), ['cam1', 'cam3'], 'switching one ON leaves the others OFF');
  assertEqual(sw.offState('camNew', NOW), null, 'a camera that was not known at the time is unaffected');
});

test('turnOff on an already-OFF camera replaces its timer (OFF again with new minutes)', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 0, NOW);
  sw.turnOff('cam1', 10, NOW + MIN);
  assertEqual(sw.offState('cam1', NOW + MIN), { until: NOW + 11 * MIN });
});

test('turnOn on a camera that was not OFF reports false', () => {
  assertEqual(new RecordingSwitch().turnOn('cam1'), false);
});

test('expire removes the ones that ran out, keeps the rest, and says which and when', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('short', 1, NOW);
  sw.turnOff('long', 60, NOW);
  sw.turnOff('forever', 0, NOW);
  assertEqual(sw.expire(NOW + 30 * 1000), []);
  assertEqual(sw.expire(NOW + 2 * MIN), [{ id: 'short', until: NOW + MIN }], 'reports WHEN it ran out (1 min in), not when it was noticed (2 min in)');
  assertEqual(sw.expire(NOW + 2 * MIN), [], 'only reported once');
  assertEqual(sw.offIds(NOW + 2 * MIN), ['forever', 'long']);
});

test('offIds lists only cameras that are OFF right now', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('b', 1, NOW); sw.turnOff('a', 0, NOW);
  assertEqual(sw.offIds(NOW), ['a', 'b']);
  assertEqual(sw.offIds(NOW + 2 * MIN), ['a'], 'a timed one that has run out is not listed even before expire() runs');
});

// ── persistence ──
test('serialize / parse round-trips, and the file only lists OFF cameras', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam2', 30, NOW); sw.turnOff('cam1', 0, NOW);
  const text = sw.serialize();
  assertEqual(JSON.parse(text), { v: 1, cameras: { cam1: { until: null }, cam2: { until: NOW + 30 * MIN } } });
  const r = RecordingSwitch.parse(text, NOW + MIN);
  assertEqual(r.warnings, []);
  assertEqual(r.expired, []);
  assertEqual(r.sw.offState('cam1', NOW + MIN), { until: null });
  assertEqual(r.sw.offState('cam2', NOW + MIN), { until: NOW + 30 * MIN });
  assertEqual(r.sw.offState('cam3', NOW + MIN), null);
});

test('an empty switch serializes to an empty camera list', () => {
  assertEqual(JSON.parse(new RecordingSwitch().serialize()), { v: 1, cameras: {} });
});

test('a timed OFF keeps counting down while the relay is stopped: it is judged against the time at restart', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 60, NOW);
  const text = sw.serialize();
  const still = RecordingSwitch.parse(text, NOW + 40 * MIN);              // restarted 40 min later
  assertEqual(still.sw.offState('cam1', NOW + 40 * MIN), { until: NOW + 60 * MIN }, '20 minutes still to go');
  const over = RecordingSwitch.parse(text, NOW + 90 * MIN);               // restarted 90 min later
  assertEqual(over.sw.offState('cam1', NOW + 90 * MIN), null, 'it ran out while the relay was down');
  assertEqual(over.expired, ['cam1'], 'and the caller is told, so it can log it');
});

test('a forever-OFF survives a restart however long the relay was down', () => {
  const sw = new RecordingSwitch();
  sw.turnOff('cam1', 0, NOW);
  const r = RecordingSwitch.parse(sw.serialize(), NOW + 1000 * 24 * 60 * MIN);
  assertEqual(r.sw.offState('cam1', NOW), { until: null });
});

test('a damaged file means EVERY camera records (fail towards recording, never towards silence)', () => {
  for (const text of ['', '{ not json', 'null', '42', '[]', '{}', '{"v":1}', '{"cameras":[]}', '{"cameras":"x"}']) {
    const r = RecordingSwitch.parse(text, NOW);
    assertEqual(r.sw.offIds(NOW), [], JSON.stringify(text));
    assertEqual(r.warnings.length, 1, `${JSON.stringify(text)} should warn`);
  }
});

test('unusable entries are dropped with a warning, the good ones are kept', () => {
  const text = JSON.stringify({ v: 1, cameras: {
    good: { until: null },
    'bad id!': { until: null },
    '../evil': { until: null },
    noUntil: {},
    strUntil: { until: '123' },
    nanUntil: { until: null, extra: 1 },
    notObject: 5,
    nul: null,
  } });
  const r = RecordingSwitch.parse(text, NOW);
  assertEqual(r.sw.offIds(NOW), ['good', 'nanUntil']);
  assertEqual(r.warnings.length, 6);
});

// ── describeOff ──
test('describeOff: null when recording is allowed', () => {
  assertEqual(describeOff(null, NOW), null);
});

test('describeOff: forever has no end and no countdown', () => {
  assertEqual(describeOff({ until: null }, NOW), { forever: true, until: null, remainingMs: null });
});

test('describeOff: a timed OFF reports its end as an ISO time and the milliseconds left', () => {
  assertEqual(describeOff({ until: NOW + 90000 }, NOW), { forever: false, until: new Date(NOW + 90000).toISOString(), remainingMs: 90000 });
  assertEqual(describeOff({ until: NOW - 5 }, NOW).remainingMs, 0, 'never negative');
});

summarize();
