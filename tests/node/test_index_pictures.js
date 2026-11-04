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
function run({ mux, withScripts = true, ids = ['a', 'b'] }) {
  const log = [];
  const imgs = {};
  for (const id of ids) imgs[id] = { src: '', dataset: { src: `stream.php?cam=${id}` } };
  const created = [];
  const fakePictures = {
    show: (id) => log.push(`show ${id}`),
    hide: (id) => log.push(`hide ${id}`),
    close: () => log.push('close'),
  };
  const win = withScripts ? { CamMuxPictures: { create: (options) => { created.push(options); return fakePictures; } } } : {};
  const env = {
    window: win,
    CamMuxPictures: win.CamMuxPictures,
    document: { getElementById: (name) => imgs[name.replace('img-', '')] || null },
    getAllCameraIds: () => ids,
    reloadStream: (id) => log.push(`reload ${id}`),
    armStreamWatchdog: (id) => log.push(`watchdog ${id}`),
    onStreamError: (id) => log.push(`error ${id}`),
    console: { warn: (text) => log.push(`warn ${text.split(' ')[0]}`) },
  };
  const names = Object.keys(env);
  const body = SOURCE.replace(PLACEHOLDER, mux ? 'true' : 'false');
  const api = new Function(...names, `${body}\nreturn { openPicture, closePicture, fallBackToStreams, pictures: () => pictures };`)(...names.map((n) => env[n]));
  return { api, log, imgs, created, env };
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
  assertEqual(t.created[0].imgFor('b'), t.imgs.b);
  assertEqual(t.created[0].imgFor('nope'), null);
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

summarize();
