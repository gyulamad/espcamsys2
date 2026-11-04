'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { createSorter } = require('../../nodejs/camera-relay/lib/sorter');
const ps = require('../../nodejs/camera-relay/lib/personscan');

const CLIP = '/r/cam1/cam1_2026.mp4';

function rig({ action = 'move', writing = false, modelExists = true, clipExists = true, detector, moveFails = false, clipGoneAtStart = false } = {}) {
  const calls = [];
  const config = ps.resolveScanConfig({ action }, '/relay');
  let checks = 0;
  const files = {
    // the clip exists at the first look unless clipGoneAtStart; clipExists=false means it vanishes while the detector works
    exists: (p) => { if (p === config.model) return modelExists; checks += 1; return checks === 1 ? !clipGoneAtStart : clipExists; },
    isBeingWritten: () => writing,
    move: (a, b) => { if (moveFails) throw new Error('EACCES'); calls.push(['move', a, b]); },
    remove: (p) => calls.push(['remove', p]),
    removeThumbnail: (p) => calls.push(['removeThumbnail', p]),
  };
  const runDetector = async (args) => { calls.push(['detect', args[args.indexOf('--video') + 1]]); return detector; };
  return { sorter: createSorter({ config, runDetector, files }), calls, config };
}
const answer = (obj, code = 0) => ({ code, stdout: JSON.stringify(obj), stderr: '', timedOut: false, spawnError: null });

test('person found: clip kept, nothing touched', async () => {
  const r = rig({ detector: answer({ ok: true, person: true, confidence: 0.9 }) });
  assertEqual(await r.sorter.sort(CLIP), { state: 'person', confidence: 0.9 });
  assertEqual(r.calls, [['detect', CLIP]]);
});

test('no person + move: clip goes to no-person/', async () => {
  const r = rig({ detector: answer({ ok: true, person: false }) });
  assertEqual(await r.sorter.sort(CLIP), { state: 'moved' });
  assertEqual(r.calls[1], ['move', CLIP, '/r/cam1/no-person/cam1_2026.mp4']);
});

test('no person + delete: clip removed', async () => {
  const r = rig({ action: 'delete', detector: answer({ ok: true, person: false }) });
  assertEqual(await r.sorter.sort(CLIP), { state: 'removed' });
  assertEqual(r.calls[1], ['remove', CLIP]);
});

test('clip the relay is still encoding: not even scanned', async () => {
  const r = rig({ writing: true, detector: answer({ ok: true, person: false }) });
  const o = await r.sorter.sort(CLIP);
  assertEqual(o.state, 'error');
  assertTrue(o.reason.includes('still being encoded'));
  assertEqual(r.calls, []);
});

test('clip gone before the scan: error, nothing scanned', async () => {
  const r = rig({ clipGoneAtStart: true, detector: answer({ ok: true, person: false }) });
  assertEqual((await r.sorter.sort(CLIP)).reason, 'the recording no longer exists');
  assertEqual(r.calls, []);
});

test('model missing: error naming the path, clip untouched', async () => {
  const r = rig({ modelExists: false, detector: answer({ ok: true, person: false }) });
  const o = await r.sorter.sort(CLIP);
  assertEqual(o.state, 'error');
  assertTrue(o.reason.includes(r.config.model));
  assertEqual(r.calls, []);
});

test('detector failures never remove the clip', async () => {
  for (const detector of [
    { code: 1, stdout: '{"ok":false,"error":"x"}', stderr: '', timedOut: false, spawnError: null },
    { code: null, stdout: '', stderr: '', timedOut: true, spawnError: null },
    { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' },
    { code: 0, stdout: 'garbage', stderr: '', timedOut: false, spawnError: null },
  ]) {
    for (const action of ['move', 'delete']) {
      const r = rig({ action, detector });
      assertEqual((await r.sorter.sort(CLIP)).state, 'error');
      assertEqual(r.calls, [['detect', CLIP]]);
    }
  }
});

test('clip deleted while being checked: thumbnail cleaned up, reported', async () => {
  const r = rig({ clipExists: false, detector: answer({ ok: true, person: true, confidence: 0.8 }) });
  const o = await r.sorter.sort(CLIP);
  assertEqual(o.state, 'error');
  assertEqual(r.calls[1], ['removeThumbnail', CLIP]);
});

test('move fails: error, not a crash', async () => {
  const r = rig({ moveFails: true, detector: answer({ ok: true, person: false }) });
  const o = await r.sorter.sort(CLIP);
  assertEqual(o.state, 'error');
  assertTrue(o.reason.includes('EACCES'));
});

summarize();
