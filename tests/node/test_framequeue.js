'use strict';

// Tests the recording frame writer (nodejs/camera-relay/lib/framequeue.js): the queue that
// replaced a per-frame fs.writeFileSync in server.js's startRecording(). What has to hold:
//   * frames are written one at a time, in arrival order (ffmpeg's frame_%06d.jpg pattern
//     reads up to the first gap, so the numbering must never get out of step)
//   * a write that fails (rejects, or throws synchronously) is reported and the queue
//     continues — the clip loses that frame, not the rest of the recording
//   * a disk that falls behind bounds the queue: the oldest frames are dropped and
//     reported, the rest are written in order once the disk recovers
//   * write() never throws, and a broken onError/onDrop cannot stop the queue
//   * the bytes are copied on the way in, so the caller's buffer can be reused afterwards
//   * idle() resolves exactly when everything enqueued before it has settled
//
// The fake writeFile hands out promises the test settles by hand, so every ordering rule
// above is checked against a disk the test slows down at will. (Async style as in
// test_scanqueue.js: await until the queue has done its thing, then assert inside test().)

const { createFrameWriter, DEFAULT_MAX_PENDING } = require('../../nodejs/camera-relay/lib/framequeue');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const tick = () => new Promise((r) => setImmediate(r));

// A writeFile whose results the test controls: each call records { path, data, settle, fail }
// and returns a promise the test settles (fs.settle(i) / fs.fail(i)). maxInFlight() says how
// many writes were ever running at once — the "one at a time" rule.
function fakeDisk() {
  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fs = {
    writeFile(path, data) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        writes.push({ path, data, settle: () => { inFlight -= 1; resolve(); }, fail: (err) => { inFlight -= 1; reject(err); } });
      });
    },
    settle(i) { writes[i].settle(); },
    fail(i, err) { writes[i].fail(err || new Error('disk full')); },
    count: () => writes.length,
    paths: () => writes.map((w) => w.path),
    datas: () => writes.map((w) => w.data),
  };
  fs.maxInFlight = () => maxInFlight;
  return fs;
}

(async () => {
  // ── order and concurrency ──
  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({ writeFile: fs.writeFile });
    for (const n of [1, 2, 3, 4, 5]) w.write(`f${n}`, Buffer.from([n]));
    await tick(); await tick();
    test('only the first frame is in flight; the rest wait their turn', () => {
      assertEqual(fs.count(), 1);
      assertEqual(w.pending(), 4);
    });
    for (let i = 0; i < 4; i++) { fs.settle(i); await tick(); }
    test('frames land in arrival order, never two writes at once', () => {
      assertEqual(fs.paths(), ['f1', 'f2', 'f3', 'f4', 'f5']);
      assertEqual(fs.maxInFlight(), 1);
      assertEqual(w.pending(), 0);
      assertEqual(w.dropped(), 0);
    });
  })();

  // ── failures ──
  await (async () => {
    const fs = fakeDisk();
    const errors = [];
    const w = createFrameWriter({ writeFile: fs.writeFile, onError: (err) => errors.push(err.message) });
    w.write('f1', Buffer.from([1]));
    w.write('f2', Buffer.from([2]));
    w.write('f3', Buffer.from([3]));
    await tick(); await tick();
    fs.fail(0, new Error('disk full'));   // f1's write rejects
    await tick(); await tick();
    test('a rejected write is reported and does not stop the queue', () => {
      assertEqual(errors, ['disk full']);
      assertEqual(fs.count(), 2, 'f2 was attempted next');
    });
    fs.settle(1); await tick();
    test('the frames after the failed one still land, in order', () => {
      assertEqual(fs.paths(), ['f1', 'f2', 'f3']);
      assertEqual(w.dropped(), 0);
    });
  })();

  await (async () => {
    let calls = 0;
    const errors = [];
    const boom = () => { calls += 1; throw new Error('sync throw'); };
    const w = createFrameWriter({ writeFile: boom, onError: (err) => errors.push(err.message) });
    w.write('f1', Buffer.from([1]));
    w.write('f2', Buffer.from([2]));
    await tick(); await tick(); await tick();
    test('a writeFile that THROWS synchronously is reported, twice, and nothing is stuck', () => {
      assertEqual(calls, 2);
      assertEqual(errors, ['sync throw', 'sync throw']);
      assertEqual(w.pending(), 0);
    });
  })();

  // ── the disk falling behind ──
  await (async () => {
    const fs = fakeDisk();
    const drops = [];
    const w = createFrameWriter({ writeFile: fs.writeFile, maxPending: 3, onDrop: (dropped, waiting) => drops.push([dropped, waiting]) });
    for (const n of [1, 2, 3, 4, 5, 6]) w.write(`f${n}`, Buffer.from([n]));   // nothing settles yet
    await tick(); await tick();
    test('a full queue drops its oldest frames and says so', () => {
      assertEqual(w.dropped(), 3, 'f1..f3 were dropped so f4..f6 fit');
      assertEqual(w.pending(), 2, 'f5 and f6 wait (f4 is in flight)');
      assertEqual(fs.count(), 1, 'still only one write in flight');
      assertTrue(drops.length >= 1, `the drop was reported (got ${JSON.stringify(drops)})`);
      assertEqual(drops[drops.length - 1][0], 3, 'the report counts every drop so far');
    });
    fs.settle(0); await tick(); fs.settle(1); await tick(); fs.settle(2); await tick();
    test('once the disk recovers, the surviving frames land in order', () => {
      assertEqual(fs.paths(), ['f4', 'f5', 'f6']);
      assertEqual(w.dropped(), 3);
      assertEqual(w.pending(), 0);
      assertEqual(fs.maxInFlight(), 1);
    });
  })();

  // ── the bytes are copied on the way in ──
  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({ writeFile: fs.writeFile });
    const frame = Buffer.from([1, 2, 3]);
    w.write('f1', frame);
    frame[0] = 99;   // the caller reuses its buffer (the push socket reuses its receive buffer)
    await tick(); await tick();
    fs.settle(0); await tick();
    test('a mutated caller buffer does not change what lands on disk', () => {
      assertEqual(Array.from(fs.datas()[0]), [1, 2, 3]);
    });
  })();

  // ── nothing the caller does can make write() throw ──
  await (async () => {
    const errors = [];
    const w = createFrameWriter({
      writeFile: () => Promise.resolve(),
      copy: () => { throw new Error('cannot copy'); },
      onError: (err) => errors.push(err.message),
    });
    w.write('f1', Buffer.from([1]));   // must not throw
    await tick(); await tick();
    test('a throwing copy is reported, not thrown', () => {
      assertEqual(errors, ['cannot copy']);
      assertEqual(w.pending(), 0);
    });
  })();

  // ── a broken reporter must not stop the queue ──
  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({
      writeFile: fs.writeFile,
      onError: () => { throw new Error('broken reporter'); },
    });
    w.write('f1', Buffer.from([1]));
    w.write('f2', Buffer.from([2]));
    await tick(); await tick();
    fs.fail(0);   // reported through a reporter that itself throws
    await tick(); await tick();
    fs.settle(1); await tick();
    test('a broken onError cannot stop the queue (the chain never rejects)', () => {
      assertEqual(fs.paths(), ['f1', 'f2']);
    });
  })();

  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({
      writeFile: fs.writeFile,
      maxPending: 1,
      onDrop: () => { throw new Error('broken drop reporter'); },
    });
    w.write('f1', Buffer.from([1]));
    await tick(); await tick();          // f1 is in flight now, the queue is empty
    w.write('f2', Buffer.from([2]));    // queued (nothing to drop yet)
    w.write('f3', Buffer.from([3]));    // the queue is full: f2 is dropped, through the broken reporter
    await tick(); await tick();
    fs.settle(0); await tick(); await tick();
    test('a broken onDrop cannot stop the queue either', () => {
      assertEqual(w.dropped(), 1);
      assertEqual(fs.paths(), ['f1', 'f3'], 'the surviving frames are still written in order');
    });
  })();

  // ── idle() ──
  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({ writeFile: fs.writeFile });
    w.write('f1', Buffer.from([1]));
    w.write('f2', Buffer.from([2]));
    await tick(); await tick();
    let idleDone = false;
    w.idle().then(() => { idleDone = true; });
    await tick(); await tick();
    test('idle() does not resolve while a write is in flight', () => assertEqual(idleDone, false));
    fs.settle(0); await tick(); await tick();
    test('...nor while the next one is', () => assertEqual(idleDone, false));
    fs.settle(1); await tick(); await tick();
    test('it resolves once everything enqueued before it has settled', () => assertEqual(idleDone, true));
  })();

  await (async () => {
    const w0 = createFrameWriter({ writeFile: () => Promise.resolve() });
    let done0 = false;
    w0.idle().then(() => { done0 = true; });
    await tick();
    test('idle() of a fresh writer resolves at once', () => assertEqual(done0, true));
  })();

  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({ writeFile: fs.writeFile, onError: () => {} });
    w.write('f1', Buffer.from([1]));
    await tick(); await tick();
    let done = false;
    w.idle().then(() => { done = true; });
    fs.fail(0);   // the only frame fails
    await tick(); await tick();
    test('a failed write counts as settled for idle()', () => assertEqual(done, true));
  })();

  // ── construction ──
  await (async () => {
    const fs = fakeDisk();
    const w = createFrameWriter({ writeFile: fs.writeFile, maxPending: 0 });
    w.write('f1', Buffer.from([1]));
    await tick(); await tick();
    test('a maxPending below 1 falls back to the default instead of dropping everything', () => {
      assertEqual(DEFAULT_MAX_PENDING >= 1, true);
      assertEqual(fs.count(), 1, 'the frame was written, not dropped');
      assertEqual(w.dropped(), 0);
    });
  })();

  test('writeFile is required', () => {
    let threw = null;
    try { createFrameWriter({}); } catch (err) { threw = err; }
    assertTrue(!!threw && /writeFile/.test(threw.message), 'a TypeError naming writeFile');
  });

  summarize();
})();
