'use strict';

// test_busy.js — the visual confirmation of a click (php/cameras/js/busy.js): the spinner on a button that works in the
// background, and the full-screen cover over a page that is being replaced.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { create } = require('../../php/cameras/js/busy');

// ── A stand-in for the page: just what busy.js touches ───────────────

function fakeElement(attrs = {}) {
  const el = {
    attrs: { ...attrs }, classes: new Set(), children: [], hidden: false, textContent: '', id: '', className: '',
    classList: { toggle: (c, on) => { on ? el.classes.add(c) : el.classes.delete(c); }, contains: (c) => el.classes.has(c) },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    hasAttribute(k) { return k in el.attrs; },
    append(...c) { el.children.push(...c); },
    appendChild(c) { el.children.push(c); return c; },
    closest() { return el.link || null; },
  };
  return el;
}

function fakePage(options) {
  const listeners = {};
  const timers = [];
  const doc = {
    body: fakeElement(),
    createElement: () => fakeElement(),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const win = {
    assigned: [],
    location: { assign: (u) => win.assigned.push(u) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
    addEventListener: (type, fn) => { listeners['win:' + type] = fn; },
  };
  const busy = create({ document: doc, window: win }, options);
  busy.watchNavigation();
  return { busy, doc, win, listeners, timers, cover: () => doc.body.children[0] };
}

const click = (link, extra = {}) => ({ target: { closest: () => link }, button: 0, defaultPrevented: false, ...extra });
const link = (attrs) => fakeElement({ 'data-page-load': '', href: 'page.php', ...attrs });

// ── run: the spinner on a button ─────────────────────────────────────

test('run: the button is busy while the work is going on and plain again after it', async () => {
  const { busy } = fakePage();
  const btn = fakeElement();
  let finish;
  const pending = busy.run(btn, () => new Promise((r) => { finish = r; }));
  assertTrue(btn.classes.has('is-busy'), 'spinner on');
  assertEqual(btn.getAttribute('aria-busy'), 'true');
  finish('done');
  assertEqual(await pending, 'done', 'gives back what the work gives back');
  assertTrue(!btn.classes.has('is-busy') && btn.getAttribute('aria-busy') === null, 'spinner off');
});

test('run: a failing work throws its error on and still takes the spinner away', async () => {
  const { busy } = fakePage();
  const btn = fakeElement();
  let caught = null;
  try { await busy.run(btn, async () => { throw new Error('nope'); }); } catch (e) { caught = e; }
  assertEqual(caught && caught.message, 'nope');
  assertTrue(!btn.classes.has('is-busy'));
});

test('run: a work that throws at once (not async) is handled the same way', async () => {
  const { busy } = fakePage();
  const btn = fakeElement();
  let caught = null;
  try { await busy.run(btn, () => { throw new Error('sync'); }); } catch (e) { caught = e; }
  assertEqual(caught && caught.message, 'sync');
  assertTrue(!btn.classes.has('is-busy'));
});

test('run: a second click on a busy button does not start the work again', async () => {
  const { busy } = fakePage();
  const btn = fakeElement();
  let starts = 0, finish;
  const work = () => { starts++; return new Promise((r) => { finish = r; }); };
  const first = busy.run(btn, work);
  const second = busy.run(btn, work);
  assertEqual(starts, 1);
  finish('x');
  assertEqual(await first, 'x');
  assertEqual(await second, 'x', 'it gets the first run\'s answer');
  await busy.run(btn, async () => { starts++; });
  assertEqual(starts, 2, 'after it is done a click works again');
});

test('run: two different buttons are busy independently', async () => {
  const { busy } = fakePage();
  const a = fakeElement(), b = fakeElement();
  let finishA;
  const pa = busy.run(a, () => new Promise((r) => { finishA = r; }));
  await busy.run(b, async () => {});
  assertTrue(a.classes.has('is-busy') && !b.classes.has('is-busy'));
  finishA();
  await pa;
});

test('run: no button (or a plain promise as the work) just runs', async () => {
  const { busy } = fakePage();
  assertEqual(await busy.run(null, async () => 5), 5);
  assertEqual(await busy.run(null, () => 6), 6);
  assertEqual(await busy.run(fakeElement(), Promise.resolve(7)), 7);
});

// ── the cover over the page ──────────────────────────────────────────

test('showPage: the cover is made once, says what is going on and is a polite status for screen readers', () => {
  const { busy, doc, cover } = fakePage();
  assertEqual(doc.body.children.length, 0, 'nothing is added to a page that never navigates');
  busy.showPage('Logging out…');
  busy.showPage();
  assertEqual(doc.body.children.length, 1);
  assertEqual(cover().id, 'page-busy');
  assertEqual(cover().getAttribute('role'), 'status');
  assertEqual(cover().hidden, false);
  assertEqual(cover().children[1].textContent, 'Loading…', 'the default text');
});

test('showPage: the text of the cover is set as text (never markup)', () => {
  const { busy, cover } = fakePage();
  busy.showPage('<img src=x onerror=alert(1)>');
  assertEqual(cover().children[1].textContent, '<img src=x onerror=alert(1)>');
});

test('hidePage: takes the cover and its give-up timer away', () => {
  const { busy, cover, timers } = fakePage();
  busy.showPage('x');
  busy.hidePage();
  assertEqual(cover().hidden, true);
  assertTrue(timers[0].cleared);
  busy.hidePage();   // nothing shown: harmless
});

test('showPage: a page that does not come gives the window back after the give-up time', () => {
  const { busy, cover, timers } = fakePage({ giveUpMs: 1234 });
  busy.showPage('x');
  assertEqual(timers[0].ms, 1234);
  timers[0].fn();
  assertEqual(cover().hidden, true);
});

test('showPage: showing it again restarts the give-up time', () => {
  const { busy, timers } = fakePage();
  busy.showPage('a');
  busy.showPage('b');
  assertTrue(timers[0].cleared && !timers[1].cleared);
});

test('navigate: covers the page first and then goes to the address', () => {
  const { busy, win, cover } = fakePage();
  busy.navigate('index.php');
  assertEqual(cover().hidden, false);
  assertEqual(win.assigned, ['index.php']);
});

// ── links and forms that replace the page ────────────────────────────

test('a plain click on a marked link covers the page, with the link\'s own text when it has one', () => {
  const { listeners, cover } = fakePage();
  listeners.click(click(link({ 'data-page-load': 'Opening…' })));
  assertEqual(cover().hidden, false);
  assertEqual(cover().children[1].textContent, 'Opening…');
});

test('a click that does not replace the page leaves it alone', () => {
  const cases = {
    'a link that is not marked': null,
    'a modified click (new tab)': click(link(), { ctrlKey: true }),
    'a meta click': click(link(), { metaKey: true }),
    'a shift click': click(link(), { shiftKey: true }),
    'an alt click (download)': click(link(), { altKey: true }),
    'a middle click': click(link(), { button: 1 }),
    'a click that was already handled': click(link(), { defaultPrevented: true }),
    'a link to a new tab': click(link({ target: '_blank' })),
    'a download link': click(link({ download: 'a.mp4' })),
    'a link that stays on the page': click(link({ href: '#top' })),
    'a link without an address': click(link({ href: '' })),
    'a script link': click(link({ href: 'javascript:void(0)' })),
    'a mail link': click(link({ href: 'MAILTO:a@b.c' })),
    'a blob link': click(link({ href: 'blob:xyz' })),
  };
  for (const [name, ev] of Object.entries(cases)) {
    const { listeners, doc } = fakePage();
    listeners.click(ev || { target: { closest: () => null }, button: 0 });
    assertEqual(doc.body.children.length, 0, name);
  }
});

test('a link that opens in this window explicitly (_self) does cover the page', () => {
  const { listeners, cover } = fakePage();
  listeners.click(click(link({ target: '_self' })));
  assertEqual(cover().hidden, false);
});

test('a click on something that is not an element is ignored', () => {
  const { listeners, doc } = fakePage();
  listeners.click({ target: null });
  listeners.click({ target: {} });
  assertEqual(doc.body.children.length, 0);
});

test('a submitted marked form covers the page with its text; one that was stopped does not', () => {
  const form = fakeElement({ 'data-page-load': 'Logging out…' });
  const { listeners, cover, doc } = fakePage();
  listeners.submit({ target: { closest: () => form }, defaultPrevented: true });
  assertEqual(doc.body.children.length, 0, 'stopped by the page: it is not leaving');
  listeners.submit({ target: { closest: () => form }, defaultPrevented: false });
  assertEqual(cover().children[1].textContent, 'Logging out…');
  listeners.submit({ target: { closest: () => null }, defaultPrevented: false });
});

test('coming back to a page the browser kept (back button) takes the cover away; a fresh load does not matter', () => {
  const { busy, listeners, cover } = fakePage();
  busy.showPage('x');
  listeners['win:pageshow']({ persisted: false });
  assertEqual(cover().hidden, false);
  listeners['win:pageshow']({ persisted: true });
  assertEqual(cover().hidden, true);
});

summarize();
