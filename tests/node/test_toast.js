'use strict';
// Unit tests for php/cameras/js/toast.js (F-12): the toast popups that carry the buttons' result
// messages (REBOOT, the recording switch, APPLY of the settings pages...) instead of a message
// printed next to the button. The document and the timers are fakes, so no browser is needed —
// the same way tests/node/test_screen_keeper.js tests its module.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const T = require(path.join(__dirname, '../../php/cameras/js/toast.js'));

// ── fakes ────────────────────────────────────────────────────────────
// Just enough of an element: tag, attributes, classList, children, listeners, remove(), textContent.
function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    children: [],
    parent: null,
    listeners: {},
    className: '',
    textContent: '',
    type: '',
    hidden: false,
    classList: {
      add(c) { if (!el.className.split(/\s+/).includes(c)) el.className = (el.className + ' ' + c).trim(); },
      remove(c) { el.className = el.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      contains(c) { return el.className.split(/\s+/).includes(c); },
      toggle(c) { if (el.classList.contains(c)) { el.classList.remove(c); return false; } el.classList.add(c); return true; },
    },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null; },
    appendChild(node) {
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = el;
      el.children.push(node);
      return node;
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn); },
    // Fires the listeners with an event that carries the target and a stopPropagation recorder.
    dispatch(type, ev = {}) {
      const event = Object.assign({ type, target: el, stopPropagation() { event.stopped = true; } }, ev);
      (el.listeners[type] || []).forEach((fn) => fn(event));
      return event;
    },
  };
  return el;
}

// A document: a head, a body, createElement. querySelector understands what toast.js asks it
// ('style[data-cam-toast]' on the style host) and nothing else — a missing answer throws the test,
// never silently passes it.
function fakeDoc() {
  const head = fakeEl('head');
  const body = fakeEl('body');
  const doc = {
    head,
    body,
    created: [],
    createElement(tag) { const el = fakeEl(tag); doc.created.push(el); return el; },
  };
  const matches = (el, selector) => {
    const tag = selector.replace(/\[.*\]$/, '').trim().toLowerCase();
    const attr = /\[([^\]=]+)(?:="([^"]*)")?\]/.exec(selector);
    return el.tagName.toLowerCase() === tag
      && (!attr || (attr[1] in el.attrs && (attr[2] === undefined || el.attrs[attr[1]] === attr[2])));
  };
  const findIn = (root, selector) => {
    for (const child of root.children) {
      if (matches(child, selector)) return child;
      const deep = findIn(child, selector);
      if (deep) return deep;
    }
    return null;
  };
  head.querySelector = (selector) => findIn(head, selector);
  body.querySelector = (selector) => findIn(body, selector);
  return doc;
}

// Timers that only run when the test says so.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    count: () => pending.size,
    // Runs every callback that is pending now, including the ones a callback schedules (a dismissal
    // animates first, then drops) — until nothing is left, so a test reads like the browser's outcome.
    // A fired timer is gone (as in a browser); only genuinely re-armed ones come back.
    fire() {
      for (let round = 0; round < 10 && pending.size > 0; round++) {
        const batch = [...pending.entries()];
        batch.forEach(([id, { fn }]) => { pending.delete(id); fn(); });
      }
      assertTrue(pending.size === 0, 'timers.fire() left timers pending (a dismissal never ends?)');
    },
    lastMs() {
      const all = [...pending.values()];
      return all.length ? all[all.length - 1].ms : null;
    },
  };
}

function makeToast() {
  const doc = fakeDoc();
  const timers = fakeTimers();
  const cam = T.create({ doc, timers });
  const box = doc.body.children.find((c) => c.id === 'cam-toasts');
  assertTrue(!!box, 'the toast container was not added to the body');
  const texts = () => box.children.map((t) => t.children[0].textContent);
  return { doc, timers, cam, box, texts };
}

(async () => {
  // ── showing ──────────────────────────────────────────────────────
  {
    const { doc, cam, box, texts } = makeToast();
    test('show() puts the message in a container on the body, as TEXT', () => {
      cam.show('Saved.', 'ok');
      assertEqual(texts(), ['Saved.']);
      assertEqual(doc.head.children.filter((c) => c.tagName === 'STYLE').length, 1, 'the look is one <style>');
    });
    test('the toast is announced and its kind shows', () => {
      const t = box.children[0];
      assertEqual(t.attrs['data-kind'], 'ok');
      assertEqual(t.attrs.role, 'status');
      assertEqual(box.attrs['aria-live'], 'polite');
      assertEqual(t.children[1].attrs['aria-label'], 'Dismiss', 'the ✕ has its own label');
    });
  }
  {
    const { doc, cam, box } = makeToast();
    test('a hostile message stays text: no element, no script', () => {
      cam.show('<img src=x onerror="window.__pwned=1"><b>x</b>', 'error');
      const msg = box.children[0].children[0];
      assertEqual(msg.children.length, 0, 'no children were made out of the message');
      assertEqual(msg.textContent, '<img src=x onerror="window.__pwned=1"><b>x</b>');
      assertEqual(box.children[0].attrs.role, 'alert', 'errors are announced assertively');
    });
    test('the look is installed once, even with two instances on one page', () => {
      T.create({ doc, timers: fakeTimers() });
      assertEqual(doc.head.children.filter((c) => c.tagName === 'STYLE').length, 1);
    });
  }
  {
    const { cam, box } = makeToast();
    test('an unknown kind falls back to info', () => {
      cam.show('hello', 'nonsense');
      assertEqual(box.children[0].attrs['data-kind'], 'info');
    });
    test('an empty message shows as an (empty) toast, no throw', () => {
      cam.show();
      assertEqual(box.children[1].children[0].textContent, '');
    });
  }

  // ── going away ───────────────────────────────────────────────────
  {
    const { timers, cam, box } = makeToast();
    test('a toast dismisses itself (info after 8 s, like the old note)', () => {
      cam.show('Loaded.', 'info');
      assertEqual(timers.lastMs(), T.INFO_MS);
      timers.fire();
      assertEqual(box.children.length, 0, 'gone after its time');
    });
    test('an error stays a little longer', () => {
      cam.show('No relay answered', 'error');
      assertEqual(timers.lastMs(), T.ERROR_MS);
    });
    test('a custom time is honoured', () => {
      cam.show('brief', 'info', { ms: 250 });
      assertEqual(timers.lastMs(), 250);
      timers.fire();
      assertEqual(box.children.length, 0);
    });
  }
  {
    const { timers, cam, box } = makeToast();
    test('a click on the toast dismisses it at once and clears its timer', () => {
      cam.show('Sending…', 'busy');
      assertEqual(timers.count(), 1, 'its self-dismiss timer');
      box.children[0].dispatch('click');
      assertEqual(timers.count(), 1, 'the auto timer is gone, only the out-animation is left');
      timers.fire();
      assertEqual(box.children.length, 0);
    });
    test('the ✕ button dismisses and keeps the event to itself', () => {
      cam.show('Reboot requested', 'ok');
      const ev = box.children[0].children[1].dispatch('click');
      assertTrue(ev.stopped, 'stopPropagation was called');
      timers.fire();
      assertEqual(box.children.length, 0);
    });
  }
  {
    const { timers, cam, box } = makeToast();
    test('hovering pauses the countdown; leaving arms it again', () => {
      cam.show('Saved, but check the relay', 'error');
      box.children[0].dispatch('mouseenter');
      assertEqual(timers.count(), 0, 'paused: nothing pending');
      timers.fire();
      assertEqual(box.children.length, 1, 'still shown while hovered');
      box.children[0].dispatch('mouseleave');
      assertEqual(timers.count(), 1, 'armed again');
      timers.fire();
      assertEqual(box.children.length, 0, 'and it goes away on its own');
    });
  }
  {
    const { cam, box, texts } = makeToast();
    test(`at most ${T.MAX_TOASTS} toasts: the oldest drops at once`, () => {
      for (let i = 0; i < T.MAX_TOASTS + 1; i++) cam.show('message ' + i, 'info');
      assertEqual(box.children.length, T.MAX_TOASTS);
      assertEqual(texts()[0], 'message 1', 'message 0 was dropped');
      assertEqual(texts()[texts().length - 1], 'message ' + T.MAX_TOASTS);
    });
    test('a burst of many cannot flood the screen either', () => {
      for (let i = 0; i < 12; i++) cam.show('burst ' + i, 'error');
      assertEqual(box.children.length, T.MAX_TOASTS);
    });
  }

  // ── without a document ───────────────────────────────────────────
  {
    const quiet = T.create({ doc: null });
    test('without a document, show() is a quiet no-op', () => {
      assertTrue(quiet.show('anywhere?', 'ok') === null);
    });
    const plain = T.create();
    test('in plain node (no document global) create() still hands out a safe show()', () => {
      assertTrue(typeof plain.show === 'function');
    });
  }

  summarize();
})();
