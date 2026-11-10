'use strict';
// busy.js — the visual confirmation of a click, for every page. Two kinds of wait:
//
//   a button that works in the background (a request is on its way: BROWSE ARCHIVE, SAVE, RECORD ALL, ...) gets a
//   little rolling spinner in front of its text until the work is done:      CamBusy.run(button, () => doTheWork())
//
//   a click that replaces the whole page (the navigation bar, LOG OUT, a link to another page, a redirect after a save)
//   puts a full-screen cover with a spinner over the page until the next one has loaded. The links and forms that do it
//   say so with a `data-page-load` attribute (its value, when it has one, is the cover's text: "Logging out…"; the
//   default is "Loading…") — CamLayout::pageLoadAttr(). A link that does NOT open a page (a download, a new tab) has
//   no such attribute, so the cover never waits for a page that does not come. From script: CamBusy.navigate(url).
//
// Looks: CamLayout::busyStyle(), on every page. Loaded by the pages as a plain script (window.CamBusy, which also starts
// watching the page's links and forms) and by the tests with require() (create(), with a stand-in for the page).

(function (root, factory) {
  const api = { create: factory };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    root.CamBusy = factory({ document, window });
    root.CamBusy.watchNavigation();
  }
})(typeof self !== 'undefined' ? self : this, function create(env, options = {}) {
  const BUSY_CLASS = 'is-busy';
  const COVER_ID = 'page-busy';
  const PAGE_ATTR = 'data-page-load';
  const DEFAULT_TEXT = 'Loading…';
  // A page that has not come after this long (the visitor pressed Stop, the network is gone) gives the window back.
  const GIVE_UP_MS = options.giveUpMs === undefined ? 30000 : options.giveUpMs;
  const NOT_A_PAGE = /^(javascript|mailto|tel|blob|data):/i;

  const doc = env.document;
  const win = env.window;
  const working = new WeakMap();   // button -> the promise of the work it is busy with
  let cover = null;
  let textEl = null;
  let giveUpTimer = null;

  // ── The button ──────────────────────────────────────────────────────

  function mark(button, busy) {
    button.classList.toggle(BUSY_CLASS, busy);
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  // Runs `work` (a function returning a promise, or a promise) and shows the spinner on `button` meanwhile; gives back
  // what the work gives back (or throws what it throws) and always takes the spinner away. A click on a button that is
  // still busy does not start the work again: it gets the first run's promise. No button: the work just runs.
  async function run(button, work) {
    const start = () => (typeof work === 'function' ? work() : work);
    if (!button) return start();
    if (working.has(button)) return working.get(button);
    mark(button, true);
    const job = (async () => start())();
    working.set(button, job);
    try {
      return await job;
    } finally {
      working.delete(button);
      mark(button, false);
    }
  }

  // ── The page ────────────────────────────────────────────────────────

  // The cover is made when it is first needed (nothing to put on a page that never navigates).
  function ensureCover() {
    if (cover) return cover;
    const spinner = doc.createElement('span');
    spinner.className = 'busy-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    textEl = doc.createElement('span');
    textEl.className = 'page-busy-text';
    cover = doc.createElement('div');
    cover.id = COVER_ID;
    cover.className = 'page-busy';
    cover.setAttribute('role', 'status');
    cover.setAttribute('aria-live', 'polite');
    cover.hidden = true;
    cover.append(spinner, textEl);
    doc.body.appendChild(cover);
    return cover;
  }

  function hidePage() {
    win.clearTimeout(giveUpTimer);
    giveUpTimer = null;
    if (cover) cover.hidden = true;
  }

  // Covers the page with the spinner and `text`. If the next page does not come in time, the cover goes again.
  function showPage(text) {
    ensureCover();
    textEl.textContent = text || DEFAULT_TEXT;
    cover.hidden = false;
    win.clearTimeout(giveUpTimer);
    if (GIVE_UP_MS > 0) giveUpTimer = win.setTimeout(hidePage, GIVE_UP_MS);
  }

  // Goes to `url` in this window, with the cover over the page until it has loaded.
  function navigate(url, text) {
    showPage(text);
    win.location.assign(url);
  }

  // Does this click on `link` replace the page? Only a plain left click on a link that says so (data-page-load) and
  // that opens in this window, is not a download and does not just move within the page.
  function opensPage(ev, link) {
    if (ev.defaultPrevented || (ev.button || 0) !== 0) return false;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return false;   // a new tab / window / download
    const target = link.getAttribute('target');
    if (target && target !== '_self') return false;
    if (link.hasAttribute('download')) return false;
    const href = link.getAttribute('href');
    return !!href && href[0] !== '#' && !NOT_A_PAGE.test(href);
  }

  function labelOf(el) {
    return el.getAttribute(PAGE_ATTR) || DEFAULT_TEXT;
  }

  // One listener for every link and form of the page, however and whenever it was drawn.
  function watchNavigation() {
    doc.addEventListener('click', (ev) => {
      const link = ev.target && ev.target.closest ? ev.target.closest('a[' + PAGE_ATTR + ']') : null;
      if (link && opensPage(ev, link)) showPage(labelOf(link));
    });
    doc.addEventListener('submit', (ev) => {
      const form = ev.target && ev.target.closest ? ev.target.closest('form[' + PAGE_ATTR + ']') : null;
      if (form && !ev.defaultPrevented) showPage(labelOf(form));
    });
    // Back to a page the browser kept (back / forward): it is not loading, whatever it showed when it was left.
    win.addEventListener('pageshow', (ev) => { if (ev.persisted) hidePage(); });
  }

  return { run, showPage, hidePage, navigate, watchNavigation };
});
