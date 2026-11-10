'use strict';

// test_camera_offline.js — what the dashboard and the two simple pages share about a camera that is not connected
// (php/cameras/js/camera-offline.js): the rule that says a camera is offline, and the cover that is shown over its
// last picture while it is.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const CamOffline = require('../../php/cameras/js/camera-offline');
const CamSimple = require('../../php/cameras/js/simple-logic');

// The cover as the pages deliver it: an element with a `hidden` property.
const cover = () => ({ hidden: true });

// ── isOffline ────────────────────────────────────────────────────────

test('isOffline: a camera the relay says is not online is offline', () => {
  assertEqual(CamOffline.isOffline({ a: { online: false } }, 'a'), true);
});

test('isOffline: a camera that is online is not', () => {
  assertEqual(CamOffline.isOffline({ a: { online: true } }, 'a'), false);
});

test('isOffline: only a plain online: false counts (no answer, no camera, an older relay: not known to be offline)', () => {
  const unknown = [null, undefined, 'text', 5, {}, { b: { online: false } }, { a: null }, { a: {} }, { a: { online: 0 } }, { a: { online: '' } }, { a: { online: 'false' } }, { a: { online: null } }];
  for (const status of unknown) {
    assertEqual(CamOffline.isOffline(status, 'a'), false, JSON.stringify(status));
  }
});

test('isOffline: it is judged camera by camera', () => {
  const status = { a: { online: false }, b: { online: true }, c: {} };
  assertEqual(['a', 'b', 'c', 'd'].map((id) => CamOffline.isOffline(status, id)), [true, false, false, false]);
});

test('isOffline: an id that is also a name on every object is just an unknown camera', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assertEqual(CamOffline.isOffline({}, id), false, id);
  }
});

test('the simple pages\' slideshow uses this very rule (one definition, not two)', () => {
  assertTrue(CamSimple.isOffline === CamOffline.isOffline);
});

// ── render ───────────────────────────────────────────────────────────

test('render: the cover of an offline camera is shown', () => {
  const el = cover();
  CamOffline.render(el, { a: { online: false } }, 'a');
  assertEqual(el.hidden, false);
});

test('render: the cover of a camera that is online stays hidden', () => {
  const el = cover();
  CamOffline.render(el, { a: { online: true } }, 'a');
  assertEqual(el.hidden, true);
});

test('render: nothing is covered on a guess (no answer, an unknown camera, an older relay)', () => {
  for (const status of [null, undefined, {}, { b: { online: false } }, { a: {} }]) {
    const el = cover();
    CamOffline.render(el, status, 'a');
    assertEqual(el.hidden, true, JSON.stringify(status));
  }
});

test('render: the cover follows the camera — shown when it drops, gone when it is back, gone when the answer is lost', () => {
  const el = cover();
  CamOffline.render(el, { a: { online: false } }, 'a');
  assertEqual(el.hidden, false, 'dropped');
  CamOffline.render(el, { a: { online: true } }, 'a');
  assertEqual(el.hidden, true, 'back');
  CamOffline.render(el, { a: { online: false } }, 'a');
  CamOffline.render(el, null, 'a');
  assertEqual(el.hidden, true, 'no answer: not known to be offline');
});

test('render: it touches only the cover it is given, and only its `hidden`', () => {
  const el = Object.assign(cover(), { className: 'cam-offline', textContent: 'CAMERA OFFLINE' });
  const other = cover();
  CamOffline.render(el, { a: { online: false }, b: { online: false } }, 'a');
  assertEqual([el.className, el.textContent, other.hidden], ['cam-offline', 'CAMERA OFFLINE', true]);
});

test('render: it says whether the camera is offline', () => {
  assertEqual(CamOffline.render(cover(), { a: { online: false } }, 'a'), true);
  assertEqual(CamOffline.render(cover(), { a: { online: true } }, 'a'), false);
  assertEqual(CamOffline.render(cover(), null, 'a'), false);
});

test('render: a page without the cover element is left alone (no throw), and the answer is still given', () => {
  assertEqual(CamOffline.render(null, { a: { online: false } }, 'a'), true);
  assertEqual(CamOffline.render(undefined, { a: { online: true } }, 'a'), false);
});

summarize();
