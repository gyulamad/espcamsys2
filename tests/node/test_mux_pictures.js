'use strict';

// test_mux_pictures.js — the glue between the mux stream and the dashboard's <img> elements
// (php/cameras/js/mux-pictures.js), with a fake connection manager: which cameras the connection is opened for,
// that calls made together become one (re)connection, how a picture reaches its image and what happens to the
// object URLs, and what the page is told.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const codec = require('../../php/cameras/js/mux-codec');
const Pictures = require('../../php/cameras/js/mux-pictures');

function setup() {
  const calls = [];
  const deferred = [];
  const urls = { made: [], revoked: [] };
  const imgs = {};
  for (const id of ['a', 'b', 'c']) {
    imgs[id] = { src: '', removed: 0, removeAttribute(name) { if (name === 'src') { this.src = ''; this.removed += 1; } } };
  }
  const page = { down: [], fallbacks: 0 };
  let clientOptions = null;
  let state = 'idle';
  const fakeClient = {
    start() { calls.push('start'); state = 'connecting'; },
    restart() { calls.push('restart'); state = 'connecting'; },
    stop() { calls.push('stop'); state = 'idle'; },
    state: () => state,
  };
  const pictures = Pictures.create({
    url: 'mux.php',
    imgFor: (id) => imgs[id] || null,
    onDown: (ids) => page.down.push(ids),
    onFallback: () => { page.fallbacks += 1; },
    env: {
      createClient: (options) => { clientOptions = options; return fakeClient; },
      codec,
      defer: (fn) => deferred.push(fn),
      Blob: class { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
      createObjectURL: (blob) => { const u = 'blob:' + urls.made.length; urls.made.push([u, blob]); return u; },
      revokeObjectURL: (u) => urls.revoked.push(u),
    },
  });
  const settle = () => { while (deferred.length) deferred.shift()(); };
  const frame = (id, bytes = [1, 2, 3]) => clientOptions.onMessage({ type: codec.TYPE_FRAME, source: 'cam:' + id, payload: new Uint8Array(bytes) });
  return { pictures, calls, imgs, urls, page, settle, frame, options: () => clientOptions, setState: (s) => { state = s; } };
}

test('showing several cameras together opens ONE connection, for all of them (sorted)', () => {
  const t = setup();
  t.pictures.show('c'); t.pictures.show('a'); t.pictures.show('b');
  assertEqual(t.calls, [], 'nothing before the calls have all been made');
  t.settle();
  assertEqual(t.calls, ['restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a%2Cb%2Cc');
});

test('asking again for the same cameras while the connection is open does nothing', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.pictures.show('a'); t.settle();
  assertEqual(t.calls, ['restart']);
});

test('RELOAD on a connection that is waiting to retry retries at once; on a stopped one it starts it', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.setState('waiting');
  t.pictures.show('a'); t.settle();
  t.setState('idle');
  t.pictures.show('a'); t.settle();
  assertEqual(t.calls, ['restart', 'restart', 'start']);
});

test('a different list of cameras reopens the connection for the new list', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.show('b'); t.settle();
  t.pictures.hide('b'); t.settle();
  assertEqual(t.calls, ['restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a');
  t.pictures.show('b'); t.settle();
  assertEqual(t.calls.length, 3);
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a%2Cb');
});

test('no camera shown any more closes the connection', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.pictures.hide('a'); t.settle();
  assertEqual(t.calls, ['restart', 'stop']);
  t.pictures.show('a'); t.settle();
  assertEqual(t.calls, ['restart', 'stop', 'restart'], 'and showing it again opens it again');
});

test('a picture becomes the source of its camera\'s image, as a JPEG blob', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.frame('a', [9, 8]);
  assertEqual(t.imgs.a.src, 'blob:0');
  assertEqual([t.urls.made[0][1].type, Array.from(t.urls.made[0][1].parts[0])], ['image/jpeg', [9, 8]]);
});

test('the previous picture\'s object URL is released when the next one replaces it', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.frame('a'); t.frame('a'); t.frame('a');
  assertEqual([t.imgs.a.src, t.urls.revoked], ['blob:2', ['blob:0', 'blob:1']]);
});

test('pictures of cameras that are not shown, of other kinds, and heartbeats are ignored', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.frame('b');
  t.options().onMessage({ type: codec.TYPE_HEARTBEAT, source: '', payload: new Uint8Array(0) });
  t.options().onMessage({ type: codec.TYPE_FRAME, source: 'det:a', payload: new Uint8Array([1]) });
  t.options().onMessage({ type: 77, source: 'cam:a', payload: new Uint8Array([1]) });
  t.frame('zzz');
  assertEqual([t.urls.made.length, t.imgs.a.src, t.imgs.b.src], [0, '', '']);
});

test('a camera whose image the page does not have is skipped without a fuss', () => {
  const t = setup();
  t.pictures.show('zzz'); t.settle();
  t.frame('zzz');
  assertEqual(t.urls.made.length, 0);
});

test('hide empties the image, releases its object URL and ignores pictures still on their way', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.show('b'); t.settle();
  t.frame('a');
  t.pictures.hide('a');
  assertEqual([t.imgs.a.src, t.imgs.a.removed, t.urls.revoked], ['', 1, ['blob:0']]);
  t.frame('a');
  assertEqual(t.urls.made.length, 1, 'a picture that was already on its way is dropped');
});

test('the page is told which cameras were being shown when the connection goes down', () => {
  const t = setup();
  t.pictures.show('b'); t.pictures.show('a'); t.settle();
  t.options().onDown();
  assertEqual(t.page.down, [['a', 'b']]);
});

test('onFallback is passed on when the client gives up', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.options().onGiveUp();
  assertEqual(t.page.fallbacks, 1);
});

test('reconnect opens the connection again even though it looks open (a locked phone drops it without a sound)', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.show('b'); t.settle();
  t.setState('live');
  t.pictures.reconnect();
  assertEqual(t.calls, ['restart', 'restart']);
  t.settle();
  assertEqual(t.calls, ['restart', 'restart'], 'a sync scheduled before it does not open a third');
});

test('reconnect with no camera shown does nothing', () => {
  const t = setup();
  t.pictures.reconnect();
  assertEqual(t.calls, []);
});

test('close stops the connection, releases every object URL and forgets the cameras', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.show('b'); t.settle();
  t.frame('a'); t.frame('b');
  t.pictures.close();
  assertEqual(t.calls, ['restart', 'stop']);
  assertEqual(t.urls.revoked.sort(), ['blob:0', 'blob:1']);
  t.frame('a');
  assertEqual(t.urls.made.length, 2, 'nothing is shown after close');
  t.settle();
  assertEqual(t.calls, ['restart', 'stop'], 'a sync that was already scheduled does not reopen it');
});

summarize();
