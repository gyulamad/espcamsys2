'use strict';

const { EventEmitter } = require('events');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { runProcess } = require('../../nodejs/camera-relay/lib/runprocess');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.killed = null; c.kill = (s) => { c.killed = s; setImmediate(() => c.emit('close', null, s)); };
  return c;
}

(async () => {
  let r = await runProcess('x', ['a'], { spawnFn: () => { const c = fakeChild(); setImmediate(() => { c.stdout.emit('data', Buffer.from('out')); c.stderr.emit('data', Buffer.from('err')); c.emit('close', 0, null); }); return c; } });
  test('collects output and exit code', () => assertEqual([r.code, r.stdout, r.stderr, r.timedOut, r.spawnError], [0, 'out', 'err', false, null]));

  r = await runProcess('x', [], { spawnFn: () => { const c = fakeChild(); setImmediate(() => c.emit('error', new Error('spawn x ENOENT'))); return c; } });
  test('a missing program is a result, not a throw', () => assertEqual([r.spawnError, r.code], ['spawn x ENOENT', null]));

  r = await runProcess('x', [], { spawnFn: () => { throw new Error('EAGAIN'); } });
  test('spawn throwing synchronously is a result too', () => assertEqual(r.spawnError, 'EAGAIN'));

  let child;
  r = await runProcess('x', [], { timeoutMs: 5, spawnFn: () => { child = fakeChild(); return child; } });
  test('a hung process is killed and reported as timed out', () => assertEqual([r.timedOut, child.killed], [true, 'SIGKILL']));

  r = await runProcess('x', [], { maxOutputBytes: 4, spawnFn: () => { const c = fakeChild(); setImmediate(() => { c.stdout.emit('data', Buffer.from('abcdefgh')); c.stdout.emit('data', Buffer.from('ijk')); c.emit('close', 0, null); }); return c; } });
  test('output is capped', () => assertEqual(r.stdout, 'abcd'));

  let opts;
  r = await runProcess('x', ['y'], { env: { A: '1' }, spawnFn: (cmd, args, o) => { opts = [cmd, args, o]; const c = fakeChild(); setImmediate(() => c.emit('close', 0, null)); return c; } });
  test('never uses a shell and passes env through', () => {
    assertEqual([opts[0], opts[1], opts[2].shell, opts[2].env], ['x', ['y'], false, { A: '1' }]);
    assertTrue(true);
  });
  summarize();
})();
