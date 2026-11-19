'use strict';

// test_logtail.js — nodejs/camera-relay/lib/logtail.js: the tail of the relay's log and Apache's error log that the
// dashboard's OTA & LOGS page shows (what `tail -n N file | grep -E '\b(WARN|ERROR)\b'` would print).
// The files are real (a throwaway folder); nothing is mocked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { asyncTest: test, assertEqual, assertTrue, runAsyncTests } = require('./framework');
const logtail = require('../../nodejs/camera-relay/lib/logtail');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const makeFile = (content) => { n += 1; const f = path.join(dir, `f${n}.log`); fs.writeFileSync(f, content); return f; };

const RELAY_ERR = '2026-11-17T10:00:01.234Z ERROR cam2@192.168.4.20 up=3621.4s: Frame capture failed';
const RELAY_WARN = '2026-11-17T10:00:02.000Z WARN  cam3@192.168.4.21: weak signal';
const RELAY_INFO = '2026-11-17T10:00:03.000Z INFO  cam2@192.168.4.20 [relay]: camera connected';
const APACHE_ERR = '[Tue Nov 17 10:00:04.123456 2026] [php:error] [pid 812] [client 10.0.0.5:5000] PHP Fatal error:  Uncaught Error';
const APACHE_WARN = '[Tue Nov 17 10:00:05.000000 2026] [core:warn] [pid 812] AH00045: child process still did not exit';
const APACHE_NOTICE = '[Tue Nov 17 10:00:06.000000 2026] [mpm_prefork:notice] [pid 1] AH00163: Apache configured';

// ── the request ─────────────────────────────────────────────────────────

test('parseLineCount: a whole number from 1 to 5000, 1000 when absent or empty', () => {
  assertEqual(logtail.parseLineCount(undefined), { ok: true, value: 1000 });
  assertEqual(logtail.parseLineCount(''), { ok: true, value: 1000 });
  assertEqual(logtail.parseLineCount('1'), { ok: true, value: 1 });
  assertEqual(logtail.parseLineCount('250'), { ok: true, value: 250 });
  assertEqual(logtail.parseLineCount('5000'), { ok: true, value: 5000 });
});

test('parseLineCount: anything else is refused (never clamped, never guessed)', () => {
  for (const bad of ['0', '5001', '-1', '12a', ' 5', '1.5', '1e3', '123456', ['1', '2'], { a: 1 }, 5]) {
    assertEqual(logtail.parseLineCount(bad).ok, false, JSON.stringify(bad));
  }
  assertTrue(logtail.parseLineCount('0').error.includes('1 to 5000'));
});

test('parseLevels: no filter when absent, empty or with ALL', () => {
  assertEqual(logtail.parseLevels(undefined), { ok: true, levels: null });
  assertEqual(logtail.parseLevels(''), { ok: true, levels: null });
  assertEqual(logtail.parseLevels('ALL'), { ok: true, levels: null });
  assertEqual(logtail.parseLevels('warn,all'), { ok: true, levels: null });
});

test('parseLevels: the chosen levels, case-insensitive, in a fixed order, once each', () => {
  assertEqual(logtail.parseLevels('WARN,ERROR'), { ok: true, levels: ['WARN', 'ERROR'] });
  assertEqual(logtail.parseLevels('error, warn ,ERROR'), { ok: true, levels: ['WARN', 'ERROR'] });
  assertEqual(logtail.parseLevels('DEBUG'), { ok: true, levels: ['DEBUG'] });
});

test('parseLevels: an unknown level, a list that is not a string: refused', () => {
  for (const bad of ['FATAL', 'WARN,FATAL', 'WARN;ERROR', 'WARN,,ERROR', ['WARN'], { a: 1 }]) {
    assertEqual(logtail.parseLevels(bad).ok, false, JSON.stringify(bad));
  }
});

// ── one line ────────────────────────────────────────────────────────────

test('levelsOfLine: the level words of a relay log line, as grep -w finds them', () => {
  assertEqual([...logtail.levelsOfLine(RELAY_ERR, 'relay')], ['ERROR']);
  assertEqual([...logtail.levelsOfLine(RELAY_WARN, 'relay')], ['WARN']);
  assertEqual([...logtail.levelsOfLine('    -12.3s INFO push connection established', 'relay')], ['INFO']);
  assertEqual([...logtail.levelsOfLine('2026-11-17T10:00:03.000Z INFO  x: a WARN then an ERROR', 'relay')].sort(), ['ERROR', 'INFO', 'WARN']);
});

test('levelsOfLine: only whole upper-case words count', () => {
  for (const line of ['ERRORS happened', 'a WARNING', 'xINFO', 'error warn info debug', 'NOERROR']) {
    assertEqual([...logtail.levelsOfLine(line, 'relay')], [], line);
  }
});

test('levelsOfLine: an Apache line counts at the level of its [module:level] tag', () => {
  assertEqual([...logtail.levelsOfLine(APACHE_ERR, 'apache')], ['ERROR']);
  assertEqual([...logtail.levelsOfLine(APACHE_WARN, 'apache')], ['WARN']);
  assertEqual([...logtail.levelsOfLine(APACHE_NOTICE, 'apache')], ['INFO']);
  assertEqual([...logtail.levelsOfLine('[x] [proxy_fcgi:crit] boom', 'apache')], ['ERROR']);
  assertEqual([...logtail.levelsOfLine('[x] [core:alert] boom', 'apache')], ['ERROR']);
  assertEqual([...logtail.levelsOfLine('[x] [core:emerg] boom', 'apache')], ['ERROR']);
  assertEqual([...logtail.levelsOfLine('[x] [rewrite:trace3] detail', 'apache')], ['DEBUG']);
  assertEqual([...logtail.levelsOfLine('[x] [core:debug] detail', 'apache')], ['DEBUG']);
});

test('levelsOfLine: the Apache tag is read only in the Apache log, and a tag and a word add up', () => {
  assertEqual([...logtail.levelsOfLine('[php:error] looks like a tag', 'relay')], []);
  assertEqual([...logtail.levelsOfLine('[x] [core:warn] says ERROR in the text', 'apache')].sort(), ['ERROR', 'WARN']);
});

test('matchesLevels: no filter keeps everything; a filter keeps the lines at one of its levels', () => {
  assertTrue(logtail.matchesLevels('anything at all', null, 'relay'));
  assertTrue(logtail.matchesLevels(RELAY_ERR, ['WARN', 'ERROR'], 'relay'));
  assertTrue(logtail.matchesLevels(RELAY_WARN, ['WARN', 'ERROR'], 'relay'));
  assertTrue(!logtail.matchesLevels(RELAY_INFO, ['WARN', 'ERROR'], 'relay'));
  assertTrue(logtail.matchesLevels(APACHE_ERR, ['ERROR'], 'apache'));
  assertTrue(!logtail.matchesLevels(APACHE_NOTICE, ['ERROR'], 'apache'));
  assertTrue(!logtail.matchesLevels('no level here', ['ERROR'], 'relay'));
});

test('cleanLine: control characters become ?, a tab stays, a very long line is cut', () => {
  assertEqual(logtail.cleanLine('a\u001b[31mred\u001b[0m\tb\u0000c\u007fd'), 'a?[31mred?[0m\tb?c?d');
  assertEqual(logtail.cleanLine('plain text, ünïcode ✓'), 'plain text, ünïcode ✓');
  const cut = logtail.cleanLine('x'.repeat(5000));
  assertEqual(cut.length, 2001);
  assertTrue(cut.endsWith('x…'));
});

// ── one file ────────────────────────────────────────────────────────────

test('tailFile: the last N lines, oldest first', async () => {
  const f = makeFile(['one', 'two', 'three', 'four', 'five'].join('\n') + '\n');
  assertEqual(await logtail.tailFile(f, 3), { ok: true, lines: ['three', 'four', 'five'] });
  assertEqual(await logtail.tailFile(f, 99), { ok: true, lines: ['one', 'two', 'three', 'four', 'five'] });
  assertEqual(await logtail.tailFile(f, 1), { ok: true, lines: ['five'] });
});

test('tailFile: a last line without its newline is a line too; CRLF endings are dropped; blank lines stay', () => {
  const f = makeFile('a\r\nb\n\nc');
  return logtail.tailFile(f, 10).then((r) => assertEqual(r, { ok: true, lines: ['a', 'b', '', 'c'] }));
});

test('tailFile: an empty file has no lines', async () => {
  assertEqual(await logtail.tailFile(makeFile(''), 5), { ok: true, lines: [] });
});

test('tailFile: a file bigger than the window gives whole lines only, the newest ones', async () => {
  const all = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(3, '0')}`);
  const f = makeFile(all.join('\n') + '\n');           // 9 bytes a line
  const r = await logtail.tailFile(f, 1000, 100);       // a window of 100 bytes: the oldest of its lines is cut
  assertTrue(r.ok);
  assertTrue(r.lines.length > 0 && r.lines.length <= 11, `lines: ${r.lines.length}`);
  assertEqual(r.lines[r.lines.length - 1], 'line-199');
  for (const l of r.lines) assertTrue(/^line-\d{3}$/.test(l), `a whole line: ${l}`);
});

test('tailFile: a multi-byte character cut by the window does not leak into a line', async () => {
  const f = makeFile('é'.repeat(50) + '\nlast\n');
  const r = await logtail.tailFile(f, 10, 20);
  assertEqual(r, { ok: true, lines: ['last'] });
});

test('tailFile: a file that is not there, a folder', async () => {
  assertEqual(await logtail.tailFile(path.join(dir, 'nope.log'), 5), { ok: false, error: 'the file does not exist' });
  assertEqual(await logtail.tailFile(dir, 5), { ok: false, error: 'it is not a regular file' });
});

test('tailFile: a file the relay may not read says so (skipped when run as root, which may read anything)', async () => {
  if (process.getuid && process.getuid() === 0) { console.log('       (running as root: skipped)'); return; }
  const f = makeFile('secret\n');
  fs.chmodSync(f, 0o000);
  assertEqual(await logtail.tailFile(f, 5), { ok: false, error: 'the relay is not allowed to read it (permission denied)' });
});

test('capChars: the newest lines that fit', () => {
  assertEqual(logtail.capChars(['aaaa', 'bbbb', 'cccc'], 10), ['bbbb', 'cccc']);
  assertEqual(logtail.capChars(['aaaa', 'bbbb', 'cccc'], 1000), ['aaaa', 'bbbb', 'cccc']);
  assertEqual(logtail.capChars(['a very long line'], 5), []);
  assertEqual(logtail.capChars([], 5), []);
});

// ── the answer ──────────────────────────────────────────────────────────

test('readSources: the tail comes first, the filter second (what tail | grep does)', async () => {
  // 6 lines, the ERROR is the 1st: a tail of 4 does not reach it, though it is in the file
  const f = makeFile([RELAY_ERR, RELAY_INFO, RELAY_INFO, RELAY_WARN, RELAY_INFO, RELAY_INFO].join('\n') + '\n');
  const [src] = await logtail.readSources([{ kind: 'relay', path: f }], 4, ['WARN', 'ERROR']);
  assertEqual(src, { kind: 'relay', path: f, ok: true, lines: [RELAY_WARN] });
  const [all] = await logtail.readSources([{ kind: 'relay', path: f }], 4, null);
  assertEqual(all.lines.length, 4);
});

test('readSources: a source that cannot be read is reported, the others are still read', async () => {
  const f = makeFile(`${RELAY_ERR}\n`);
  const missing = path.join(dir, 'gone.log');
  const out = await logtail.readSources([{ kind: 'relay', path: f }, { kind: 'apache', path: missing }], 10, null);
  assertEqual(out[0], { kind: 'relay', path: f, ok: true, lines: [RELAY_ERR] });
  assertEqual(out[1], { kind: 'apache', path: missing, ok: false, error: 'the file does not exist' });
});

test('readSources: Apache lines are filtered by their tag, lines are cleaned', async () => {
  const f = makeFile([APACHE_NOTICE, APACHE_ERR + '\u001b[0m', APACHE_WARN].join('\n') + '\n');
  const [src] = await logtail.readSources([{ kind: 'apache', path: f }], 10, ['ERROR']);
  assertEqual(src.lines, [APACHE_ERR + '?[0m']);
});

test('answer: the shape, the defaults and the time', async () => {
  const f = makeFile(`${RELAY_ERR}\n${RELAY_INFO}\n`);
  const r = await logtail.answer({}, [{ kind: 'relay', path: f }], new Date('2026-11-17T12:00:00.000Z'));
  assertEqual(r.status, 200);
  assertEqual(r.body, { at: '2026-11-17T12:00:00.000Z', lines: 1000, levels: null, sources: [{ kind: 'relay', path: f, ok: true, lines: [RELAY_ERR, RELAY_INFO] }] });
});

test('answer: the query is applied', async () => {
  const f = makeFile(`${RELAY_ERR}\n${RELAY_INFO}\n${RELAY_WARN}\n`);
  const r = await logtail.answer({ lines: '3', levels: 'warn,error' }, [{ kind: 'relay', path: f }]);
  assertEqual(r.body.levels, ['WARN', 'ERROR']);
  assertEqual(r.body.lines, 3);
  assertEqual(r.body.sources[0].lines, [RELAY_ERR, RELAY_WARN]);
});

test('answer: a query that is not understood is a 400 and reads nothing', async () => {
  const f = path.join(dir, 'never-read.log');
  const bad = await logtail.answer({ lines: 'many' }, [{ kind: 'relay', path: f }]);
  assertEqual(bad.status, 400);
  assertTrue(bad.body.error.includes('lines'));
  const badLevel = await logtail.answer({ levels: 'LOUD' }, [{ kind: 'relay', path: f }]);
  assertEqual(badLevel.status, 400);
  assertTrue(badLevel.body.error.includes('levels'));
});

test('answer: only the configured files are read, never a path from the request', async () => {
  const secret = makeFile('top secret\n');
  const f = makeFile(`${RELAY_ERR}\n`);
  const r = await logtail.answer({ file: secret, path: secret, source: secret }, [{ kind: 'relay', path: f }]);
  assertEqual(r.body.sources.map((s) => s.path), [f]);
  assertTrue(!JSON.stringify(r.body).includes('top secret'));
});

// ── the configuration ───────────────────────────────────────────────────

test('resolveSources: the relay log, and Apache\'s error log when there is one', () => {
  assertEqual(logtail.resolveSources({ relayLog: '/r/camera.log', apacheErrorLog: '/var/log/apache2/error.log' }), [
    { kind: 'relay', path: '/r/camera.log' }, { kind: 'apache', path: '/var/log/apache2/error.log' },
  ]);
  assertEqual(logtail.resolveSources({ relayLog: '/r/c.log', apacheErrorLog: '/var/log/httpd/error_log' })[1].path, '/var/log/httpd/error_log');
});

test('resolveSources: a relative Apache path is relative to the relay folder', () => {
  assertEqual(logtail.resolveSources({ relayLog: '/r/c.log', apacheErrorLog: 'logs/apache.log' }, '/relay')[1].path, '/relay/logs/apache.log');
});

test('resolveSources: an empty Apache setting leaves it out; the relay\'s own log is always there', () => {
  assertEqual(logtail.resolveSources({ relayLog: '/r/c.log', apacheErrorLog: '' }), [{ kind: 'relay', path: '/r/c.log' }]);
  assertEqual(logtail.resolveSources({ relayLog: '/r/c.log' }), [{ kind: 'relay', path: '/r/c.log' }]);
});

runAsyncTests();
