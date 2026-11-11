'use strict';

// test_device_info_line.js — php/cameras/js/device-info.js: the line of facts about a board on a camera's or a
// detector's card. The element is a tiny DOM stand-in here; tests/dom/test_device_info_dom.js does it in a real page.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const I = require('../../php/cameras/js/device-info');

test('fmtUptime: seconds, minutes, then hours and minutes', () => {
  assertEqual(I.fmtUptime(0), '0 s');
  assertEqual(I.fmtUptime(59999), '59 s');
  assertEqual(I.fmtUptime(60000), '1 min');
  assertEqual(I.fmtUptime(3599000), '59 min');
  assertEqual(I.fmtUptime(3600000), '1 h 0 min');
  assertEqual(I.fmtUptime(3 * 3600000 + 7 * 60000), '3 h 7 min');
});

test('summarize: a camera\'s facts, in the order address, connected, up, memory, firmware', () => {
  assertEqual(I.summarize({ ip: '192.168.1.50', connectedForMs: 125000, uptimeMs: 7200000, heapBytes: 81920, fw: 'abc123' }),
    '192.168.1.50 · connected 2 min · up 2 h 0 min · 80 KB free · fw abc123');
});

test('summarize: a detector\'s facts, with the trouble it counted (zero counts are not shown)', () => {
  assertEqual(I.summarize({ ip: '10.0.0.9', uptimeMs: 5000, heapBytes: 2048, reconnects: 3, jpegFails: 2, fw: 'd1' }),
    '10.0.0.9 · up 5 s · 2 KB free · 3 reconnects · 2 JPEG failures · fw d1');
  assertEqual(I.summarize({ ip: '10.0.0.9', reconnects: 0, jpegFails: 0 }), '10.0.0.9');
});

test('summarize: a value that is missing, null or of the wrong type is left out; zero uptime and memory are real values', () => {
  assertEqual(I.summarize({ ip: null, uptimeMs: 0, heapBytes: 0, fw: '', connectedForMs: '5', reconnects: NaN }), 'up 0 s · 0 KB free');
  assertEqual(I.summarize({ uptimeMs: -1, heapBytes: Infinity, ip: 5, fw: {} }), '');
});

test('summarize: nothing, or not an object -> empty', () => {
  for (const v of [undefined, null, {}, 'x', 5, []]) assertEqual(I.summarize(v), '');
});

function fakeEl() { return { textContent: 'old', hidden: false }; }

test('render: shows the line and unhides the element', () => {
  const el = fakeEl();
  el.hidden = true;
  I.render(el, { ip: '10.0.0.1', fw: 'x' });
  assertEqual([el.textContent, el.hidden], ['10.0.0.1 · fw x', false]);
});

test('render: nothing to show hides the element and leaves nothing of the earlier line', () => {
  const el = fakeEl();
  I.render(el, null);
  assertEqual([el.textContent, el.hidden], ['', true]);
});

test('render: markup in a value stays text (it is only ever assigned to textContent)', () => {
  const el = fakeEl();
  I.render(el, { fw: '<img src=x onerror=1>' });
  assertEqual(el.textContent, 'fw <img src=x onerror=1>');
});

test('render: a missing element is nothing to do', () => {
  I.render(null, { ip: '1.2.3.4' });
  assertTrue(true);
});

summarize();
