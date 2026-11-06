'use strict';

// test_fullscreen.js — php/cameras/js/fullscreen.js (the full-screen toggle of the simple view's picture)
// against hand-made stand-ins for the document and the element: no browser, nothing to install.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const CamFullscreen = require(path.join(__dirname, '../../php/cameras/js/fullscreen.js'));

// An element that records the full-screen requests made on it. `request`: 'standard' | 'webkit' | 'none'.
// `result`: what the request returns (a promise when the browser answers asynchronously).
function makeElement(request = 'standard', result) {
  const el = { requested: 0 };
  const ask = () => { el.requested += 1; return result; };
  if (request === 'standard') el.requestFullscreen = ask;
  if (request === 'webkit') el.webkitRequestFullscreen = ask;
  return el;
}

// A document that knows which element is full screen right now and records the exits.
function makeDocument({ full = null, webkitFull = null, exit = 'standard' } = {}) {
  const doc = { exited: 0 };
  if (full) doc.fullscreenElement = full;
  if (webkitFull) doc.webkitFullscreenElement = webkitFull;
  const leave = () => { doc.exited += 1; };
  if (exit === 'standard') doc.exitFullscreen = leave;
  if (exit === 'webkit') doc.webkitExitFullscreen = leave;
  return doc;
}

test('toggle: an element that is not full screen is asked to go full screen', () => {
  const el = makeElement();
  const doc = makeDocument();
  assertEqual(CamFullscreen.toggle(el, doc), true);
  assertEqual(el.requested, 1);
  assertEqual(doc.exited, 0);
});

test('toggle: the element that is full screen leaves it again', () => {
  const el = makeElement();
  const doc = makeDocument({ full: el });
  assertEqual(CamFullscreen.toggle(el, doc), true);
  assertEqual(doc.exited, 1);
  assertEqual(el.requested, 0);
});

test('toggle: another element being full screen does not count — this one is requested', () => {
  const el = makeElement();
  const doc = makeDocument({ full: makeElement() });
  assertEqual(CamFullscreen.toggle(el, doc), true);
  assertEqual(el.requested, 1);
  assertEqual(doc.exited, 0);
});

test('toggle: Safari\'s WebKit names work for entering and for leaving', () => {
  const el = makeElement('webkit');
  assertEqual(CamFullscreen.toggle(el, makeDocument()), true);
  assertEqual(el.requested, 1);
  const doc = makeDocument({ webkitFull: el, exit: 'webkit' });
  assertEqual(CamFullscreen.toggle(el, doc), true);
  assertEqual(doc.exited, 1);
});

test('toggle: a browser without the feature does nothing and says so (no throw)', () => {
  assertEqual(CamFullscreen.toggle(makeElement('none'), makeDocument()), false);
  const el = makeElement('none');
  assertEqual(CamFullscreen.toggle(el, makeDocument({ full: el, exit: 'none' })), false);
});

test('toggle: no element, or no document, is nothing to do', () => {
  assertEqual(CamFullscreen.toggle(null, makeDocument()), false);
  assertEqual(CamFullscreen.toggle(undefined, makeDocument()), false);
  assertEqual(CamFullscreen.toggle(makeElement(), null), false);   // no browser document either (node)
});

test('toggle: a refused request is logged, never thrown', () => {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    // the answer of a refusing browser, with a catch() that reports at once (the shared test() is synchronous)
    const refusal = new Error('not allowed');
    const refused = makeElement('standard', { catch: (handle) => handle(refusal) });
    assertEqual(CamFullscreen.toggle(refused, makeDocument()), true);
    const refusedExit = makeElement();
    const doc = makeDocument({ full: refusedExit });
    doc.exitFullscreen = () => ({ catch: (handle) => handle(refusal) });
    assertEqual(CamFullscreen.toggle(refusedExit, doc), true);
  } finally {
    console.error = realError;
  }
  assertEqual(logged.length, 2);
  assertTrue(logged.every((args) => args[0] === 'Fullscreen failed:' && args[1].message === 'not allowed'));
});

test('current: the standard name wins, the WebKit one is the fallback, nothing is null', () => {
  const a = makeElement();
  const b = makeElement();
  assertTrue(CamFullscreen.current(makeDocument({ full: a, webkitFull: b })) === a);
  assertTrue(CamFullscreen.current(makeDocument({ webkitFull: b })) === b);
  assertEqual(CamFullscreen.current(makeDocument()), null);
});

summarize();
