'use strict';
// js/dashboard-layout.js — which layout the dashboard shows, and the wiring of the navigation bar's
// DASHBOARD GRID / DASHBOARD LIST links, on a tiny fake page (no browser needed).
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const L = require('../../php/cameras/js/dashboard-layout.js');

function fakeLink(key) {
  const classes = new Set();
  const attrs = {};
  let handler = null;
  return {
    dataset: { nav: key },
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
    setAttribute(k, v) { attrs[k] = v; },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener(type, fn) { if (type === 'click') handler = fn; },
    click(event) { const e = Object.assign({ defaultPrevented: false, button: 0, prevented: false, preventDefault() { this.prevented = true; } }, event); handler(e); return e; },
  };
}

function fakePage({ search = '', saved = null, storageBroken = false } = {}) {
  const gridClasses = new Set();
  const grid = { classList: { toggle(c, on) { if (on) gridClasses.add(c); else gridClasses.delete(c); }, contains: (c) => gridClasses.has(c) } };
  const links = { 'dashboard-grid': fakeLink('dashboard-grid'), 'dashboard-list': fakeLink('dashboard-list') };
  const store = saved === null ? {} : { 'esp32-layout': saved };
  const urls = [];
  const env = {
    document: {
      getElementById: (id) => (id === 'grid' ? grid : null),
      querySelectorAll: () => Object.values(links),
    },
    location: { search },
    history: { replaceState: (a, b, url) => urls.push(url) },
    storage: {
      getItem: (k) => { if (storageBroken) throw new Error('blocked'); return k in store ? store[k] : null; },
      setItem: (k, v) => { if (storageBroken) throw new Error('blocked'); store[k] = v; },
    },
  };
  return { env, grid, links, store, urls };
}

test('resolve: the address wins over the remembered layout, then the remembered one, then the grid', () => {
  assertEqual(L.resolve('?layout=list', 'grid'), 'list');
  assertEqual(L.resolve('?layout=grid', 'list'), 'grid');
  assertEqual(L.resolve('', 'list'), 'list');
  assertEqual(L.resolve('', null), 'grid');
});

test('resolve: anything that is not grid or list is ignored', () => {
  assertEqual(L.resolve('?layout=table', 'list'), 'list');
  assertEqual(L.resolve('?layout=LIST', null), 'grid');
  assertEqual(L.resolve('?layout[]=list', null), 'grid');
  assertEqual(L.resolve(undefined, 'nonsense'), 'grid');
});

test('modeOfKey: only the two dashboard keys stand for a layout', () => {
  assertEqual(L.modeOfKey('dashboard-grid'), 'grid');
  assertEqual(L.modeOfKey('dashboard-list'), 'list');
  for (const k of ['dashboard-table', 'simple-view', 'all-files', '', null, undefined]) assertEqual(L.modeOfKey(k), null, String(k));
});

test('wire: starts in the remembered layout and marks its link', () => {
  const p = fakePage({ saved: 'list' });
  L.wire(p.env);
  assertTrue(p.grid.classList.contains('layout-list'));
  assertTrue(p.links['dashboard-list'].classList.contains('current'));
  assertEqual(p.links['dashboard-list'].getAttribute('aria-current'), 'page');
  assertTrue(!p.links['dashboard-grid'].classList.contains('current'));
  assertEqual(p.links['dashboard-grid'].getAttribute('aria-current'), null);
});

test('wire: ?layout= in the address wins and is not written to the storage by itself', () => {
  const p = fakePage({ search: '?layout=grid', saved: 'list' });
  L.wire(p.env);
  assertTrue(!p.grid.classList.contains('layout-list'));
  assertEqual(p.store['esp32-layout'], 'list');
});

test('wire: a click switches in place, remembers the choice and keeps the address in step — no navigation', () => {
  const p = fakePage();
  L.wire(p.env);
  const e = p.links['dashboard-list'].click();
  assertTrue(e.prevented, 'the link does not reload the page');
  assertTrue(p.grid.classList.contains('layout-list'));
  assertTrue(p.links['dashboard-list'].classList.contains('current') && !p.links['dashboard-grid'].classList.contains('current'));
  assertEqual(p.store['esp32-layout'], 'list');
  assertEqual(p.urls, ['./?layout=list']);
  p.links['dashboard-grid'].click();
  assertTrue(!p.grid.classList.contains('layout-list'));
  assertEqual(p.store['esp32-layout'], 'grid');
});

test('wire: a click with a modifier key or another button is left to the browser (new tab, ...)', () => {
  const p = fakePage();
  L.wire(p.env);
  for (const ev of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const e = p.links['dashboard-list'].click(ev);
    assertTrue(!e.prevented, JSON.stringify(ev));
  }
  assertTrue(!p.grid.classList.contains('layout-list'));
  assertEqual(p.urls, []);
});

test('wire: blocked storage or history never stops the layout from switching', () => {
  const p = fakePage({ storageBroken: true });
  p.env.history.replaceState = () => { throw new Error('not allowed'); };
  L.wire(p.env);
  p.links['dashboard-list'].click();
  assertTrue(p.grid.classList.contains('layout-list'));
});

summarize();
