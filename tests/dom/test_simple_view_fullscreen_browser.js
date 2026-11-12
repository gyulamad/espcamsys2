#!/usr/bin/env node
'use strict';
// test_simple_view_fullscreen_browser.js — the two ways of showing the simple view full screen, in a REAL browser:
// the Fullscreen API, the top layer and what is covered by what need a real engine (the glue tests run against fakes).
// The page is the real simple-view.php markup (CamLayout::simpleViewPage), the scripts are the real files of
// php/cameras/js; only the relay side (mux.php) is left unanswered, so no picture ever arrives.
//
//   - the FULL SCREEN button is shown by the script (it is delivered hidden: a .btn has its own display, so the page
//     needs its own [hidden] rule), on the status line's row, right of the slideshow button
//   - a click on it puts the WHOLE page full screen: the status line (camera name, clock, recording) is still on top
//     of everything where it was, and the button is pressed; a second click leaves
//   - a click on the picture puts the picture box alone full screen, covering the status line (no camera name, clock,
//     countdown on screen); a second click leaves — whatever was full screen before
//   - when full screen ends some other way (Esc does the same) the button is not pressed any more
//   - a click on the picture while the whole page is full screen shows the picture alone; the next click steps back to
//     the whole page (the browser leaves one level at a time — kept on purpose), the button leaves for the normal window
//   - the page raised no script error on the way
//
// Needs `php` (the real CamLayout writes the page) and the playwright package with a browser; says SKIP and passes
// if one is missing.
//
// Usage:  node tests/dom/test_simple_view_fullscreen_browser.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const ORIGIN = 'http://camdash.test';
const CAMERAS = [{ id: 'cam-a', name: 'Cam A', icon: '🚪' }, { id: 'cam-b', name: 'Cam B', icon: '🚗' }];

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

async function main() {
  if (!chromium) { console.log('SKIP: the playwright package is not installed.'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  const html = pageHtml();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.route(ORIGIN + '/**', (route) => answer(route, html));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(ORIGIN + '/simple-view.php');

    // ── helpers that look at the page the way a person does ──
    const fullscreenId = () => page.evaluate(() => (document.fullscreenElement ? (document.fullscreenElement === document.documentElement ? 'page' : document.fullscreenElement.id) : null));
    // Waits until `id` is the full-screen element, then two frames more: the page hears of it by the fullscreenchange
    // event, which comes a moment after document.fullscreenElement changed (the button's state follows that event).
    const settled = async (id) => {
      await page.waitForFunction((want) => {
        const el = document.fullscreenElement;
        const now = el ? (el === document.documentElement ? 'page' : el.id) : null;
        return now === want;
      }, id, { timeout: 5000 });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    };
    // Who is on top at the middle of `sel`: true when that element (or a child of it) is what a click there would hit.
    const onTop = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    }, sel);
    const rect = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    const pressed = () => page.$eval('#fullscreen', (b) => [b.getAttribute('aria-pressed'), b.classList.contains('on')]);

    // ── the button ──
    check('the FULL SCREEN button is shown by the script, although it is delivered hidden', await page.isVisible('#fullscreen'));
    check('a hidden .btn is really not displayed (its own display must not beat the hidden attribute)', await page.evaluate(() => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.hidden = true;
      document.body.appendChild(b);
      return getComputedStyle(b).display === 'none';
    }));
    const slideshow = await rect('#slideshow');
    const button = await rect('#fullscreen');
    check('it sits on the status line, right of the slideshow button, on the same row', button.l >= slideshow.r && Math.abs(button.t - slideshow.t) < 4, JSON.stringify({ slideshow, button }));
    check('nothing is full screen when the page opens, and the button is not pressed', (await fullscreenId()) === null && JSON.stringify(await pressed()) === '["false",false]');

    // ── the button: the whole page, status line included ──
    await page.click('#fullscreen');
    await settled('page');
    check('FULL SCREEN: the whole page (document element) is the full-screen element', (await fullscreenId()) === 'page');
    check('FULL SCREEN: the status line stays in view and on top (a click there would hit it)', (await onTop('.status')) && (await onTop('#clock')) && (await onTop('#cam-name')));
    check('FULL SCREEN: the picture is still there too', await onTop('#picture-box'));
    check('FULL SCREEN: the button is pressed', JSON.stringify(await pressed()) === '["true",true]', JSON.stringify(await pressed()));
    await page.click('#fullscreen');
    await settled(null);
    check('FULL SCREEN again: back to the normal window, button not pressed', (await fullscreenId()) === null && JSON.stringify(await pressed()) === '["false",false]');

    // ── a click on the picture: the picture alone ──
    await page.click('#picture');
    await settled('picture-box');
    check('PICTURE: the picture box is the full-screen element', (await fullscreenId()) === 'picture-box');
    const box = await rect('#picture-box');
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    check('PICTURE: it covers the whole screen', box.l === 0 && box.t === 0 && Math.round(box.r) === size.w && Math.round(box.b) === size.h, JSON.stringify({ box, size }));
    check('PICTURE: the status line is not on screen — nothing of it is on top (no camera name, clock, countdown, buttons)',
      !(await onTop('.status')) && !(await onTop('#clock')) && !(await onTop('#cam-name')) && !(await onTop('#slideshow')));
    check('PICTURE: the page\'s button is not pressed (the page itself is not the full-screen element)', JSON.stringify(await pressed()) === '["false",false]');
    await page.click('#picture');
    await settled(null);
    check('PICTURE again: back to the normal window, status line in view', (await fullscreenId()) === null && (await onTop('.status')));

    // ── full screen that ends some other way (Esc does the same) ──
    await page.click('#fullscreen');
    await settled('page');
    await page.evaluate(() => document.exitFullscreen());
    await settled(null);
    await page.waitForFunction(() => document.getElementById('fullscreen').getAttribute('aria-pressed') === 'false', null, { timeout: 5000 });
    check('left without the button: the button is not pressed any more', JSON.stringify(await pressed()) === '["false",false]');

    // ── from the whole page to the picture alone ──
    await page.click('#fullscreen');
    await settled('page');
    await page.click('#picture');
    await settled('picture-box');
    check('a click on the picture while the whole page is full screen shows the picture alone', (await fullscreenId()) === 'picture-box' && !(await onTop('.status')));
    await page.click('#picture');
    await settled('page');
    check('…and the next click on it steps back to the whole page full screen (the browser leaves one level), button pressed again, status line in view',
      (await fullscreenId()) === 'page' && JSON.stringify(await pressed()) === '["true",true]' && (await onTop('.status')));
    await page.click('#fullscreen');
    await settled(null);
    check('…and the FULL SCREEN button then leaves full screen for the normal window', (await fullscreenId()) === null && JSON.stringify(await pressed()) === '["false",false]');

    check('no script error on the page', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
}

main().then(summarize, (e) => { console.error(e); failCount += 1; summarize(); });
