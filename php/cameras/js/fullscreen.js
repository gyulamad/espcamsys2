'use strict';
// fullscreen.js — enter or leave full screen for one element. Loaded by the pages as a plain script
// (window.CamFullscreen) and by tests/node/test_fullscreen.js with require(). The document is a parameter,
// so the test needs no browser.
//
// The element that is shown full screen should be a wrapper that holds everything layered on the picture
// (an overlay, a border, ...): only what is inside the full-screen element stays visible.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamFullscreen = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The element that is full screen right now (standard or the old WebKit name), or null.
  function current(doc) {
    return doc.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  // The browser refuses a full-screen request now and then (not allowed here, no user gesture): that
  // is logged and never thrown, the page just stays as it is.
  function logRefusal(result) {
    if (result && typeof result.catch === 'function') result.catch((err) => console.error('Fullscreen failed:', err));
  }

  // Full screen on when `el` is not the full-screen element, off when it is.
  // -> true when a request was made, false when there was nothing to do (no element, no document, or a
  // browser without the full-screen feature).
  function toggle(el, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!el || !d) return false;
    if (current(d) === el) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (!exit) return false;
      logRefusal(exit.call(d));
      return true;
    }
    const request = el.requestFullscreen || el.webkitRequestFullscreen;   // webkit: Safari
    if (!request) return false;
    logRefusal(request.call(el));
    return true;
  }

  return { current, toggle };
});
