'use strict';

// test_index_pictures.js — where the dashboard page (php/cameras/index.php) gets its live data from: ONE mux.php
// connection, and nothing else. Runs exactly the block between its <pictures-source> markers against stand-ins for the
// page (no PHP, no browser): the page must hand every camera, every detector and the readings to js/mux-pictures.js,
// start them at load, say so when the connection is down (also when no camera picture is wanted), and never fall
// back to a connection of its own per picture (no stream.php, no detector-stream.php, no src on any image).

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <pictures-source>\n([\s\S]*?)\/\/ <\/pictures-source>/.exec(page);
assertTrue(!!m, 'the page has a <pictures-source> block');
const SOURCE = m[1];
assertTrue(!/<\?/.test(SOURCE), 'the block has no PHP in it: it is the same for every page');

// Runs the block as the page would, with `withScripts` = whether js/mux-pictures.js was loaded.
function run({ withScripts = true, ids = ['a', 'b'], detectorRows = [] } = {}) {
  const log = [];
  const imgs = {};
  for (const id of ids) imgs[id] = { src: '' };
  const detImgs = {};
  for (const id of detectorRows) detImgs[id] = { src: '' };
  const created = [];
  const fakePictures = {
    show: (id) => log.push(`show ${id}`),
    hide: (id) => log.push(`hide ${id}`),
    showDetector: (id) => log.push(`showDetector ${id}`),
    hideDetector: (id) => log.push(`hideDetector ${id}`),
    watchStatus: (on) => log.push(`watchStatus ${on}`),
    watchCameraStatus: (on) => log.push(`watchCameraStatus ${on}`),
    close: () => log.push('close'),
  };
  const env = {
    document: {
      getElementById: (name) => (name.startsWith('detimg-') ? detImgs[name.slice('detimg-'.length)] : imgs[name.replace('img-', '')]) || null,
      querySelectorAll: () => detectorRows.map((id) => ({ dataset: { cam: id } })),
    },
    onLiveDetectorData: (data) => log.push(`status ${JSON.stringify(data)}`),
    onLiveCameraStatus: (data) => log.push(`cameraStatus ${JSON.stringify(data)}`),
    onLiveDataDown: () => log.push('dataDown'),
    getAllCameraIds: () => ids,
    reloadStream: (id) => log.push(`reload ${id}`),
    onStreamError: (id) => log.push(`error ${id}`),
  };
  if (withScripts) env.CamMuxPictures = { create: (options) => { created.push(options); return fakePictures; } };
  const names = Object.keys(env);
  // (CamMuxPictures is a global of the page: without its script the name is simply not defined)
  const api = new Function(...names, `${SOURCE}\nreturn { openPicture, closePicture, closeDetectorPicture, pictures };`)(...names.map((n) => env[n]));
  return { api, log, imgs, detImgs, created };
}

test('one mux object for the whole page, pointed at mux.php, finding each camera\'s image', () => {
  const t = run();
  assertEqual(t.created.length, 1);
  assertEqual(t.created[0].url, 'mux.php');
  assertEqual(t.created[0].imgFor('cam', 'b'), t.imgs.b);
  assertEqual(t.created[0].imgFor('cam', 'nope'), null);
});

test('there is no fallback: the mux object is given no way to give up, and the page has no other source', () => {
  const t = run();
  assertEqual(Object.keys(t.created[0]).sort(), ['imgFor', 'onCameraStatus', 'onDown', 'onStatus', 'url']);
  assertTrue(!/stream\.php|detector-stream|detector-events|EventSource|fallBack|onFallback|muxEnabled|MUX_ENABLED/.test(page), 'the page still mentions an old source');
});

test('the images have no source yet, so every camera is started at load, and their recording state is asked for', () => {
  const t = run();
  assertEqual(t.log, ['reload a', 'reload b', 'watchCameraStatus true']);
});

test('opening and closing a picture go to the mux object, never to the image', () => {
  const t = run();
  t.log.length = 0;
  t.api.openPicture('a');
  t.api.closePicture('b');
  assertEqual(t.log, ['show a', 'hide b']);
  assertEqual([t.imgs.a.src, t.imgs.b.src], ['', ''], 'no request of its own was made');
});

test('when the connection goes down every shown camera is marked as in error, and the numbers say there is no data', () => {
  const t = run();
  t.log.length = 0;
  t.created[0].onDown(['a', 'b']);
  assertEqual(t.log, ['error a', 'error b', 'dataDown']);
});

test('when the connection goes down with NO camera picture wanted (all hidden), the numbers still say there is no data', () => {
  const t = run();
  t.log.length = 0;
  t.created[0].onDown([]);
  assertEqual(t.log, ['dataDown']);
});

test('with detectors: their pictures and readings are asked for at load, after the cameras are started', () => {
  const t = run({ detectorRows: ['a', 'b'] });
  assertEqual(t.log, ['reload a', 'reload b', 'watchCameraStatus true', 'showDetector a', 'showDetector b', 'watchStatus true']);
});

test('no detectors: the readings are not asked for', () => {
  const t = run();
  assertEqual(t.log, ['reload a', 'reload b', 'watchCameraStatus true'], 'no detector picture, no detector readings');
});

test('a detector image is found by its own id, and the readings go to the page\'s handler', () => {
  const t = run({ detectorRows: ['a'] });
  assertEqual(t.created[0].imgFor('det', 'a'), t.detImgs.a);
  assertEqual(t.created[0].imgFor('det', 'b'), null);
  t.log.length = 0;
  t.created[0].onStatus({ a: { state: 'online' } });
  assertEqual(t.log, ['status {"a":{"state":"online"}}']);
});

test('the cameras\' recording state goes to the page\'s handler', () => {
  const t = run();
  t.log.length = 0;
  t.created[0].onCameraStatus({ a: { recording: true } });
  assertEqual(t.log, ['cameraStatus {"a":{"recording":true}}']);
});

test('closing a detector picture goes to the mux object', () => {
  const t = run({ detectorRows: ['a'] });
  t.log.length = 0;
  t.api.closeDetectorPicture('a');
  assertEqual(t.log, ['hideDetector a']);
});

test('the only timers of the page are clocks, countdowns and the "still looking" keep-alive: none asks for live data', () => {
  const timers = page.split('\n').filter((line) => /\b(setInterval|setTimeout)\(/.test(line)).map((line) => line.trim());
  const allowed = [
    /^tick\(\); setInterval\(tick, 1000\);/,                                   // the clock
    /^setInterval\(\(\) => \{ getAllCameraIds\(\)\.forEach\(renderSwitch\); \}, 1000\);/,   // "REC OFF · 5 min left"
    /^recordCountdowns\[id\] = setInterval\(/,                                  // "REC 12s"
    /^if \(document\.querySelector\('\.det-row'\)\) setInterval\(keepDetectorViewsAlive, WATCH_KEEP_MS\);/,   // the POST that says a person is here
  ];
  const stray = timers.filter((line) => !allowed.some((re) => re.test(line)));
  assertEqual(stray, [], 'a timer that is not a clock, a countdown or the keep-alive');
  assertEqual(timers.length, allowed.length, 'every allowed timer is there exactly once');
});

test('without js/mux-pictures.js the page does not quietly fall back: it fails at once, where the cause is', () => {
  assertThrows(() => run({ withScripts: false }), 'expected the missing script to be an error');
});

summarize();
