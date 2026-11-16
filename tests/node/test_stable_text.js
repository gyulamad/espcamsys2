'use strict';

// test_stable_text.js — the reservations of js/stable-text.js (F-35): an element whose text changes keeps the
// room of its widest wording, so a change of value cannot move where a wrapping row breaks its lines. The
// measurement is handed in (no layout engine is needed), the elements are plain stand-ins: what is under test
// is the RULE — which width is reserved, that a wider reservation is never given back, that the candidates are
// the ones the page passed, and that a page without a document (or with an empty candidate list) is left alone.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const CamStableText = require('../../php/cameras/js/stable-text');

// A text's "width": its length. A text's "wrapped height": one line per 8 characters, rounded up — and no
// room to wrap into (clientWidth 0) measures to nothing, like the real measurer.
const widths = new Map([['NEXT IN 10 s', 110], ['⏸ SLIDESHOW ON', 130]]);
const measureText = (text) => widths.get(text) ?? text.length * 10;
const measureLines = (text, el) => (el.clientWidth ? Math.ceil(text.length / 8) * 14 : 0);

// A stand-in element with just what reserve()/reserveHeight() touch.
function el() {
  return { style: {}, clientWidth: 80 };
}

// create() with the document/window left out and the measurers handed in: nothing global is touched.
function api() {
  return CamStableText.create({ doc: null, win: null, measureText, measureLines });
}

test('reserve sets min-width to the widest of the candidates', () => {
  const e = el();
  assertEqual(api().reserve(e, ['NEXT IN 10 s', 'NEXT IN 9 s']), '110px');
  assertEqual(e.style.minWidth, '110px');
});

test('reserve includes the element\'s own padding and border: the reservation sizes the whole box (F-35)', () => {
  // A pill or button draws its text plus its chrome; min-width is the whole box (border-box), so the
  // reserved room must be text + chrome or the element could still shrink between its wordings.
  const doc = {
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    defaultView: { getComputedStyle: () => ({ paddingLeft: '8px', paddingRight: '8px', borderLeftWidth: '1px', borderRightWidth: '1px',
                                              paddingTop: '2px', paddingBottom: '2px', borderTopWidth: '0px', borderBottomWidth: '0px' }) },
  };
  const stable = CamStableText.create({ doc, win: null, measureText, measureLines });
  const e = el();
  stable.reserve(e, ['ab']);   // 20px of text
  assertEqual(e.style.minWidth, '38px', 'text (20) + padding (16) + border (2)');
  stable.reserveHeight(e, ['abcdefgh abcdef']);   // two lines of 14
  assertEqual(e.style.minHeight, '32px', 'two lines (28) + padding (4)');
});

test('a computed style that says nothing about chrome reserves the text alone', () => {
  const doc = {
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    defaultView: { getComputedStyle: () => ({}) },
  };
  const stable = CamStableText.create({ doc, win: null, measureText, measureLines });
  const e = el();
  stable.reserve(e, ['ab']);
  assertEqual(e.style.minWidth, '20px');
});

test('reserve takes the widest even when it is not the first or the current text', () => {
  const e = el();
  api().reserve(e, ['⏸ SLIDESHOW ON', '▶ SLIDESHOW']);
  assertEqual(e.style.minWidth, '130px');
});

test('reserve measures unknown texts by their length when no width is mapped', () => {
  const e = el();
  api().reserve(e, ['ab', 'abc', 'ab']);
  assertEqual(e.style.minWidth, '30px');
});

test('a wider reservation is kept; a narrower one never pulls it down (two writers, F-35)', () => {
  const e = el();
  const stable = api();
  stable.reserve(e, ['ab']);          // 20px
  e.style.minWidth = '50px';          // as busy.js would leave behind
  stable.reserve(e, ['ab']);          // the same candidates again: the room stays
  assertEqual(e.style.minWidth, '50px');
  stable.reserve(e, ['abcdef']);      // 60px: wider wins
  assertEqual(e.style.minWidth, '60px');
  stable.reserve(e, ['ab']);          // narrower: the 60px stay
  assertEqual(e.style.minWidth, '60px');
});

test('reserve with a fresh candidate list replaces the old candidates (they are the ones re-measured)', () => {
  const e = el();
  const stable = api();
  stable.reserve(e, ['abcdefgh']);    // 80px
  stable.reserve(e, ['ab']);          // 20px, but max-with-existing keeps 80px
  assertEqual(e.style.minWidth, '80px');
});

test('reserve ignores what is not its business: no element, no texts, junk in the list', () => {
  const stable = api();
  assertTrue(stable.reserve(null, ['ab']) === null, 'no element');
  assertTrue(stable.reserve(el(), []) === null, 'no candidates');
  assertTrue(stable.reserve(el(), ['', undefined, 5]) === null, 'only junk candidates');
});

test('reserveHeight sets min-height to the tallest wrapped candidate', () => {
  const e = el();
  api().reserveHeight(e, ['abcdefgh abcdef', 'short']);
  assertEqual(e.style.minHeight, '28px');   // the 16-character sentence wraps to two lines
});

test('reserveHeight without room to measure (a hidden element) reserves nothing', () => {
  const e = el();
  e.clientWidth = 0;
  api().reserveHeight(e, ['12345678 12345678']);
  assertEqual(e.style.minHeight, undefined);
});

test('release takes the reservation back', () => {
  const e = el();
  const stable = api();
  stable.reserve(e, ['ab']);
  stable.release(e);
  assertEqual(e.style.minWidth, '');
  stable.reserve(e, ['ab']);
  assertEqual(e.style.minWidth, '20px');   // and a fresh reservation starts from nothing again
});

test('release of an element with no reservation changes nothing', () => {
  const stable = api();
  const e = el();
  stable.release(e);
  assertEqual(e.style.minWidth, undefined);
});

test('remeasureAll re-applies the live reservations with the current measurement', () => {
  const e = el();
  const stable = api();
  stable.reserve(e, ['ab']);
  widths.set('ab', 40);   // the "font" changed: the same text now measures wider
  stable.remeasureAll();
  assertEqual(e.style.minWidth, '40px');
  widths.set('ab', undefined);
});

test('remeasureAll is wired to the fonts and the resize of the document it was given', () => {
  const listeners = [];
  const e = el();
  const doc = {
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    fonts: {
      ready: { then: (fn) => { listeners.push(['fonts.ready', fn]); return { catch() {} }; } },
      addEventListener: (k, fn) => listeners.push(['fonts.' + k, fn]),
    },
  };
  const win = { addEventListener: (k, fn) => listeners.push([k, fn]) };
  const stable = CamStableText.create({ doc, win, measureText, measureLines });
  stable.reserve(e, ['ab']);
  assertTrue(listeners.some(([k]) => k === 'resize'), 'the window resize re-measures');
  assertTrue(listeners.some(([k]) => k === 'fonts.ready'), 'the fonts re-measure when they are in');
  // The wiring happens once per instance: a second reservation must not add a second set of listeners.
  stable.reserve(e, ['abc']);
  assertEqual(listeners.length, 3);
});

test('a page without any document (the node tests) reserves nothing and does not throw', () => {
  const stable = CamStableText.create({ doc: null, win: null });
  const e = el();
  assertTrue(stable.reserve(e, ['ab']) === null);
  assertEqual(e.style.minWidth, undefined);
});

summarize();
