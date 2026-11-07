'use strict';

// Unit tests for php/cameras/js/screen-keeper.js: keeping a phone's screen on with the Wake Lock API, and with
// a hidden silent video where that API is missing or refused. Browser objects are fakes.

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const K = require(path.join(__dirname, '../../php/cameras/js/screen-keeper.js'));

const tick = () => new Promise((r) => setImmediate(r));

function fakeDoc(state = 'visible') {
  const handlers = {};
  return {
    visibilityState: state,
    handlers,
    addEventListener(t, h) { (handlers[t] = handlers[t] || new Set()).add(h); },
    removeEventListener(t, h) { if (handlers[t]) handlers[t].delete(h); },
    fire(t) { for (const h of [...(handlers[t] || [])]) h(); },
    count(t) { return handlers[t] ? handlers[t].size : 0; },
  };
}
function fakeLock() {
  const l = { released: false, listeners: [], addEventListener(t, h) { l.listeners.push(h); }, release() { l.released = true; l.listeners.forEach((h) => h()); } };
  return l;
}
function fakeNav({ refuse = false } = {}) {
  const nav = { locks: [], wakeLock: { request: async () => { if (refuse) throw new Error('denied'); const l = fakeLock(); nav.locks.push(l); return l; } } };
  return nav;
}
function fakeVideoMaker({ rejectFirst = 0 } = {}) {
  const state = { made: 0, plays: 0, video: null };
  const make = () => {
    state.made++;
    state.video = { paused: true, play() { state.plays++; if (state.plays <= rejectFirst) return Promise.reject(new Error('NotAllowedError')); this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
    return state.video;
  };
  return { make, state };
}

(async () => {
  {
    const nav = fakeNav(), doc = fakeDoc(), v = fakeVideoMaker();
    const k = K.create({ nav, doc, makeVideo: v.make });
    k.keepAwake(); await tick();
    test('wake lock is requested and used when available', () => {
      assertEqual(nav.locks.length, 1);
      assertEqual(k.method(), 'wake-lock');
      assertEqual(v.state.made, 0, 'no video needed');
    });
    k.keepAwake(); await tick();
    test('asking twice takes one lock', () => assertEqual(nav.locks.length, 1));
    doc.visibilityState = 'hidden'; nav.locks[0].release();
    doc.fire('visibilitychange'); await tick();
    test('hidden page: nothing requested', () => assertEqual(nav.locks.length, 1));
    doc.visibilityState = 'visible'; doc.fire('visibilitychange'); await tick();
    test('shown again: lock re-acquired', () => { assertEqual(nav.locks.length, 2); assertEqual(k.method(), 'wake-lock'); });
    k.allowSleep();
    test('allowSleep releases the lock', () => { assertTrue(nav.locks[1].released); assertEqual(k.isAwake(), false); });
    doc.fire('visibilitychange'); await tick();
    test('after allowSleep, no re-acquire', () => assertEqual(nav.locks.length, 2));
  }
  {
    const nav = fakeNav(), doc = fakeDoc(), k = K.create({ nav, doc, makeVideo: fakeVideoMaker().make });
    k.keepAwake(); k.allowSleep(); await tick();
    test('allowSleep while the request is pending releases the late lock', () => { assertTrue(nav.locks[0].released); assertEqual(k.isAwake(), false); });
  }
  {
    const v = fakeVideoMaker(), k = K.create({ nav: {}, doc: fakeDoc(), makeVideo: v.make });
    k.keepAwake(); await tick();
    test('no Wake Lock API: the video plays', () => { assertEqual(k.method(), 'video'); assertEqual(v.state.made, 1); });
    k.allowSleep();
    test('allowSleep pauses the video', () => assertEqual(k.isAwake(), false));
  }
  {
    const v = fakeVideoMaker(), k = K.create({ nav: fakeNav({ refuse: true }), doc: fakeDoc(), makeVideo: v.make });
    k.keepAwake(); await tick();
    test('wake lock refused: falls back to the video', () => assertEqual(k.method(), 'video'));
  }
  {
    const doc = fakeDoc(), v = fakeVideoMaker({ rejectFirst: 1 }), k = K.create({ nav: {}, doc, makeVideo: v.make });
    k.keepAwake(); await tick();
    test('autoplay refused: waits for a touch', () => { assertEqual(k.isAwake(), false); assertTrue(doc.count('touchend') > 0); });
    doc.fire('touchend'); await tick();
    test('the touch starts the video and removes the listeners', () => { assertEqual(k.method(), 'video'); assertEqual(doc.count('touchend'), 0); assertEqual(doc.count('click'), 0); });
  }
  {
    const doc = fakeDoc(), v = fakeVideoMaker({ rejectFirst: 1 }), k = K.create({ nav: {}, doc, makeVideo: v.make });
    k.keepAwake(); await tick(); k.allowSleep();
    test('allowSleep removes the touch listeners', () => assertEqual(doc.count('click'), 0));
  }
  {
    const k = K.create({ nav: null, doc: null });
    test('nothing available: does nothing, never throws', () => { k.keepAwake(); k.allowSleep(); assertEqual(k.method(), 'none'); });
  }
  {
    const k = K.create({ nav: {}, doc: fakeDoc(), makeVideo: () => { throw new Error('boom'); } });
    test('a failing video build does not throw', () => { k.keepAwake(); assertEqual(k.isAwake(), false); });
  }
  test('embedded videos are data URLs of a small size', () => {
    for (const u of [K.VIDEO_WEBM, K.VIDEO_MP4]) assertTrue(/^data:video\/(webm|mp4);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length < 4000, u.slice(0, 30));
  });
  summarize();
})();
