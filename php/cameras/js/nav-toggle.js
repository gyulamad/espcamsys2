'use strict';
// nav-toggle.js — the navigation bar's hamburger on a phone (F-42): on a narrow screen the bar shows
// the ☰ button only, and opening it stacks the pages' links below it (LOG OUT at the end), so one
// small icon stands in for a bar that would otherwise scroll sideways under a thumb. Without
// JavaScript nothing changes: the bar stays what it always was (every link visible, scrolling when it
// must), because the burger and the mobile behaviour are put in place here, by script — the same
// progressive pattern as the camera settings page's .is-mobile class.
//
// Loaded as a plain script (window.CamNavToggle) from CamLayout::navBar(), which emits it right after
// the bar it belongs to, on every page that has the bar. wire() is pure enough to be driven from a
// test with an injected matchMedia; on the page the default is the window's.
//
//   CamNavToggle.wire({ document })                      — the page's one call
//   CamNavToggle.wire({ document, matchMedia })          — a test's call, with a fake matchMedia

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamNavToggle = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // What "narrow" means. The pages' own media queries fold at the same width, so the whole dashboard
  // goes mobile together.
  const MQ = '(max-width: 700px)';

  function wire(env) {
    const doc = env.document;
    const nav = doc.getElementById('site-nav') || doc.querySelector('.site-nav');
    const mqFn = env.matchMedia
      || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null);
    if (!nav || !mqFn || nav.dataset.navToggle) return null;   // no bar, no media queries, or already wired
    nav.dataset.navToggle = '1';
    const mq = mqFn(MQ);

    const burger = doc.createElement('button');
    burger.type = 'button';
    burger.className = 'nav-burger';
    burger.textContent = '☰';
    burger.setAttribute('aria-label', 'Menu');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-controls', 'site-nav');
    nav.insertBefore(burger, nav.firstChild);

    const setOpen = (open) => {
      nav.classList.toggle('nav-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const isOpen = () => nav.classList.contains('nav-open');
    burger.addEventListener('click', () => { setOpen(!isOpen()); });
    // a click outside an open menu closes it, and so does Escape: the menu must not trap the page
    doc.addEventListener('click', (ev) => {
      if (isOpen() && !nav.contains(ev.target)) setOpen(false);
    });
    doc.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && isOpen()) setOpen(false);
    });

    const apply = () => {
      nav.classList.toggle('nav-mobile', mq.matches);
      if (!mq.matches) setOpen(false);   // back on a wide screen the bar is open by definition
    };
    apply();
    // matchMedia grew addEventListener; the older addListener is what lingering Safari versions have
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    else if (typeof mq.addListener === 'function') mq.addListener(apply);

    return { burger, isOpen, setOpen, apply };
  }

  return { wire, MQ };
});
