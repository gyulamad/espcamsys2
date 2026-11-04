'use strict';

// fake_dom.js — just enough of a browser page to run php/cameras/lib/recordings-list.js under plain node
// (no jsdom, no browser, nothing to install): elements with children, classes, dataset, listeners and
// ids, `document.getElementById`, and the two selectors the list uses ('.cls' and '.cls:checked').
// Not a general DOM: anything else throws, so a test never passes on behaviour this file does not model.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.disabled = false;
    this.checked = false;
    this.clicks = 0;
    this.classList = {
      contains: (c) => this.classes().includes(c),
      remove: (c) => { this.className = this.classes().filter((x) => x !== c).join(' '); },
      toggle: (c) => {
        const had = this.classes().includes(c);
        this.className = (had ? this.classes().filter((x) => x !== c) : [...this.classes(), c]).join(' ');
        return !had;
      },
    };
  }

  classes() { return this.className.split(/\s+/).filter(Boolean); }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  appendChild(node) {
    if (typeof node === 'string') { this.textContent += node; return node; }
    if (node.parent) node.remove();
    node.parent = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => { c.parent = null; });
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ type, target: this })); }
  // A click runs the listeners, as a browser does (a checkbox flips first and fires "change").
  click() {
    this.clicks += 1;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatch('change');
    }
    this.dispatch('click');
  }

  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector) {
    const m = /^\.([\w-]+)(:checked)?$/.exec(selector);
    if (!m) throw new Error(`fake DOM does not model the selector ${selector}`);
    return this.descendants().filter((e) => e.classes().includes(m[1]) && (!m[2] || e.checked));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  text() { return this.textContent + this.children.map((c) => c.text()).join(''); }
}

function createFakeDocument() {
  const body = new FakeElement('body');
  return {
    body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => body.descendants().find((e) => e.id === id) || null,
    // Document-level listeners (the picture viewer closes on Escape); key(name) is a key press.
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    key(name) { [...(this.listeners.keydown || [])].forEach((fn) => fn({ type: 'keydown', key: name })); },
  };
}

module.exports = { FakeElement, createFakeDocument };
