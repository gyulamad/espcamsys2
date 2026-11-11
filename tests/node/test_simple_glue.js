'use strict';

// test_simple_glue.js — the page scripts of the simple camera pages (php/cameras/js/simple-view.js and
// simple-list.js) run against a tiny hand-made DOM, a fake CamMuxPictures (the one mux.php connection: it records
// what the page asks for and lets the test push what the relay would), fake timers and a fake clock: no
// browser, no jsdom, nothing to install. The rules themselves are tested in test_simple_logic.js; this
// checks that the pages are wired to them: pager, status line, recording indicator, slideshow, and that nothing
// is polled and no picture has a connection of its own.

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
const CamOffline = require(path.join(JS, 'camera-offline.js'));   // the real one: the pages' cover rule and its way of showing it

const CAMS = [{ id: 'a', name: 'Alpha', icon: '🚪' }, { id: 'b', name: 'Beta', icon: '🚗' }, { id: 'c', name: 'Gamma' }];   // c: an older page without icons
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
    removeAttribute(k) { if (k === 'src') this.src = ''; delete this.attrs[k]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
  }, extra);
}

// The fake of js/mux-pictures.js: what the page asks the one connection for (cam / det pictures, the two kinds of
// readings) and the callbacks it gave, so the test can push what the relay would send. The real parts are tested in
// test_mux_pictures.js / test_mux_client.js.
function makeMux() {
  const mux = { created: [], opts: null, cam: new Set(), det: new Set(), watching: { status: false, cameraStatus: false }, log: [] };
  mux.api = {
    create(opts) {
      mux.created.push(opts);
      mux.opts = opts;
      return {
        show: (id) => { mux.log.push('show ' + id); mux.cam.add(id); },
        // like the real one: a hidden camera's image is emptied
        hide: (id) => { mux.log.push('hide ' + id); mux.cam.delete(id); const img = opts.imgFor('cam', id); if (img) img.removeAttribute('src'); },
        showDetector: (id) => mux.det.add(id),
        hideDetector: (id) => mux.det.delete(id),
        watchStatus: (on) => { mux.watching.status = on; },
        watchCameraStatus: (on) => { mux.watching.cameraStatus = on; },
        reconnect() {},
        close() {},
      };
    },
  };
  // A frame of camera `id` arrives: painted only if that camera is wanted and the page gives an image for it
  // (what js/mux-pictures.js does).
  mux.paint = (id, src = 'frame-of-' + id) => {
    if (!mux.cam.has(id)) return;
    const img = mux.opts.imgFor('cam', id);
    if (img) img.src = src;
  };
  return mux;
}

// The one camera the page asks the connection for. The simple view shows ONE camera at a time: asking for
// two (the old one not hidden) would put every other camera's pictures on the link for nothing.
const shownId = (env) => {
  const ids = [...env.mux.cam];
  assertEqual(ids.length, 1, 'exactly one camera picture is asked for: ' + ids.join());
  return ids[0];
};

// A page environment. `relay`: what the relay pushes (the recording state of the cameras, the detectors' readings;
// mutable by the test, null / garbage = the connection is down: nothing is known).
function makeEnv({ cameras = CAMS, current = 'a', seconds = 10, dataCameras, fullscreen = true, muxHelper = true, offlineHelper = true } = {}) {
  const env = { now: 1000000, intervals: [], timeouts: [], urls: [], relay: { status: {}, detectors: {} }, clockWindow: {} };
  // js/fullscreen.js stand-in: records the elements it was asked to toggle (the real one is tested in test_fullscreen.js)
  env.fullscreen = fullscreen ? { toggled: [], toggle(el) { this.toggled.push(el); } } : undefined;
  env.muxHelper = muxHelper;   // false: js/mux-pictures.js is not on the page
  env.mux = makeMux();
  env.offlineHelper = offlineHelper;   // false: js/camera-offline.js is not on the page
  const els = {};
  for (const id of ['view', 'picture', 'picture-box', 'prev', 'next', 'slideshow', 'clock', 'cam-name', 'cam-icon', 'rec', 'countdown', 'countdown-bar', 'countdown-fill', 'offline']) els[id] = makeEl();
  for (const id of ['countdown', 'countdown-bar', 'offline']) els[id].hidden = true;   // as the page is delivered
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
  // The only request a page still makes by itself is the one-shot detector-view.php (the live view of a detector).
  env.fetch = async (url, options) => {
    env.urls.push(url);
    env.posted = (env.posted || []).concat([{ url, options }]);
    return { ok: true, json: async () => ({}) };
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
  env.window = { CamSimple, CamOffline: env.offlineHelper ? CamOffline : undefined, CamMuxPictures: env.muxHelper ? env.mux.api : undefined, CamFullscreen: env.fullscreen, innerHeight: 800, addEventListener(type, fn) { (env.windowListeners[type] = env.windowListeners[type] || []).push(fn); } };
  cleanups.push(install(env));
  delete require.cache[require.resolve(path.join(JS, file))];
  require(path.join(JS, file));
  // Later happenings (a timer fires, a poll) run in the same environment, then let promises settle.
  env.run = async (fn) => { await fn(); await flush(); await flush(); };
  env.interval = (ms) => env.intervals.filter((i) => i.ms === ms);
  env.advance = (ms, ticks = 1) => env.run(async () => {
    for (let i = 0; i < ticks; i += 1) { env.now += ms; for (const t of env.interval(1000)) await t.fn(); }
  });
  // What the relay pushes now: its state and its readings, to whatever the page watches. Anything that is not a
  // plain map (null, an error text) stands for "the connection is down".
  const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  env.poll = () => env.run(async () => {
    const { opts, watching } = env.mux;
    if (!isMap(env.relay.status) || !isMap(env.relay.detectors)) { opts.onDown([...env.mux.cam]); return; }
    if (watching.status) opts.onStatus(env.relay.detectors);
    if (watching.cameraStatus) opts.onCameraStatus(env.relay.status);
  });
  env.down = () => env.run(async () => env.mux.opts.onDown([...env.mux.cam]));
  return env;
}

// The page starts with the slideshow ON. Most tests want to switch it on themselves, so by default the
// slideshow is stopped again here; pass { slideshowOn: true } to get the page as it opens.
const started = async (opts) => {
  const env = load(makeEnv(opts), 'simple-view.js');
  await env.run(async () => {});
  if (!(opts && opts.slideshowOn)) env.els.slideshow.fire('click');
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

test('view: a click on the picture toggles full screen of the picture box — not of the bare image', async () => {
  const env = await started();
  env.els.picture.fire('click');
  assertEqual(env.fullscreen.toggled.length, 1);
  assertTrue(env.fullscreen.toggled[0] === env.els['picture-box'], 'the box goes full screen, so what is laid over the picture goes with it');
  env.els.picture.fire('click');   // the same click leaves again (the helper decides): one more request, no state kept here
  assertEqual(env.fullscreen.toggled.length, 2);
});

test('view: the icon follows the name when the camera changes; a camera without an icon shows none', async () => {
  const env = await started();
  // (the server writes the first icon into the page; the script keeps it in step from the first switch on)
  env.els.next.fire('click');
  assertEqual([env.els['cam-name'].textContent, env.els['cam-icon'].textContent], ['Beta', '🚗']);
  env.els.next.fire('click');
  assertEqual([env.els['cam-name'].textContent, env.els['cam-icon'].textContent], ['Gamma', '']);
  env.els.next.fire('click');
  assertEqual([env.els['cam-name'].textContent, env.els['cam-icon'].textContent], ['Alpha', '🚪']);
});

// ── the slideshow's time-left indicator ─────────────────────────────

const shown = (env) => ({ text: env.els.countdown.textContent, hidden: env.els.countdown.hidden, barHidden: env.els['countdown-bar'].hidden, width: env.els['countdown-fill'].style.width });

test('countdown: nothing is shown until the slideshow runs, and it goes away when the slideshow stops', async () => {
  const env = await started({ seconds: 5 });
  assertEqual([env.els.countdown.hidden, env.els['countdown-bar'].hidden], [true, true], 'hidden while the slideshow is stopped');
  env.els.slideshow.fire('click');
  assertEqual(shown(env), { text: 'NEXT IN 5 s', hidden: false, barHidden: false, width: '100%' }, 'at once, not at the next second');
  env.els.slideshow.fire('click');
  assertEqual([env.els.countdown.hidden, env.els['countdown-bar'].hidden], [true, true]);
});

test('countdown: the seconds and the bar run down with the time, and start over after the switch', async () => {
  const env = await started({ seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 1);
  assertEqual(shown(env), { text: 'NEXT IN 4 s', hidden: false, barHidden: false, width: '80%' });
  await env.advance(1000, 3);
  assertEqual([env.els.countdown.textContent, env.els['countdown-fill'].style.width], ['NEXT IN 1 s', '20%']);
  await env.advance(1000, 1);   // time is up: the picture changes and the next camera gets a full time
  assertEqual(shownId(env), 'b');
  assertEqual([env.els.countdown.textContent, env.els['countdown-fill'].style.width], ['NEXT IN 5 s', '100%']);
});

test('countdown: the bar jumps back to full without sliding, and runs down smoothly again', async () => {
  const env = await started({ seconds: 3 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 1);
  assertEqual(env.els['countdown-fill'].style.transition, '', 'running out is animated (the stylesheet\'s transition)');
  await env.advance(1000, 2);   // switch
  assertEqual(env.els['countdown-fill'].style.transition, 'none', 'the refill is not');
  await env.advance(1000, 1);
  assertEqual(env.els['countdown-fill'].style.transition, '');
});

test('countdown: pressing NEXT or PREV during the slideshow gives the camera a full time, shown at once', async () => {
  const env = await started({ seconds: 10 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 6);
  assertEqual(env.els.countdown.textContent, 'NEXT IN 4 s');
  env.els.next.fire('click');
  assertEqual([env.els.countdown.textContent, env.els['countdown-fill'].style.width], ['NEXT IN 10 s', '100%']);
});

test('countdown: a camera that starts recording is shown at once and its time starts over', async () => {
  const env = await started({ seconds: 10 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 4);
  env.relay.status = { c: { recording: true }, b: { recording: true } };
  await env.poll();
  assertEqual(shownId(env), 'b');
  assertEqual(env.els.countdown.textContent, 'NEXT IN 10 s');
});

test('countdown: hidden while there is nowhere to go (the only recording camera stays), back when there is', async () => {
  const env = await started({ seconds: 10 });
  env.relay.status = { a: { recording: true } };
  await env.poll();
  env.els.slideshow.fire('click');
  assertEqual([env.els.countdown.hidden, env.els['countdown-bar'].hidden], [true, true]);
  env.relay.status = { a: { recording: true }, b: { recording: true } };
  await env.poll();
  assertEqual(env.els.countdown.hidden, false);
});

test('countdown: one camera only — a slideshow with nowhere to go shows no indicator', async () => {
  const env = await started({ cameras: [CAMS[0]], seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 2);
  assertEqual([env.els.countdown.hidden, env.els['countdown-bar'].hidden], [true, true]);
});

test('view: the pager and the slideshow button do not touch full screen', async () => {
  const env = await started();
  env.els.next.fire('click');
  env.els.slideshow.fire('click');
  assertEqual(env.fullscreen.toggled.length, 0);
});

test('view: without the full-screen helper (script not loaded) the page still works and a click does nothing', async () => {
  const env = await started({ fullscreen: false });
  env.els.picture.fire('click');   // no listener, no crash
  env.els.next.fire('click');
  assertEqual(env.els['cam-name'].textContent, 'Beta');
});

test('view: the picture box has the red frame (class "recording") exactly while the CURRENT camera records', async () => {
  const env = await started({ current: 'a' });
  const framed = () => env.els['picture-box'].classList.contains('recording');
  assertEqual(framed(), false, 'not known yet: no frame');
  env.relay.status = { a: { recording: true }, b: { recording: false } };
  await env.poll();
  assertEqual(framed(), true);
  env.els.next.fire('click');   // b does not record: the frame follows the camera that is shown
  assertEqual(framed(), false);
  env.els.prev.fire('click');
  assertEqual(framed(), true);
  env.relay.status = { a: { recording: false } };   // the recording is over
  await env.poll();
  assertEqual(framed(), false);
  env.relay.status = { a: { recording: true } };
  await env.poll();
  assertEqual(framed(), true);
  env.relay.status = null;   // the relay cannot be asked: not known is not "recording"
  await env.poll();
  assertEqual(framed(), false);
});

test('view: a page without the mux scripts (js/mux-pictures.js) does nothing at all (it cannot show or know anything)', async () => {
  const env = await started({ muxHelper: false });
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
});

test('view: a page without the offline-cover script does nothing at all, and does not throw', async () => {
  const env = await started({ offlineHelper: false });
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
  assertTrue(env.els.offline.hidden, 'nothing is covered');
});

test('view: asks the ONE connection for the picture of the camera on screen, the recording state and the readings — and nothing else', async () => {
  const env = await started({ current: 'b' });
  assertEqual(env.mux.created.length, 1, 'one connection object');
  assertEqual(env.mux.created[0].url, 'mux.php');
  assertEqual(shownId(env), 'b');
  assertEqual([env.mux.watching.status, env.mux.watching.cameraStatus], [true, true]);
  assertEqual(env.mux.det.size, 0, 'no detector picture is shown on this page');
  assertEqual(env.urls, [], 'no request of its own: no stream.php, no status.php, no detector-status.php');
  await env.advance(1000, 30);
  assertEqual(env.urls, []);
  assertEqual(env.intervals.map((i) => i.ms), [1000], 'the only timer is the clock / slideshow tick: nothing is polled');
});

test('view: what is pushed is shown at once; garbage or a lost connection is "not known", never "off"', async () => {
  const env = await started({ current: 'a' });
  env.relay.status = { a: { recording: true } };
  await env.poll();
  assertEqual(env.els.rec.textContent, 'RECORDING: ON');
  env.mux.opts.onCameraStatus([]);                 // not a map of cameras
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
  env.mux.opts.onCameraStatus({ a: { recording: false } });
  assertEqual(env.els.rec.textContent, 'RECORDING: off');
  env.mux.opts.onCameraStatus('error');
  assertEqual(env.els.rec.textContent, 'RECORDING: –');
});

test('view: while the connection is down the picture is blank (its alt text shows) and nothing is known; it all comes back with the push', async () => {
  const env = await started({ current: 'b' });
  env.els.picture.alt = 'Beta';   // (the server writes it into the page)
  env.mux.paint('b');
  assertEqual(env.els.picture.src, 'frame-of-b');
  env.relay.status = { b: { recording: true, online: false } };
  await env.poll();
  assertEqual([env.els.rec.textContent, env.els['picture-box'].classList.contains('recording'), env.els.offline.hidden], ['RECORDING: ON', true, false]);
  await env.down();
  assertEqual(env.els.picture.src, '', 'no frozen picture posing as live');
  assertEqual(env.els.picture.alt, 'Beta', 'the alt text stays and says which camera it is');
  assertEqual([env.els.rec.textContent, env.els['picture-box'].classList.contains('recording'), env.els.offline.hidden], ['RECORDING: –', false, true], 'no state is known');
  assertEqual(shownId(env), 'b', 'the camera is still wanted: the connection reopens by itself');
  await env.poll();
  env.mux.paint('b');
  assertEqual([env.els.picture.src, env.els.rec.textContent], ['frame-of-b', 'RECORDING: ON']);
});

test('view: only the camera on screen gets a picture; switching hides the old one first, and a late frame of it is dropped', async () => {
  const env = await started({ current: 'a' });
  assertEqual(env.mux.log, ['show a']);
  env.mux.paint('a');
  env.els.next.fire('click');
  assertEqual(env.mux.log, ['show a', 'hide a', 'show b'], 'old out, new in');
  assertEqual(env.els.picture.src, '', 'the old picture is gone at once');
  env.mux.paint('a');   // a frame of a, still on its way
  assertEqual(env.els.picture.src, '', 'not painted');
  assertEqual(env.mux.opts.imgFor('cam', 'a'), null, 'the page has no image for a camera that is not on screen');
  assertTrue(env.mux.opts.imgFor('cam', 'b') === env.els.picture);
  assertEqual(env.mux.opts.imgFor('det', 'b'), null, 'no detector pictures on this page');
  env.mux.paint('b');
  assertEqual(env.els.picture.src, 'frame-of-b');
  assertEqual(shownId(env), 'b');
});

test('view: showing the camera that is already on screen asks for nothing new', async () => {
  const env = await started({ current: 'a' });
  env.relay.status = { a: { recording: true } };
  await env.poll();   // the slideshow stays on a: nothing to hide or show
  await env.advance(1000, 3);
  assertEqual(env.mux.log, ['show a']);
});

test('view: the detectors\' live views are switched on by the tick while the slideshow runs, and renewed every 20 s — nothing polls', async () => {
  const env = await started({ seconds: 600 });
  env.relay.detectors = { a: { online: true, view: { supported: true, wanted: false } }, b: { online: true } };
  env.relay.status = {};
  env.els.slideshow.fire('click');   // the slideshow starts
  await env.poll();
  const views = () => (env.posted || []).filter((r) => r.url.startsWith('detector-view.php'));
  assertEqual(views().map((r) => r.url), ['detector-view.php?cam=a&action=on']);
  await env.advance(1000, 19);
  assertEqual(views().length, 1, 'not renewed before 20 s');
  await env.advance(1000, 2);
  assertEqual(views().length, 2, 'renewed by the tick, with no push needed');
  assertEqual(views()[1].options.method, 'POST');
});

test('view: NEXT and PREV switch the picture, the name, the title and the address, wrapping around', async () => {
  const env = await started({ current: 'a' });
  env.els.next.fire('click');
  assertEqual(shownId(env), 'b');
  assertEqual(env.els['cam-name'].textContent, 'Beta');
  assertEqual(env.document.title, 'Beta — ESP32-CAM Dashboard');
  assertEqual(env.history.replaced.pop(), 'simple-view.php?cam=b');
  env.els.prev.fire('click');
  env.els.prev.fire('click');
  assertEqual(shownId(env), 'c');   // wrapped from the first to the last
  env.els.next.fire('click');
  assertEqual(shownId(env), 'a');
  assertEqual(env.els.picture.alt, 'Alpha');
});

test('view: the arrow keys page too, other keys do nothing', async () => {
  const env = await started({ current: 'a' });
  env.key('ArrowRight');
  assertEqual(shownId(env), 'b');
  env.key('ArrowLeft');
  assertEqual(shownId(env), 'a');
  env.key('Enter');
  assertEqual(shownId(env), 'a');
});

test('view: a camera id goes to the connection as it is (js/mux-pictures.js encodes it in the address)', async () => {
  const env = await started({ cameras: [{ id: 'a', name: 'A' }, { id: 'x y&z', name: 'Z' }] });
  env.els.next.fire('click');
  assertEqual(shownId(env), 'x y&z');
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

test('view: the slideshow is ON when the page opens (button pressed, running, counting down)', async () => {
  const env = await started({ slideshowOn: true, seconds: 5 });
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'true');
  assertTrue(env.els.slideshow.classList.contains('on'));
  assertTrue(/ON/.test(env.els.slideshow.textContent), env.els.slideshow.textContent);
  assertTrue(env.els.countdown.hidden === false, 'the time-left indicator is shown');
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'b');   // moved on by itself, nothing was clicked
});

test('view: the button stops the slideshow that started by itself, and again starts it', async () => {
  const env = await started({ slideshowOn: true, seconds: 5 });
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'false');
  await env.advance(1000, 30);
  assertEqual(shownId(env), 'a');
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'true');
});

test('view: without the slideshow the picture never changes by itself', async () => {
  const env = await started();
  env.relay.status = { c: { recording: true } };
  await env.poll();
  await env.advance(1000, 60);
  assertEqual(shownId(env), 'a');   // never switched: still the first camera
});

test('view: the slideshow moves to the next camera after the time of the setting', async () => {
  const env = await started({ seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 4);
  assertEqual(shownId(env), 'a');
  await env.advance(1000, 1);
  assertEqual(shownId(env), 'b');
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'c');
});

test('view: a camera that starts recording is shown at once, at the next look at the relay', async () => {
  const env = await started({ seconds: 60 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 2);
  assertEqual(shownId(env), 'a');
  env.relay.status = { c: { recording: true } };
  await env.poll();
  assertEqual(shownId(env), 'c');
  assertEqual(env.els.rec.textContent, 'RECORDING: ON');
});

test('view: motion from a paired person detector is shown at once, but not instead of a recording camera', async () => {
  const env = await started({ seconds: 60 });
  env.els.slideshow.fire('click');
  env.relay.detectors = { b: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } } };
  await env.poll();
  assertEqual(shownId(env), 'b');
  env.relay.status = { b: { recording: true } };
  env.relay.detectors = { b: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } }, c: { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } } };
  await env.poll();
  assertEqual(shownId(env), 'b', 'motion on c does not pull the view away from the recording b');
});

const MOVING = { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } };

test('view: a lost connection does not take the view from a camera that records, whatever starts to move elsewhere (the human is held)', async () => {
  const env = await started({ seconds: 60, current: 'b' });
  env.els.slideshow.fire('click');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  await env.down();                            // the connection is lost ...
  env.relay.detectors = { c: MOVING };         // ... just as another camera starts to move (the push that follows)
  env.mux.opts.onStatus(env.relay.detectors);
  assertEqual(shownId(env), 'b', 'still on b');
  await env.advance(1000, 3);
  assertEqual(shownId(env), 'b', 'still on b');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  assertEqual(shownId(env), 'b', 'and when the relay answers again');
});

test('view: a human on the screen keeps the view through every turn, and a missing look; only once he is gone for good the time moves it on', async () => {
  const env = await started({ seconds: 10, current: 'b' });
  env.els.slideshow.fire('click');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  await env.advance(1000, 15);                 // the 10 s are up once: the human stays
  assertEqual(shownId(env), 'b', 'b stays');
  env.relay.status = {};                       // the data lets go of the human (gone, or just a gap)
  env.relay.detectors = { c: MOVING };
  await env.poll();
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'b', 'held: 5 s later it is still b');
  await env.advance(1000, 15);
  assertEqual(shownId(env), 'c', 'gone for good: on to the camera that moves');
});

test('view: with cameras recording, the slideshow skips the ones that do not', async () => {
  const env = await started({ current: 'a', seconds: 5 });
  env.relay.status = { a: { recording: true }, c: { recording: true } };
  env.els.slideshow.fire('click');
  await env.poll();
  assertEqual(shownId(env), 'c');   // c has just started recording: shown at once
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'a');   // b is skipped
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'c');
});

test('view: PREV / NEXT during a slideshow give that camera a full time', async () => {
  const env = await started({ seconds: 5 });
  env.els.slideshow.fire('click');
  await env.advance(1000, 4);
  env.els.next.fire('click');                  // the viewer goes to b with 1 s left on a
  assertEqual(shownId(env), 'b');
  await env.advance(1000, 4);
  assertEqual(shownId(env), 'b');
  await env.advance(1000, 1);
  assertEqual(shownId(env), 'c');
});

test('view: garbage in the camera data, or no cameras, does not throw and does nothing', async () => {
  for (const dataCameras of ['not json', '{"a":1}', '[]', '[null, 5, {"name":"x"}]']) {
    const env = await started({ dataCameras });
    env.els.next.fire('click');
    env.els.prev.fire('click');
    env.els.slideshow.fire('click');
    await env.advance(1000, 30);
    assertEqual(env.mux.cam.size, 0, `data: ${dataCameras}: no picture is asked for`);
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
  await env.run(async () => {});   // the slideshow starts by itself
  await env.advance(1000, 9);
  assertEqual(shownId(env), 'a');
  await env.advance(1000, 1);
  assertEqual(shownId(env), 'b');
});

// ── cameras that are not connected ───────────────────────────────────

test('view: the offline cover is over the picture of a camera that is not connected, and goes when it is back', async () => {
  const env = await started({ current: 'a' });
  assertTrue(env.els.offline.hidden, 'nothing is covered before the relay says so');
  env.relay.status = { a: { online: false }, b: { online: true } };
  await env.poll();
  assertTrue(!env.els.offline.hidden, 'a is offline');
  env.els.next.fire('click');   // the pager still goes to b: the viewer picks by hand
  assertEqual(shownId(env), 'b');
  assertTrue(env.els.offline.hidden, 'b is online');
  env.els.prev.fire('click');   // a again: offline, covered AT ONCE (no wait for the next poll)
  assertTrue(!env.els.offline.hidden);
  env.relay.status = { a: { online: true } };
  await env.poll();
  assertTrue(env.els.offline.hidden, 'a is back');
  env.relay.status = { a: { online: false } };
  await env.poll();
  env.relay.status = null;   // no answer: not known to be offline
  await env.poll();
  assertTrue(env.els.offline.hidden);
});

test('view: the slideshow skips the cameras that are not connected, and the pager does not', async () => {
  const env = await started({ current: 'a', seconds: 5 });
  env.relay.status = { a: { online: true }, b: { online: false }, c: { online: true } };
  await env.poll();
  env.els.slideshow.fire('click');
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'c', 'b is skipped');
  env.relay.status = { a: { online: true }, b: { online: true }, c: { online: true } };
  await env.poll();
  await env.advance(1000, 5);
  assertEqual(shownId(env), 'a');
});

// ── simple-list.js ───────────────────────────────────────────────────

const THUMB_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
function listEnv(count, { width = 1024, height = 768, muxHelper = true, navHeight = 44, offlineHelper = true } = {}) {
  const env = makeEnv({ muxHelper, offlineHelper });
  // one thumbnail per camera, as the page has them: an element that carries its camera id in data-cam
  env.thumbs = Array.from({ length: count }, (_, i) => {
    const offline = makeEl(); offline.hidden = true;   // the cover inside the thumbnail, as the page delivers it
    const img = makeEl();                              // its picture: no src until the connection paints it
    return makeEl({ dataset: { cam: THUMB_IDS[i] || 'cam' + i }, offline, img, querySelector: (sel) => ({ '.cam-offline': offline, img }[sel] || null) });
  });
  const grid = makeEl({ dataset: { count: String(count) }, children: env.thumbs });
  env.document.getElementById = (id) => (id === 'thumbs' ? grid : null);
  env.document.querySelector = (sel) => ({ '.bar': { offsetHeight: 48 }, '.site-nav': navHeight === null ? null : { offsetHeight: navHeight } }[sel] || null);
  env.document.documentElement.clientWidth = width;
  env.grid = grid;
  env.height = height;
  return env;
}

test('list: sizes the thumbnails to the screen through CamSimple.fitThumbnails and marks the grid as fitted', () => {
  const env = listEnv(6, { width: 1024, height: 768 });
  load(env, 'simple-list.js');
  const expected = CamSimple.fitThumbnails({ width: 1024 - 24, height: 800 - 44 - 48 - 12, count: 6, aspect: 4 / 3, gap: 8, minWidth: 160 });
  assertEqual(env.grid.style.props['--thumb-w'], expected.width + 'px');
  assertEqual(env.grid.style.props['--cols'], String(expected.cols));
  assertTrue(env.grid.classList.contains('fitted'));
});

test('list: the room the thumbnails get is the window minus the navigation bar and the count line', () => {
  const room = (navHeight) => {
    const env = listEnv(6, { navHeight });
    load(env, 'simple-list.js');
    return env.grid.style.props['--thumb-w'];
  };
  const fitFor = (above) => CamSimple.fitThumbnails({ width: 1000, height: 800 - above - 12, count: 6, aspect: 4 / 3, gap: 8, minWidth: 160 }).width + 'px';
  assertEqual(room(44), fitFor(44 + 48));
  assertEqual(room(70), fitFor(70 + 48), 'a taller bar (a large font) takes more');
  assertEqual(room(null), fitFor(44 + 48), 'no bar element found: its designed height');
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

test('list: a thumbnail whose camera records gets the red frame class, the others do not, and it follows the relay', async () => {
  const env = listEnv(3);
  env.relay.status = { a: { recording: true }, b: { recording: false } };   // c: unknown to the relay
  load(env, 'simple-list.js');
  await env.poll();   // the relay's first push
  const framed = () => env.thumbs.map((t) => t.classList.contains('recording'));
  assertEqual(framed(), [true, false, false]);
  env.relay.status = { a: { recording: false }, c: { recording: true } };
  await env.poll();
  assertEqual(framed(), [false, false, true]);
  env.relay.status = null;   // the relay cannot be asked: no frame is better than a stale one
  await env.poll();
  assertEqual(framed(), [false, false, false]);
  env.relay.status = 'http-error';   // an error answer is "not known" too
  await env.poll();
  assertEqual(framed(), [false, false, false]);
  env.relay.status = { a: { recording: true } };
  await env.poll();
  assertEqual(framed(), [true, false, false]);
  assertEqual(env.urls, [], 'nothing is asked by the page itself: the state is pushed');
});

test('list: the offline cover is on the thumbnail of a camera that is not connected, and only on that one', async () => {
  const env = listEnv(3);
  env.relay.status = { a: { online: true }, b: { online: false }, c: {} };   // c: an older relay says nothing
  load(env, 'simple-list.js');
  await env.poll();   // the relay's first push
  const covered = () => env.thumbs.map((t) => !t.offline.hidden);
  assertEqual(covered(), [false, true, false]);
  env.relay.status = { a: { online: false }, b: { online: true } };
  await env.poll();
  assertEqual(covered(), [true, false, false], 'it follows the camera');
  env.relay.status = null;   // no answer is not "offline"
  await env.poll();
  assertEqual(covered(), [false, false, false]);
});

test('list: every thumbnail\'s picture and the recording state ride on ONE connection — no timer, no request, however many cameras', async () => {
  for (const count of [2, 60]) {
    const env = listEnv(count);
    load(env, 'simple-list.js');
    await env.run(async () => {});
    assertEqual(env.mux.created.length, 1, 'one connection object for the whole page');
    assertEqual(env.mux.created[0].url, 'mux.php');
    assertEqual([...env.mux.cam].sort(), env.thumbs.map((t) => t.dataset.cam).sort(), 'every thumbnail is asked for, in one go');
    assertEqual(env.mux.watching.cameraStatus, true);
    assertEqual(env.mux.watching.status, false, 'the detectors\' readings are not needed here');
    assertEqual(env.urls, [], 'no stream.php, no status.php');
    assertEqual(env.intervals.length, 0, 'nothing is polled');
  }
});

test('list: a frame is painted onto its own thumbnail only', async () => {
  const env = listEnv(3);
  load(env, 'simple-list.js');
  env.mux.paint('b');
  assertEqual(env.thumbs.map((t) => t.img.src), ['', 'frame-of-b', '']);
  assertEqual(env.mux.opts.imgFor('cam', 'zzz'), null, 'a camera the page does not have');
  assertEqual(env.mux.opts.imgFor('det', 'a'), null, 'no detector pictures on this page');
});

test('list: while the connection is down the pictures are blank, no frame and no cover is shown; it all comes back with the push', async () => {
  const env = listEnv(3);
  load(env, 'simple-list.js');
  env.relay.status = { a: { recording: true }, b: { online: false } };
  await env.poll();
  for (const id of ['a', 'b', 'c']) env.mux.paint(id);
  assertEqual(env.thumbs.map((t) => t.img.src), ['frame-of-a', 'frame-of-b', 'frame-of-c']);
  await env.down();
  assertEqual(env.thumbs.map((t) => t.img.src), ['', '', ''], 'no frozen picture posing as live');
  assertEqual(env.thumbs.map((t) => t.classList.contains('recording')), [false, false, false]);
  assertTrue(env.thumbs.every((t) => t.offline.hidden), 'not known to be offline');
  assertEqual([...env.mux.cam].sort(), ['a', 'b', 'c'], 'all still wanted: the connection reopens by itself');
  await env.poll();
  assertEqual(env.thumbs.map((t) => t.classList.contains('recording')), [true, false, false]);
});

test('list: without the mux scripts the thumbnails are still sized, and nothing is asked for', async () => {
  const env = listEnv(3, { muxHelper: false });
  load(env, 'simple-list.js');
  await env.run(async () => {});
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
  assertTrue(env.grid.classList.contains('fitted'));
});

test('list: a page without the offline-cover script does nothing at all, and does not throw', async () => {
  const env = listEnv(3, { offlineHelper: false });
  env.relay.status = { a: { online: false } };
  load(env, 'simple-list.js');
  await env.run(async () => {});
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
  assertTrue(env.thumbs.every((t) => t.offline.hidden), 'nothing is covered');
});

test('list: a page without the grid (no cameras) does nothing', () => {
  const env = makeEnv();
  env.document.getElementById = () => null;
  load(env, 'simple-list.js');
  assertEqual(Object.keys(env.windowListeners).length, 0);
});

runAll();
