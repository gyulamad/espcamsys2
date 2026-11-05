'use strict';

// test_index_pictures.js — where the dashboard page (php/cameras/index.php) gets its live pictures from: ONE mux.php
// connection, or one stream.php per camera. Runs exactly the block between its <pictures-source> markers against
// stand-ins for the page (no PHP, no browser): the old per-camera behaviour must be unchanged when mux is off, and
// with mux on the page must hand the cameras to js/mux-pictures.js, start them, and go back to one connection per
// camera when mux.php cannot be used (or its scripts did not load).

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <pictures-source>\n([\s\S]*?)\/\/ <\/pictures-source>/.exec(page);
assertTrue(!!m, 'the page has a <pictures-source> block');
const SOURCE = m[1];
const PLACEHOLDER = "<?= $muxEnabled ? 'true' : 'false' ?>";
assertTrue(SOURCE.includes(PLACEHOLDER), 'the block gets its on/off switch from PHP in the one expected place');

// Runs the block as the page would, with mux on or off, and `withScripts` = whether js/mux-pictures.js was loaded.
function run({ mux, withScripts = true, ids = ['a', 'b'], detectorRows = [] }) {
  const log = [];
  const imgs = {};
  for (const id of ids) imgs[id] = { src: '', dataset: { src: `stream.php?cam=${id}` } };
  const detImgs = {};
  for (const id of detectorRows) detImgs[id] = { src: '', dataset: { src: `detector-stream.php?cam=${id}` } };
  const created = [];
  const fakePictures = {
    show: (id) => log.push(`show ${id}`),
    hide: (id) => log.push(`hide ${id}`),
    showDetector: (id) => log.push(`showDetector ${id}`),
    hideDetector: (id) => log.push(`hideDetector ${id}`),
    watchStatus: (on) => log.push(`watchStatus ${on}`),
    close: () => log.push('close'),
  };
  const win = withScripts ? { CamMuxPictures: { create: (options) => { created.push(options); return fakePictures; } } } : {};
  const env = {
    window: win,
    CamMuxPictures: win.CamMuxPictures,
    document: {
      getElementById: (name) => (name.startsWith('detimg-') ? detImgs[name.slice('detimg-'.length)] : imgs[name.replace('img-', '')]) || null,
      querySelectorAll: () => detectorRows.map((id) => ({ dataset: { cam: id } })),
    },
    onLiveDetectorData: (data) => log.push(`status ${JSON.stringify(data)}`),
    reconnectDetectorImg: (id) => log.push(`reconnectDetector ${id}`),
    openDetectorEvents: () => log.push('openDetectorEvents'),
    getAllCameraIds: () => ids,
    reloadStream: (id) => log.push(`reload ${id}`),
    armStreamWatchdog: (id) => log.push(`watchdog ${id}`),
    onStreamError: (id) => log.push(`error ${id}`),
    console: { warn: (text) => log.push(`warn ${text.split(' ')[0]}`) },
  };
  const names = Object.keys(env);
  const body = SOURCE.replace(PLACEHOLDER, mux ? 'true' : 'false');
  const api = new Function(...names, `${body}\nreturn { openPicture, closePicture, closeDetectorPicture, fallBackToStreams, pictures: () => pictures };`)(...names.map((n) => env[n]));
  return { api, log, imgs, detImgs, created, env };
}

test('mux off: nothing is started by this block, no mux object exists', () => {
  const t = run({ mux: false });
  assertEqual(t.log, []);
  assertEqual(t.created.length, 0);
  assertEqual(t.api.pictures(), null);
});

test('mux off: opening a picture is the old stream.php request, cache-busted, with its watchdog', () => {
  const t = run({ mux: false });
  t.api.openPicture('a');
  assertTrue(/^stream\.php\?cam=a&_=\d+$/.test(t.imgs.a.src), t.imgs.a.src);
  assertEqual(t.log, ['watchdog a']);
});

test('mux off: closing a picture empties its source, as before', () => {
  const t = run({ mux: false });
  t.imgs.a.src = 'stream.php?cam=a&_=1';
  t.api.closePicture('a');
  assertEqual(t.imgs.a.src, '');
});

test('mux on: one mux object for the whole page, pointed at mux.php, finding each camera\'s image', () => {
  const t = run({ mux: true });
  assertEqual(t.created.length, 1);
  assertEqual(t.created[0].url, 'mux.php');
  assertEqual(t.created[0].imgFor('cam', 'b'), t.imgs.b);
  assertEqual(t.created[0].imgFor('cam', 'nope'), null);
});

test('mux on: the images have no source yet, so every camera is started at load', () => {
  const t = run({ mux: true });
  assertEqual(t.log, ['reload a', 'reload b']);
});

test('mux on: opening and closing a picture go to the mux object, never to the image', () => {
  const t = run({ mux: true });
  t.log.length = 0;
  t.api.openPicture('a');
  t.api.closePicture('b');
  assertEqual(t.log, ['show a', 'hide b']);
  assertEqual([t.imgs.a.src, t.imgs.b.src], ['', ''], 'no stream.php request was made');
});

test('mux on: when the connection goes down every shown camera is marked as in error', () => {
  const t = run({ mux: true });
  t.log.length = 0;
  t.created[0].onDown(['a', 'b']);
  assertEqual(t.log, ['error a', 'error b']);
});

test('mux on: when mux.php cannot be used it is closed and every camera gets its own stream.php', () => {
  const t = run({ mux: true });
  t.log.length = 0;
  t.created[0].onFallback();
  assertEqual(t.log, ['warn mux.php', 'close', 'reload a', 'reload b']);
  assertEqual(t.api.pictures(), null);
  t.log.length = 0;
  t.api.openPicture('a');
  assertTrue(/^stream\.php\?cam=a&_=\d+$/.test(t.imgs.a.src), 'the old way from now on');
  assertEqual(t.log, ['watchdog a']);
});

test('mux on but its scripts did not load: the same old way, started at load', () => {
  const t = run({ mux: true, withScripts: false });
  assertEqual(t.api.pictures(), null);
  assertEqual(t.log, ['reload a', 'reload b'], 'every camera is started (reloadStream then opens stream.php)');
  t.log.length = 0;
  t.api.openPicture('b');
  assertTrue(/^stream\.php\?cam=b&_=\d+$/.test(t.imgs.b.src));
});

test('mux on, with detectors: their pictures and readings are asked for at load, after the cameras are started', () => {
  const t = run({ mux: true, detectorRows: ['a', 'b'] });
  assertEqual(t.log, ['reload a', 'reload b', 'showDetector a', 'showDetector b', 'watchStatus true']);
});

test('mux on, no detectors: the readings are not asked for', () => {
  const t = run({ mux: true });
  assertEqual(t.log, ['reload a', 'reload b'], 'no detector picture, no readings');
});

test('mux on: a detector image is found by its own id, and the readings go to the page\'s handler', () => {
  const t = run({ mux: true, detectorRows: ['a'] });
  assertEqual(t.created[0].imgFor('det', 'a'), t.detImgs.a);
  assertEqual(t.created[0].imgFor('det', 'b'), null);
  t.log.length = 0;
  t.created[0].onStatus({ a: { state: 'online' } });
  assertEqual(t.log, ['status {"a":{"state":"online"}}']);
});

test('mux on: closing a detector picture goes to the mux object; mux off it empties the image as before', () => {
  const on = run({ mux: true, detectorRows: ['a'] });
  on.log.length = 0;
  on.api.closeDetectorPicture('a');
  assertEqual(on.log, ['hideDetector a']);
  const off = run({ mux: false, detectorRows: ['a'] });
  off.detImgs.a.src = 'detector-stream.php?cam=a&_=1';
  off.api.closeDetectorPicture('a');
  assertEqual(off.detImgs.a.src, '');
  off.api.closeDetectorPicture('nope');   // a camera without a detector: nothing to close, no crash
});

test('mux on, falling back: the detectors\' pictures and the readings stream come back the old way too', () => {
  const t = run({ mux: true, detectorRows: ['a', 'b'] });
  t.log.length = 0;
  t.created[0].onFallback();
  assertEqual(t.log, ['warn mux.php', 'close', 'reload a', 'reload b', 'reconnectDetector a', 'reconnectDetector b', 'openDetectorEvents']);
});

test('mux on, falling back, no detectors: the readings stream is not opened', () => {
  const t = run({ mux: true });
  t.log.length = 0;
  t.created[0].onFallback();
  assertEqual(t.log.includes('openDetectorEvents'), false);
});

summarize();
