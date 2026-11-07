'use strict';

// test_storagenotice.js — the "storage almost full" message (lib/storagenotice.js): when it is sent, when it is
// repeated, when it stays quiet, and what happens when a channel fails. No disk, no network, no real clock.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { MultiNotifier, Notifier } = require('../../nodejs/camera-relay/lib/notify/notifier');
const { buildStorageView, MIB } = require('../../nodejs/camera-relay/lib/diskspace');
const s = require('../../nodejs/camera-relay/lib/storagenotice');

const T0 = Date.UTC(2026, 10, 7, 17, 52, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const view = (freeMB, minFreeMB = 1000) => buildStorageView(freeMB * MIB, minFreeMB);
const unknown = buildStorageView(null, 1000);
const DAILY = DAY;
const sent = (at) => ({ sentAt: at, failedAt: null });

// ── config ──
test('config: a reminder every 24 hours by default', () => {
  assertEqual(s.resolveStorageNoticeConfig(undefined), { reminderMs: DAY, warnings: [] });
  assertEqual(s.resolveStorageNoticeConfig({}), { reminderMs: DAY, warnings: [] });
  assertEqual(s.resolveStorageNoticeConfig('nonsense'), { reminderMs: DAY, warnings: [] });
});

test('config: whole hours from 0 (no reminders) up to a year', () => {
  const c = (v) => s.resolveStorageNoticeConfig({ storageReminderHours: v });
  assertEqual([c(0).reminderMs, c(1).reminderMs, c(6).reminderMs, c(8760).reminderMs], [0, HOUR, 6 * HOUR, 8760 * HOUR]);
  assertEqual(c(6).warnings, []);
});

test('config: anything else falls back to 24 hours with a warning', () => {
  for (const bad of [-1, 1.5, '24', 8761, null, NaN, true]) {
    const r = s.resolveStorageNoticeConfig({ storageReminderHours: bad });
    assertEqual([r.reminderMs, r.warnings.length], [DAY, 1], String(bad));
    assertTrue(r.warnings[0].includes('storageReminderHours'));
  }
});

// ── nextStep: the decision ──
test('nextStep: a disk with enough room says nothing', () => {
  assertEqual(s.nextStep(s.IDLE, view(5000), T0, DAILY), { send: null, state: s.IDLE });
  assertEqual(s.nextStep(s.IDLE, view(1000), T0, DAILY).send, null);   // exactly the minimum is not "below"
});

test('nextStep: the disk falls below the minimum — the first message', () => {
  assertEqual(s.nextStep(s.IDLE, view(999), T0, DAILY), { send: 'first', state: s.IDLE });
});

test('nextStep: while it stays low, one reminder per interval — not before', () => {
  const state = sent(T0);
  assertEqual(s.nextStep(state, view(500), T0 + MIN, DAILY).send, null);
  assertEqual(s.nextStep(state, view(500), T0 + DAY - 1, DAILY).send, null);
  assertEqual(s.nextStep(state, view(500), T0 + DAY, DAILY).send, 'reminder');
  assertEqual(s.nextStep(state, view(500), T0 + 40 * DAY, DAILY).send, 'reminder');
});

test('nextStep: reminders switched off (0) — the first message only, however long it stays low', () => {
  assertEqual(s.nextStep(sent(T0), view(500), T0 + 400 * DAY, 0).send, null);
  assertEqual(s.nextStep(s.IDLE, view(500), T0, 0).send, 'first');
});

test('nextStep: a clock that was set back never holds a message back', () => {
  assertEqual(s.nextStep(sent(T0), view(500), T0 - 5 * MIN, DAILY).send, 'reminder');
  assertEqual(s.nextStep({ sentAt: null, failedAt: T0 }, view(500), T0 - 5 * MIN, DAILY).send, 'first');
});

test('nextStep: a message nobody received is retried after RETRY_MS, not at every check', () => {
  const failedFirst = { sentAt: null, failedAt: T0 };
  assertEqual(s.nextStep(failedFirst, view(500), T0 + MIN, DAILY).send, null);
  assertEqual(s.nextStep(failedFirst, view(500), T0 + s.RETRY_MS - 1, DAILY).send, null);
  assertEqual(s.nextStep(failedFirst, view(500), T0 + s.RETRY_MS, DAILY).send, 'first');
  const failedReminder = { sentAt: T0, failedAt: T0 + DAY };
  assertEqual(s.nextStep(failedReminder, view(500), T0 + DAY + MIN, DAILY).send, null);
  assertEqual(s.nextStep(failedReminder, view(500), T0 + DAY + s.RETRY_MS, DAILY).send, 'reminder');
});

test('nextStep: a failed first message is still retried when reminders are off', () => {
  assertEqual(s.nextStep({ sentAt: null, failedAt: T0 }, view(500), T0 + s.RETRY_MS, 0).send, 'first');
});

test('nextStep: recovered — 10 % above the minimum — forgets the episode', () => {
  assertEqual(s.nextStep(sent(T0), view(1100), T0 + MIN, DAILY), { send: null, state: s.IDLE });
  assertEqual(s.nextStep({ sentAt: null, failedAt: T0 }, view(5000), T0 + MIN, DAILY).state, s.IDLE);
});

test('nextStep: between the minimum and the recovery margin the episode goes on, silently', () => {
  const state = sent(T0);
  const step = s.nextStep(state, view(1050), T0 + MIN, DAILY);
  assertEqual(step.send, null);
  assertTrue(step.state === state);
});

test('nextStep: an unreadable disk changes nothing', () => {
  const state = sent(T0);
  const step = s.nextStep(state, unknown, T0 + 9 * DAY, DAILY);
  assertEqual(step.send, null);
  assertTrue(step.state === state);
});

test('nextStep: a minimum of 0 switches it off and forgets the episode', () => {
  assertEqual(s.nextStep(sent(T0), view(0, 0), T0 + MIN, DAILY), { send: null, state: s.IDLE });
  assertEqual(s.nextStep(s.IDLE, view(0, 0), T0, DAILY).send, null);
});

test('afterAttempt: delivered remembers when, failed remembers the failure and keeps the last delivery', () => {
  assertEqual(s.afterAttempt(s.IDLE, true, T0), { sentAt: T0, failedAt: null });
  assertEqual(s.afterAttempt({ sentAt: T0, failedAt: null }, false, T0 + DAY), { sentAt: T0, failedAt: T0 + DAY });
  assertEqual(s.afterAttempt({ sentAt: T0, failedAt: T0 + DAY }, true, T0 + DAY + 1), { sentAt: T0 + DAY + 1, failedAt: null });
});

// ── the text ──
test('buildStorageText: the facts, in the wording of the dashboard alert, one per line', () => {
  assertEqual(s.buildStorageText(view(312, 1024), { kind: 'first', nowMs: T0, baseUrl: 'http://pi/camdash' }).split('\n'), [
    'The recording storage is almost empty.',
    'Free: 312 MB (the minimum is 1024 MB). Please delete old files.',
    'Time: 2026-11-07 17:52:00 UTC',
    'Recordings: http://pi/camdash/all-recordings.php',
  ]);
});

test('buildStorageText: a reminder says so; without a dashboard address there is no link line', () => {
  const lines = s.buildStorageText(view(0, 1024), { kind: 'reminder', nowMs: T0, baseUrl: null }).split('\n');
  assertEqual(lines, [
    'Reminder: the recording storage is still almost empty.',
    'Free: 0 MB (the minimum is 1024 MB). Please delete old files.',
    'Time: 2026-11-07 17:52:00 UTC',
  ]);
});

// ── createStorageNotifier: the whole thing, with a fake disk, clock and channels ──
class Spy extends Notifier {
  constructor(fail) { super('spy'); this.sent = []; this.fail = fail; }
  async deliver(m) { if (this.fail) throw new Error(this.fail); this.sent.push(m); }
}

function setup({ channels = [new Spy()], free = 5000, min = 1000, reminderMs = DAILY, baseUrl = 'http://pi/camdash' } = {}) {
  const env = { free, min, t: T0, logs: [], reads: 0, readFails: null };
  const notifier = new MultiNotifier(channels);
  const n = s.createStorageNotifier({
    notifier,
    readView: async () => {
      env.reads += 1;
      if (env.readFails) throw new Error(env.readFails);
      return buildStorageView(env.free === null ? null : env.free * MIB, env.min);
    },
    config: { reminderMs },
    baseUrl,
    now: () => env.t,
    log: (level, message) => env.logs.push([level, message]),
  });
  return { n, env, channels };
}
const advance = (env, ms) => { env.t += ms; };

(async () => {
  // a whole low-disk story
  const a = setup();
  await a.n.check();
  test('a disk with room: nothing is sent and nothing is logged', () => {
    assertEqual([a.channels[0].sent.length, a.env.logs], [0, []]);
  });
  a.env.free = 312;
  await a.n.check();
  test('the disk falls below the minimum: one plain-text message, no picture', () => {
    assertEqual(a.channels[0].sent.length, 1);
    const m = a.channels[0].sent[0];
    assertTrue(!('image' in m));
    assertEqual(m.text.split('\n')[0], 'The recording storage is almost empty.');
    assertTrue(m.text.includes('Free: 312 MB (the minimum is 1000 MB)'));
    assertEqual(a.env.logs, [['INFO', 'storage notification (first) sent: 312 MB free, minimum 1000 MB']]);
  });
  for (let i = 0; i < 30; i += 1) { advance(a.env, MIN); await a.n.check(); }
  test('a disk that stays low is not announced at every check', () => assertEqual(a.channels[0].sent.length, 1));
  advance(a.env, DAY);
  await a.n.check();
  test('after the reminder interval it is mentioned once more, as a reminder', () => {
    assertEqual(a.channels[0].sent.length, 2);
    assertTrue(a.channels[0].sent[1].text.startsWith('Reminder: the recording storage is still almost empty.'));
  });
  a.env.free = 4000;
  advance(a.env, MIN);
  await a.n.check();
  a.env.free = 100;
  advance(a.env, MIN);
  await a.n.check();
  test('space is freed, then the disk fills again: a new episode starts with a new first message', () => {
    assertEqual(a.channels[0].sent.length, 3);
    assertTrue(a.channels[0].sent[2].text.startsWith('The recording storage is almost empty.'));
  });

  // hovering around the limit
  const h = setup({ free: 900 });
  await h.n.check();
  for (const free of [1010, 990, 1040, 960, 1099, 980]) { h.env.free = free; advance(h.env, MIN); await h.n.check(); }
  test('a disk hovering around the minimum does not announce itself each time it crosses it', () => {
    assertEqual(h.channels[0].sent.length, 1);
  });
  h.env.free = 1100;
  advance(h.env, MIN);
  await h.n.check();
  h.env.free = 900;
  advance(h.env, MIN);
  await h.n.check();
  test('once it has climbed 10 % over the minimum, the next fall is announced again', () => {
    assertEqual(h.channels[0].sent.length, 2);
  });

  // reminders off
  const once = setup({ free: 100, reminderMs: 0 });
  await once.n.check();
  advance(once.env, 100 * DAY);
  await once.n.check();
  test('reminders switched off: one message per episode', () => assertEqual(once.channels[0].sent.length, 1));

  // the minimum is changed on the settings page while the disk is low
  const m = setup({ free: 500, min: 1000 });
  await m.n.check();
  m.env.min = 0;
  advance(m.env, MIN);
  await m.n.check();
  m.env.min = 1000;
  advance(m.env, MIN);
  await m.n.check();
  test('minimum 0 and then back on while the disk is still low: announced again', () => assertEqual(m.channels[0].sent.length, 2));

  // no channel, unreadable disk
  const none = setup({ channels: [], free: 10 });
  await none.n.check();
  test('with no channel configured the disk is not even read', () => assertEqual([none.env.reads, none.env.logs], [0, []]));

  const blind = setup({ free: null });
  await blind.n.check();
  advance(blind.env, DAY);
  await blind.n.check();
  test('an unreadable disk is no message and no log line', () => assertEqual([blind.channels[0].sent.length, blind.env.reads, blind.env.logs], [0, 2, []]));

  // channels that fail
  const mixed = setup({ channels: [new Spy('quota exceeded'), new Spy()], free: 100 });
  await mixed.n.check();
  test('one channel failing is logged by name and the others still deliver', () => {
    assertEqual(mixed.channels[1].sent.length, 1);
    assertEqual(mixed.env.logs, [
      ['WARN', 'the storage notification through spy failed: quota exceeded'],
      ['INFO', 'storage notification (first) sent: 100 MB free, minimum 1000 MB'],
    ]);
  });
  advance(mixed.env, 5 * MIN);
  await mixed.n.check();
  test('a message that went through somewhere is not retried', () => assertEqual(mixed.channels[1].sent.length, 1));

  const dead = setup({ channels: [new Spy('blocked')], free: 100 });
  await dead.n.check();
  advance(dead.env, MIN);
  await dead.n.check();
  advance(dead.env, s.RETRY_MS);
  await dead.n.check();
  test('when no channel delivers, it is retried after the retry delay — not at every check', () => {
    assertEqual(dead.env.logs.length, 2);
    assertTrue(dead.env.logs.every(([level]) => level === 'WARN'));
  });
  dead.channels[0].fail = null;
  advance(dead.env, s.RETRY_MS);
  await dead.n.check();
  test('and once a channel works again the message that was waiting is delivered as a first message', () => {
    assertEqual(dead.channels[0].sent.length, 1);
    assertTrue(dead.channels[0].sent[0].text.startsWith('The recording storage is almost empty.'));
  });

  // things that go wrong in the check itself never escape
  const broken = setup({ free: 100 });
  broken.env.readFails = 'df exploded';
  let escaped = null;
  try { await broken.n.check(); } catch (e) { escaped = e; }
  broken.env.readFails = null;
  await broken.n.check();
  test('a failing read is logged, never escapes, and the next check works', () => {
    assertEqual(escaped, null);
    assertEqual(broken.env.logs[0], ['WARN', 'the storage check failed: df exploded']);
    assertEqual(broken.channels[0].sent.length, 1);
  });

  const exploding = s.createStorageNotifier({
    notifier: { isEmpty: () => false, send: async () => { throw new Error('kaput'); } },
    readView: async () => view(10), config: { reminderMs: DAILY }, baseUrl: null, now: () => T0,
    log: (level, message) => exploding.logs.push([level, message]),
  });
  exploding.logs = [];
  await exploding.check();
  await exploding.check();
  test('a notifier that throws is logged as a failed delivery and retried only after the delay', () => {
    assertEqual(exploding.logs, [['WARN', 'the storage notification through notifier failed: kaput']]);
  });

  // overlapping checks
  // (every send waits at a gate that is opened by hand, so a regression shows up as a failed test, not a hang)
  const gates = [];
  const slow = new Spy();
  slow.deliver = (msg) => new Promise((resolve) => { gates.push(() => { slow.sent.push(msg); resolve(); }); });
  const busy = setup({ channels: [slow], free: 100 });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = busy.n.check();
  await tick();
  const second = busy.n.check();
  await tick();
  test('a check that arrives while the previous one is still sending is skipped', () => assertEqual([busy.env.reads, gates.length], [1, 1]));
  gates.forEach((open) => open());
  await Promise.all([first, second]);
  await busy.n.check();
  test('and the next one after it finished is an ordinary check again', () => assertEqual([busy.env.reads, slow.sent.length], [2, 1]));

  summarize();
})();
