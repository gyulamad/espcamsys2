'use strict';

// test_mux_client.js — the connection manager of the dashboard's mux stream (php/cameras/js/mux-client.js) against a
// fake fetch and fake timers: no browser, nothing to install. The wire format is test_muxcodec.js's business;
// this checks the life of the connection: opening, reading, retrying with a growing pause, giving up after three
// attempts that never produced a message (so the page can fall back), a silent link, and closing on purpose.

const path = require('path');
const { assertEqual, assertTrue } = require('./framework');
const enc = require('../../nodejs/camera-relay/lib/muxcodec');
const codec = require('../../php/cameras/js/mux-codec');
const Client = require('../../php/cameras/js/mux-client');

// The shared test() is synchronous; these tests wait for promises, so they run one after the other here.
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of queue) {
    try { await fn(); pass += 1; console.log(`[PASS] ${name}`); } catch (err) { fail += 1; console.error(`[FAIL] ${name} -- ${err.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

const flush = () => new Promise((r) => setImmediate(r));
const JPEG = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// Timers that only move when the test says so.
function fakeClock() {
  const clock = { now: 0, next: 1, timers: new Map() };
  clock.setTimeout = (fn, ms) => { const id = clock.next++; clock.timers.set(id, { at: clock.now + ms, fn }); return id; };
  clock.clearTimeout = (id) => { clock.timers.delete(id); };
  clock.advance = async (ms) => {
    const end = clock.now + ms;
    for (;;) {
      const due = [...clock.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]);
      clock.now = due[1].at;
      due[1].fn();
      await flush();
    }
    clock.now = end;
    await flush();
  };
  clock.pending = () => clock.timers.size;
  return clock;
}

// One fake network: every fetch() is recorded; the test decides what each one answers.
function fakeNetwork() {
  const net = { calls: [], answers: [] };
  net.fetch = (url, options) => {
    const call = { url, options, chunks: [], waiting: null, closed: false, error: null, aborted: false };
    net.calls.push(call);
    const wake = () => { if (call.waiting) { const w = call.waiting; call.waiting = null; w(); } };
    call.push = (bytes) => { call.chunks.push(new Uint8Array(bytes)); wake(); };
    call.end = () => { call.closed = true; wake(); };
    options.signal.addEventListener('abort', () => { call.aborted = true; call.error = abortError(); wake(); });
    const answer = net.answers.shift() || {};
    if (answer.reject) return Promise.reject(answer.reject);
    const response = {
      ok: answer.ok !== false,
      status: answer.status || 200,
      headers: { get: () => (answer.contentType === undefined ? enc.CONTENT_TYPE : answer.contentType) },
      body: {
        getReader: () => ({
          read: async () => {
            for (;;) {
              if (call.error) throw call.error;
              if (call.chunks.length) return { done: false, value: call.chunks.shift() };
              if (call.closed) return { done: true };
              await new Promise((resolve) => { call.waiting = resolve; });
            }
          },
        }),
      },
    };
    return Promise.resolve(response);
  };
  return net;
}

function setup(options = {}) {
  const clock = fakeClock();
  const net = fakeNetwork();
  const seen = { messages: [], down: 0, giveUp: 0, urls: 0 };
  const client = Client.create({
    buildUrl: () => { seen.urls += 1; return 'mux.php?cams=a,b'; },
    onMessage: (m) => seen.messages.push(m),
    onDown: () => { seen.down += 1; },
    onGiveUp: () => { seen.giveUp += 1; },
    env: {
      fetch: net.fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      AbortController, codec,
    },
  });
  if (options.answers) net.answers.push(...options.answers);
  return { clock, net, seen, client };
}

test('start opens the connection once, with the camera list asked for at that moment', async () => {
  const { net, seen, client } = setup();
  client.start();
  client.start();
  await flush();
  assertEqual(net.calls.length, 1);
  assertEqual(net.calls[0].url, 'mux.php?cams=a,b');
  assertEqual(net.calls[0].options.credentials, 'same-origin');
  assertEqual(seen.urls, 1);
  assertEqual(client.state(), 'connecting', 'nothing has arrived yet');
});

test('messages are handed over as they arrive, even cut anywhere, and the first one makes the client live', async () => {
  const { net, seen, client } = setup();
  client.start();
  await flush();
  const bytes = Buffer.concat([enc.encodeHeartbeat(), enc.encodeFrame('cam:a', JPEG)]);
  net.calls[0].push(bytes.subarray(0, 5));
  await flush();
  assertEqual(seen.messages.length, 0);
  net.calls[0].push(bytes.subarray(5));
  await flush();
  assertEqual(seen.messages.map((m) => [m.type, m.source]), [[enc.TYPE_HEARTBEAT, ''], [enc.TYPE_FRAME, 'cam:a']]);
  assertEqual(client.state(), 'live');
});

test('a connection that ends after it was live is reopened after 1 s, and the page is told it went down', async () => {
  const { clock, net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].push(enc.encodeHeartbeat());
  await flush();
  net.calls[0].end();
  await flush();
  assertEqual([client.state(), seen.down, net.calls.length], ['waiting', 1, 1]);
  await clock.advance(999);
  assertEqual(net.calls.length, 1, 'not yet');
  await clock.advance(1);
  assertEqual(net.calls.length, 2);
  assertEqual(seen.giveUp, 0);
});

test('the pause between attempts grows 1, 2, 4 ... up to 15 s', () => {
  assertEqual([0, 1, 2, 3, 4, 5, 9].map(Client.backoffMs), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('three attempts in a row that never produce a message: onGiveUp, and the client stops', async () => {
  const { clock, net, seen, client } = setup({ answers: [{ ok: false, status: 502 }, { contentType: 'text/html' }, { reject: new Error('network') }] });
  client.start();
  await flush();
  await clock.advance(1000);
  await clock.advance(2000);
  assertEqual(net.calls.length, 3);
  assertEqual([seen.giveUp, client.state(), seen.down], [1, 'idle', 3]);
  assertEqual(clock.pending(), 0, 'nothing is left running');
});

test('an attempt that answers with a type other than the mux type is refused, however it ends', async () => {
  const { net, seen, client } = setup({ answers: [{ contentType: 'multipart/x-mixed-replace; boundary=frame' }] });
  client.start();
  await flush();
  assertEqual([seen.messages.length, seen.down, client.state()], [0, 1, 'waiting']);
});

test('a stream of garbage counts as a failed attempt (the format is not the one this page knows)', async () => {
  const { net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].push(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 1]));
  await flush();
  assertEqual([seen.messages.length, seen.down, client.state()], [0, 1, 'waiting']);
});

test('a connection that was live earlier does not count towards giving up', async () => {
  const { clock, net, seen, client } = setup();
  client.start();
  await flush();
  for (let round = 0; round < 5; round++) {
    const call = net.calls[net.calls.length - 1];
    call.push(enc.encodeHeartbeat());
    await flush();
    call.end();
    await flush();
    await clock.advance(1000);
  }
  assertEqual([seen.giveUp, net.calls.length], [0, 6]);
});

test('a link that goes silent for 15 s is closed and reopened', async () => {
  const { clock, net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].push(enc.encodeHeartbeat());
  await flush();
  await clock.advance(14999);
  assertEqual(net.calls[0].aborted, false);
  await clock.advance(1);
  assertTrue(net.calls[0].aborted, 'the silent connection was closed');
  assertEqual([seen.down, client.state()], [1, 'waiting']);
  await clock.advance(1000);
  assertEqual(net.calls.length, 2);
});

test('every arriving byte restarts the silence timer', async () => {
  const { clock, net, client } = setup();
  client.start();
  await flush();
  for (let i = 0; i < 4; i++) {
    net.calls[0].push(enc.encodeHeartbeat());
    await flush();
    await clock.advance(10000);
  }
  assertEqual(net.calls[0].aborted, false);
  assertEqual(client.state(), 'live');
});

test('an attempt that is never answered is given up after 15 s too', async () => {
  const net = fakeNetwork();
  net.fetch = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(abortError())));
  const clock = fakeClock();
  const seen = { down: 0 };
  const client = Client.create({ buildUrl: () => 'x', onMessage() {}, onDown: () => { seen.down += 1; }, onGiveUp() {},
    env: { fetch: net.fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, AbortController, codec } });
  client.start();
  await flush();
  await clock.advance(15000);
  assertEqual([seen.down, client.state()], [1, 'waiting']);
});

test('restart closes the open connection, asks for the camera list again, and opens a new one at once', async () => {
  const { clock, net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].push(enc.encodeHeartbeat());
  await flush();
  client.restart();
  await flush();
  assertEqual([net.calls.length, net.calls[0].aborted, seen.urls], [2, true, 2]);
  assertEqual(seen.down, 0, 'closing on purpose is not "going down"');
  assertEqual(clock.pending(), 1, 'only the new connection\'s silence timer');
});

test('restart while waiting to retry does not wait for the pause', async () => {
  const { net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].end();
  await flush();
  assertEqual(client.state(), 'waiting');
  client.restart();
  await flush();
  assertEqual(net.calls.length, 2);
  assertEqual(seen.down, 1);
});

test('stop closes the connection and cancels everything: no retry, no late message', async () => {
  const { clock, net, seen, client } = setup();
  client.start();
  await flush();
  net.calls[0].push(enc.encodeFrame('cam:a', JPEG));
  await flush();
  assertEqual(seen.messages.length, 1);
  client.stop();
  net.calls[0].push(enc.encodeFrame('cam:a', JPEG));
  await flush();
  await clock.advance(60000);
  assertEqual([client.state(), net.calls.length, seen.messages.length, seen.down, clock.pending()], ['idle', 1, 1, 0, 0]);
  client.start();
  await flush();
  assertEqual(net.calls.length, 2, 'it can be started again');
});

test('a retry that was waiting when the client was stopped never happens', async () => {
  const { clock, net, client } = setup();
  client.start();
  await flush();
  net.calls[0].end();
  await flush();
  client.stop();
  await clock.advance(60000);
  assertEqual(net.calls.length, 1);
});

runAll();
