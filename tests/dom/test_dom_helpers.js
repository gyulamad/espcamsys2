// test_dom_helpers.js — closeWindow() in dom_helpers.js really makes a closed window safe: a page that asks
// for an animation frame after its window was closed (a late fetch() answer) must neither crash the process
// (jsdom bug: "Cannot read properties of null (reading '_location')") nor get a frame drawn; and the
// page's own .then/.catch of that same late answer must not die either — on a closed window `document`
// and `window.location` are undefined, so a handler that builds DOM ("the index could not be loaded",
// say) used to end the run with "Cannot read properties of undefined (reading 'createElement')" instead.
//
// Usage:  node tests/dom/test_dom_helpers.js        Exit code: 0 if every check passed, 1 otherwise.

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const { closeWindow } = require('./dom_helpers');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Closes a window with `close`, then does what a late fetch() answer does to the page: asks for a frame
// whose callback reads the document. Reports whether the process survived and whether the frame was drawn.
async function lateFrameAfter(close) {
  const crashes = [];
  const onCrash = (e) => crashes.push(String(e && e.message || e));
  process.on('uncaughtException', onCrash);
  let drawn = false;
  try {
    const dom = new JSDOM('<body><div class="row"></div></body>', { pretendToBeVisual: true });
    const w = dom.window;
    close(dom);
    w.requestAnimationFrame(() => { drawn = true; w.document.querySelectorAll('.row'); });
    await sleep(150);   // several 60 Hz frames
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
  return { crashes, drawn };
}

// Closes a window with `close`, then does what a late fetch() answer's .then does to the page: reads the
// document and its location. Reports whether the process survived and whether the callback ran to its end.
async function lateCallbackAfter(close) {
  const crashes = [];
  const onCrash = (e) => crashes.push(String(e && e.message || e));
  process.on('uncaughtException', onCrash);
  let ran = false;
  try {
    const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:9/', pretendToBeVisual: true });
    const w = dom.window;
    close(dom);
    try {
      await Promise.resolve().then(() => { w.document.createElement('div'); ran = String(w.location.href) === 'http://127.0.0.1:9/'; });
    } catch (e) { crashes.push(String(e && e.message || e)); }   // a throw here rejects the chain — it never reaches the process handler
    await sleep(50);
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
  return { crashes, ran };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }

  const safe = await lateFrameAfter(closeWindow);
  check('a frame asked for after closeWindow() does not crash the process', safe.crashes.length === 0, safe.crashes.join(' | '));
  check('...and is never drawn', safe.drawn === false);

  // closeWindow(null) is what the tests call when the setup failed before the window existed.
  let threw = false;
  try { closeWindow(null); closeWindow(undefined); } catch (e) { threw = true; }
  check('closeWindow() with no window is a no-op', threw === false);

  // The window is really closed — jsdom has taken the live document away — and the page is left with the
  // detached document handed back (the same object it had all along), so anything it still runs finds a
  // page that answers instead of nothing. (jsdom has no window.closed; the document is the observable.)
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const page = dom.window.document;
  closeWindow(dom);
  check('closeWindow() hands the closed window its document back, still usable',
    dom.window.document === page && typeof dom.window.document.createElement === 'function');
  let twice = false;
  try { closeWindow(dom); } catch (e) { twice = true; }
  check('closing twice is harmless', twice === false);

  // The second way a late fetch() answer used to kill the run: through the page's own .then or .catch, not
  // a frame. With the plain close() this still crashes jsdom — if a newer jsdom stops doing that too, this
  // check fails and closeWindow() can be retired.
  const alive = await lateCallbackAfter(closeWindow);
  check('a page .then/.catch running after closeWindow() does not crash the process', alive.crashes.length === 0, alive.crashes.join(' | '));
  check('...and runs to its end against the handed-back document', alive.ran === true);
  const plainCallback = await lateCallbackAfter((d) => d.window.close());
  check('(the reason it exists) a plain window.close() lets that late callback crash jsdom too', plainCallback.crashes.length > 0, 'jsdom no longer crashes: closeWindow() may not be needed any more');
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
main();
