#!/usr/bin/env node
'use strict';
// test_simple_view_swipe_browser.js — the simple view's swipe paging (#168) in a REAL browser: a pointer
// pipeline (setPointerCapture, the pointercancel path, which element a click really hits) needs a real
// engine, the pure verdict is unit-tested in tests/node/test_simple_logic.js and the glue here only wires
// it. The page is the real simple-view.php markup (CamLayout::simpleViewPage), the scripts are the real
// files of php/cameras/js; only the relay side (mux.php) is left unanswered, so no picture ever arrives
// (the swipe works on the picture box whatever its <img> shows).
//
//   - a horizontal drag left past the threshold pages to the NEXT camera (the name and the address follow)
//   - a horizontal drag right goes back to the previous one (wrapping at both ends, like the buttons)
//   - while the finger is down the picture follows it (a transform, no transition), and on release it
//     returns to rest
//   - a committed swipe does NOT throw the page into full screen (the click the pointer ends with is
//     swallowed), while a plain click still toggles the picture's full screen as before
//   - a short drag (under the threshold) is no page change
//   - the page raised no script error on the way
//
// Needs `php` (the real CamLayout writes the page) and the playwright package with a browser; says SKIP
// and passes if one is missing.
//
// Usage:  node tests/dom/test_simple_view_swipe_browser.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const ORIGIN = 'http://camdash.test';
const CAMERAS = [{ id: 'cam-a', name: 'Cam A', icon: '🚪' }, { id: 'cam-b', name: 'Cam B', icon: '🚗' }, { id: 'cam-c', name: 'Cam C', icon: '🌳' }];

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

    const shown = () => page.evaluate(() => document.getElementById('cam-name').textContent);
    const drag = async (x0, y0, x1, y1, steps = 12) => {
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      }
      await page.mouse.up();
      // the slide-in runs 200 ms; let it settle before anybody looks
      await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    };
    // The picture box's middle (the box flexes with the layout; never assume a fixed size).
    const boxCenter = () => page.evaluate(() => {
      const r = document.getElementById('picture-box').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    });

    // ── a drag left pages to the next camera ──
    let box = await boxCenter();
    await drag(box.x + box.w * 0.4, box.y, box.x - box.w * 0.4, box.y);
    check('a drag left past the threshold shows the NEXT camera', (await shown()) === 'Cam B', await shown());
    check('the address follows the camera the pager picked', page.url().includes('cam=cam-b'), page.url());

    // ── a drag right goes back (and wraps at the first camera) ──
    box = await boxCenter();
    await drag(box.x - box.w * 0.4, box.y, box.x + box.w * 0.4, box.y);
    check('a drag right shows the PREVIOUS camera', (await shown()) === 'Cam A', await shown());
    box = await boxCenter();
    await drag(box.x - box.w * 0.4, box.y, box.x + box.w * 0.4, box.y);
    check('dragging right on the first camera wraps to the last (like the buttons)', (await shown()) === 'Cam C', await shown());

    // ── the picture follows the finger while it is down ──
    await page.evaluate(() => { document.getElementById('picture').style.transition = 'none'; });
    box = await boxCenter();
    await page.mouse.move(box.x + box.w * 0.4, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.1, box.y, { steps: 6 });
    const midDrag = await page.evaluate(() => document.getElementById('picture').style.transform);
    await page.mouse.up();
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    check('while the pointer is down the picture follows it (a transform)', /translateX\(\s*-?\d+(\.\d+)?px\)/.test(midDrag), midDrag);

    // ── a committed swipe must not throw the page into full screen ──
    box = await boxCenter();
    await drag(box.x + box.w * 0.4, box.y, box.x - box.w * 0.4, box.y);
    const afterSwipe = await page.evaluate(() => document.fullscreenElement);
    check('a committed swipe does not toggle the full screen', afterSwipe === null, String(afterSwipe));

    // ── a plain click still toggles the picture's full screen (the guard eats exactly one click) ──
    box = await boxCenter();
    await page.mouse.click(box.x, box.y);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    const clicked = await page.evaluate(() => (document.fullscreenElement ? document.fullscreenElement.id : null));
    check('a plain click on the picture still shows the picture alone full screen', clicked === 'picture-box', String(clicked));
    if (clicked) {
      await page.evaluate(() => document.exitFullscreen().catch(() => {}));
      await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    }

    // ── a short drag is no page change ──
    const before = await shown();
    box = await boxCenter();
    await drag(box.x + 20, box.y, box.x - 20, box.y);
    check('a 40px drag (under the 48px threshold) changes nothing', (await shown()) === before, await shown());

    check('the page raised no script error on the way', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
  summarize();
}

main().catch((e) => { console.error('[FAIL] the test run threw:', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); summarize(); });
