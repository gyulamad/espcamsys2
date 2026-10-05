'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { LogWriter } = require('../../nodejs/camera-relay/lib/logwriter');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logwriter-'));
let n = 0;
const freshFile = () => path.join(tmp, `case${n++}`, 'sub', 'camera.log'); // sub/ does not exist yet
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

(async () => {
  // ── async scenarios first; their results are asserted below ──
  // 1. many un-awaited appends must land in order, none interleaved
  const f1 = freshFile();
  const w1 = new LogWriter({ file: f1, maxBytes: 1e9, keep: 2 });
  await Promise.all(Array.from({ length: 200 }, (_, i) => w1.append(`line ${i}\n`)));
  const ordered = read(f1).split('\n').filter(Boolean);

  // 2. a failed write rejects THAT call but later writes still go through
  const f2 = freshFile();
  let calls = 0;
  const flaky = Object.assign({}, fs, {
    promises: Object.assign({}, fs.promises, {
      appendFile: (...args) => (++calls === 2 ? Promise.reject(new Error('disk exploded')) : fs.promises.appendFile(...args)),
    }),
  });
  const w2 = new LogWriter({ file: f2, maxBytes: 1e9, keep: 2, fsImpl: flaky });
  const r = await Promise.all([w2.append('a\n').then(() => 'ok', (e) => e.message), w2.append('b\n').then(() => 'ok', (e) => e.message), w2.append('c\n').then(() => 'ok', (e) => e.message)]);
  const afterFailure = { results: r, content: read(f2) };

  // 3. async rotation keeps order across the rotation boundary
  const f3 = freshFile();
  const w3 = new LogWriter({ file: f3, maxBytes: 100, keep: 2 });
  for (let i = 0; i < 30; i++) w3.append(`entry-${String(i).padStart(2, '0')}-xxxxxxxxxxxxxxxxxxxx\n`); // 25 bytes each
  await w3._chain;
  const rotatedAsync = [read(f3), read(f3 + '.1'), read(f3 + '.2'), read(f3 + '.3')];

  // ── assertions ──
  test('append: creates the folder, and many un-awaited appends land in order', () => {
    assertEqual(ordered.length, 200);
    assertEqual(ordered, Array.from({ length: 200 }, (_, i) => `line ${i}`));
  });

  test('append: a failed write rejects only that call; the queue is not poisoned', () => {
    assertEqual(afterFailure.results, ['ok', 'disk exploded', 'ok']);
    assertEqual(afterFailure.content, 'a\nc\n');
  });

  test('rotation (async): newest entries are in the live file, older ones in .1/.2, nothing beyond keep', () => {
    assertEqual(rotatedAsync[3], null, 'only `keep` rotated files exist');
    const all = [rotatedAsync[2], rotatedAsync[1], rotatedAsync[0]].filter((x) => x !== null).join('').split('\n').filter(Boolean);
    // what survives is a contiguous, ordered run ending at the newest entry
    const nums = all.map((l) => Number(l.slice(6, 8)));
    assertEqual(nums[nums.length - 1], 29);
    assertEqual(nums, nums.slice().sort((a, b) => a - b));
    assertTrue(nums.every((v, i) => i === 0 || v === nums[i - 1] + 1), 'no gaps inside what is kept');
    assertTrue(nums.length < 30, 'old entries were discarded');
  });

  // ── synchronous behaviour ──
  test('appendSync: writes immediately and tracks the size', () => {
    const f = freshFile();
    const w = new LogWriter({ file: f, maxBytes: 1e9, keep: 2 });
    w.appendSync('héllo\n'); // multi-byte: size is in BYTES
    w.appendSync('x\n');
    assertEqual(read(f), 'héllo\nx\n');
    assertEqual(w.size, Buffer.byteLength('héllo\nx\n'));
  });

  test('startup: an existing log file is appended to and its size counted', () => {
    const f = freshFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '12345678\n');
    const w = new LogWriter({ file: f, maxBytes: 1e9, keep: 2 });
    assertEqual(w.size, 9);
    w.appendSync('more\n');
    assertEqual(read(f), '12345678\nmore\n');
  });

  test('rotation: shifts camera.log -> .1 -> .2 and drops the oldest', () => {
    const f = freshFile();
    const w = new LogWriter({ file: f, maxBytes: 20, keep: 2 });
    w.appendSync('AAAAAAAAAAAAAAA\n'); // 16 bytes
    w.appendSync('BBBBBBBBBBBBBBB\n'); // would exceed 20 -> rotates first
    w.appendSync('CCCCCCCCCCCCCCC\n');
    w.appendSync('DDDDDDDDDDDDDDD\n');
    assertEqual(read(f), 'DDDDDDDDDDDDDDD\n');
    assertEqual(read(f + '.1'), 'CCCCCCCCCCCCCCC\n');
    assertEqual(read(f + '.2'), 'BBBBBBBBBBBBBBB\n');
    assertEqual(read(f + '.3'), null);
    // 'A...' (the oldest) is gone entirely
    assertTrue(![read(f), read(f + '.1'), read(f + '.2')].join('').includes('A'));
  });

  test('rotation: an entry is never split across two files', () => {
    const f = freshFile();
    const w = new LogWriter({ file: f, maxBytes: 30, keep: 1 });
    const entry = 'header line\n    trace 1\n    trace 2\n'; // 36 bytes > maxBytes on its own
    w.appendSync(entry);
    w.appendSync(entry);
    assertEqual(read(f), entry);
    assertEqual(read(f + '.1'), entry);
  });

  test('rotation: disk use is bounded by (keep + 1) * maxBytes however much is written', () => {
    const f = freshFile();
    const w = new LogWriter({ file: f, maxBytes: 200, keep: 3 });
    for (let i = 0; i < 500; i++) w.appendSync(`${'x'.repeat(40)}\n`);
    const total = [f, f + '.1', f + '.2', f + '.3', f + '.4'].map(read).filter((x) => x !== null).reduce((s, x) => s + Buffer.byteLength(x), 0);
    assertTrue(total <= 4 * 200, `total=${total}`);
    assertEqual(read(f + '.4'), null);
  });

  test('a file that is missing from the rotation chain is fine (gaps are skipped)', () => {
    const f = freshFile();
    const w = new LogWriter({ file: f, maxBytes: 20, keep: 3 });
    w.appendSync('AAAAAAAAAAAAAAA\n');
    w.appendSync('BBBBBBBBBBBBBBB\n'); // .2 and .3 do not exist yet — must not throw
    assertEqual(read(f + '.1'), 'AAAAAAAAAAAAAAA\n');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  summarize();
})();
