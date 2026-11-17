'use strict';

// test_alarm_sounds.js — which alarm events a page plays, and how (php/cameras/js/alarm-sounds.js), with a fake Audio.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const A = require('../../php/cameras/js/alarm-sounds');

const ev = (seq, at, extra = {}) => ({ seq, at, kind: 'recordStart', camId: 'cam1', sound: `s${seq}.wav`, ...extra });
const list = (events, { epoch = 100, now = 1000 } = {}) => ({ epoch, now, events });
const fresh = () => ({ epoch: null, seq: 0 });

// ── selectNew ──

test('selectNew: the first list is only remembered — nothing is played, however fresh', () => {
  const r = A.selectNew(fresh(), list([ev(1, 999), ev(2, 1000)]));
  assertEqual(r, { memory: { epoch: 100, seq: 2 }, events: [] });
  assertEqual(A.selectNew(fresh(), list([])), { memory: { epoch: 100, seq: 0 }, events: [] });
});

test('selectNew: after that, events with a higher number are new, oldest first, and remembered', () => {
  const m = { epoch: 100, seq: 2 };
  const r = A.selectNew(m, list([ev(2, 900), ev(4, 990), ev(3, 980)], { now: 1000 }));
  assertEqual(r.events.map((e) => e.seq), [3, 4]);
  assertEqual(r.memory, { epoch: 100, seq: 4 });
  assertEqual(A.selectNew(r.memory, list([ev(3, 980), ev(4, 990)])).events, [], 'the same list again: nothing new');
});

test('selectNew: an event older than the limit is not played, but is still passed over (never played later)', () => {
  const r = A.selectNew({ epoch: 100, seq: 0 }, list([ev(1, 1000 - A.MAX_AGE_MS - 1), ev(2, 1000 - A.MAX_AGE_MS)], { now: 1000 }));
  assertEqual(r.events.map((e) => e.seq), [2]);
  assertEqual(r.memory.seq, 2);
  assertEqual(A.selectNew({ epoch: 100, seq: 0 }, list([ev(1, 0)], { now: 1000 }), 500).events, []);   // a shorter limit is honoured
});

test('selectNew: a different epoch (the relay restarted) is remembered like a first list, whatever the numbers', () => {
  const r = A.selectNew({ epoch: 100, seq: 50 }, list([ev(1, 999)], { epoch: 200 }));
  assertEqual(r, { memory: { epoch: 200, seq: 1 }, events: [] });
  assertEqual(A.selectNew(r.memory, list([ev(1, 999), ev(2, 1000)], { epoch: 200 })).events.map((e) => e.seq), [2]);
});

test('selectNew: a list that is not one changes nothing and plays nothing', () => {
  const m = { epoch: 100, seq: 3 };
  for (const bad of [null, undefined, 5, 'x', {}, { epoch: 1, now: 2 }, { epoch: '1', now: 2, events: [] }, { epoch: 1, now: 2.5, events: [] }, { epoch: 1, now: 2, events: 'x' }]) {
    assertEqual(A.selectNew(m, bad), { memory: m, events: [] }, JSON.stringify(bad));
  }
});

test('selectNew: events that are malformed are skipped, the rest still count', () => {
  const m = { epoch: 100, seq: 0 };
  const r = A.selectNew(m, list([null, 'x', { seq: 1 }, { seq: '2', at: 1, sound: 'a.wav' }, { seq: 3, at: 999, sound: 5 }, ev(4, 999)]));
  assertEqual(r.events.map((e) => e.seq), [4]);
});

test('selectNew does not change what it was given', () => {
  const m = { epoch: 100, seq: 1 };
  const p = list([ev(2, 999)]);
  const before = JSON.stringify([m, p]);
  A.selectNew(m, p);
  assertEqual(JSON.stringify([m, p]), before);
});

// ── create ──

class FakeAudio {
  constructor(url, behaviour) { this.url = url; this.listeners = {}; this.played = 0; this.behaviour = behaviour; }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  emit(name) { (this.listeners[name] || []).forEach((fn) => fn()); }
  play() {
    this.played += 1;
    if (this.behaviour === 'throw') throw new Error('sync');
    if (this.behaviour === 'blocked') return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    if (this.behaviour === 'broken') return Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
    return Promise.resolve();
  }
}

function setup(behaviour) {
  const made = [];
  const blocked = [];
  const clock = { t: 0 };
  const alarms = A.create({
    createAudio: (url) => { const a = new FakeAudio(url, behaviour); made.push(a); return a; },
    onBlocked: (e) => blocked.push(e),
    now: () => clock.t,
  });
  return { alarms, made, blocked, clock };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  // the first list is only remembered; the next new event plays
  const a = setup();
  a.alarms.handle(list([ev(1, 999)]));
  const playedOnFirst = a.made.length;
  a.alarms.handle(list([ev(1, 999), ev(2, 1000)]));
  const playedOnNext = a.made.map((x) => [x.url, x.played]);

  // several new events of one list: one sound; while it plays the others are skipped; once it ended the next plays
  const b = setup();
  b.alarms.handle(list([]));
  b.alarms.handle(list([ev(1, 999), ev(2, 999), ev(3, 999)]));
  const oneSound = b.made.length;
  b.alarms.handle(list([ev(4, 1000)]));
  const stillOne = b.made.length;
  b.made[0].emit('ended');
  b.alarms.handle(list([ev(5, 1001)]));
  const afterEnd = b.made.map((x) => x.url);

  // an audio that fails to load frees the player; a sound that never ends is let go after the limit
  const c = setup();
  c.alarms.handle(list([]));
  c.alarms.handle(list([ev(1, 999)]));
  c.made[0].emit('error');
  c.alarms.handle(list([ev(2, 1000)]));
  const afterError = c.made.length;
  c.clock.t += A.MAX_PLAY_MS + 1;
  c.alarms.handle(list([ev(3, 1001)]));
  const afterLimit = c.made.length;

  // the browser refuses: the page is told which event, and the player is free again for the next
  const d = setup('blocked');
  d.alarms.handle(list([]));
  d.alarms.handle(list([ev(1, 999)]));
  await tick();
  const blockedEvents = d.blocked.map((e) => e.seq);
  d.alarms.handle(list([ev(2, 1000)]));
  const afterBlocked = d.made.length;

  // other failures do not say "blocked", and a throwing play() does not break the page
  const e = setup('broken');
  e.alarms.handle(list([])); e.alarms.handle(list([ev(1, 999)])); await tick();
  const f = setup('throw');
  f.alarms.handle(list([])); f.alarms.handle(list([ev(1, 999)]));
  f.alarms.handle(list([ev(2, 1000)]));

  // the url of a sound is its name, escaped
  const g = setup();
  g.alarms.handle(list([])); g.alarms.handle(list([ev(1, 999, { sound: 'a b&c.wav' })]));

  // the default for a refused sound: one toast, if there is one to show
  const shown = [];
  globalThis.CamToast = { show: (text, kind) => shown.push([text, kind]) };
  const h = A.create({ createAudio: (url) => new FakeAudio(url, 'blocked'), now: () => 0 });
  h.handle(list([])); h.handle(list([ev(1, 999)])); await tick(); h.handle(list([ev(2, 1000)])); await tick();
  delete globalThis.CamToast;
  const noToast = A.create({ createAudio: (url) => new FakeAudio(url, 'blocked'), now: () => 0 });
  let noToastError = null;
  try { noToast.handle(list([])); noToast.handle(list([ev(1, 999)])); await tick(); } catch (err) { noToastError = err; }

  test('create: the first list plays nothing; the next new event plays that sound from sounds.php', () => {
    assertEqual(playedOnFirst, 0);
    assertEqual(playedOnNext, [['sounds.php?name=s2.wav', 1]]);
  });
  test('create: one sound at a time — several new events are one sound, others are skipped while it plays', () => {
    assertEqual(oneSound, 1);
    assertEqual(b.made[0].url, 'sounds.php?name=s1.wav');
    assertEqual(stillOne, 1);
    assertEqual(afterEnd, ['sounds.php?name=s1.wav', 'sounds.php?name=s5.wav']);
  });
  test('create: a sound that fails to load frees the player, and one that never ends is let go after the limit', () => {
    assertEqual(afterError, 2);
    assertEqual(afterLimit, 3);
  });
  test('create: a browser that refuses to play is reported once with the event, and the next alarm is tried again', () => {
    assertEqual(blockedEvents, [1]);
    assertEqual(afterBlocked, 2);
  });
  test('create: other failures are not reported as blocked, and a play() that throws is survived', () => {
    assertEqual(e.blocked, []);
    assertEqual(f.made.length, 2);
    assertEqual(f.blocked, []);
  });
  test('create: the sound\'s name goes into the address escaped', () => {
    assertEqual(g.made[0].url, 'sounds.php?name=a%20b%26c.wav');
  });
  test('create: by default a refused sound is said once with a toast (if there is one), however many are refused', () => {
    assertEqual(shown.length, 1);
    assertEqual(shown[0][1], 'info');
    assertTrue(/blocked an alarm sound.*Click or tap/.test(shown[0][0]));
    assertEqual(noToastError, null, 'without a toast nothing breaks');
  });
  test('the module is available to pages as CamAlarmSounds', () => {
    assertTrue(typeof A.create === 'function' && globalThis.CamAlarmSounds === A);
  });
  summarize();
})();
