'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { createAlarmFeed, KEEP_EVENTS } = require('../../nodejs/camera-relay/lib/alarmfeed');

function make(extra = {}) {
  const clock = { t: 5000 };
  const feed = createAlarmFeed({ now: () => clock.t, ...extra });
  return { feed, clock };
}
const ev = (n) => ({ kind: 'recordStart', camId: `cam${n}`, sound: `s${n}.wav` });

test('a new feed has no events, the time it started, and the time now', () => {
  const { feed, clock } = make();
  assertEqual(feed.snapshot(), { epoch: 5000, now: 5000, events: [] });
  clock.t = 9000;
  assertEqual(feed.snapshot(), { epoch: 5000, now: 9000, events: [] });
});

test('publish numbers events 1, 2, 3 ... and stamps each with the time it was published', () => {
  const { feed, clock } = make();
  feed.publish(ev(1));
  clock.t = 6000;
  feed.publish({ kind: 'personDetected', camId: 'cam2', sound: 'p.mp3' });
  assertEqual(feed.snapshot().events, [
    { seq: 1, at: 5000, kind: 'recordStart', camId: 'cam1', sound: 's1.wav' },
    { seq: 2, at: 6000, kind: 'personDetected', camId: 'cam2', sound: 'p.mp3' },
  ]);
});

test('only the latest events are kept, and the numbers keep going up', () => {
  const { feed } = make();
  for (let i = 1; i <= KEEP_EVENTS + 3; i += 1) feed.publish(ev(i));
  const seqs = feed.snapshot().events.map((e) => e.seq);
  assertEqual(seqs.length, KEEP_EVENTS);
  assertEqual(seqs[0], 4);
  assertEqual(seqs[seqs.length - 1], KEEP_EVENTS + 3);
  const small = make({ keep: 2 });
  for (let i = 1; i <= 5; i += 1) small.feed.publish(ev(i));
  assertEqual(small.feed.snapshot().events.map((e) => e.seq), [4, 5]);
});

test('publish tells the bus once per event; nobody is told by looking at the snapshot', () => {
  const { feed } = make();
  let changes = 0;
  feed.bus.on('change', () => { changes += 1; });
  feed.snapshot();
  assertEqual(changes, 0);
  feed.publish(ev(1));
  feed.publish(ev(2));
  assertEqual(changes, 2);
});

test('the snapshot is a copy: changing it cannot change what the feed holds', () => {
  const { feed } = make();
  feed.publish(ev(1));
  const snap = feed.snapshot();
  snap.events[0].sound = 'evil.wav';
  snap.events.push({ seq: 99 });
  assertEqual(feed.snapshot().events.map((e) => e.sound), ['s1.wav']);
});

test('the snapshot is JSON the mux stream can send as it is', () => {
  const { feed } = make();
  feed.publish(ev(1));
  assertEqual(JSON.parse(JSON.stringify(feed.snapshot())), feed.snapshot());
});

test('the bus tolerates as many viewers as /mux allows (no listener warning)', () => {
  const { feed } = make({ maxListeners: 20 });
  assertTrue(feed.bus.getMaxListeners() >= 20);
});

summarize();
