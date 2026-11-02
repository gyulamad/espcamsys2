'use strict';

// test_simple_glue.js — the page scripts of the simple camera pages (php/cameras/js/simple-view.js and
// simple-list.js) run against a tiny hand-made DOM, a fake relay (fetch), fake timers and a fake clock:
// no browser, no jsdom, nothing to install. The rules themselves are tested in test_simple_logic.js; this
// checks that the pages are wired to them: pager, status line, recording indicator, slideshow, retry.

const path = require('path');
const { assertEqual, assertTrue } = require('./framework');

// The shared test() is synchronous; these tests wait for promises, so they run one after the other here,
// reported the way the shared runner reports.
const queue = [];
const cleanups = [];   // put the real globals back after each test
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of queue) {
    try { await fn(); pass += 1; console.log(`[PASS] ${name}`); } catch (err) { fail += 1; console.error(`[FAIL] ${name} -- ${err.message}`); }
    while (cleanups.length) cleanups.pop()();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

const JS = path.join(__dirname, '../../php/cameras/js');
const CamSimple = require(path.join(JS, 'simple-logic.js'));

const CAMS = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];
const flush = () => new Promise((r) => setImmediate(r));

// One element: what the scripts touch of it, and a way for the test to fire its events.
function makeEl(extra) {
  const listeners = {};
  const classes = new Set();
  return Object.assign({
    textContent: '', className: '', src: '', alt: '', dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    attrs: {}, children: [], offsetHeight: 40,
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
  }, extra);
}

// A page environment. `relay`: what status.php / detector-status.php answer (mutable by the test; null = failed).
function makeEnv({ cameras = CAMS, current = 'a', seconds = 10, dataCameras } = {}) {
  const env = { now: 1000000, intervals: [], timeouts: [], urls: [], relay: { status: {}, detectors: {} }, clockWindow: {} };
  const els = {};
  for (const id of ['view', 'picture', 'prev', 'next', 'slideshow', 'clock', 'cam-name', 'rec']) els[id] = makeEl();
  els.view.dataset = {
    cameras: dataCameras !== undefined ? dataCameras : JSON.stringify(cameras), current, slideshowSeconds: String(seconds),
  };
  env.els = els;
  const docListeners = {};
  env.document = {
    title: '', getElementById: (id) => els[id] || null, querySelector: () => null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    documentElement: { clientWidth: 1000 },
  };
  env.key = (key) => (docListeners.keydown || []).forEach((fn) => fn({ key }));
  env.history = { replaced: [], replaceState(a, b, url) { this.replaced.push(url); } };
  env.fetch = async (url) => {
    env.urls.push(url);
    const answer = url === 'status.php' ? env.relay.status : env.relay.detectors;
    if (answer === 'http-error') return { ok: false, json: async () => ({}) };
    if (answer === null) throw new Error('relay unreachable');
    return { ok: true, json: async () => answer };
  };
  return env;
}

// Puts the environment in place of the browser's globals; returns the function that puts them back.
// Timers are captured (the test fires them), and Date.now is the environment's own clock.
function install(env) {
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = v; };
  set('window', env.window);
  set('document', env.document);
  set('history', env.history);
  set('fetch', env.fetch);
  set('setInterval', (fn, ms) => { env.intervals.push({ fn, ms }); return env.intervals.length; });
  set('setTimeout', (fn, ms) => { const t = { fn, ms, cleared: false }; env.timeouts.push(t); return t; });
  set('clearTimeout', (t) => { if (t) t.cleared = true; });
  const realNow = Date.now;
  Date.now = () => env.now;
  return () => {
    Date.now = realNow;
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, saved[k]); }
  };
}

// Runs the page script `file` in the environment, which then stays in place (as a page's globals do)
// until the test is over.
function load(env, file) {
  env.windowListeners = {};
  env.window = { CamSimple, innerHeight: 800, addEventListener(type, fn) { (env.windowListeners[type] = env.windowListeners[type] || []).push(fn); } };
  cleanups.push(install(env));
  delete require.cache[require.resolve(path.join(JS, file))];
  require(path.join(JS, file));
  // Later happenings (a timer fires, a poll) run in the same environment, then let promises settle.
  env.run = async (fn) => { await fn(); await flush(); await flush(); };
  env.interval = (ms) => env.intervals.filter((i) => i.ms === ms);
  env.advance = (ms, ticks = 1) => env.run(async () => {
    for (let i = 0; i < ticks; i += 1) { env.now += ms; for (const t of env.interval(1000)) await t.fn(); }
  });
  env.poll = () => env.run(async () => { for (const t of env.interval(2000)) await t.fn(); });
  return env;
}

const started = async (opts) => {
  const env = load(makeEnv(opts), 'simple-view.js');
  await env.run(async () => {});
  return env;
};

// ── simple-view.js ───────────────────────────────────────────────────

test('view: starts on the camera of the page, with its name and the clock', async () => {
  const env = await started({ current: 'b' });
  assertTrue(/^\d\d:\d\d:\d\d$/.test(env.els.clock.textContent), env.els.clock.textContent);
});

test('view: the status line shows the recording state of the CURRENT camera: ON / off / unknown', async () => {
  const env = await started({ current: 'a' });
  env.relay.status = { a: { recording: true }, b: { recording: false } };
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: ON');
  assertEqual(env.els.rec.className, 'rec-on');
  env.els.next.fire('click');
  assertEqual(env.els.rec.textContent, 'RECORDING: off');
  assertEqual(env.els.rec.className, 'rec-off');
  env.relay.status = null;   // the relay cannot be reached: unknown, not "off"
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
});

test('view: asks status.php and detector-status.php, and an HTTP error answer is treated as unknown', async () => {
  const env = await started();
  assertTrue(env.urls.includes('status.php') && env.urls.includes('detector-status.php'), env.urls.join());
  env.relay.status = 'http-error';
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
  env.relay.status = { error: 'Could not reach relay' };   // an error-shaped answer is no status
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
  env.relay.status = [];                                   // neither is an array
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
});

test('view: NEXT and PREV switch the picture, the name, the title and the address, wrapping around', async () => {
  const env = await started({ current: 'a' });
  env.els.next.fire('click');
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  assertEqual(env.els['cam-name'].textContent, 'Beta');
  assertEqual(env.document.title, 'Beta — ESP32-CAM Dashboard');
  assertEqual(env.history.replaced.pop(), 'simple-view.php?cam=b');
  env.els.prev.fire('click');
  env.els.prev.fire('click');
  assertEqual(env.els.picture.src, 'stream.php?cam=c');   // wrapped from the first to the last
  env.els.next.fire('click');
  assertEqual(env.els.picture.src, 'stream.php?cam=a');
  assertEqual(env.els.picture.alt, 'Alpha');
});

test('view: the arrow keys page too, other keys do nothing', async () => {
  const env = await started({ current: 'a' });
  env.key('ArrowRight');
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  env.key('ArrowLeft');
  assertEqual(env.els.picture.src, 'stream.php?cam=a');
  env.key('Enter');
  assertEqual(env.els.picture.src, 'stream.php?cam=a');
});

test('view: a camera id is URL-encoded in the stream address', async () => {
  const env = await started({ cameras: [{ id: 'a', name: 'A' }, { id: 'x y&z', name: 'Z' }] });
  env.els.next.fire('click');
  assertEqual(env.els.picture.src, 'stream.php?cam=x%20y%26z');
});

test('view: SLIDESHOW button turns the slideshow on and off and says so', async () => {
  const env = await started();
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'true');
  assertTrue(env.els.slideshow.classList.contains('on'));
  assertTrue(/ON/.test(env.els.slideshow.textContent), env.els.slideshow.textContent);
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'false');
  assertTrue(!env.els.slideshow.classList.contains('on'));
  assertTrue(!/ON/.test(env.els.slideshow.textContent));
});

test('view: without the slideshow the picture never changes by itself', async () => {
  const env = await started();
  env.relay.status = { c: { recording: true } };
  await env.poll();
  await env.advance(1000, 60);
  assertEqual(env.els.picture.src, '');   // never set: still the page's own first picture
});

test('view: the slideshow moves to the next camera after the time of the setting', async () => {
  const env = await started({ seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 4);
  assertEqual(env.els.picture.src, '');
  await env.advance(1000, 1);
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=c');
});

test('view: a camera that starts recording is shown at once, at the next look at the relay', async () => {
  const env = await started({ seconds: 60 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 2);
  assertEqual(env.els.picture.src, '');
  env.relay.status = { c: { recording: true } };
  await env.poll();
  assertEqual(env.els.picture.src, 'stream.php?cam=c');
  assertEqual(env.els.rec.textContent, 'RECORDING: ON');
});

test('view: motion from a paired person detector is shown at once, but not instead of a recording camera', async () => {
  const env = await started({ seconds: 60 });
  env.els.slideshow.fire('click');
  env.relay.detectors = { b: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } } };
  await env.poll();
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  env.relay.status = { b: { recording: true } };
  env.relay.detectors = { b: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } }, c: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } } };
  await env.poll();
  assertEqual(env.els.picture.src, 'stream.php?cam=b', 'motion on c does not pull the view away from the recording b');
});

test('view: with cameras recording, the slideshow skips the ones that do not', async () => {
  const env = await started({ current: 'a', seconds: 5 });
  env.relay.status = { a: { recording: true }, c: { recording: true } };
  env.els.slideshow.fire('click');
  await env.poll();
  assertEqual(env.els.picture.src, 'stream.php?cam=c');   // c has just started recording: shown at once
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=a');   // b is skipped
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=c');
});

test('view: PREV / NEXT during a slideshow give that camera a full time', async () => {
  const env = await started({ seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 4);
  env.els.next.fire('click');                  // the viewer goes to b with 1 s left on a
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  await env.advance(1000, 4);
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  await env.advance(1000, 1);
  assertEqual(env.els.picture.src, 'stream.php?cam=c');
});

test('view: a broken picture stream is opened again a little later, once however often it fails', async () => {
  const env = await started({ current: 'b' });
  env.els.picture.fire('error');
  env.els.picture.fire('error');
  const live = env.timeouts.filter((t) => !t.cleared);
  assertEqual(live.length, 1);
  assertEqual(live[0].ms, 3000);
  await env.run(async () => live[0].fn());
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
});

test('view: garbage in the camera data, or no cameras, does not throw and does nothing', async () => {
  for (const dataCameras of ['not json', '{"a":1}', '[]', '[null, 5, {"name":"x"}]']) {
    const env = await started({ dataCameras });
    env.els.next.fire('click');
    env.els.prev.fire('click');
    env.els.slideshow.fire('click');
    await env.advance(1000, 30);
    assertEqual(env.els.picture.src, '', `data: ${dataCameras}`);
  }
});

test('view: a page without the root element (the "no cameras" page) does nothing at all', () => {
  const env = makeEnv();
  delete env.els.view;
  load(env, 'simple-view.js');
  assertEqual(env.intervals.length, 0);
  assertEqual(env.urls.length, 0);
});

test('view: the slideshow time falls back to 10 s when the page does not give a usable one', async () => {
  const env = makeEnv({ seconds: 'x' });
  load(env, 'simple-view.js');
  await env.run(async () => {});
  env.els.slideshow.fire('click');
  await env.advance(1000, 9);
  assertEqual(env.els.picture.src, '');
  await env.advance(1000, 1);
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
});

// ── simple-list.js ───────────────────────────────────────────────────

function listEnv(count, { width = 1024, height = 768 } = {}) {
  const env = makeEnv();
  const grid = makeEl({ dataset: { count: String(count) }, children: new Array(count) });
  env.document.getElementById = (id) => (id === 'thumbs' ? grid : null);
  env.document.querySelector = (sel) => (sel === '.bar' ? { offsetHeight: 48 } : null);
  env.document.documentElement.clientWidth = width;
  env.grid = grid;
  env.height = height;
  return env;
}

test('list: sizes the thumbnails to the screen through CamSimple.fitThumbnails and marks the grid as fitted', () => {
  const env = listEnv(6, { width: 1024, height: 768 });
  load(env, 'simple-list.js');
  const expected = CamSimple.fitThumbnails({ width: 1024 - 24, height: 800 - 48 - 12, count: 6, aspect: 4 / 3, gap: 8, minWidth: 160 });
  assertEqual(env.grid.style.props['--thumb-w'], expected.width + 'px');
  assertEqual(env.grid.style.props['--cols'], String(expected.cols));
  assertTrue(env.grid.classList.contains('fitted'));
});

test('list: sizes again when the window changes size', () => {
  const env = listEnv(6);
  load(env, 'simple-list.js');
  const before = env.grid.style.props['--thumb-w'];
  env.document.documentElement.clientWidth = 400;
  env.window.innerHeight = 3000;
  assertEqual(env.windowListeners.resize.length, 1);
  env.windowListeners.resize[0]();
  assertTrue(env.grid.style.props['--thumb-w'] !== before, 'a narrower window gives other thumbnails');
  assertTrue(parseInt(env.grid.style.props['--thumb-w'], 10) >= 160, 'never below the recognisable minimum');
});

test('list: a very full list keeps the minimum size (the page scrolls)', () => {
  const env = listEnv(60, { width: 800 });
  load(env, 'simple-list.js');
  assertTrue(parseInt(env.grid.style.props['--thumb-w'], 10) >= 160);
});

test('list: a page without the grid (no cameras) does nothing', () => {
  const env = makeEnv();
  env.document.getElementById = () => null;
  load(env, 'simple-list.js');
  assertEqual(Object.keys(env.windowListeners).length, 0);
});

runAll();
