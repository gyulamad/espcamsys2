'use strict';
// toast.js — the dashboard's toast popups (F-12): the short result messages of the buttons
// (REBOOT, the recording switch, APPLY of the settings pages, ...) used to be printed in a span
// next to the button, where a longer message broke the surrounding UI into extra lines. They are
// shown as stacked toasts in a corner of the window now, and this file is the ONE implementation.
//
// Loaded by the pages as a plain script (window.CamToast) and by tests/node/test_toast.js with
// require(); the browser's objects and timers are parameters, so the test needs no browser.
//
//   CamToast.show('Saved.', 'ok')        kinds: 'ok' | 'info' | 'busy' | 'error' (default 'info')
//   CamToast.show(text, kind, { ms })    ms: how long it stays (default below)
//
// Behaviour, kept deliberately small:
//   - a message is TEXT: it is set with textContent, so whatever the relay or config.php put in
//     it can never become markup or script (the page rule of security review F-05);
//   - a toast dismisses itself after a few seconds — the old .switch-note cleared itself after
//     8 s, so 8 s it is; errors stay a little longer;
//   - hovering a toast pauses its countdown, so a long message can be read in peace;
//   - a click anywhere on it dismisses it at once (the ✕ is there to make that discoverable);
//   - at most MAX_TOASTS are shown: a new message drops the oldest at once, so a burst of
//     failures (a RELOAD ALL while the relay is down, say) cannot flood the screen;
//   - the container is an aria-live region, so a screen reader announces what appears: politely
//     for the usual messages, assertively (role="alert") for errors;
//   - it never throws: without a usable document there is nowhere to show anything, and show()
//     returns quietly.
//
// The look is injected as one <style> here, so a page needs no CSS of its own for the toasts and
// every page shows them the same. The colours are the dashboard palette's literals (the pages'
// CSS variables differ slightly, and a toast must not change with the page it pops up on).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamToast = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_TOASTS = 4;        // visible at once; a new one drops the oldest
  const INFO_MS = 8000;        // the .switch-note cleared itself after 8 s — kept as the default
  const ERROR_MS = 12000;      // errors stay a little longer, they are the ones worth reading twice
  const OUT_MS = 150;          // the out-animation, before the element leaves the DOM
  const KINDS = { ok: 'ok', info: 'info', busy: 'busy', error: 'error' };
  const DEFAULT_KIND = 'info';

  const STYLE = [
    '#cam-toasts { position: fixed; top: 12px; right: 12px; z-index: 1000; display: flex; flex-direction: column; gap: 8px;',
    '  width: min(360px, calc(100vw - 24px)); pointer-events: none; }',
    '.cam-toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 8px;',
    '  background: #111520; color: #cdd8f0; border: 1px solid #3c4d80; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.45);',
    '  padding: 9px 10px 9px 12px; font-family: ui-monospace, monospace; font-size: .72rem; line-height: 1.45;',
    '  letter-spacing: .02em; cursor: pointer; animation: cam-toast-in .18s ease-out; }',
    '.cam-toast .cam-toast-msg { flex: 1 1 auto; overflow-wrap: anywhere; white-space: pre-line; }',
    '.cam-toast .cam-toast-x { flex: 0 0 auto; background: transparent; border: 0; color: #7c8ab0; font: inherit;',
    '  cursor: pointer; padding: 0 2px; line-height: inherit; }',
    '.cam-toast .cam-toast-x:hover, .cam-toast .cam-toast-x:focus-visible { color: #cdd8f0; outline: none; }',
    '.cam-toast[data-kind="ok"]    { border-color: #1a4d3a; color: #2dd67b; }',
    '.cam-toast[data-kind="info"]  { border-color: #3c4d80; }',
    '.cam-toast[data-kind="busy"]  { border-color: #6b4a14; color: #ffb020; }',
    '.cam-toast[data-kind="error"] { border-color: #7a2e3a; color: #ff4f5e; }',
    '.cam-toast.cam-toast-out { animation: cam-toast-out .15s ease-in forwards; }',
    '@keyframes cam-toast-in  { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }',
    '@keyframes cam-toast-out { to { opacity: 0; transform: translateY(-6px); } }',
    '@media (prefers-reduced-motion: reduce) { .cam-toast, .cam-toast.cam-toast-out { animation: none; } }',
  ].join('\n');

  // The style goes in once per document. head may be missing (a minimal fake): body is fine too.
  function installStyle(doc) {
    const host = doc.head || doc.body;
    if (!host || host.querySelector('style[data-cam-toast]')) return;
    const style = doc.createElement('style');
    style.setAttribute('data-cam-toast', '');
    style.textContent = STYLE;
    host.appendChild(style);
  }

  function kindOf(kind) {
    return KINDS[kind] || DEFAULT_KIND;
  }

  function removeFromDom(el) {
    if (typeof el.remove === 'function') { el.remove(); return; }
    const p = el.parentNode || el.parent;
    if (p && typeof p.removeChild === 'function') p.removeChild(el);
  }

  function create({ doc, timers } = {}) {
    const docObj = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
    const setTimeoutFn = (timers && timers.setTimeout) || ((fn, ms) => setTimeout(fn, ms));
    const clearTimeoutFn = (timers && timers.clearTimeout) || ((id) => clearTimeout(id));
    if (!docObj || !docObj.body) {
      return { show: () => null };   // nowhere to show: stay quiet, the message is lost but nothing breaks
    }
    installStyle(docObj);

    const box = docObj.createElement('div');
    box.id = 'cam-toasts';
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', 'Notifications');
    docObj.body.appendChild(box);

    const live = [];   // the toasts still on the screen, oldest first

    // Out of the DOM at once, with no animation (its timer included): the cap and the dismissals
    // all end here, so a toast cannot linger half-dismissed.
    function hardDrop(toast) {
      toast.dismissed = true;
      if (toast.timer) clearTimeoutFn(toast.timer);
      toast.timer = null;
      const i = live.indexOf(toast);
      if (i !== -1) live.splice(i, 1);
      removeFromDom(toast.el);
    }

    // The usual way to go: a short out-animation first, then hardDrop.
    function dismiss(toast) {
      if (toast.dismissed) return;
      if (toast.timer) clearTimeoutFn(toast.timer);
      toast.timer = null;
      try {
        toast.el.classList.add('cam-toast-out');
        setTimeoutFn(() => hardDrop(toast), OUT_MS);
      } catch (e) {
        hardDrop(toast);
      }
    }

    function show(message, kind, opts) {
      const el = docObj.createElement('div');
      el.className = 'cam-toast';
      el.setAttribute('data-kind', kindOf(kind));
      el.setAttribute('role', kindOf(kind) === 'error' ? 'alert' : 'status');

      const msg = docObj.createElement('span');
      msg.className = 'cam-toast-msg';
      msg.textContent = String(message === undefined || message === null ? '' : message);   // text, never markup
      el.appendChild(msg);

      const x = docObj.createElement('button');
      x.className = 'cam-toast-x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '✕';
      el.appendChild(x);

      const life = Object.assign({ ms: kindOf(kind) === 'error' ? ERROR_MS : INFO_MS }, opts || {});
      const toast = { el, timer: null, dismissed: false };
      const arm = () => { if (!toast.timer && !toast.dismissed) toast.timer = setTimeoutFn(() => dismiss(toast), life.ms); };
      const pause = () => { if (toast.timer) { clearTimeoutFn(toast.timer); toast.timer = null; } };

      x.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); dismiss(toast); });
      el.addEventListener('click', () => dismiss(toast));
      el.addEventListener('mouseenter', pause);
      el.addEventListener('mouseleave', arm);

      // The oldest makes room NOW (no animation: the cap is about what is on the screen).
      while (live.length >= MAX_TOASTS) hardDrop(live[0]);

      live.push(toast);
      box.appendChild(el);
      arm();
      return el;
    }

    return { show };
  }

  // The instance the pages use (lazily, so requiring the file where there is no DOM stays harmless).
  let shared = null;
  function sharedInstance() {
    if (!shared) shared = create();
    return shared;
  }

  return {
    create,
    MAX_TOASTS,
    INFO_MS,
    ERROR_MS,
    show(message, kind, opts) { return sharedInstance().show(message, kind, opts); },
  };
});
