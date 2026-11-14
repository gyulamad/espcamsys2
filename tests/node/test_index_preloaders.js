'use strict';

// test_index_preloaders.js — F-25: the dashboard's camera cards have two preloaders, the page's own stream overlay
// (CONNECTING… / STREAM ERROR / FEED PAUSED) and the relay's "CAMERA OFFLINE / Reconnecting…" cover, and they must
// never show at once. Runs the block between the page's <stream-preloader-source> markers (index.php: the two state
// maps, syncPreloaders and its setters) against stand-in elements and the REAL js/camera-offline.js, and checks the
// rule from the page's side: what each writer's state change does to the two layers. The wiring of the writers
// themselves (onStreamLoad, onStreamError, reloadStream, toggleHide, the status push) is checked on the real page
// with a real browser-like DOM by tests/dom/test_offline_preloader_dom.js.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const CamOffline = require('../../php/cameras/js/camera-offline');   // the real one: it is what the page runs

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <stream-preloader-source>\n([\s\S]*?)\/\/ <\/stream-preloader-source>/.exec(page);
assertTrue(!!m, 'the page has a <stream-preloader-source> block');

// A stand-in for the page's overlay / cover elements: jsdom supports classList.toggle(name, force), and so does this.
function makeEl(id) {
  const classes = new Set();
  return {
    id,
    hidden: true,
    classList: {
      toggle(name, on) {
        if (on === undefined) on = !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        return classes.has(name);
      },
      contains: (name) => classes.has(name),
    },
  };
}

function run() {
  const els = {};
  const env = {
    // An id set to null in `els` stands for an element the page does not have (getElementById gives null then).
    document: { getElementById: (id) => (els[id] === null ? null : (els[id] = els[id] || makeEl(id))) },
    CamOffline,
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${m[1]}\nreturn { syncPreloaders, setStreamState, setKnownOffline };`)(...names.map((n) => env[n]));
  return {
    api,
    els,
    coverOf: (id) => els['offline-' + id],
    overlayOf: (id) => els['overlay-' + id],
    // What the user would see: the cover alone, the overlay alone, both (the F-25 bug), or neither.
    shown: (id) => `${(!els['offline-' + id].hidden ? 'cover' : '')}+${els['overlay-' + id].classList.contains('visible') ? 'overlay' : ''}`,
  };
}

test('a page starts as its HTML does: CONNECTING… on the overlay, no cover', () => {
  const t = run();
  t.api.setStreamState('a', 'connecting');
  assertEqual(t.shown('a'), '+overlay');
  assertEqual(t.coverOf('a').hidden, true);
});

test('the relay says the camera is offline: the CAMERA OFFLINE cover shows and the CONNECTING… spinner steps aside (the F-25 bug)', () => {
  const t = run();
  t.api.setStreamState('a', 'connecting');
  t.api.setKnownOffline('a', true);
  assertEqual(t.shown('a'), 'cover+', 'only the cover');
});

test('the camera is back: the cover goes and CONNECTING… comes back until a picture ends it', () => {
  const t = run();
  t.api.setStreamState('a', 'connecting');
  t.api.setKnownOffline('a', true);
  t.api.setKnownOffline('a', false);
  assertEqual(t.shown('a'), '+overlay');
  t.api.setStreamState('a', 'live');
  assertEqual(t.shown('a'), '+', 'neither: the picture is live');
});

test('a camera that was live and drops: the cover takes over; when it is back no spinner blinks (the pictures just resume)', () => {
  const t = run();
  t.api.setStreamState('a', 'live');
  t.api.setKnownOffline('a', true);
  assertEqual(t.shown('a'), 'cover+', 'dropped: the cover over the last picture');
  t.api.setKnownOffline('a', false);
  assertEqual(t.shown('a'), '+', 'back: no CONNECTING… over a camera that was already live');
});

test('the page\'s data connection drops (STREAM ERROR): an offline camera keeps its cover instead of a second spinner', () => {
  const t = run();
  t.api.setKnownOffline('a', true);
  t.api.setStreamState('a', 'error');
  assertEqual(t.shown('a'), 'cover+', 'offline: the cover');
  const t2 = run();
  t2.api.setStreamState('b', 'error');
  assertEqual(t2.shown('b'), '+overlay', 'a camera not known to be offline says STREAM ERROR');
  t2.api.setKnownOffline('b', false);
  t2.api.setStreamState('b', 'error');
  assertEqual(t2.shown('b'), '+overlay', '...and it comes back when the camera is known to be online again');
});

test('a feed the user paused shows FEED PAUSED even when the camera is offline (RESTORE must stay reachable); restoring shows the cover again', () => {
  const t = run();
  t.api.setKnownOffline('a', true);
  t.api.setStreamState('a', 'paused');
  assertEqual(t.shown('a'), '+overlay', 'paused: the overlay with RESTORE');
  t.api.setStreamState('a', 'connecting');   // RESTORE pressed: reloadStream's state
  assertEqual(t.shown('a'), 'cover+', 'restored while still offline: the cover again');
});

test('only a plain offline: true counts, as CamOffline.render reports it', () => {
  const t = run();
  t.api.setKnownOffline('a', undefined);
  t.api.setStreamState('a', 'connecting');
  assertEqual(t.shown('a'), '+overlay', 'no answer is not known to be offline');
  t.api.setKnownOffline('a', false);
  assertEqual(t.shown('a'), '+overlay');
});

test('a camera without the cover or the overlay element does not break the other one', () => {
  const t = run();
  t.els['offline-b'] = null;   // the page does not have this cover
  t.els['overlay-c'] = null;   // ... nor this overlay
  let threw = false;
  try { t.api.setKnownOffline('b', true); t.api.setStreamState('b', 'connecting'); } catch (e) { threw = true; }
  assertTrue(!threw, 'no throw');
  try { t.api.setKnownOffline('c', true); t.api.setStreamState('c', 'connecting'); } catch (e) { threw = true; }
  assertTrue(!threw, 'no throw without the overlay either');
});

test('the rule and the writers are wired together: every writer of a layer goes through the setters', () => {
  // The glue is only as good as its wiring: the four stream writers must set the state, and the status push must
  // say what the relay answered. (The behaviour end to end is the DOM test's business.)
  assertTrue(/function onStreamLoad\(id\) \{[\s\S]*?setStreamState\(id, 'live'\)/.test(page), 'onStreamLoad');
  assertTrue(/function onStreamError\(id\) \{[\s\S]*?setStreamState\(id, 'error'\)/.test(page), 'onStreamError');
  assertTrue(/function reloadStream\(id\) \{[\s\S]*?setStreamState\(id, 'connecting'\)/.test(page), 'reloadStream');
  assertTrue(/'FEED PAUSED', false\);[\s\S]*?setStreamState\(id, 'paused'\)/.test(page), 'toggleHide');
  assertTrue(/setKnownOffline\(id, CamOffline\.render\(/.test(page), 'the status push');
});

summarize();