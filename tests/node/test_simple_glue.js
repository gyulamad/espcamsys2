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
const CamRelayJson = require(path.join(JS, 'relay-json.js'));   // the real one: it asks the environment's fetch

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
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
  }, extra);
}

// A page environment. `relay`: what status.php / detector-status.php answer (mutable by the test; null = failed).
function makeEnv({ cameras = CAMS, current = 'a', seconds = 10, dataCameras, fullscreen = true, relayJson = true } = {}) {
  const env = { now: 1000000, intervals: [], timeouts: [], urls: [], relay: { status: {}, detectors: {} }, clockWindow: {} };
  // js/fullscreen.js stand-in: records the elements it was asked to toggle (the real one is tested in test_fullscreen.js)
  env.fullscreen = fullscreen ? { toggled: [], toggle(el) { this.toggled.push(el); } } : undefined;
  env.relayJson = relayJson;   // false: the helper script is not on the page
  const els = {};
  for (const id of ['view', 'picture', 'picture-box', 'prev', 'next', 'slideshow', 'clock', 'cam-name', 'cam-icon', 'rec', 'countdown', 'countdown-bar', 'countdown-fill', 'loading']) els[id] = makeEl();
  for (const id of ['countdown', 'countdown-bar', 'loading']) els[id].hidden = true;   // as the page is delivered
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
  env.window = { CamSimple, CamRelayJson: env.relayJson ? CamRelayJson : undefined, CamFullscreen: env.fullscreen, innerHeight: 800, addEventListener(type, fn) { (env.windowListeners[type] = env.windowListeners[type] || []).push(fn); } };
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
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
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
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
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

test('view: a page without the helper that asks the relay does nothing at all (it cannot know anything)', async () => {
  const env = await started({ relayJson: false });
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
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

test('view: the slideshow is ON when the page opens (button pressed, running, counting down)', async () => {
  const env = await started({ slideshowOn: true, seconds: 5 });
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'true');
  assertTrue(env.els.slideshow.classList.contains('on'));
  assertTrue(/ON/.test(env.els.slideshow.textContent), env.els.slideshow.textContent);
  assertTrue(env.els.countdown.hidden === false, 'the time-left indicator is shown');
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=b');   // moved on by itself, nothing was clicked
});

test('view: the button stops the slideshow that started by itself, and again starts it', async () => {
  const env = await started({ slideshowOn: true, seconds: 5 });
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'false');
  await env.advance(1000, 30);
  assertEqual(env.els.picture.src, '');
  env.els.slideshow.fire('click');
  assertEqual(env.els.slideshow.attrs['aria-pressed'], 'true');
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

const MOVING = { online: true, report: { scene: { motion: 900, motionAtLeast: 300 } } };

test('view: one failed look at the relay does not take the view from a camera that records, whatever starts to move elsewhere', async () => {
  const env = await started({ seconds: 60, current: 'b' });
  env.els.slideshow.fire('click');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  env.relay.status = 'http-error';             // one look fails ...
  env.relay.detectors = { c: MOVING };         // ... just as another camera starts to move
  await env.poll();
  assertEqual(env.els.picture.src, '', 'still on b');
  await env.advance(1000, 3);
  assertEqual(env.els.picture.src, '', 'still on b');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  assertEqual(env.els.picture.src, '', 'and when the relay answers again');
});

test('view: an answer that arrives late does not replace a newer one', async () => {
  const env = await started({ seconds: 60, current: 'b' });
  env.els.slideshow.fire('click');
  const pending = [];   // the requests the page makes, answered by hand
  globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url, answer: (body) => resolve({ ok: true, json: async () => body }) }));
  const [look] = env.interval(2000);
  const older = look.fn();                      // two looks at the relay: pending[0], [1] and pending[2], [3] ...
  const newer = look.fn();
  pending[2].answer({ b: { recording: true } });   // ... the newer one is answered first
  pending[3].answer({});
  await newer;
  assertEqual(env.els.rec.textContent, 'RECORDING: ON');
  pending[0].answer({ b: { recording: false } });  // the older answer comes in last
  pending[1].answer({});
  await older;
  assertEqual(env.els.rec.textContent, 'RECORDING: ON', 'the older answer is old news');
});

test('view: a human on the screen keeps the view through every turn, and a missing look; only once he is gone for good the time moves it on', async () => {
  const env = await started({ seconds: 10, current: 'b' });
  env.els.slideshow.fire('click');
  env.relay.status = { b: { recording: true } };
  await env.poll();
  await env.advance(1000, 15);                 // the 10 s are up once: the human stays
  assertEqual(env.els.picture.src, '', 'b stays');
  env.relay.status = {};                       // the data lets go of the human (gone, or just a gap)
  env.relay.detectors = { c: MOVING };
  await env.poll();
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, '', 'held: 5 s later it is still b');
  await env.advance(1000, 15);
  assertEqual(env.els.picture.src, 'stream.php?cam=c', 'gone for good: on to the camera that moves');
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
  await env.run(async () => {});   // the slideshow starts by itself
  await env.advance(1000, 9);
  assertEqual(env.els.picture.src, '');
  await env.advance(1000, 1);
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
});

// ── cameras that are not connected ───────────────────────────────────

test('view: the loading indicator covers the picture of a camera that is not connected, and goes when it is back', async () => {
  const env = await started({ current: 'a' });
  assertTrue(env.els.loading.hidden, 'nothing is covered before the relay says so');
  env.relay.status = { a: { online: false }, b: { online: true } };
  await env.poll();
  assertTrue(!env.els.loading.hidden, 'a is offline');
  env.els.next.fire('click');   // the pager still goes to b: the viewer picks by hand
  assertEqual(env.els.picture.src, 'stream.php?cam=b');
  assertTrue(env.els.loading.hidden, 'b is online');
  env.els.prev.fire('click');   // a again: offline, covered AT ONCE (no wait for the next poll)
  assertTrue(!env.els.loading.hidden);
  env.relay.status = { a: { online: true } };
  await env.poll();
  assertTrue(env.els.loading.hidden, 'a is back');
  env.relay.status = { a: { online: false } };
  await env.poll();
  env.relay.status = null;   // no answer: not known to be offline
  await env.poll();
  assertTrue(env.els.loading.hidden);
});

test('view: the slideshow skips the cameras that are not connected, and the pager does not', async () => {
  const env = await started({ current: 'a', seconds: 5 });
  env.relay.status = { a: { online: true }, b: { online: false }, c: { online: true } };
  await env.poll();
  env.els.slideshow.fire('click');
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=c', 'b is skipped');
  env.relay.status = { a: { online: true }, b: { online: true }, c: { online: true } };
  await env.poll();
  await env.advance(1000, 5);
  assertEqual(env.els.picture.src, 'stream.php?cam=a');
});

// ── simple-list.js ───────────────────────────────────────────────────

const THUMB_IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
function listEnv(count, { width = 1024, height = 768, relayJson = true, navHeight = 44 } = {}) {
  const env = makeEnv({ relayJson });
  // one thumbnail per camera, as the page has them: an element that carries its camera id in data-cam
  env.thumbs = Array.from({ length: count }, (_, i) => {
    const loading = makeEl(); loading.hidden = true;   // the cover inside the thumbnail, as the page delivers it
    return makeEl({ dataset: { cam: THUMB_IDS[i] || 'cam' + i }, loading, querySelector: (sel) => (sel === '.cam-loading' ? loading : null) });
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
  await env.run(async () => {});
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
  assertTrue(env.urls.length >= 5 && env.urls.every((u) => u === 'status.php'), 'only status.php is asked: ' + env.urls.join());
});

test('list: the loading cover is on the thumbnail of a camera that is not connected, and only on that one', async () => {
  const env = listEnv(3);
  env.relay.status = { a: { online: true }, b: { online: false }, c: {} };   // c: an older relay says nothing
  load(env, 'simple-list.js');
  await env.run(async () => {});
  const covered = () => env.thumbs.map((t) => !t.loading.hidden);
  assertEqual(covered(), [false, true, false]);
  env.relay.status = { a: { online: false }, b: { online: true } };
  await env.poll();
  assertEqual(covered(), [true, false, false], 'it follows the camera');
  env.relay.status = null;   // no answer is not "offline"
  await env.poll();
  assertEqual(covered(), [false, false, false]);
});

test('list: the relay is asked once at once and then every 2 seconds, by one timer', async () => {
  const env = listEnv(2);
  load(env, 'simple-list.js');
  await env.run(async () => {});
  assertEqual(env.urls, ['status.php']);
  assertEqual(env.interval(2000).length, 1);
  assertEqual(env.intervals.length, 1);
});

test('list: without the helper that asks the relay the thumbnails are still sized, and nothing is polled', async () => {
  const env = listEnv(3, { relayJson: false });
  load(env, 'simple-list.js');
  await env.run(async () => {});
  assertEqual(env.urls, []);
  assertEqual(env.intervals.length, 0);
  assertTrue(env.grid.classList.contains('fitted'));
});

test('list: a page without the grid (no cameras) does nothing', () => {
  const env = makeEnv();
  env.document.getElementById = () => null;
  load(env, 'simple-list.js');
  assertEqual(Object.keys(env.windowListeners).length, 0);
});

runAll();
