'use strict';

// test_mux_pictures.js — the glue between the mux stream and the dashboard's <img> elements
// (php/cameras/js/mux-pictures.js), with a fake connection manager: which cameras the connection is opened for,
// that calls made together become one (re)connection, how a picture reaches its image and what happens to the
// object URLs, and what the page is told.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
// (state messages carry JSON text)
const codec = require('../../php/cameras/js/mux-codec');
const Pictures = require('../../php/cameras/js/mux-pictures');

function setup() {
  const calls = [];
  const deferred = [];
  const urls = { made: [], revoked: [] };
  const imgs = {};      // the cameras' images
  const detImgs = {};   // the images of the detectors paired with them
  const makeImg = () => ({ src: '', removed: 0, removeAttribute(name) { if (name === 'src') { this.src = ''; this.removed += 1; } } });
  for (const id of ['a', 'b', 'c']) {
    imgs[id] = makeImg();
    detImgs[id] = makeImg();
  }
  const page = { down: [], status: [], cameraStatus: [] };
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
    imgFor: (kind, id) => (kind === 'det' ? detImgs : imgs)[id] || null,
    onStatus: (data) => page.status.push(data),
    onCameraStatus: (data) => page.cameraStatus.push(data),
    onDown: (ids) => page.down.push(ids),
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
  const frame = (id, bytes = [1, 2, 3], kind = 'cam') => clientOptions.onMessage({ type: codec.TYPE_FRAME, source: kind + ':' + id, payload: new Uint8Array(bytes) });
  const sendState = (text, source = codec.STATE_DETECTORS) => clientOptions.onMessage({ type: codec.TYPE_STATE, source, payload: new TextEncoder().encode(text) });
  return { pictures, calls, imgs, detImgs, sendState, urls, page, settle, frame, options: () => clientOptions, setState: (s) => { state = s; } };
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

test('nothing wanted any more closes the connection', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.pictures.hide('a'); t.settle();
  assertEqual(t.calls, ['restart', 'stop']);
  t.pictures.show('a'); t.settle();
  assertEqual(t.calls, ['restart', 'stop', 'restart'], 'and showing it again opens it again');
});

test('a camera shown alone is asked for with cams= and nothing else', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a');
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
  t.options().onMessage({ type: codec.TYPE_FRAME, source: 'det:a', payload: new Uint8Array([1]) });   // its detector's picture is not wanted
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

test('the client is given no way to give up: there is nothing to fall back on', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  assertEqual(Object.keys(t.options()).sort(), ['buildUrl', 'onDown', 'onMessage']);
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

test('reconnect with nothing wanted does nothing', () => {
  const t = setup();
  t.pictures.reconnect();
  assertEqual(t.calls, []);
});

test('reconnect with only readings wanted opens the connection again, without cams=', () => {
  const t = setup();
  t.pictures.watchStatus(true); t.pictures.watchCameraStatus(true); t.settle();
  t.pictures.reconnect();
  assertEqual(t.calls, ['restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?rec=1&status=1');
});

test('detector pictures: asked for with dets=, painted on the detector\'s image, never on the camera\'s', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.show('b'); t.pictures.showDetector('b'); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a%2Cb&dets=b');
  t.frame('b', [7], 'det');
  assertEqual([t.detImgs.b.src, t.imgs.b.src, t.detImgs.a.src], ['blob:0', '', '']);
  t.frame('b', [8], 'cam');
  assertEqual([t.detImgs.b.src, t.imgs.b.src], ['blob:0', 'blob:1'], 'each picture on its own image');
});

test('detector pictures: hiding one empties its image, releases its URL and reopens the connection without it', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.showDetector('a'); t.settle();
  t.frame('a', [1], 'det');
  t.pictures.hideDetector('a'); t.settle();
  assertEqual([t.detImgs.a.src, t.detImgs.a.removed, t.urls.revoked], ['', 1, ['blob:0']]);
  assertEqual(t.calls, ['restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a');
  t.frame('a', [1], 'det');
  assertEqual(t.urls.made.length, 1, 'a detector picture still on its way is dropped');
});

test('readings: asked for with status=1, delivered as the page\'s { camId: status } object', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.watchStatus(true); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a&status=1');
  t.sendState('{"a":{"state":"online"}}');
  assertEqual(t.page.status, [{ a: { state: 'online' } }]);
});

test('readings: not JSON, another source, or not asked for: ignored', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.sendState('{"a":1}');
  assertEqual(t.page.status, [], 'not asked for');
  t.pictures.watchStatus(true); t.settle();
  t.sendState('not json {');
  t.sendState('{"a":1}', 'state:other');
  assertEqual(t.page.status, []);
});

test('readings: turning them on or off reopens the connection once, asking for the same twice does not', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.pictures.watchStatus(true); t.settle();
  t.pictures.watchStatus(true); t.settle();
  t.pictures.watchStatus(false); t.settle();
  assertEqual(t.calls, ['restart', 'restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a');
});

test('the cameras\' recording state: asked for with rec=1, delivered to its own callback, never to the detectors\'', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.watchCameraStatus(true); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a&rec=1');
  t.sendState('{"a":{"recording":true,"recordingCount":3}}', 'state:cameras');
  assertEqual([t.page.cameraStatus, t.page.status], [[{ a: { recording: true, recordingCount: 3 } }], []]);
});

test('both kinds of readings: both asked for, each delivered to its own callback', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.watchStatus(true); t.pictures.watchCameraStatus(true); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a&rec=1&status=1');
  t.sendState('{"d":1}');
  t.sendState('{"c":2}', 'state:cameras');
  assertEqual([t.page.status, t.page.cameraStatus], [[{ d: 1 }], [{ c: 2 }]]);
  t.pictures.watchStatus(false); t.settle();
  assertEqual(t.options().buildUrl(), 'mux.php?cams=a&rec=1');
  t.sendState('{"d":3}');
  assertEqual(t.page.status.length, 1, 'no longer asked for: ignored');
});

test('the cameras\' recording state: not asked for, not JSON, or turned off again: ignored', () => {
  const t = setup();
  t.pictures.show('a'); t.settle();
  t.sendState('{"a":1}', 'state:cameras');
  t.pictures.watchCameraStatus(true); t.settle();
  t.sendState('nope {', 'state:cameras');
  t.pictures.watchCameraStatus(false); t.settle();
  t.sendState('{"a":1}', 'state:cameras');
  assertEqual(t.page.cameraStatus, []);
  assertEqual(t.calls, ['restart', 'restart', 'restart'], 'each change of what is asked for reopens the connection once');
});

test('hiding the last camera keeps the connection while readings or detector pictures are wanted: reopened without cams=', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.showDetector('a'); t.pictures.watchStatus(true); t.settle();
  t.pictures.hide('a'); t.settle();
  assertEqual(t.calls, ['restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?dets=a&status=1');
});

test('hiding every camera keeps the recording state and the readings coming (no picture, no cams=)', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.watchCameraStatus(true); t.pictures.watchStatus(true); t.settle();
  t.pictures.hide('a'); t.settle();
  assertEqual(t.calls, ['restart', 'restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?rec=1&status=1');
  t.sendState('{"a":1}', 'state:cameras');
  assertEqual(t.page.cameraStatus, [{ a: 1 }], 'the recording state still reaches the page');
});

test('a page that only watches readings (no picture ever) opens the connection', () => {
  const t = setup();
  t.pictures.watchCameraStatus(true); t.settle();
  assertEqual(t.calls, ['restart']);
  assertEqual(t.options().buildUrl(), 'mux.php?rec=1');
  t.pictures.watchCameraStatus(false); t.settle();
  assertEqual(t.calls, ['restart', 'stop'], 'and nothing wanted closes it');
});

test('close forgets detector pictures and readings too', () => {
  const t = setup();
  t.pictures.show('a'); t.pictures.showDetector('a'); t.pictures.watchStatus(true); t.settle();
  t.frame('a', [1], 'det');
  t.pictures.close();
  assertEqual(t.urls.revoked, ['blob:0']);
  t.sendState('{"a":1}');
  t.frame('a', [1], 'det');
  assertEqual([t.page.status.length, t.urls.made.length], [0, 1]);
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
