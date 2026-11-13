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

// ── commands (a reboot) ─────────────────────────────────────────────────

const HEARD = ds.applyReport(ds.emptyState(), { rev: '0', result: 'boot', message: '', line: 'A=1' }, 10);

test('queueCommand: the reboot is a queued line like a change — same slot, same number, who asked', () => {
  const q = ds.queueCommand(HEARD, 'reboot', 5000, 'alice@10.0.0.2');
  assertEqual([q.rev, q.state.pending.line, q.state.pending.by], ['5000', ds.COMMAND_LINES.reboot, 'alice@10.0.0.2']);
  assertEqual(q.state.reported, HEARD.reported);   // what the board reported is kept
  assertEqual(ds.commandOf(q.state.pending), 'reboot');
});

test('queueCommand: replaces a waiting settings change, and a settings change replaces it', () => {
  const change = ds.queueChange(HEARD, 'A=2', 100, '').state;
  const reboot = ds.queueCommand(change, 'reboot', 200, '');
  assertEqual(reboot.state.pending.line, ds.COMMAND_LINES.reboot);
  assertEqual(ds.queueChange(reboot.state, 'A=3', 300, '').state.pending.line, 'A=3');
});

test('queueCommand: an unknown command is a programming error, never a queued line', () => {
  for (const bad of ['format', 'REBOOT', '', '__proto__', 'constructor', undefined]) {
    let threw = false;
    try { ds.queueCommand(HEARD, bad, 1, ''); } catch (e) { threw = true; }
    assertTrue(threw, String(bad));
  }
});

test('a command line can never come from the settings routes: checkStagedLine insists on KEY=value', () => {
  assertEqual(ds.checkStagedLine(ds.COMMAND_LINES.reboot).ok, false);
  assertEqual(ds.checkStagedLine('!reboot\n').ok, false);
  assertEqual(ds.commandOf({ line: 'A=1' }), null);
  assertEqual(ds.commandOf({ line: 'A=!reboot' }), null);   // only the whole line is the command
  assertEqual(ds.commandOf(null), null);
});

test('changeReply: a reboot is offered to the board as "<number>\\n!reboot\\n" until it is COMMAND_TTL_MS old', () => {
  const st = ds.queueCommand(HEARD, 'reboot', 1000, '').state;
  assertEqual(ds.changeReply(st, 1000), '1000\n!reboot\n');
  assertEqual(ds.changeReply(st, 1000 + ds.COMMAND_TTL_MS), '1000\n!reboot\n');   // exactly at the limit: still valid
  assertEqual(ds.changeReply(st, 1000 + ds.COMMAND_TTL_MS + 1), null);             // one ms later: gone
});

test('changeReply: only commands expire — a settings change waits as long as it takes, and no clock means no expiry', () => {
  const change = ds.queueChange(HEARD, 'A=2', 1000, '').state;
  assertEqual(ds.changeReply(change, 1000 + 100 * ds.COMMAND_TTL_MS), '1000\nA=2\n');
  const reboot = ds.queueCommand(HEARD, 'reboot', 1000, '').state;
  assertEqual(ds.changeReply(reboot), '1000\n!reboot\n');
});

test('an expired reboot is not shown as waiting either, and the slot is free for the next one', () => {
  const st = ds.queueCommand(HEARD, 'reboot', 1000, '').state;
  assertEqual(ds.viewState(st, 1000 + ds.COMMAND_TTL_MS + 1).pending, null);
  assertEqual(ds.viewState(st, 1000 + 5).pending.command, 'reboot');
  const again = ds.queueCommand(st, 'reboot', 1000 + ds.COMMAND_TTL_MS + 1, '');
  assertEqual(ds.changeReply(again.state, 1000 + ds.COMMAND_TTL_MS + 2), `${again.rev}\n!reboot\n`);
});

test('viewState: a reboot shows as command "reboot" with no keys; an ordinary change has no command field at all', () => {
  const v = ds.viewState(ds.queueCommand(HEARD, 'reboot', 1000, 'carol').state, 1001);
  assertEqual([v.pending.command, v.pending.keys, v.pending.by], ['reboot', [], 'carol']);
  const plain = ds.viewState(ds.queueChange(HEARD, 'A=2', 1000, 'carol').state, 1001);
  assertTrue(!('command' in plain.pending), 'the shape of a settings change is unchanged');
});

test('applyReport: the board\'s "applied" for the reboot clears it, so it is not offered again after the restart', () => {
  const q = ds.queueCommand(HEARD, 'reboot', 1000, '');
  const s = ds.applyReport(q.state, { rev: q.rev, result: 'applied', message: 'restarting on request', line: 'A=1' }, 1500);
  assertEqual(s.pending, null);
  assertEqual(ds.changeReply(s, 1600), null);
  assertEqual(s.last.message, 'restarting on request');
});

test('applyReport: a board that does not know commands says "rejected", which clears it and tells the dashboard', () => {
  const q = ds.queueCommand(HEARD, 'reboot', 1000, '');
  const s = ds.applyReport(q.state, { rev: q.rev, result: 'rejected', message: 'the line is not KEY=value', line: 'A=1' }, 1500);
  assertEqual([s.pending, s.last.result], [null, 'rejected']);
});

test('commandRefusal: only a device the relay has heard from can be sent a command', () => {
  assertTrue(typeof ds.commandRefusal(ds.emptyState()) === 'string', 'never heard from: refused, with a reason');
  assertEqual(ds.commandRefusal(HEARD), null);
});

test('parseState: a queued command survives the file round trip', () => {
  const st = ds.queueCommand(HEARD, 'reboot', 1000, 'x').state;
  assertEqual(ds.parseState(JSON.stringify(st)), st);
  assertEqual(ds.commandOf(ds.parseState(JSON.stringify(st)).pending), 'reboot');
});

test('stateFile: under the type, in its own folder, so it can never collide with a staged line', () => {
  assertEqual(ds.stateFile('/d', 'recorder', 'cam1'), path.join('/d', 'recorder', 'state', 'cam1.json'));
  assertTrue(ds.stateFile('/d', 'recorder', 'cam1') !== ds.fileFor('/d', 'recorder', 'cam1'));
});

// ── SETUP_MODE ──────────────────────────────────────────────────────────

const stateReporting = (line, at) => ({ ...ds.emptyState(), reported: { line, at } });

test('setupModeDevices: lists only boards whose last report has SETUP_MODE exactly "1", sorted by type then id', () => {
  const list = ds.setupModeDevices([
    { type: 'recorder', id: 'cam2', state: stateReporting('A=1;SETUP_MODE=1', 20) },
    { type: 'detector', id: 'det9', state: stateReporting('SETUP_MODE=1', 30) },
    { type: 'recorder', id: 'cam1', state: stateReporting('SETUP_MODE=1;A=2', 10) },
    { type: 'recorder', id: 'off', state: stateReporting('SETUP_MODE=0', 5) },
    { type: 'recorder', id: 'absent', state: stateReporting('A=1', 5) },
    { type: 'recorder', id: 'odd', state: stateReporting('SETUP_MODE=true', 5) },
    { type: 'recorder', id: 'empty', state: stateReporting('SETUP_MODE=', 5) },
    { type: 'recorder', id: 'never', state: ds.emptyState() },
  ]);
  assertEqual(list, [
    { type: 'detector', id: 'det9', reportedAt: 30 },
    { type: 'recorder', id: 'cam1', reportedAt: 10 },
    { type: 'recorder', id: 'cam2', reportedAt: 20 },
  ]);
});

test('setupModeDevices: junk entries and bad types/ids are skipped, never thrown on', () => {
  assertEqual(ds.setupModeDevices(null), []);
  assertEqual(ds.setupModeDevices([]), []);
  assertEqual(ds.setupModeDevices([null, 5, {}, { type: 'x', id: 'a', state: stateReporting('SETUP_MODE=1', 1) },
    { type: 'recorder', id: '../a', state: stateReporting('SETUP_MODE=1', 1) },
    { type: 'recorder', id: 'a' }]), []);
});

test('setupModeDevices: the first SETUP_MODE of a line wins, and an escaped separator in another value cannot fake one', () => {
  assertEqual(ds.setupModeDevices([{ type: 'recorder', id: 'a', state: stateReporting('SETUP_MODE=0;SETUP_MODE=1', 1) }]), []);
  assertEqual(ds.setupModeDevices([{ type: 'recorder', id: 'b', state: stateReporting('NAME=x\\;SETUP_MODE=1', 1) }]), []);
});

test('stateIdFromFileName: only <valid id>.json counts', () => {
  assertEqual(ds.stateIdFromFileName('cam2.json'), 'cam2');
  assertEqual(ds.stateIdFromFileName('cam2.json.tmp'), null);
  assertEqual(ds.stateIdFromFileName('.json'), null);
  assertEqual(ds.stateIdFromFileName('_x.json'), null);
  assertEqual(ds.stateIdFromFileName('a b.json'), null);
  assertEqual(ds.stateIdFromFileName(undefined), null);
});

summarize();
