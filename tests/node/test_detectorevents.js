'use strict';
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ev = require('../../nodejs/camera-relay/lib/detectorevents');

test('encodeEvent: one SSE message, JSON on a single data line', () => {
  assertEqual(ev.encodeEvent('detectors', { a: 1 }), 'event: detectors\ndata: {"a":1}\n\n');
  const s = ev.encodeEvent('x', { t: 'line1\nline2' });
  assertEqual(s.split('\n').length, 4, 'a newline inside a value is escaped, never a second data line');
});

test('createFeed: every change is sent at once while the connection keeps up', () => {
  const out = []; let n = 0;
  const feed = ev.createFeed((t) => { out.push(t); return true; }, () => ({ n: ++n }));
  feed.notify(); feed.notify(); feed.notify();
  assertEqual(out.length, 3);
  assertTrue(out[2].includes('"n":3'));
});

test('createFeed: a stalled connection gets ONE newest update after drain, not a queue', () => {
  const out = []; let n = 0; let ok = false;
  const feed = ev.createFeed((t) => { out.push(t); return ok; }, () => ({ n: ++n }));
  feed.notify();                     // sent, but the buffer is now full
  feed.notify(); feed.notify(); feed.notify(); // collapsed
  assertEqual(out.length, 1);
  ok = true;
  feed.drain();
  assertEqual(out.length, 2, 'exactly one catch-up message');
  assertTrue(out[1].includes('"n":2'), 'snapshot is taken at send time, so it is the newest');
  feed.drain();
  assertEqual(out.length, 2, 'drain with nothing pending sends nothing');
});

test('createFeed: drain without a stall does not send; notify after drain sends again', () => {
  const out = [];
  const feed = ev.createFeed((t) => { out.push(t); return true; }, () => ({}));
  feed.drain();
  assertEqual(out.length, 0);
  feed.notify();
  assertEqual(out.length, 1);
});

test('constants are sane', () => {
  assertTrue(ev.REFRESH_MS >= 200 && ev.REFRESH_MS <= 5000);
  assertTrue(ev.MAX_VIEWERS >= 1);
  assertEqual(ev.HEADERS['Content-Type'].split(';')[0], 'text/event-stream');
});

summarize();
