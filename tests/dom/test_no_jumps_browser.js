#!/usr/bin/env node
'use strict';
// test_no_jumps_browser.js — F-35, the page the ticket is about, in a REAL browser at a PHONE viewport: the
// simple view's status line is a row that wraps, and its texts change every second (the slideshow's countdown,
// the recording state, what holds the screen) and at every camera switch (the name). A change of width used to
// move where the row broke its lines, and the picture — everything the status line leaves — hopped up and down.
// The pages now reserve the room of each text's widest wording (js/stable-text.js), so the layout depends only
// on the width of the screen, never on the data:
//
//   - the countdown runs "NEXT IN 10 s" -> "NEXT IN 9 s" and then the slideshow switches to the next camera (a
//     LONGER name): the status line keeps its height and the picture its room, every measure of them
//   - the slideshow button's wider wording ("⏸ SLIDESHOW ON") and a change of the recording state move
//     nothing either
//   - the slideshow HOLDING on the camera that is on screen (it is recording: what the relay pushes when a
//     recording starts) moves nothing either — the countdown bar stays with the slideshow instead of
//     vanishing and growing the picture by its four pixels, and the seconds hide into their reserved room
//   - the reservations are on the page before the first second has passed (countdown, recording state, screen
//     state, slideshow button, camera title) and are at least as wide as what they show
//   - the screen-state line is there from the first paint (not two seconds in), saying what holds the screen
//   - the page raised no script error on the way
//
// The clock is put under the test's control (Date.now), so the countdown is driven exactly — no waiting for
// wall-clock seconds. Needs `php` (the real CamLayout writes the page) and the playwright package with a
// browser; says SKIP and passes if either is missing.
//
// Usage:  node tests/dom/test_no_jumps_browser.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const ORIGIN = 'http://camdash.test';
// Two cameras whose names differ in length as much as they can: the reservation must make the switch of the
// slideshow (and of the pager) invisible to the layout.
const CAMERAS = [{ id: 'cam-a', name: 'Cam A', icon: '🚪' }, { id: 'cam-b', name: 'The Much Longer Name Of Camera B', icon: '🚗' }];
const SCREEN_TEXTS = ['SCREEN: KEPT ON', 'SCREEN: KEPT ON (VIDEO)', 'SCREEN: NOT HELD – TOUCH THE PAGE'];

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

// The page as the server sends it.
function pageHtml() {
  const php = 'require "' + DASH_SRC + '/lib/Logic.php"; require "' + DASH_SRC + '/lib/Layout.php";'
    + ' $c = json_decode(' + JSON.stringify(JSON.stringify(CAMERAS)) + ', true); echo CamLayout::simpleViewPage($c, $c[0], 10);';
  const r = spawnSync('php', ['-r', php], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('php failed: ' + r.stderr);
  return r.stdout;
}

// What a request gets: the page, the real scripts, and nothing else (no relay, no fonts, no icon).
function answer(route, html) {
  const { pathname } = new URL(route.request().url());
  if (pathname === '/simple-view.php') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  const script = pathname.startsWith('/js/') ? path.join(DASH_SRC, 'js', path.basename(pathname)) : null;
  if (script && fs.existsSync(script)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(script, 'utf8') });
  return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not here' });
}

// The layout the ticket is about: the status line's own height (a row that wraps), where it starts, and the
// room the picture gets (everything the status line leaves).
const LAYOUT = `(() => {
  const status = document.querySelector('.status').getBoundingClientRect();
  const picture = document.getElementById('picture-box').getBoundingClientRect();
  return { statusTop: status.top, statusHeight: status.height, pictureTop: picture.top, pictureHeight: picture.height };
})()`;

async function main() {
  if (!chromium) { console.log('SKIP: the playwright package is not installed.'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  const html = pageHtml();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } });   // a phone
    await context.route(ORIGIN + '/**', (route) => answer(route, html));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The page's own clock, under the test's hand: the slideshow's countdown follows Date.now().
    await page.addInitScript(() => {
      const base = Date.now();
      let offsetMs = 0;
      window.__advanceClock = (ms) => { offsetMs += ms; return base + offsetMs; };
      Date.now = () => base + offsetMs;
    });
    // The mux transport, stubbed: js/mux-client.js's client is replaced by one that stands still, and the
    // test pushes the cameras' recording state the way the relay does — through the page's REAL
    // js/mux-pictures.js, whose js/mux-codec.js message format this mirrors ({ type, source, payload }).
    // (The property is intercepted, not replaced: the real file's assignment lands in the empty setter, so
    // nothing throws and the page loads exactly as it ships.)
    await page.addInitScript(() => {
      let onMessage = null;
      Object.defineProperty(window, 'CamMuxClient', {
        configurable: true,
        get() {
          return { create(options) { onMessage = options.onMessage; return { start() {}, restart() {}, stop() {}, state: () => 'live' }; } };
        },
        set() {},
      });
      window.__cameraStatus = (data) => {
        if (onMessage) onMessage({ type: 3, source: 'state:cameras', payload: new TextEncoder().encode(JSON.stringify(data)) });
      };
    });
    await page.goto(ORIGIN + '/simple-view.php');

    const text = (sel) => page.$eval(sel, (el) => el.textContent);
    check('the page opens on the first camera with the full slideshow time', (await text('#countdown')) === 'NEXT IN 10 s' && (await text('#cam-name')) === 'Cam A', JSON.stringify({ countdown: await text('#countdown'), name: await text('#cam-name') }));
    const screenText = await text('#screen-state');
    check('the screen-state line is there at once (not two seconds in) and says what holds the screen', SCREEN_TEXTS.includes(screenText), JSON.stringify(screenText));

    // The reservations, before the first second has passed. Each must cover what the element draws NOW
    // (its own padding and border included — the reservation sizes the whole box, border-box).
    const widths = await page.$$eval('#countdown, #rec, #slideshow, #screen-state, #cam-name, #cam-icon', (els) => els.map((el) => {
      const reserved = parseFloat(el.style.minWidth) || 0;
      return { id: el.id, reserved, drawn: el.getBoundingClientRect().width };
    }));
    for (const w of widths) check(`reserved room not smaller than what it draws (${w.id})`, w.reserved >= w.drawn - 0.5, JSON.stringify(w));

    // The ticket's case: 10 s -> 9 s, and then the switch to the LONGER-named camera. Not one measure may move.
    const before = await page.evaluate(LAYOUT);
    await page.evaluate(() => window.__advanceClock(1000));
    await page.waitForFunction(() => document.getElementById('countdown').textContent === 'NEXT IN 9 s');
    const at9 = await page.evaluate(LAYOUT);
    await page.evaluate(() => window.__advanceClock(9000));
    await page.waitForFunction(() => document.getElementById('cam-name').textContent === 'The Much Longer Name Of Camera B');
    const afterSwitch = await page.evaluate(LAYOUT);
    const same = (a, b) => Math.abs(a - b) < 0.5;
    check('the countdown 10 s -> 9 s moves nothing (status and picture keep their place and height)',
      same(before.statusTop, at9.statusTop) && same(before.statusHeight, at9.statusHeight) && same(before.pictureTop, at9.pictureTop) && same(before.pictureHeight, at9.pictureHeight),
      JSON.stringify({ before, at9 }));
    check('the switch to the longer-named camera moves nothing either',
      same(before.statusTop, afterSwitch.statusTop) && same(before.statusHeight, afterSwitch.statusHeight) && same(before.pictureTop, afterSwitch.pictureTop) && same(before.pictureHeight, afterSwitch.pictureHeight),
      JSON.stringify({ before, afterSwitch }));
    check('the countdown runs on: the next camera has its full time again', (await text('#countdown')) === 'NEXT IN 10 s', await text('#countdown'));

    // The slideshow button's two wordings differ in width (and in which font draws their pictogram — the
    // reason .btn has an explicit line height): with the wider one's room reserved, its label change
    // moves nothing either. The recording state changes its wording at the same time, as it does live.
    await page.evaluate(() => {
      const b = document.getElementById('slideshow');
      b.textContent = '⏸ SLIDESHOW ON';
      b.setAttribute('aria-pressed', 'true');
      const rec = document.getElementById('rec');
      rec.textContent = 'RECORDING: ON';
      rec.className = 'rec-on';
    });
    const atOn = await page.evaluate(LAYOUT);
    check('the slideshow button\'s wider wording (and RECORDING: ON) moves nothing',
      same(before.statusTop, atOn.statusTop) && same(before.statusHeight, atOn.statusHeight) && same(before.pictureTop, atOn.pictureTop) && same(before.pictureHeight, atOn.pictureHeight),
      JSON.stringify({ before, atOn }));

    // The hold (F-35): the camera that is on screen starts recording — the relay pushes its state, the page
    // shows RECORDING: ON, the red frame lights up around the picture, and the slideshow HOLDS on this
    // camera (nothing to count down to). The countdown bar must stay with the slideshow: hiding it grew the
    // picture by its four pixels — the hop that used to come with the frame's lighting-up. The seconds hide
    // into their reserved room.
    await page.evaluate(() => window.__cameraStatus({ 'cam-a': { recording: false }, 'cam-b': { recording: true } }));
    await page.waitForFunction(() => document.getElementById('rec').textContent === 'RECORDING: ON');
    const atHold = await page.evaluate(LAYOUT);
    const holdState = await page.evaluate(() => ({
      textHidden: document.getElementById('countdown').hidden,
      barHidden: document.getElementById('countdown-bar').hidden,
      frameOn: document.getElementById('picture-box').classList.contains('recording'),
    }));
    check('the hold (the camera on screen records) moves nothing',
      same(before.statusTop, atHold.statusTop) && same(before.statusHeight, atHold.statusHeight) && same(before.pictureTop, atHold.pictureTop) && same(before.pictureHeight, atHold.pictureHeight),
      JSON.stringify({ before, atHold }));
    check('during the hold the seconds hide but the bar and the red frame stay', holdState.textHidden === true && holdState.barHidden === false && holdState.frameOn === true, JSON.stringify(holdState));

    // The hold lifts the way it does live: the recording moves to the OTHER camera — the slideshow follows
    // it (a camera that records is shown first), the countdown runs again, and nothing has moved.
    await page.evaluate(() => window.__cameraStatus({ 'cam-a': { recording: true }, 'cam-b': { recording: false } }));
    await page.waitForFunction(() => !document.getElementById('countdown').hidden && document.getElementById('countdown').textContent.startsWith('NEXT IN'));
    const afterHold = await page.evaluate(LAYOUT);
    check('when the hold lifts the countdown is back and nothing has moved',
      same(before.statusTop, afterHold.statusTop) && same(before.statusHeight, afterHold.statusHeight) && same(before.pictureTop, afterHold.pictureTop) && same(before.pictureHeight, afterHold.pictureHeight),
      JSON.stringify({ before, afterHold }));

    check('the page raised no script error', errors.length === 0, JSON.stringify(errors));
  } finally {
    await browser.close();
  }
  summarize();
}

main().catch((e) => { console.error(e); summarize(); });
