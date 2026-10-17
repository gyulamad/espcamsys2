'use strict';

// Unit tests for lib/devicesettings.js — the settings the relay stages for
// boards that are missing some. The HTTP side is in
// tests/e2e/test_device_settings_e2e.js.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ds = require('../../nodejs/camera-relay/lib/devicesettings');

// ── what may be asked for ───────────────────────────────────────────────

test('isType: only the two sketch types', () => {
  assertEqual(ds.isType('recorder'), true);
  assertEqual(ds.isType('detector'), true);
  assertEqual(ds.isType('Recorder'), false);
  assertEqual(ds.isType('../recorder'), false);
  assertEqual(ds.isType(''), false);
  assertEqual(ds.isType(undefined), false);
});

test('isId: the camera-id rule, and nothing that could leave the folder', () => {
  for (const ok of ['cam1', 'cam2-human', 'A', 'a.b_c-d', 'x'.repeat(64)]) assertEqual(ds.isId(ok), true, ok);
  for (const bad of ['', '.', '..', '.hidden', '_fleet', '-x', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'cam1\n', 'ca\u00e9', null, 7]) {
    assertEqual(ds.isId(bad), false, String(bad));
  }
});

test('parseNeed: a list of setting names; anything malformed is dropped, never an error', () => {
  assertEqual(ds.parseNeed('NEW_KEY'), ['NEW_KEY']);
  assertEqual(ds.parseNeed('A,B_2,C'), ['A', 'B_2', 'C']);
  assertEqual(ds.parseNeed('A,A,B'), ['A', 'B']);
  assertEqual(ds.parseNeed('A,bad key,B;DROP,C'), ['A', 'C']);
  assertEqual(ds.parseNeed(''), []);
  assertEqual(ds.parseNeed(undefined), []);
  assertEqual(ds.parseNeed(['A']), []);
  assertEqual(ds.parseNeed(Array.from({ length: 100 }, (_, i) => `K${i}`).join(',')).length, 64);
});

// ── the line an operator stages ─────────────────────────────────────────

test('checkStagedLine: a normal line is accepted, trailing whitespace and newline trimmed', () => {
  assertEqual(ds.checkStagedLine('A=1;B=two'), { ok: true, line: 'A=1;B=two' });
  assertEqual(ds.checkStagedLine('A=1;B=two\n'), { ok: true, line: 'A=1;B=two' });
  assertEqual(ds.checkStagedLine('A=1\r\n\r\n'), { ok: true, line: 'A=1' });
});

test('checkStagedLine: a value may contain spaces and escapes (a password), kept as sent', () => {
  assertEqual(ds.checkStagedLine('WIFI=my net:pa\\;ss').line, 'WIFI=my net:pa\\;ss');
});

test('checkStagedLine: an empty body means "remove what is staged"', () => {
  assertEqual(ds.checkStagedLine(''), { ok: true, line: '' });
  assertEqual(ds.checkStagedLine('  \n'), { ok: true, line: '' });
});

test('checkStagedLine: refuses what a board could not take anyway', () => {
  assertEqual(ds.checkStagedLine('no equals sign here').ok, false);
  assertEqual(ds.checkStagedLine('A=1\nB=2').ok, false);          // a newline inside
  assertEqual(ds.checkStagedLine('A=1\u0000B=2').ok, false);       // control character
  assertEqual(ds.checkStagedLine('A=' + 'x'.repeat(1030)).ok, false);
  assertEqual(ds.checkStagedLine({ A: 1 }).ok, false);
  assertEqual(ds.checkStagedLine(undefined).ok, false);
  assertTrue(/too long/.test(ds.checkStagedLine('A=' + 'x'.repeat(1030)).error), 'says why');
});

test('checkStagedLine: exactly the limit is fine', () => {
  assertEqual(ds.checkStagedLine('A=' + 'x'.repeat(ds.MAX_LINE - 2)).ok, true);
  assertEqual(ds.checkStagedLine('A=' + 'x'.repeat(ds.MAX_LINE - 1)).ok, false);
});

// ── names for the log (never values) ────────────────────────────────────

test('keyNames: lists the setting names, in order, upper-cased', () => {
  assertEqual(ds.keyNames('NEW_ONE=1;other=abc;LAST=x'), ['NEW_ONE', 'OTHER', 'LAST']);
});

test('keyNames: an escaped ; inside a value does not start a new name', () => {
  assertEqual(ds.keyNames('API_KEY=a\\;SECRET=oops;B=2'), ['API_KEY', 'B']);
});

test('keyNames: ignores empty pieces, pieces without = and bad names; never returns a value', () => {
  assertEqual(ds.keyNames(';;A=1;;junk;bad name=2;B=3;'), ['A', 'B']);
  assertEqual(ds.keyNames('WIFI=home:hunter2').join(','), 'WIFI');
});

// ── where it is kept, and which one a device gets ───────────────────────

test('fileFor: one file per device, one per type for the fleet, all inside the folder', () => {
  const dir = path.join(path.sep, 'x', 'ds');
  assertEqual(ds.fileFor(dir, 'recorder', 'cam1'), path.join(dir, 'recorder', 'cam1.txt'));
  assertEqual(ds.fileFor(dir, 'detector', null), path.join(dir, 'detector', '_fleet.txt'));
});

test('pickStaged: the device\'s own line beats the fleet line', () => {
  assertEqual(ds.pickStaged('A=1', 'A=2'), { line: 'A=1', source: 'device' });
  assertEqual(ds.pickStaged(null, 'A=2'), { line: 'A=2', source: 'fleet' });
  assertEqual(ds.pickStaged('', 'A=2'), { line: 'A=2', source: 'fleet' });
  assertEqual(ds.pickStaged('A=1', null), { line: 'A=1', source: 'device' });
  assertEqual(ds.pickStaged(null, null), null);
  assertEqual(ds.pickStaged('', ''), null);
});

// ── the log gate ────────────────────────────────────────────────────────

test('FetchLogGate: logs the first ask, stays quiet on repeats, speaks up on a change or after a quiet period', () => {
  const g = new ds.FetchLogGate(10 * 60 * 1000);
  assertEqual(g.check('cam1', 'none|NEW', 0), true);
  assertEqual(g.check('cam1', 'none|NEW', 5000), false);
  assertEqual(g.check('cam1', 'none|NEW', 599999), false);
  assertEqual(g.check('cam1', 'none|NEW', 600000), true, 'quiet period over');
  assertEqual(g.check('cam1', 'device|NEW', 600001), true, 'the outcome changed');
  assertEqual(g.check('cam1', 'device|NEW,OTHER', 600002), true, 'the missing set changed');
});

test('FetchLogGate: devices are tracked separately, and memory stays bounded', () => {
  const g = new ds.FetchLogGate(1000);
  assertEqual(g.check('a', 's', 0), true);
  assertEqual(g.check('b', 's', 1), true);
  assertEqual(g.check('a', 's', 2), false);
  for (let i = 0; i < 3000; i += 1) g.check(`id${i}`, 's', 3);
  assertTrue(g.last.size <= 1001, 'bounded');
});

// ── changes queued from the dashboard, and what the board reports ───────

test('parseSettingsLine: names and values, with the backslash escapes undone', () => {
  assertEqual(ds.parseSettingsLine('PUSH_GAP_MUL=1.5;WIFI=my\\:net:****;NOTE=a\\;b\\\\c'), { PUSH_GAP_MUL: '1.5', WIFI: 'my:net:****', NOTE: 'a;b\\c' });
});

test('parseSettingsLine: values may hold "=", the first of a name wins, junk pieces are skipped', () => {
  assertEqual(ds.parseSettingsLine('A=b=c;A=2;lower=1;=x;nokey;bad key=2;B=;;'), { A: 'b=c', LOWER: '1', B: '' });   // names are upper-cased, like the boards do
  assertEqual(ds.parseSettingsLine(''), {});
  assertEqual(ds.parseSettingsLine(null), {});
});

test('parseReportBody: number, result, message, then the settings line', () => {
  const r = ds.parseReportBody('555\napplied\nchanged: LOG_HEARTBEAT\nLOG_HEARTBEAT=900;X=1\n');
  assertEqual([r.ok, r.rev, r.result, r.message, r.line], [true, '555', 'applied', 'changed: LOG_HEARTBEAT', 'LOG_HEARTBEAT=900;X=1']);
  assertEqual(ds.parseReportBody('0\nboot\n\nA=1').ok, true);
});

test('parseReportBody: refuses what is not that', () => {
  for (const bad of [null, '', 'x', '1\napplied\nmsg', 'abc\napplied\nm\nA=1', '1\nmaybe\nm\nA=1', '12345678901234567890\napplied\nm\nA=1',
    `1\napplied\n${'m'.repeat(501)}\nA=1`, `1\napplied\nm\n${'A'.repeat(ds.MAX_REPORT_LINE + 1)}`, '1\napplied\nm\x00\nA=1']) {
    assertTrue(!ds.parseReportBody(bad).ok, JSON.stringify(bad).slice(0, 60));
  }
});

test('nextRev: always larger than the last one, even if the clock stands still or goes back', () => {
  assertEqual(ds.nextRev(0, 1000), '1000');
  assertEqual(ds.nextRev(1000, 1000), '1001');
  assertEqual(ds.nextRev(5000, 1000), '5001');
});

test('queueChange: queues one change, a newer one replaces it, an empty line cancels', () => {
  const a = ds.queueChange(ds.emptyState(), 'A=1', 1000, 'alice');
  assertEqual([a.rev, a.state.pending.line, a.state.pending.by], ['1000', 'A=1', 'alice']);
  const b = ds.queueChange(a.state, 'B=2', 1000, 'bob');
  assertEqual([b.rev, b.state.pending.line], ['1001', 'B=2']);
  const c = ds.queueChange(b.state, '', 2000, 'bob');
  assertEqual([c.rev, c.state.pending], [null, null]);
  assertTrue(a.state !== ds.emptyState() && ds.emptyState().pending === null, 'inputs are not modified');
});

test('changeReply: "<number>\\n<line>\\n" while queued, null otherwise', () => {
  assertEqual(ds.changeReply(ds.emptyState()), null);
  assertEqual(ds.changeReply(ds.queueChange(ds.emptyState(), 'A=1', 7, '').state), '7\nA=1\n');
});

test('applyReport: a boot report only refreshes what the board holds', () => {
  const q = ds.queueChange(ds.emptyState(), 'A=1', 100, '').state;
  const s = ds.applyReport(q, { rev: '0', result: 'boot', message: '', line: 'A=0' }, 200);
  assertEqual([s.reported, s.pending !== null, s.last], [{ line: 'A=0', at: 200 }, true, null]);
});

test('applyReport: the answer to the waiting change clears it and is remembered', () => {
  const q = ds.queueChange(ds.emptyState(), 'A=1', 100, '').state;
  const s = ds.applyReport(q, { rev: '100', result: 'applied', message: 'changed: A', line: 'A=1' }, 300);
  assertEqual([s.pending, s.last], [null, { rev: '100', result: 'applied', message: 'changed: A', at: 300 }]);
});

test('applyReport: an answer to an OLDER change does not cancel the newer one', () => {
  let st = ds.queueChange(ds.emptyState(), 'A=1', 100, '').state;
  st = ds.queueChange(st, 'A=2', 200, '').state;
  const s = ds.applyReport(st, { rev: '100', result: 'rejected', message: 'no', line: 'A=0' }, 300);
  assertEqual(s.pending.line, 'A=2');
  assertEqual(s.last.result, 'rejected');
});

test('viewState: the dashboard gets settings as an object and the queued NAMES — never the queued values', () => {
  let st = ds.applyReport(ds.emptyState(), { rev: '0', result: 'boot', message: '', line: 'A=1;SECRET=********' }, 50);
  st = ds.queueChange(st, 'A=2;B=hunter2', 60, 'carol').state;
  const v = ds.viewState(st);
  assertEqual(v.reported, { settings: { A: '1', SECRET: '********' }, at: 50 });
  assertEqual([v.pending.keys, v.pending.by], [['A', 'B'], 'carol']);
  assertTrue(!JSON.stringify(v).includes('hunter2'), 'no queued value');
  assertEqual(ds.viewState(ds.emptyState()), { reported: null, pending: null, last: null });
});

test('parseState: round-trips, and anything damaged is just an empty state', () => {
  let st = ds.queueChange(ds.emptyState(), 'A=1', 100, 'x').state;
  st = ds.applyReport(st, { rev: '0', result: 'boot', message: '', line: 'A=0' }, 120);
  assertEqual(ds.parseState(JSON.stringify(st)), st);
  for (const bad of [undefined, '', '{nope', 'null', '[]', '{"pending":{"rev":"x","line":"A=1","at":1}}']) assertEqual(ds.parseState(bad).pending, null, String(bad));
  assertEqual(ds.parseState(JSON.stringify({ lastRev: 'x' })).lastRev, 0);
});

test('stateFile: under the type, in its own folder, so it can never collide with a staged line', () => {
  assertEqual(ds.stateFile('/d', 'recorder', 'cam1'), path.join('/d', 'recorder', 'state', 'cam1.json'));
  assertTrue(ds.stateFile('/d', 'recorder', 'cam1') !== ds.fileFor('/d', 'recorder', 'cam1'));
});

summarize();
