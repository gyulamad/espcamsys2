'use strict';

// test_muxfeed.js — what GET /mux does for one viewer (nodejs/camera-relay/lib/muxfeed.js): the list of cameras it
// accepts, the "newest picture only" rule for a viewer that cannot keep up, and the wiring to the cameras.

const { EventEmitter } = require('events');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const feedLib = require('../../nodejs/camera-relay/lib/muxfeed');
const codec = require('../../nodejs/camera-relay/lib/muxcodec');
const decoder = require('../../php/cameras/js/mux-codec');
const { CAMERA_ID_RE } = require('../../nodejs/camera-relay/lib/logentry');

const RULES = { idPattern: CAMERA_ID_RE, maxCameras: 3, maxDetectors: 2 };
const pic = (n) => Buffer.from([0xff, 0xd8, n]);

// Everything written, decoded back into [type, source, first payload byte].
function recorder(answers = []) {
  const writes = [];
  const write = (bytes) => { writes.push(bytes); return answers.length ? answers.shift() : true; };
  const decoded = () => writes.flatMap((b) => decoder.createParser().push(new Uint8Array(b)).map((m) => [m.type, m.source, m.payload[2]]));
  return { write, writes, decoded };
}

test('parseRequest: a comma-separated list of cameras, each once, in the order given', () => {
  assertEqual(feedLib.parseRequest({ cams: 'a,b,c' }, RULES), { cams: ['a', 'b', 'c'], dets: [], status: false, rec: false });
  assertEqual(feedLib.parseRequest({ cams: 'b,a,b' }, RULES).cams, ['b', 'a']);
  assertEqual(feedLib.parseRequest({ cams: 'cam-1.x_2' }, RULES).cams, ['cam-1.x_2']);
});

test('parseRequest: the cameras\' recording state is an optional extra, asked for with rec=1 only', () => {
  assertEqual(feedLib.parseRequest({ cams: 'a' }, RULES).rec, false);
  assertEqual(feedLib.parseRequest({ cams: 'a', rec: '1' }, RULES).rec, true);
  assertEqual(feedLib.parseRequest({ cams: 'a', rec: 'true' }, RULES).rec, false);
  assertEqual(feedLib.parseRequest({ cams: 'a', rec: ['1', '1'] }, RULES).rec, false);
});

test('parseRequest: detectors and the readings are optional extras', () => {
  assertEqual(feedLib.parseRequest({ cams: 'a', dets: 'd1,d2', status: '1' }, RULES), { cams: ['a'], dets: ['d1', 'd2'], status: true, rec: false });
  assertEqual(feedLib.parseRequest({ cams: 'a', status: '0' }, RULES).status, false);
  assertEqual(feedLib.parseRequest({ cams: 'a', status: 'yes' }, RULES).status, false, 'only "1" asks for the readings');
});

test('parseRequest: everything else is an error that says why', () => {
  for (const cams of [undefined, '', ',', 'a,', 'a,,b', ['a', 'b'], 'a b', '../x', 'a/b', 'a'.repeat(65), {}, 5]) {
    const r = feedLib.parseRequest({ cams }, RULES);
    assertTrue(typeof r.error === 'string' && r.cams === undefined, `cams ${JSON.stringify(cams)} must be refused`);
  }
  assertTrue(/cams.*more than 3/.test(feedLib.parseRequest({ cams: 'a,b,c,d' }, RULES).error));
  assertEqual(feedLib.parseRequest({ cams: 'a,a,a,b' }, RULES).cams, ['a', 'b'], 'the limit counts distinct cameras');
  for (const dets of ['', ',', 'd1,', ['d1', 'd2'], 'a/b', '__proto__/x', 5]) {
    const r = feedLib.parseRequest({ cams: 'a', dets }, RULES);
    assertTrue(typeof r.error === 'string' && /dets/.test(r.error), `dets ${JSON.stringify(dets)} must be refused`);
  }
  assertTrue(/dets.*more than 2/.test(feedLib.parseRequest({ cams: 'a', dets: 'x,y,z' }, RULES).error));
});

test('createFeed: while the connection keeps up every picture is written at once', () => {
  const r = recorder();
  const feed = feedLib.createFeed(r.write);
  feed.offer('cam:a', pic(1));
  feed.offer('cam:b', pic(2));
  feed.offer('cam:a', pic(3));
  assertEqual(r.decoded(), [[1, 'cam:a', 1], [1, 'cam:b', 2], [1, 'cam:a', 3]]);
});

test('createFeed: a full connection keeps only the NEWEST picture of each camera, sent after drain', () => {
  const r = recorder([false]);                 // the first write fills the buffer
  const feed = feedLib.createFeed(r.write);
  feed.offer('cam:a', pic(1));
  feed.offer('cam:a', pic(2));
  feed.offer('cam:b', pic(3));
  feed.offer('cam:a', pic(4));
  assertEqual(r.writes.length, 1, 'nothing is written while the buffer is full');
  feed.drain();
  assertEqual(r.decoded(), [[1, 'cam:a', 1], [1, 'cam:a', 4], [1, 'cam:b', 3]], 'a1 went out first; then only the newest of a, and b');
  feed.drain();
  assertEqual(r.writes.length, 3, 'drain with nothing waiting writes nothing');
});

test('createFeed: draining stops again as soon as the buffer is full, the rest waits for the next drain', () => {
  const r = recorder([false, false, true]);
  const feed = feedLib.createFeed(r.write);
  feed.offer('cam:a', pic(1));   // false: full
  feed.offer('cam:b', pic(2));
  feed.offer('cam:c', pic(3));
  feed.drain();                  // writes b: false again
  assertEqual(r.decoded().map((m) => m[1]), ['cam:a', 'cam:b']);
  feed.drain();                  // writes c
  assertEqual(r.decoded().map((m) => m[1]), ['cam:a', 'cam:b', 'cam:c']);
});

test('createFeed: a heartbeat is written when idle and left out when the connection is busy', () => {
  const r = recorder([false]);
  const feed = feedLib.createFeed(r.write);
  feed.heartbeat();
  assertEqual(r.decoded().map((m) => m[0]), [codec.TYPE_HEARTBEAT]);
  feed.heartbeat();
  assertEqual(r.writes.length, 1, 'the buffer is full: the connection is plainly alive');
  feed.drain();
  feed.heartbeat();
  assertEqual(r.writes.length, 2);
});

function cameras(...ids) {
  return ids.map((id) => ({ id, cam: { emitter: new EventEmitter(), frame: null } }));
}
function fakeTimers() {
  const t = { fn: null, ms: null, cleared: 0, all: [] };
  t.set = (fn, ms) => { t.fn = fn; t.ms = ms; t.all.push({ fn, ms }); return 'timer'; };
  t.clear = (h) => { if (h === 'timer') t.cleared += 1; };
  return t;
}

test('openSession: a heartbeat first, then the last known pictures, then every new one', () => {
  const r = recorder();
  const list = cameras('a', 'b');
  list[1].cam.frame = pic(9);
  const timers = fakeTimers();
  feedLib.openSession({ write: r.write, cameras: list, setTimer: timers.set, clearTimer: timers.clear });
  assertEqual(r.decoded(), [[2, '', undefined], [1, 'cam:b', 9]]);
  list[0].cam.emitter.emit('frame', pic(5));
  assertEqual(r.decoded().pop(), [1, 'cam:a', 5]);
});

test('openSession: the heartbeat timer runs at HEARTBEAT_MS and beats', () => {
  const r = recorder();
  const timers = fakeTimers();
  feedLib.openSession({ write: r.write, cameras: cameras('a'), setTimer: timers.set, clearTimer: timers.clear });
  assertEqual(timers.ms, feedLib.HEARTBEAT_MS);
  timers.fn();
  assertEqual(r.decoded().map((m) => m[0]), [2, 2]);
});

test('openSession: close() leaves nothing subscribed and stops the timer; pictures after it are ignored', () => {
  const r = recorder();
  const list = cameras('a', 'b');
  const timers = fakeTimers();
  const session = feedLib.openSession({ write: r.write, cameras: list, setTimer: timers.set, clearTimer: timers.clear });
  assertEqual(list.map((c) => c.cam.emitter.listenerCount('frame')), [1, 1]);
  session.close();
  assertEqual(list.map((c) => c.cam.emitter.listenerCount('frame')), [0, 0]);
  assertEqual(timers.cleared, 1);
  list[0].cam.emitter.emit('frame', pic(1));
  assertEqual(r.writes.length, 1, 'only the first heartbeat was ever written');
});

test('openSession: drain() lets a viewer that was behind catch up', () => {
  const r = recorder([true, false]);       // the heartbeat fits, the first picture fills the buffer
  const list = cameras('a');
  const session = feedLib.openSession({ write: r.write, cameras: list, setTimer: () => 't', clearTimer: () => {} });
  list[0].cam.emitter.emit('frame', pic(1));
  list[0].cam.emitter.emit('frame', pic(2));
  list[0].cam.emitter.emit('frame', pic(3));
  session.drain();
  assertEqual(r.decoded().map((m) => m[2]), [undefined, 1, 3]);
});

test('createFeed: the readings are made when they are SENT, so a viewer that is behind gets the newest and nothing is built for the rest', () => {
  const r = recorder([false]);
  const feed = feedLib.createFeed(r.write);
  let made = 0;
  const snapshot = () => ({ n: ++made });
  feed.offerState(codec.STATE_DETECTORS, snapshot);   // sent: the buffer is now full
  feed.offerState(codec.STATE_DETECTORS, snapshot);
  feed.offerState(codec.STATE_DETECTORS, snapshot);
  assertEqual(made, 1, 'nothing was built for the two that had to wait');
  feed.drain();
  assertEqual(made, 2);
  const states = r.writes.flatMap((b) => decoder.createParser().push(new Uint8Array(b))).filter((m) => m.type === codec.TYPE_STATE);
  assertEqual(states.map((m) => JSON.parse(Buffer.from(m.payload).toString())), [{ n: 1 }, { n: 2 }]);
  assertEqual(states[0].source, 'state:detectors');
});

test('createFeed: pictures and readings wait in the same line: one message per source, the newest', () => {
  const r = recorder([false]);
  const feed = feedLib.createFeed(r.write);
  feed.offer('cam:a', pic(1));
  feed.offerState(codec.STATE_DETECTORS, () => ({ v: 1 }));
  feed.offer('det:d', pic(2));
  feed.offer('det:d', pic(3));
  feed.drain();
  assertEqual(r.decoded().map((m) => [m[0], m[1]]), [[1, 'cam:a'], [3, 'state:detectors'], [1, 'det:d']]);
  assertEqual(r.decoded()[2][2], 3, 'the newest picture of det:d');
});

function bus() {
  return new EventEmitter();
}
function detector(frame = null) {
  return { emitter: new EventEmitter(), frame };
}

test('openSession: a detector\'s pictures arrive under its own source, the last one at once', () => {
  const r = recorder();
  const d = detector(pic(7));
  feedLib.openSession({ write: r.write, cameras: cameras('a'), detectors: { ids: ['d1'], lookup: (id) => (id === 'd1' ? d : undefined), bus: bus() }, setTimer: () => 't', clearTimer: () => {} });
  assertEqual(r.decoded().filter((m) => m[1] !== ''), [[1, 'det:d1', 7]]);
  d.emitter.emit('frame', pic(8));
  assertEqual(r.decoded().pop(), [1, 'det:d1', 8]);
});

test('openSession: a detector that connects later is picked up when the relay says something changed', () => {
  const r = recorder();
  const known = {};
  const b = bus();
  feedLib.openSession({ write: r.write, cameras: cameras('a'), detectors: { ids: ['d1', 'd2'], lookup: (id) => known[id], bus: b }, setTimer: () => 't', clearTimer: () => {} });
  const d2 = detector();
  known.d2 = d2;
  b.emit('change');
  d2.emitter.emit('frame', pic(5));
  assertEqual(r.decoded().filter((m) => m[1] === 'det:d2'), [[1, 'det:d2', 5]]);
  b.emit('change'); b.emit('change');
  assertEqual(d2.emitter.listenerCount('frame'), 1, 'followed once, however often the relay says something changed');
});

test('openSession: the readings are sent at once, on every change, and once a second', () => {
  const r = recorder();
  const b = bus();
  const timers = fakeTimers();
  let n = 0;
  feedLib.openSession({ write: r.write, cameras: cameras('a'), status: { snapshot: () => ({ n: ++n }), bus: b }, setTimer: timers.set, clearTimer: timers.clear });
  const states = () => r.writes.flatMap((x) => decoder.createParser().push(new Uint8Array(x))).filter((m) => m.type === codec.TYPE_STATE).length;
  assertEqual(states(), 1, 'at once');
  b.emit('change');
  assertEqual(states(), 2, 'on a change');
  assertEqual(timers.all.map((x) => x.ms), [feedLib.STATUS_REFRESH_MS, feedLib.HEARTBEAT_MS], 'a timer for the readings, one for the heartbeat');
  timers.all[0].fn();
  assertEqual(states(), 3, 'and every second');
});

test('openSession: close() stops following detectors and readings too', () => {
  const r = recorder();
  const b = bus();
  const d = detector();
  const timers = fakeTimers();
  const session = feedLib.openSession({ write: r.write, cameras: cameras('a'), detectors: { ids: ['d1'], lookup: () => d, bus: b }, status: { snapshot: () => ({}), bus: b }, setTimer: timers.set, clearTimer: timers.clear });
  assertEqual([b.listenerCount('change'), d.emitter.listenerCount('frame')], [2, 1]);
  session.close();
  assertEqual([b.listenerCount('change'), d.emitter.listenerCount('frame')], [0, 0]);
  const written = r.writes.length;
  b.emit('change');
  d.emitter.emit('frame', pic(1));
  assertEqual(r.writes.length, written, 'nothing is written after close');
});

test('createFeed: readings given as JSON text are sent as they are (not encoded a second time)', () => {
  const r = recorder();
  const feed = feedLib.createFeed(r.write);
  feed.offerState(codec.STATE_CAMERAS, () => '{"a":{"recording":true}}');
  const [m] = r.writes.flatMap((b) => decoder.createParser().push(new Uint8Array(b)));
  assertEqual([m.type, m.source, Buffer.from(m.payload).toString()], [codec.TYPE_STATE, 'state:cameras', '{"a":{"recording":true}}']);
});

function sharedSnapshot() {
  const s = { listeners: new Set(), unsubscribed: 0 };
  s.subscribe = (listener) => { s.listeners.add(listener); return () => { s.listeners.delete(listener); s.unsubscribed += 1; }; };
  s.push = (text) => [...s.listeners].forEach((l) => l(text));
  return s;
}

test('openSession: the cameras\' recording state is sent as state:cameras every time the shared snapshot has a new one', () => {
  const r = recorder();
  const shared = sharedSnapshot();
  feedLib.openSession({ write: r.write, cameras: cameras('a'), cameraStatus: shared, setTimer: () => 't', clearTimer: () => {} });
  shared.push('{"a":{"recording":false}}');
  shared.push('{"a":{"recording":true}}');
  const states = r.writes.flatMap((x) => decoder.createParser().push(new Uint8Array(x))).filter((m) => m.type === codec.TYPE_STATE);
  assertEqual(states.map((m) => [m.source, Buffer.from(m.payload).toString()]),
    [['state:cameras', '{"a":{"recording":false}}'], ['state:cameras', '{"a":{"recording":true}}']]);
});

test('openSession: not asked for = not subscribed; close() unsubscribes', () => {
  const r = recorder();
  const shared = sharedSnapshot();
  feedLib.openSession({ write: r.write, cameras: cameras('a'), setTimer: () => 't', clearTimer: () => {} });
  assertEqual(shared.listeners.size, 0);
  const session = feedLib.openSession({ write: r.write, cameras: cameras('a'), cameraStatus: shared, setTimer: () => 't', clearTimer: () => {} });
  assertEqual(shared.listeners.size, 1);
  session.close();
  assertEqual([shared.listeners.size, shared.unsubscribed], [0, 1]);
  const written = r.writes.length;
  shared.push('{}');
  assertEqual(r.writes.length, written);
});

test('HEADERS: a mux stream is never sniffed as anything else and never cached', () => {
  assertEqual(feedLib.HEADERS['Content-Type'], 'application/x-espcam-mux');
  assertEqual(feedLib.HEADERS['X-Content-Type-Options'], 'nosniff');
  assertEqual(feedLib.HEADERS['Cache-Control'], 'no-store');
  assertTrue(Object.isFrozen(feedLib.HEADERS));
  assertTrue(feedLib.HEARTBEAT_MS < 15000, 'the PHP proxy and the browser give up after 15 s of silence');
});

summarize();
