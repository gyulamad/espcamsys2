'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { ScanQueue, MAX_REMEMBERED_ERRORS } = require('../../nodejs/camera-relay/lib/scanqueue');

const tick = () => new Promise((r) => setImmediate(r));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

(async () => {
  await (async () => {
    const gate = deferred(); const order = []; const finished = [];
    const q = new ScanQueue({ work: async (j) => { order.push(`start ${j.key}`); if (j.key === 'a') await gate.promise; order.push(`end ${j.key}`); return { state: 'moved' }; }, onFinished: (j, o) => finished.push([j.key, o.state]) });
    test('jobs run one at a time, in order, and states are visible', async () => {});
    assertEqual(q.enqueue('a', {}), 'queued');
    assertEqual(q.enqueue('b', {}), 'queued');
    assertEqual(q.enqueue('a', {}), 'duplicate');
    assertEqual(q.enqueue('b', {}), 'duplicate');
    await tick();
    test('a runs, b waits', () => {
      assertEqual([q.stateOf('a'), q.stateOf('b'), q.stateOf('c'), q.size()], [{ state: 'processing' }, { state: 'queued' }, null, 2]);
      assertEqual(order, ['start a']);
    });
    gate.resolve();
    await tick(); await tick(); await tick();
    test('then b, strictly after a; all done', () => {
      assertEqual(order, ['start a', 'end a', 'start b', 'end b']);
      assertEqual(finished, [['a', 'moved'], ['b', 'moved']]);
      assertEqual([q.stateOf('a'), q.size()], [null, 0]);
    });
  })();

  await (async () => {
    let n = 0;
    const q = new ScanQueue({ work: async () => (++n === 1 ? { state: 'error', reason: 'no model' } : { state: 'person' }) });
    q.enqueue('x', {});
    await tick(); await tick();
    test('an error outcome is remembered until the next attempt', () => assertEqual(q.stateOf('x'), { state: 'error', reason: 'no model' }));
    q.enqueue('x', {});
    test('a new attempt wipes the old failure', () => assertEqual(q.stateOf('x'), { state: 'processing' }));
    await tick(); await tick();
    test('and a success leaves nothing behind', () => assertEqual(q.stateOf('x'), null));
  })();

  await (async () => {
    const seen = [];
    const q = new ScanQueue({ work: async (j) => { if (j.key === 'boom') throw new Error('kaput'); return { state: 'moved' }; }, onFinished: (j) => { seen.push(j.key); throw new Error('reporting broke'); } });
    q.enqueue('boom', {}); q.enqueue('after', {});
    await tick(); await tick(); await tick();
    test('a throwing job and a throwing reporter do not stop the queue', () => {
      assertEqual(seen, ['boom', 'after']);
      assertTrue(q.stateOf('boom').reason.includes('kaput'));
    });
  })();

  await (async () => {
    const q = new ScanQueue({ work: async () => ({ state: 'error', reason: 'r' }) });
    for (let i = 0; i < MAX_REMEMBERED_ERRORS + 5; i++) { q.enqueue(`k${i}`, {}); await tick(); }
    await tick();
    test('remembered failures are capped, oldest dropped', () => {
      assertEqual(q.failures.size, MAX_REMEMBERED_ERRORS);
      assertEqual([q.stateOf('k0'), q.stateOf(`k${MAX_REMEMBERED_ERRORS + 4}`).state], [null, 'error']);
    });
  })();

  summarize();
})();
