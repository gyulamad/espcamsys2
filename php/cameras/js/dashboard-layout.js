'use strict';
// dashboard-layout.js — the dashboard's grid / list layout, switched by the DASHBOARD GRID and DASHBOARD LIST
// links of the navigation bar. Loaded by index.php as a plain script (window.CamDashboardLayout) and by
// tests/node/test_dashboard_layout.js with require().
//
// The links are real links (./?layout=grid and ./?layout=list), so they work without JavaScript. With it, a
// click on one switches the layout in place (no reload, the live pictures keep running) and the browser
// remembers the choice (localStorage 'esp32-layout'). An address with ?layout= wins over what was remembered.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamDashboardLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MODES = ['grid', 'list'];
  const STORAGE_KEY = 'esp32-layout';
  const KEY_PREFIX = 'dashboard-';   // the navigation bar's key of a link: dashboard-grid, dashboard-list

  const isMode = (value) => MODES.includes(value);

  // The layout to show: the one in the address (?layout=), else the remembered one, else the grid.
  function resolve(search, saved) {
    const asked = new URLSearchParams(String(search || '')).get('layout');
    if (isMode(asked)) return asked;
    return isMode(saved) ? saved : 'grid';
  }

  // The mode a navigation key stands for ('dashboard-list' -> 'list'), or null for any other key.
  function modeOfKey(key) {
    const mode = String(key || '').startsWith(KEY_PREFIX) ? String(key).slice(KEY_PREFIX.length) : null;
    return isMode(mode) ? mode : null;
  }

  // The remembered layout; storage can be blocked (private window), then nothing is remembered.
  function remembered(storage) {
    try { return storage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function remember(storage, mode) {
    try { storage.setItem(STORAGE_KEY, mode); } catch (e) { /* not remembered: the layout still switches */ }
  }

  // Shows `mode`: the grid gets or loses its list class and the navigation bar marks the matching link.
  function apply(doc, mode) {
    const grid = doc.getElementById('grid');
    if (grid) grid.classList.toggle('layout-list', mode === 'list');
    doc.querySelectorAll('[data-nav^="' + KEY_PREFIX + '"]').forEach((link) => {
      const current = modeOfKey(link.dataset.nav) === mode;
      link.classList.toggle('current', current);
      if (current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  // Wires the page: the starting layout, and the links' clicks. `env`: { document, location, history, storage }
  // (the page's own by default). A click with a modifier key (new tab) or not with the main button is left to the browser.
  function wire(env) {
    const doc = env.document;
    const links = Array.from(doc.querySelectorAll('[data-nav^="' + KEY_PREFIX + '"]'));
    apply(doc, resolve(env.location.search, remembered(env.storage)));
    for (const link of links) {
      link.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const mode = modeOfKey(link.dataset.nav);
        if (mode === null) return;
        e.preventDefault();
        apply(doc, mode);
        remember(env.storage, mode);
        try { env.history.replaceState(null, '', './?layout=' + mode); } catch (e2) { /* the address just stays */ }
      });
    }
  }

  return { MODES, resolve, modeOfKey, apply, wire };
});
