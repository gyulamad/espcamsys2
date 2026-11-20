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
//
// A fetch() answer that lands after the close has a second way to kill the run that refusing frames does
// not stop: the page's own .then or .catch runs, and on a closed window `document` and `window.location`
// are undefined (close() empties window._document, which both getters read; every other global survives).
// The settings search's "the index could not be loaded" handler, for one, then dies building its note —
// "Cannot read properties of undefined (reading 'createElement')" — and the suite ends without its
// summary. Which of the two happens is a race: it is one run in a few here, more on slower machines and
// older Node, never on the fastest. So the document is captured before the close and handed back after
// it: the object itself stays fully usable on a closed window (createElement works, writes to its
// location are ignored), and whatever the page still wants to do to "the page" happens there — nothing
// it does can throw.
function closeWindow(dom) {
  if (!dom) return;
  dom.window.requestAnimationFrame = () => 0;
  const document = dom.window.document;
  dom.window.close();
  dom.window._document = document;
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
