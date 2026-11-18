'use strict';

// F-29 T9: the settings reference (docs/SETTINGS_REFERENCE.md) — the renderer (tools/render_settings_reference.js) and
// the relay adapter (tools/dump_relay_schema.js). The generator end to end (real firmware tables, --check, a stale
// file) is tests/shell/test_gen_settings_reference.sh.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { relayRows } = require('../../tools/dump_relay_schema');
const { render, cell, defaultCell, deviceRow, countLine } = require('../../tools/render_settings_reference');
const { FIELDS } = require('../../nodejs/camera-relay/lib/sysconfig');

// A dump entry of tools/dump_device_schema.cpp, with only the fields the reference reads.
const devKey = (over) => Object.assign({ name: 'X', kind: 'int', label: null, default: null, tier: null, apply: null, category: null }, over);
const row = (over) => Object.assign({ key: 'k', label: 'L', default: '1', tier: 'basic', apply: 'live', category: 'C' }, over);
const schema = (rec, det, relay) => ({ recorder: { keys: rec }, detector: { keys: det }, relay });
const lines = (md) => md.split('\n');
const tableLines = (md) => lines(md).filter((l) => l.startsWith('| `'));
const columns = (line) => line.split(/(?<!\\)\|/).length - 2;   // cells of one table line: the unescaped pipes, minus the outer two

// ── the relay adapter ────────────────────────────────────────────────────
test('relayRows: a field becomes key, label, default, apply (restart -> reboot) and category (group); no tier yet', () => {
  const out = relayRows([
    { key: 'port', type: 'int', default: 8080, restart: true, label: 'HTTP port', group: 'Network' },
    { key: 'alarmRecordSeconds', type: 'int', default: 60, restart: false, label: 'Alarm length', group: 'Recording' },
  ]);
  assertEqual(out, [
    { key: 'port', label: 'HTTP port', default: 8080, tier: null, apply: 'reboot', category: 'Network' },
    { key: 'alarmRecordSeconds', label: 'Alarm length', default: 60, tier: null, apply: 'live', category: 'Recording' },
  ]);
});

test('relayRows: a default of false or 0 or "" is a default (not "none")', () => {
  const out = relayRows([
    { key: 'a', type: 'bool', default: false, label: 'a', group: 'g' },
    { key: 'b', type: 'int', default: 0, label: 'b', group: 'g' },
    { key: 'c', type: 'sound', default: '', label: 'c', group: 'g' },
  ]);
  assertEqual(out.map((r) => r.default), [false, 0, '']);
});

test('relayRows: no default stays null, and a secret never gets one, even if the table ever carried one', () => {
  const out = relayRows([
    { key: 'camKey', type: 'secret', label: 'Camera key', group: 'Keys', restart: true },
    { key: 'leaky', type: 'secret', default: 'hunter22', label: 'x', group: 'Keys' },
  ]);
  assertEqual(out.map((r) => r.default), [null, null]);
});

test('relayRows: the real relay table maps completely — every field, in order, with a key, a label and a category', () => {
  const out = relayRows(FIELDS);
  assertEqual(out.map((r) => r.key), FIELDS.map((f) => f.key));
  assertEqual(new Set(out.map((r) => r.key)).size, out.length);
  out.forEach((r) => {
    assertTrue(typeof r.label === 'string' && r.label.length > 0);
    assertTrue(typeof r.category === 'string' && r.category.length > 0);
    assertTrue(r.apply === 'live' || r.apply === 'reboot');
  });
});

// ── the cells ────────────────────────────────────────────────────────────
test('cell: a pipe is escaped, a line break becomes a space, a backslash is doubled', () => {
  assertEqual(cell('a|b'), 'a\\|b');
  assertEqual(cell('a\nb\r\nc'), 'a b c');
  assertEqual(cell('a\\b'), 'a\\\\b');
});

test('defaultCell: none is a dash, "" is shown as "", 0 and false are shown, a value is a code span', () => {
  assertEqual(defaultCell(null), '—');
  assertEqual(defaultCell(undefined), '—');
  assertEqual(defaultCell(''), '`""`');
  assertEqual(defaultCell(0), '`0`');
  assertEqual(defaultCell(false), '`false`');
  assertEqual(defaultCell('logs/camera.log'), '`logs/camera.log`');
  assertEqual(defaultCell('a|b'), '`a\\|b`');
});

test('defaultCell: a value with a backtick cannot be a code span, so it is plain text', () => {
  assertEqual(defaultCell('a`b'), 'a`b');
});

test('deviceRow: a firmware key maps over; a secret never shows a default', () => {
  assertEqual(deviceRow(devKey({ name: 'JPEG_Q_MIN', label: 'Best', default: '12', tier: 'basic', apply: 'live', category: 'Picture & link' })),
    { key: 'JPEG_Q_MIN', label: 'Best', default: '12', tier: 'basic', apply: 'live', category: 'Picture & link' });
  assertEqual(deviceRow(devKey({ name: 'API_KEY', kind: 'secret', default: 'oops' })).default, null);
});

test('countLine: counts the rows with a default (an empty-text default counts) and those without', () => {
  assertEqual(countLine([row(), row({ default: '' }), row({ default: null })]), '3 settings: 2 with a default, 1 without.');
  assertEqual(countLine([]), '0 settings: 0 with a default, 0 without.');
});

// ── the document ─────────────────────────────────────────────────────────
test('render: three sections in the order camera, detector, relay, each with its own rows', () => {
  const md = render(schema([devKey({ name: 'A', default: '1' })], [devKey({ name: 'B' })], [row({ key: 'c' })]));
  const heads = lines(md).filter((l) => l.startsWith('## '));
  assertEqual(heads, ['## Camera (ESP32_CAM_Recorder)', '## Detector (ESP32_CAM_TFLite_Person)', '## Relay (nodejs/camera-relay)']);
  assertEqual(tableLines(md), ['| `A` | — | `1` | — | — | — |', '| `B` | — | — | — | — | — |', '| `c` | L | `1` | basic | live | C |']);
  assertTrue(md.includes('1 settings: 1 with a default, 0 without.'));
  assertTrue(md.includes('1 settings: 0 with a default, 1 without.'));
});

test('render: the rows keep the order of the source table (not sorted)', () => {
  const md = render(schema([devKey({ name: 'Z' }), devKey({ name: 'A' })], [], []));
  assertEqual(tableLines(md).map((l) => l.split('`')[1]), ['Z', 'A']);
});

test('render: a section with no settings says so and has no table', () => {
  const md = render(schema([], [], []));
  assertEqual(md.split('_No settings._').length - 1, 3);
  assertEqual(tableLines(md), []);
});

test('render: every table line has exactly six cells, even with a pipe in a label or a default', () => {
  const md = render(schema([devKey({ name: 'A', label: 'a | b', default: 'x|y', category: 'c|d' })], [], [row({ label: 'p|q' })]));
  const rows = tableLines(md);
  assertEqual(rows.length, 2);
  rows.forEach((l) => assertEqual(columns(l), 6));
});

test('render: a secret of the firmware shows no default, whatever the dump carries', () => {
  const md = render(schema([devKey({ name: 'SETUP_PASSWORD', kind: 'secret', default: 'topsecret' })], [], []));
  assertTrue(!md.includes('topsecret'));
});

test('render: the same input gives the same bytes (nothing like a date in it), ending in one newline', () => {
  const s = schema([devKey({ name: 'A', default: '1' })], [], [row()]);
  assertEqual(render(s), render(s));
  assertTrue(render(s).endsWith('|\n') && !render(s).endsWith('\n\n'));
});

test('render: starts with the GENERATED notice so nobody edits it by hand', () => {
  assertTrue(render(schema([], [], [])).startsWith('<!-- GENERATED by tools/gen_settings_reference.sh'));
});

summarize();
