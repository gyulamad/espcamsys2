'use strict';

// test_wifi_chip.js — php/cameras/js/wifi-info.js: the bands of a signal strength and what the chip shows.
// The chip is filled in with a tiny DOM stand-in here; tests/dom/test_wifi_dom.js does it in a real page.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const W = require('../../php/cameras/js/wifi-info');

// ── quality ───────────────────────────────────────────────────────────────

test('quality: the bands, with their edges belonging to the better band', () => {
  assertEqual(W.quality(-30), { level: 4, label: 'excellent' });
  assertEqual(W.quality(-55), { level: 4, label: 'excellent' });
  assertEqual(W.quality(-56), { level: 3, label: 'good' });
  assertEqual(W.quality(-65), { level: 3, label: 'good' });
  assertEqual(W.quality(-66), { level: 2, label: 'fair' });
  assertEqual(W.quality(-75), { level: 2, label: 'fair' });
  assertEqual(W.quality(-76), { level: 1, label: 'weak' });
  assertEqual(W.quality(-85), { level: 1, label: 'weak' });
  assertEqual(W.quality(-86), { level: 0, label: 'very weak' });
  assertEqual(W.quality(-127), { level: 0, label: 'very weak' });
});

test('quality: not a number -> null', () => {
  for (const v of [null, undefined, '-60', NaN, Infinity, {}, []]) assertEqual(W.quality(v), null);
});

// ── formatAge ─────────────────────────────────────────────────────────────

test('formatAge: seconds, then minutes; nothing for what is not an age', () => {
  assertEqual(W.formatAge(0), '0 s ago');
  assertEqual(W.formatAge(12400), '12 s ago');
  assertEqual(W.formatAge(59000), '59 s ago');
  assertEqual(W.formatAge(60000), '1 min ago');
  assertEqual(W.formatAge(110000), '2 min ago');
  for (const v of [-1, null, undefined, 'x', NaN]) assertEqual(W.formatAge(v), '');
});

// ── describe ──────────────────────────────────────────────────────────────

test('describe: the chip text, the band and the tooltip', () => {
  const d = W.describe({ ssid: 'HomeNet', rssi: -61, ageMs: 4000 });
  assertEqual(d.text, 'HomeNet · -61 dBm');
  assertEqual([d.level, d.label], [3, 'good']);
  assertEqual(d.title, 'HomeNet: -61 dBm, good signal, reported 4 s ago');
});

test('describe: without an age the tooltip has no "reported"', () => {
  assertEqual(W.describe({ ssid: 'HomeNet', rssi: -61 }).title, 'HomeNet: -61 dBm, good signal');
});

test('describe: nothing true to show -> null', () => {
  for (const v of [null, undefined, {}, 'HomeNet', { ssid: '', rssi: -60 }, { ssid: 5, rssi: -60 }, { ssid: 'a' }, { ssid: 'a', rssi: '-60' }, { ssid: 'a', rssi: NaN }]) {
    assertEqual(W.describe(v), null, JSON.stringify(v));
  }
});

// ── render (against a minimal element) ────────────────────────────────────

// Just enough of an element for render(): children, textContent, attributes, hidden, dataset, querySelector.
function fakeDocument() {
  function element(tag) {
    const e = {
      tag, className: '', children: [], attrs: {}, dataset: {}, hidden: true, _text: '', title: '',
      appendChild(c) { this.children.push(c); return c; },
      removeAttribute(n) { delete this.attrs[n]; if (n === 'title') this.title = ''; if (n === 'data-level') delete this.dataset.level; },
      setAttribute(n, v) { this.attrs[n] = v; },
      querySelector(sel) { const cls = sel.slice(1); return this.children.find((c) => c.className === cls) || null; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); if (v === '') this.children = []; },
    };
    return e;
  }
  const doc = { createElement: element };
  const chip = element('span');
  chip.ownerDocument = doc;
  return chip;
}

test('render: fills the chip, shows it, builds the bars once', () => {
  const chip = fakeDocument();
  W.render(chip, { ssid: 'HomeNet', rssi: -61, ageMs: 1000 });
  assertEqual(chip.hidden, false);
  assertEqual(chip.querySelector('.wifi-text').textContent, 'HomeNet · -61 dBm');
  assertEqual(chip.querySelector('.wifi-bars').children.length, W.BARS);
  assertEqual(chip.dataset.level, '3');
  const bars = chip.querySelector('.wifi-bars');
  W.render(chip, { ssid: 'HomeNet', rssi: -80, ageMs: 2000 });
  assertTrue(chip.querySelector('.wifi-bars') === bars, 'the same bars are reused on every update');
  assertEqual(chip.dataset.level, '1');
  assertEqual(chip.querySelector('.wifi-text').textContent, 'HomeNet · -80 dBm');
});

test('render: nothing to show hides the chip and leaves nothing of the last reading', () => {
  const chip = fakeDocument();
  W.render(chip, { ssid: 'HomeNet', rssi: -61, ageMs: 1000 });
  W.render(chip, null);
  assertEqual(chip.hidden, true);
  assertEqual(chip.textContent, '');
  assertEqual(chip.children.length, 0);
  assertEqual(chip.title, '');
  assertTrue(!('aria-label' in chip.attrs) && !('level' in chip.dataset), 'no attribute of the old reading is left');
});

test('render: a hostile network name is set as TEXT, never parsed (there is no innerHTML in the module)', () => {
  const chip = fakeDocument();
  const evil = '<img src=x onerror=alert(1)>';
  W.render(chip, { ssid: evil, rssi: -50, ageMs: 0 });
  assertEqual(chip.querySelector('.wifi-text').textContent, evil + ' · -50 dBm');
  const source = require('fs').readFileSync(require('path').join(__dirname, '../../php/cameras/js/wifi-info.js'), 'utf8');
  assertTrue(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), 'the module never writes markup');
});

test('render: no element (a card without the chip) is fine', () => {
  W.render(null, { ssid: 'a', rssi: -50 });
  W.render(undefined, null);
});

summarize();
