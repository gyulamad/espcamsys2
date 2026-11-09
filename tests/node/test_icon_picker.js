'use strict';

// test_icon_picker.js — php/cameras/js/icon-picker.js (the search and the arrow-key rule of the icon bubble) and
// php/cameras/js/icon-catalog.js (the icons it offers). The bubble itself, in a real browser, is
// tests/browser/test_icon_picker_browser.js.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const JS = path.join(__dirname, '../../php/cameras/js');
const Picker = require(path.join(JS, 'icon-picker.js'));
const { GROUPS } = require(path.join(JS, 'icon-catalog.js'));

const SMALL = [
  { title: 'Home', icons: [['🏠', 'House', 'home building'], ['🚪', 'Door', 'entrance front back'], ['🛋️', 'Living room', 'sofa couch']] },
  { title: 'Vehicles', icons: [['🚗', 'Car', 'auto vehicle garage'], ['🚲', 'Bicycle', 'bike cycle']] },
  { title: 'Empty', icons: [] },
];
const flat = (shown) => shown.flatMap((g) => g.icons.map((i) => i.icon));

// ── the catalog ──────────────────────────────────────────────────────

test('catalog: every icon is accepted by the server\'s rule (1-8 characters, none of < > & " \' or a control character)', () => {
  for (const group of GROUPS) {
    for (const [icon] of group.icons) {
      const length = [...icon].length;
      assertTrue(length >= 1 && length <= 8, `${icon} is ${length} characters`);
      assertTrue(!/[\x00-\x1f\x7f<>&"']/.test(icon), `${icon} has a forbidden character`);
      assertEqual(icon, icon.trim(), `${icon} has spaces around it`);
    }
  }
});

test('catalog: no icon twice, every icon has a name, groups have titles, and the default camera icon is there', () => {
  const seen = new Set();
  for (const group of GROUPS) {
    assertTrue(typeof group.title === 'string' && group.title !== '', 'a group needs a title');
    assertTrue(group.icons.length > 0, group.title + ' is empty');
    for (const [icon, name, words] of group.icons) {
      assertTrue(!seen.has(icon), `${icon} twice`);
      seen.add(icon);
      assertTrue(typeof name === 'string' && name.trim() !== '', `${icon} has no name`);
      assertTrue(words === undefined || typeof words === 'string', `${icon}: search words are text`);
    }
  }
  assertTrue(seen.has('📷'));
  assertTrue(seen.size >= 100, 'enough to choose from: ' + seen.size);
});

test('catalog: the things people put cameras on can be found by a plain word', () => {
  for (const [word, icon] of [['door', '🚪'], ['garage', '🚗'], ['dog', '🐶'], ['tree', '🌳'], ['baby', '👶'], ['kitchen', '🍳'], ['pool', '🏊'], ['bike', '🚲']]) {
    assertTrue(flat(Picker.search(GROUPS, word)).includes(icon), `"${word}" should find ${icon}`);
  }
});

test('catalog: a goat — found first by "goat", and by what people call one or where it lives', () => {
  assertEqual(flat(Picker.search(GROUPS, 'goat'))[0], '🐐', 'the goat is the first answer to "goat"');
  for (const word of ['billy', 'nanny', 'livestock', 'pen']) {
    assertTrue(flat(Picker.search(GROUPS, word)).includes('🐐'), `"${word}" should find 🐐`);
  }
  const farm = flat(Picker.search(GROUPS, 'farm'));
  for (const icon of ['🐐', '🐏', '🐑', '🐄', '🐓', '🦙', '🌾']) assertTrue(farm.includes(icon), `"farm" should find ${icon}`);
});

test('catalog: more farm and wild animals, and the farm and garden things, can be found by a plain word', () => {
  for (const [word, icon] of [['ram', '🐏'], ['llama', '🦙'], ['turkey', '🦃'], ['swan', '🦢'], ['wolf', '🐺'], ['bear', '🐻'], ['raccoon', '🦝'], ['bat', '🦇'], ['snake', '🐍'],
    ['frog', '🐸'], ['orchard', '🍎'], ['greenhouse', '🌱'], ['eggs', '🥚'], ['bucket', '🪣'], ['well', '🚰'], ['barrel', '🛢️']]) {
    assertTrue(flat(Picker.search(GROUPS, word)).includes(icon), `"${word}" should find ${icon}`);
  }
});

test('catalog: the pieces of a short phrase — where a camera looks and which one it is — can be found by a plain word', () => {
  for (const [word, icon] of [['left', '⬅️'], ['right', '➡️'], ['up', '⬆️'], ['down', '⬇️'], ['two', '2️⃣'], ['3', '3️⃣'], ['compass', '🧭'], ['spot', '📍']]) {
    assertTrue(flat(Picker.search(GROUPS, word)).includes(icon), `"${word}" should find ${icon}`);
  }
});

test('catalog: every icon is a picture, not plain text (no typed digit or letter in the place of an emoji)', () => {
  for (const group of GROUPS) {
    for (const [icon] of group.icons) {
      assertTrue([...icon].some((c) => c.codePointAt(0) > 0x7f), `${JSON.stringify(icon)} is only ASCII`);
    }
  }
});

test('catalog: every emoji is old enough for an older phone (Unicode 13, 2020, or earlier: nothing from the 2021+ additions)', () => {
  // The ranges of the code points added to Unicode (and so to emoji) AFTER version 13: a phone that is a few years
  // old draws them as an empty box. Only the planes with the newest additions are listed (the older ones are all
  // fine): 1FAB7-1FABF, 1FAC3-1FACF, 1FAD7-1FADF, 1FAE0-1FAFF, 1F6DC-1F6DF, 1F7F0, 1FA75-1FA77, 1FA87-1FA8F, 1FAA9-1FAAF.
  const tooNew = [[0x1fab7, 0x1fabf], [0x1fac3, 0x1facf], [0x1fad7, 0x1fadf], [0x1fae0, 0x1faff], [0x1f6dc, 0x1f6df], [0x1f7f0, 0x1f7f0], [0x1fa75, 0x1fa77], [0x1fa87, 0x1fa8f], [0x1faa9, 0x1faaf]];
  for (const group of GROUPS) {
    for (const [icon] of group.icons) {
      for (const c of icon) {
        const cp = c.codePointAt(0);
        assertTrue(!tooNew.some(([lo, hi]) => cp >= lo && cp <= hi), `${icon} (U+${cp.toString(16).toUpperCase()}) is newer than Unicode 13`);
      }
    }
  }
});

// ── terms / search ───────────────────────────────────────────────────

test('terms: lower case, split at any spaces, nothing empty; no text is no terms', () => {
  assertEqual(Picker.terms('  Front   DOOR '), ['front', 'door']);
  assertEqual(Picker.terms(''), []);
  assertEqual(Picker.terms('   '), []);
  assertEqual(Picker.terms(null), []);
  assertEqual(Picker.terms(undefined), []);
});

test('search: no search shows every group as it is, and drops the groups without icons', () => {
  const shown = Picker.search(SMALL, '');
  assertEqual(shown.map((g) => g.title), ['Home', 'Vehicles']);
  assertEqual(shown[0].icons, [{ icon: '🏠', name: 'House' }, { icon: '🚪', name: 'Door' }, { icon: '🛋️', name: 'Living room' }]);
  assertEqual(Picker.search(SMALL, '   '), shown, 'only spaces is no search');
});

test('search: finds by name, by search words, and by the icon itself; case does not matter', () => {
  assertEqual(flat(Picker.search(SMALL, 'DOOR')), ['🚪']);
  assertEqual(flat(Picker.search(SMALL, 'sofa')), ['🛋️']);
  assertEqual(flat(Picker.search(SMALL, 'bike')), ['🚲']);
  assertEqual(flat(Picker.search(SMALL, '🚗')), ['🚗']);
});

test('search: a part of a word is enough', () => {
  assertEqual(flat(Picker.search(SMALL, 'gar')), ['🚗']);
  assertEqual(flat(Picker.search(SMALL, 'ycl')), ['🚲'], 'in the middle of a word too');
});

test('search: several words must ALL fit, in any order', () => {
  assertEqual(flat(Picker.search(SMALL, 'living sofa')), ['🛋️']);
  assertEqual(flat(Picker.search(SMALL, 'sofa living')), ['🛋️']);
  assertEqual(Picker.search(SMALL, 'door sofa'), []);
});

test('search: the result is one flat group without a title; nothing found is an empty list', () => {
  const shown = Picker.search(SMALL, 'o');
  assertEqual(shown.length, 1);
  assertEqual(shown[0].title, '');
  assertEqual(Picker.search(SMALL, 'zzzz'), []);
});

test('search: the best fit comes first — name starts with it, then a word starts with it, then anywhere — ties in catalog order', () => {
  const groups = [{ title: 'x', icons: [
    ['🅰️', 'Gate', 'carport'],            // "car" starts a search word
    ['🅱️', 'Scarecrow', 'field'],          // "car" is inside the name
    ['🚗', 'Car', 'auto'],                 // the name starts with it
    ['🚙', 'Carriage', 'old'],             // the name starts with it, later in the catalog
  ] }];
  assertEqual(flat(Picker.search(groups, 'car')), ['🚗', '🚙', '🅰️', '🅱️']);
});

test('search: nothing in the search is taken as a pattern or markup', () => {
  for (const hostile of ['.*', '(', '[a-', '\\', '<img src=x onerror=1>', '"', '%', '^$']) {
    assertEqual(Picker.search(SMALL, hostile), [], hostile);
  }
});

test('search: a catalog with nothing in it, or no catalog, finds nothing and does not throw', () => {
  assertEqual(Picker.search([], 'a'), []);
  assertEqual(Picker.search([], ''), []);
  assertEqual(Picker.search(undefined, 'a'), []);
  assertEqual(Picker.search([{ title: 't' }], 'a'), []);
});

test('search: the real catalog — every icon is found by its own name, and the empty search gives all of them', () => {
  const all = flat(Picker.search(GROUPS, ''));
  assertEqual(all.length, GROUPS.reduce((n, g) => n + g.icons.length, 0));
  for (const group of GROUPS) {
    for (const [icon, name] of group.icons) assertTrue(flat(Picker.search(GROUPS, name)).includes(icon), `${name} should find ${icon}`);
  }
});

// ── moveIndex (arrow keys in the grid) ───────────────────────────────

test('moveIndex: left and right step by one, up and down by a row', () => {
  assertEqual(Picker.moveIndex(5, 'ArrowRight', 4, 12), 6);
  assertEqual(Picker.moveIndex(5, 'ArrowLeft', 4, 12), 4);
  assertEqual(Picker.moveIndex(5, 'ArrowDown', 4, 12), 9);
  assertEqual(Picker.moveIndex(5, 'ArrowUp', 4, 12), 1);
});

test('moveIndex: at the edges it stays (null); up from the first row is left to the caller', () => {
  assertEqual(Picker.moveIndex(0, 'ArrowLeft', 4, 12), null);
  assertEqual(Picker.moveIndex(11, 'ArrowRight', 4, 12), null);
  assertEqual(Picker.moveIndex(2, 'ArrowUp', 4, 12), null);
  assertEqual(Picker.moveIndex(10, 'ArrowDown', 4, 12), null, 'already in the last row');
});

test('moveIndex: down into a short last row goes to its last icon', () => {
  assertEqual(Picker.moveIndex(2, 'ArrowDown', 4, 10), 6);
  assertEqual(Picker.moveIndex(7, 'ArrowDown', 4, 10), 9, 'row 2 has 4 icons, row 3 only 2: the last one');
  assertEqual(Picker.moveIndex(8, 'ArrowDown', 4, 10), null, 'in the short row already');
  assertEqual(Picker.moveIndex(9, 'ArrowDown', 4, 10), null);
});

test('moveIndex: other keys and an empty grid do nothing', () => {
  assertEqual(Picker.moveIndex(3, 'Enter', 4, 12), null);
  assertEqual(Picker.moveIndex(3, 'a', 4, 12), null);
  assertEqual(Picker.moveIndex(0, 'ArrowRight', 4, 0), null);
  assertEqual(Picker.moveIndex(0, 'ArrowRight', 1, 1), null);
});

// ── shiftToFit (keeping the bubble on the screen) ────────────────────

test('shiftToFit: a bubble that fits is not moved', () => {
  assertEqual(Picker.shiftToFit(30, 336, 1000, 12), 0);
  assertEqual(Picker.shiftToFit(30, 336, 348 + 30, 12), 0, 'exactly fitting');
});

test('shiftToFit: one that runs over the right edge moves left by exactly the overflow (and keeps the margin)', () => {
  assertEqual(Picker.shiftToFit(35, 336, 360, 12), 23);   // right edge 371 -> 348
  assertEqual(Picker.shiftToFit(200, 300, 400, 12), 112); // right edge 500 -> 388
});

test('shiftToFit: never so far that its left edge leaves the screen', () => {
  assertEqual(Picker.shiftToFit(20, 336, 300, 12), 8, 'a window narrower than the bubble: left edge at the margin, the right edge loses');
  assertEqual(Picker.shiftToFit(5, 336, 300, 12), 0, 'already left of the margin: no shift to the left');
});

summarize();
