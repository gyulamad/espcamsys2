// dom_helpers.js — what the jsdom tests in this folder share.

// closeWindow(dom) — closes a jsdom window so that nothing it still has going can crash the test run.
//
// window.close() stops jsdom's animation-frame timer once. But the page is not told it is over: a
// fetch() answer that arrives afterwards (the relay and the PHP server are still shutting down) makes the
// page ask for another frame, jsdom starts a fresh timer on a window that no longer has a document, the
// frame's callback throws, and jsdom's own error report then reads window.location and dies with
// "TypeError: Cannot read properties of null (reading '_location')" — an uncaught exception that fails
// the whole run after every check has passed, on one run in a few. So frames are refused first: a window
// that is being closed does not draw anything any more.
function closeWindow(dom) {
  if (!dom) return;
  dom.window.requestAnimationFrame = () => 0;
  dom.window.close();
}

// pageScriptLoader(jsdom, names) — a resource loader for `new JSDOM(html, { resources })` that loads the named
// scripts of the page (js/<name>, from the PHP server the page came from) and nothing else: no other script, no
// fonts, no pictures, no network beyond the dashboard. Without it jsdom runs only the inline scripts of a page.
// The names are listed on purpose: a script the test does not name is not run (screen-keeper.js, for one, plays a
// video, which jsdom does not implement).
function pageScriptLoader(jsdom, names) {
  const allowed = new Set(names.map((n) => '/js/' + n));
  class PageScriptLoader extends jsdom.ResourceLoader {
    fetch(url, options) {
      return allowed.has(new URL(url).pathname) ? super.fetch(url, options) : null;
    }
  }
  return new PageScriptLoader();
}

module.exports = { closeWindow, pageScriptLoader };
