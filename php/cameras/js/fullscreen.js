'use strict';
// fullscreen.js — enter or leave full screen for one element. Loaded by the pages as a plain script
// (window.CamFullscreen) and by tests/node/test_fullscreen.js with require(). The document is a parameter,
// so the test needs no browser.
//
// The element that is shown full screen should be a wrapper that holds everything layered on the picture
// (an overlay, a border, ...): only what is inside the full-screen element stays visible. What stays visible
// is the caller's choice: the simple view shows its picture box (the picture alone) or the whole page
// (document.documentElement: the picture and the status line).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamFullscreen = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The element that is full screen right now (standard or the old WebKit name), or null.
  function current(doc) {
    return doc.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  // The document to work on: the one given, else the page's own (null in node, where there is none).
  function documentOf(doc) {
    return doc || (typeof document !== 'undefined' ? document : null);
  }

  // The browser refuses a full-screen request now and then (not allowed here, no user gesture): that
  // is logged and never thrown, the page just stays as it is.
  function logRefusal(result) {
    if (result && typeof result.catch === 'function') result.catch((err) => console.error('Fullscreen failed:', err));
  }

  // Whether the browser can show `el` full screen at all (the standard name or the old WebKit one): a page
  // offers a full-screen button only where it would do something.
  function supported(el) {
    return !!el && !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  // Calls `handler` each time the full-screen element changes: entered, left, switched to another element, or
  // ended by the browser itself (Esc). Both event names are listened to; a browser that sends both calls the
  // handler twice, so it must be safe to repeat.
  // -> true when listening, false when there was nothing to listen to (no document).
  function watch(handler, doc) {
    const d = documentOf(doc);
    if (!d || typeof d.addEventListener !== 'function') return false;
    d.addEventListener('fullscreenchange', handler);
    d.addEventListener('webkitfullscreenchange', handler);   // Safari
    return true;
  }

  // Full screen on when `el` is not the full-screen element, off when it is.
  // -> true when a request was made, false when there was nothing to do (no element, no document, or a
  // browser without the full-screen feature).
  function toggle(el, doc) {
    const d = documentOf(doc);
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

  return { current, supported, watch, toggle };
});
