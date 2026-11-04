'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const v = require('../../nodejs/camera-relay/lib/detectorview');

test('a new record: nobody wants to look, nothing heard, the view is not supported yet', () => {
  const r = v.newRecord();
  assertEqual(v.answerPoll(r, 1000), { view: false, stop: false });
  const d = v.describe(v.newRecord(), 1000);
  assertEqual(d.supported, false);
  assertEqual(d.wanted, false);
  assertEqual(d.idleFresh, false);
  assertEqual(d.pollAgeMs, null);
});

test('ON: the detector is told to stream until the ask runs out', () => {
  const r = v.newRecord();
  v.ask(r, 'on', 10000);
  assertEqual(v.answerPoll(r, 10001).view, true);
  assertEqual(v.answerPoll(r, 10000 + v.WANT_MS - 1).view, true);
  assertEqual(v.answerPoll(r, 10000 + v.WANT_MS).view, false, 'a page that went away stops being wanted by itself');
});

test('KEEP renews the ask', () => {
  const r = v.newRecord();
  v.ask(r, 'on', 0);
  v.ask(r, 'keep', 60000);
  assertEqual(v.answerPoll(r, 100000).view, true);
  assertEqual(v.answerPoll(r, 60000 + v.WANT_MS).view, false);
});

test('OFF: no longer wanted, and the detector is told to stop', () => {
  const r = v.newRecord();
  v.ask(r, 'on', 0);
  v.ask(r, 'off', 5000);
  assertEqual(v.answerPoll(r, 6000), { view: false, stop: true });
  assertEqual(v.answerPoll(r, 5000 + v.STOP_MS).stop, false, 'a stop that nobody collected expires');
});

test('ON after OFF cancels the stop', () => {
  const r = v.newRecord();
  v.ask(r, 'off', 1000);
  v.ask(r, 'on', 2000);
  assertEqual(v.answerPoll(r, 2001), { view: true, stop: false });
});

test('a closed page (keep stops coming) is NOT a stop: the detector keeps its own timer', () => {
  const r = v.newRecord();
  v.ask(r, 'on', 0);
  const a = v.answerPoll(r, v.WANT_MS + 1);
  assertEqual(a, { view: false, stop: false });
});

test('describe: supported once the detector asked, idle-fresh while its asks are recent', () => {
  const r = v.newRecord();
  v.answerPoll(r, 1000);
  assertEqual(v.describe(r, 1000 + v.IDLE_STALE_MS).idleFresh, true);
  assertEqual(v.describe(r, 1000 + v.IDLE_STALE_MS + 1).idleFresh, false);
  const d = v.describe(r, 4000);
  assertTrue(d.supported);
  assertEqual(d.pollAgeMs, 3000);
});

test('describe: wanted and the time left', () => {
  const r = v.newRecord();
  v.ask(r, 'on', 1000);
  const d = v.describe(r, 2000);
  assertTrue(d.wanted);
  assertEqual(d.wantedForMs, v.WANT_MS - 1000);
  assertEqual(v.describe(r, 1000 + v.WANT_MS).wanted, false);
});

test('isAction accepts only on / keep / off', () => {
  for (const a of ['on', 'keep', 'off']) assertTrue(v.isAction(a));
  for (const a of ['ON', '', 'toggle', null, undefined, 1, ['on']]) assertEqual(v.isAction(a), false);
});

test('encodeAnswer is the plain text the firmware looks for, with how long to stream', () => {
  assertEqual(v.encodeAnswer({ view: true, stop: false }), 'view=1;stop=0;mins=10');
  assertEqual(v.encodeAnswer({ view: false, stop: true }, 25), 'view=0;stop=1;mins=25');
});

test('viewMinutes: a whole number 1..1440, anything else is the default (10)', () => {
  assertEqual(v.viewMinutes(undefined), 10);
  assertEqual(v.viewMinutes(''), 10);
  assertEqual(v.viewMinutes('30'), 30);
  assertEqual(v.viewMinutes(1), 1);
  assertEqual(v.viewMinutes(1440), 1440);
  for (const bad of [0, -5, 1441, 2.5, 'abc', NaN, null, {}]) assertEqual(v.viewMinutes(bad), 10, String(bad));
});

summarize();
