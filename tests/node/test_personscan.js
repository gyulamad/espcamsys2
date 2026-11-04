'use strict';

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ps = require('../../nodejs/camera-relay/lib/personscan');

const DIR = '/relay';
const cfg = (raw) => ps.resolveScanConfig(raw, DIR);

test('resolveScanConfig: defaults (off, move, model under the relay folder)', () => {
  const c = cfg(undefined);
  assertEqual([c.enabled, c.auto, c.action, c.confidence, c.stride], [false, true, 'move', 0.4, 1]);
  assertEqual(c.model, '/relay/models/person.onnx');
  assertEqual(c.script, '/relay/tools/person_scan.py');
  assertEqual([c.timeoutMs, c.warnings], [900000, []]);
});

test('resolveScanConfig: valid values are taken, paths resolved against the relay folder', () => {
  const c = cfg({ enabled: true, auto: false, action: 'delete', confidence: '0.6', stride: 5, model: 'm/x.onnx', python: ' /usr/bin/python3 ', timeoutSeconds: 60 });
  assertEqual([c.enabled, c.auto, c.action, c.confidence, c.stride, c.python], [true, false, 'delete', 0.6, 5, '/usr/bin/python3']);
  assertEqual([c.model, c.timeoutMs, c.warnings], ['/relay/m/x.onnx', 60000, []]);
});

test('resolveScanConfig: bad values fall back to the default with a warning each', () => {
  const c = cfg({ enabled: 'yes', auto: 1, action: 'burn', confidence: 0, stride: 1.5, timeoutSeconds: 1 });
  assertEqual([c.enabled, c.auto, c.action, c.confidence, c.stride, c.timeoutMs], [false, true, 'move', 0.4, 1, 900000]);
  assertEqual(c.warnings.length, 6);
});

test('resolveScanConfig: a non-object block is ignored', () => {
  assertEqual(cfg('nonsense').warnings, []);
  assertEqual(cfg(null).enabled, false);
});

test('thumbnailPath / noPersonPath sit next to the clip and never look like a recording', () => {
  assertEqual(ps.thumbnailPath('/r/cam1/cam1_x.mp4'), '/r/cam1/cam1_x.mp4.thumb.jpg');
  assertEqual(ps.noPersonPath('/r/cam1/cam1_x.mp4'), '/r/cam1/no-person/cam1_x.mp4');
  assertTrue(!/\.mp4$/.test(ps.thumbnailPath('/r/cam1/cam1_x.mp4')));
});

test('buildScanArgs: plain argv entries (a hostile-looking name stays one argument)', () => {
  const c = cfg({ confidence: 0.5, stride: 2 });
  const args = ps.buildScanArgs(c, '/r/cam1/a b;rm -rf.mp4');
  assertEqual(args, [c.script, '--model', c.model, '--video', '/r/cam1/a b;rm -rf.mp4', '--thumbnail', '/r/cam1/a b;rm -rf.mp4.thumb.jpg', '--confidence', '0.5', '--stride', '2']);
});

test('scanEnv passes PATH only — no keys', () => {
  const e = ps.scanEnv({ PATH: '/x', CAM_KEY: 'secret', HOME: '/h' });
  assertEqual(Object.keys(e).sort(), ['LANG', 'OMP_NUM_THREADS', 'PATH']);
  assertEqual(e.PATH, '/x');
  assertEqual(ps.scanEnv({}).PATH, '/usr/bin:/bin');
});

const run = (o) => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...o });

test('parseScanResult: person', () => {
  assertEqual(ps.parseScanResult(run({ stdout: '{"ok":true,"person":true,"confidence":0.81}\n' })), { kind: 'person', confidence: 0.81 });
  assertEqual(ps.parseScanResult(run({ stdout: '{"ok":true,"person":true}' })), { kind: 'person', confidence: null });
});

test('parseScanResult: none only from a clean exit with an explicit ok:true person:false', () => {
  assertEqual(ps.parseScanResult(run({ stdout: 'warning line\n{"ok":true,"person":false}\n' })), { kind: 'none' });
});

test('parseScanResult: NOTHING else ever becomes "none" (that would delete footage)', () => {
  const bad = [
    run({ spawnError: 'ENOENT' }),
    run({ timedOut: true, stdout: '{"ok":true,"person":false}' }),
    run({ stdout: '' }),
    run({ stdout: 'not json' }),
    run({ stdout: '[]' }),
    run({ stdout: '{"person":false}' }),
    run({ stdout: '{"ok":true}' }),
    run({ stdout: '{"ok":true,"person":"no"}' }),
    run({ code: 1, stdout: '{"ok":true,"person":false}' }),
    run({ code: 137, stdout: '' }),
    run({ stdout: '{"ok":false,"error":"stopped early"}', code: 1 }),
  ];
  for (const r of bad) assertEqual(ps.parseScanResult(r).kind, 'error', JSON.stringify(r));
});

test('parseScanResult: reasons are readable and short', () => {
  assertEqual(ps.parseScanResult(run({ stdout: '{"ok":false,"error":"the video could not be opened"}', code: 1 })).reason, 'the video could not be opened');
  assertEqual(ps.parseScanResult(run({ stdout: '', stderr: 'Traceback\nImportError: no cv2', code: 1 })).reason, 'ImportError: no cv2');
  assertEqual(ps.parseScanResult(run({ stdout: '', code: 3 })).reason, 'the detector gave no usable answer (exit 3)');
  assertEqual(ps.parseScanResult(run({ spawnError: 'spawn python3 ENOENT' })).reason, 'the detector could not be started: spawn python3 ENOENT');
  const long = ps.parseScanResult(run({ stdout: JSON.stringify({ ok: false, error: `a\u0007${'x'.repeat(500)}` }) })).reason;
  assertEqual(long.length, 200);
  assertTrue(!long.includes('\u0007'));
});

summarize();
