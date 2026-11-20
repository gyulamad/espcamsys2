#!/usr/bin/env node
'use strict';
// test_nav_toggle_dom.js — the navigation bar's hamburger (F-42, js/nav-toggle.js) in jsdom, driven
// with a fake matchMedia (no browser, no php needed — only the jsdom package, cd tests/dom && npm install):
//   * wiring puts the ☰ button first into the bar, aria-expanded="false", and marks the bar wired so a
//     second wire() changes nothing
//   * when the media query holds, the bar gets .nav-mobile (its CSS shows the burger and hides the
//     links); a click on the burger opens (.nav-open, aria-expanded="true") and closes; a click outside
//     an open menu closes it, and so does Escape
//   * when the query does not hold (a wide screen, or jsdom's own matchMedia) the bar never gets
//     .nav-mobile: without the behaviour the bar is what it always was
//   * a media-query flip to wide closes an open menu and drops .nav-mobile
//   * without matchMedia at all the DOM is left untouched (wire returns null)
//
//   node tests/dom/test_nav_toggle_dom.js

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const { wire, MQ } = require('../../php/cameras/js/nav-toggle.js');

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}

// A fake matchMedia: the query is remembered, .matches is a settable fact, change listeners are listed
// so a test can flip the viewport class and fire the change by hand.
function fakeMQ(matches) {
  const mq = { matches, listeners: [], addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); } };
  mq.set = (v) => { mq.matches = v; mq.listeners.forEach((fn) => fn()); };
  return mq;
}

function page() {
  const dom = new JSDOM(`<!DOCTYPE html><body><nav class="site-nav" id="site-nav" aria-label="Pages">
    <a class="nav-link" href="#" data-nav="dashboard">DASHBOARD</a>
    <a class="nav-link" href="#" data-nav="all-files">ALL FILES</a>
    <form class="logout-form"><button>LOG OUT</button></form>
  </nav><main id="outside">page</main></body>`, { url: 'http://nav.test/' });
  return dom;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }

  // ── a wide screen: wired, but the bar keeps its old behaviour ────────────────────────────
  {
    const dom = page();
    const nav = dom.window.document.getElementById('site-nav');
    const mq = fakeMQ(false);
    const ctl = wire({ document: dom.window.document, matchMedia: () => mq });
    check('wiring puts the ☰ button first into the bar, labelled and not expanded',
      ctl !== null && nav.firstElementChild === ctl.burger && ctl.burger.textContent === '☰'
        && ctl.burger.getAttribute('aria-expanded') === 'false' && ctl.burger.getAttribute('aria-label') === 'Menu'
        && ctl.burger.getAttribute('aria-controls') === 'site-nav');
    check('a wide screen gets no .nav-mobile and never opens',
      nav.classList.contains('nav-mobile') === false && nav.classList.contains('nav-open') === false);
    ctl.burger.click();
    // the .nav-open class may toggle on a wide screen too — without .nav-mobile it has no effect, the
    // bar shows every link anyway; what matters is that the bar is not in its mobile shape
    check('on a wide screen the bar keeps its old shape (no .nav-mobile, links not hidden)',
      nav.classList.contains('nav-mobile') === false);
    const second = wire({ document: dom.window.document, matchMedia: () => mq });
    check('wiring twice changes nothing (one burger, the second call refuses)',
      second === null && dom.window.document.querySelectorAll('.nav-burger').length === 1);
    dom.window.close();
  }

  // ── a phone: the burger opens and closes, outside clicks and Escape close ────────────────
  {
    const dom = page();
    const doc = dom.window.document;
    const nav = doc.getElementById('site-nav');
    const mq = fakeMQ(true);
    const ctl = wire({ document: doc, matchMedia: () => mq });
    check('a narrow screen marks the bar .nav-mobile', nav.classList.contains('nav-mobile') === true);
    ctl.burger.click();
    check('the burger opens the menu (.nav-open, aria-expanded="true")',
      nav.classList.contains('nav-open') === true && ctl.burger.getAttribute('aria-expanded') === 'true');
    ctl.burger.click();
    check('a second click closes it again',
      nav.classList.contains('nav-open') === false && ctl.burger.getAttribute('aria-expanded') === 'false');
    ctl.burger.click();
    doc.getElementById('outside').click();
    check('a click outside the open menu closes it',
      nav.classList.contains('nav-open') === false && ctl.burger.getAttribute('aria-expanded') === 'false');
    ctl.burger.click();
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Escape closes the open menu', nav.classList.contains('nav-open') === false);
    ctl.burger.click();
    ctl.burger.click();   // a click ON the burger is inside the bar: the outside handler must not fight it
    check('a click on the burger itself toggles, it does not fight the outside-click handler',
      nav.classList.contains('nav-open') === false);
    dom.window.close();
  }

  // ── the viewport flips: the menu closes, the bar drops its mobile class ──────────────────
  {
    const dom = page();
    const nav = dom.window.document.getElementById('site-nav');
    const mq = fakeMQ(true);
    const ctl = wire({ document: dom.window.document, matchMedia: () => mq });
    ctl.burger.click();
    mq.set(false);
    check('flipping the media query to wide closes the menu and drops .nav-mobile',
      nav.classList.contains('nav-open') === false && nav.classList.contains('nav-mobile') === false
        && ctl.burger.getAttribute('aria-expanded') === 'false');
    mq.set(true);
    check('flipping back to narrow re-marks the bar .nav-mobile (closed, as a fresh page)',
      nav.classList.contains('nav-mobile') === true && nav.classList.contains('nav-open') === false);
    dom.window.close();
  }

  // ── no matchMedia (a very old engine): the DOM is left alone ─────────────────────────────
  {
    const dom = page();
    const doc = dom.window.document;
    const r = wire({ document: doc, matchMedia: null });
    check('without matchMedia the wiring refuses and the bar is untouched',
      r === null && doc.querySelectorAll('.nav-burger').length === 0
        && doc.getElementById('site-nav').classList.contains('nav-mobile') === false);
    dom.window.close();
  }

  check('the query the module asks for is the pages\u2019 mobile breakpoint', MQ === '(max-width: 700px)');

  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((err) => { finished = true; console.error(`[FAIL] ${err.stack || err}`); process.exitCode = 1; });
