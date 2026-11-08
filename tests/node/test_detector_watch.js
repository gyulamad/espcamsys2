'use strict';

// Tests the WATCH button logic of the dashboard page (php/cameras/index.php) by running exactly the block
// between its <detector-watch> markers: what the button shows and does in each state of a detector, and
// when an open page tells the relay "still looking".
//
// The button no longer shows the time left of the running live view (the relay still reports viewLeftS,
// the dashboard just does not put it on the button), so the streaming state is a plain '■ STOP'.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <detector-watch>\n([\s\S]*?)\/\/ <\/detector-watch>/.exec(page);
assertTrue(!!m, 'the page has a <detector-watch> block');
const w = new Function(`${m[1]}\nreturn { WATCH_KEEP_MS, WATCH_ACTIVE_MS, isStreaming, watchButton, keepAliveDue };`)();

const view = (over = {}) => Object.assign({ supported: true, wanted: false }, over);
const idle = (v) => ({ state: 'idle', online: false, report: null, view: view(v) });
const live = (left, v) => ({ state: 'online', online: true, report: { viewLeftS: left }, view: view(v) });

test('an older firmware / unknown detector has no button', () => {
  assertEqual(w.watchButton(undefined).hidden, true);
  assertEqual(w.watchButton({ state: 'online', online: true, report: {}, view: { supported: false, wanted: false } }).hidden, true);
  assertEqual(w.watchButton({ state: 'never', view: { supported: false, wanted: false } }).hidden, true);
  assertEqual(w.watchButton({ state: 'online' }).hidden, true, 'a status without view info (older relay)');
});

test('resting detector: WATCH asks for the view', () => {
  const b = w.watchButton(idle());
  assertEqual([b.hidden, b.label, b.action], [false, '▶ WATCH', 'on']);
});

test('asked but not started yet: STARTING, a click cancels', () => {
  const b = w.watchButton(idle({ wanted: true }));
  assertEqual([b.label, b.action], ['… STARTING', 'off']);
});

test('streaming: STOP (no countdown), a click stops it', () => {
  const b = w.watchButton(live(541, { wanted: true }));
  assertEqual([b.label, b.action], ['■ STOP', 'off']);
  assertEqual(w.watchButton(live(5)).label, '■ STOP');
  assertEqual(w.watchButton({ state: 'online', report: {}, view: view() }).label, '■ STOP', 'no time left reported (older firmware build)');
  assertEqual(w.watchButton({ state: 'no-picture', report: { viewLeftS: 60 }, view: view() }).action, 'off');
});

test('an offline detector that supports the view can still be asked', () => {
  const b = w.watchButton({ state: 'offline', report: null, view: view() });
  assertEqual([b.hidden, b.action], [false, 'on']);
});

const NOW = 1e9;
test('keep-alive: only while the view is wanted or running, the page is visible and the person active', () => {
  assertEqual(w.keepAliveDue(live(500), NOW, NOW - 1000, false), true);
  assertEqual(w.keepAliveDue(idle({ wanted: true }), NOW, NOW - 1000, false), true, 'asked, waiting for the detector');
  assertEqual(w.keepAliveDue(idle(), NOW, NOW - 1000, false), false, 'nobody asked: nothing to keep');
  assertEqual(w.keepAliveDue(live(500), NOW, NOW - 1000, true), false, 'hidden tab');
  assertEqual(w.keepAliveDue(live(500), NOW, NOW - w.WATCH_ACTIVE_MS, false), false, 'nobody touched the page for 10 minutes: let the view run out');
  assertEqual(w.keepAliveDue(live(500), NOW, NOW - w.WATCH_ACTIVE_MS + 1, false), true);
  assertEqual(w.keepAliveDue({ state: 'online', view: { supported: false, wanted: false } }, NOW, NOW, false), false, 'a firmware that always streams');
  assertEqual(w.keepAliveDue(undefined, NOW, NOW, false), false);
});

test('the page asks again well within the relay\'s 90 s window', () => {
  assertTrue(w.WATCH_KEEP_MS <= 30000);
});

summarize();
