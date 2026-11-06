#!/usr/bin/env node
'use strict';
// test_nav_bar_browser.js — the navigation bar (CamLayout::navBar / navBarStyle) and the dashboard's grid / list
// switch (js/dashboard-layout.js) in a REAL browser: it needs a layout engine (LOG OUT at the right end, the
// list layout really stacks the cameras) and real clicks.
//
//   - the bar has DASHBOARD GRID, DASHBOARD LIST, SIMPLE VIEW, SIMPLE LIST, ALL FILES on the left and LOG OUT at the right end
//   - a click on DASHBOARD LIST stacks the cameras in one column without leaving the page; GRID brings the columns back;
//     the marked link follows, the choice is remembered over a reload, and ?layout= in the address wins
//   - a click on another link (ALL FILES) is a normal navigation (not swallowed)
//   - on a phone-wide window the page does not scroll sideways and LOG OUT stays reachable (the bar scrolls)
//
// Needs `php` (the real CamLayout writes the bar) and the playwright package with a browser; says SKIP and passes
// if either is missing.
//
// Usage:  node tests/dom/test_nav_bar_browser.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');

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

// The page: the real bar and its style, a grid like the dashboard's (same ids and class), the real script.
function pageHtml(key) {
  const php = [
    'require "' + DASH_SRC + '/lib/Logic.php"; require "' + DASH_SRC + '/lib/Layout.php";',
    'echo "<style>:root{--surface:#111520;--border:#1e2840;--border-light:#3c4d80;--text:#cdd8f0;--accent:#00e5ff;--mono:monospace}',
    'body{margin:0} .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px} .grid.layout-list{grid-template-columns:1fr} .cam{height:40px;background:#333}",',
    'CamLayout::navBarStyle(), "</style>", CamLayout::navBar("' + key + '");',
  ].join(' ');
  const r = spawnSync('php', ['-r', php], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('php failed: ' + r.stderr);
  const js = fs.readFileSync(path.join(DASH_SRC, 'js/dashboard-layout.js'), 'utf8');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>'
    + r.stdout + '<div class="grid" id="grid"><div class="cam"></div><div class="cam"></div><div class="cam"></div><div class="cam"></div></div>'
    + '<script>' + js + '</script><script>CamDashboardLayout.wire({ document, location, history, storage: localStorage });</script></body></html>';
}

async function main() {
  if (!chromium) { console.log('SKIP: the playwright package is not installed.'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    // Served from a real address (localStorage and history need one); every path gets the page, ALL FILES gets a marker.
    await context.route('http://nav.test/**', (route) => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/all-recordings.php' ? '<!DOCTYPE html><title>files</title>' : pageHtml('dashboard-grid');
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const page = await context.newPage();
    await page.goto('http://nav.test/');

    const labels = await page.$$eval('.site-nav > a', (as) => as.map((a) => a.textContent));
    check('the bar has the five links in order', JSON.stringify(labels) === JSON.stringify(['⊞ DASHBOARD GRID', '☰ DASHBOARD LIST', '▣ SIMPLE VIEW', '▦ SIMPLE LIST', '📼 ALL FILES']), JSON.stringify(labels));
    const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    const logout = await box('.nav-logout');
    const lastLink = await box('.site-nav > a:last-of-type');
    check('LOG OUT is at the right end of the bar, after every link, on the same row', logout.r > 1200 - 40 && logout.l > lastLink.r && Math.abs(logout.t - lastLink.t) < 4, JSON.stringify({ logout, lastLink }));

    const columns = () => page.$eval('#grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    const current = () => page.$$eval('.site-nav a.current', (as) => as.map((a) => a.dataset.nav));
    check('starts as a grid with the grid link marked', (await columns()) === 2 && JSON.stringify(await current()) === '["dashboard-grid"]');

    await page.evaluate(() => { window.__sameDocument = true; });
    await page.click('[data-nav="dashboard-list"]');
    check('DASHBOARD LIST: one column, the list link marked, the address says so, and the page was not reloaded', (await columns()) === 1
      && JSON.stringify(await current()) === '["dashboard-list"]' && page.url() === 'http://nav.test/?layout=list' && (await page.evaluate(() => window.__sameDocument === true)));
    await page.reload();
    check('…the address wins on a reload', (await columns()) === 1);
    await page.goto('http://nav.test/');
    check('…and the browser remembers it for the plain address', (await columns()) === 1 && JSON.stringify(await current()) === '["dashboard-list"]');
    await page.goto('http://nav.test/?layout=grid');
    check('?layout=grid beats the remembered list', (await columns()) === 2 && JSON.stringify(await current()) === '["dashboard-grid"]');
    await page.click('[data-nav="dashboard-grid"]');
    check('DASHBOARD GRID brings the columns back', (await columns()) === 2);

    await page.click('[data-nav="all-files"]');
    check('ALL FILES is a normal navigation', page.url() === 'http://nav.test/all-recordings.php');

    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto('http://nav.test/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('on a phone-wide window the page does not scroll sideways', overflow <= 0, 'overflow ' + overflow);
    await page.$eval('.nav-logout', (el) => el.scrollIntoView());
    const reach = await box('.nav-logout');
    check('…and LOG OUT can be scrolled into view in the bar', reach.r <= 360 + 1 && reach.l >= 0, JSON.stringify(reach));
  } finally {
    await browser.close();
  }
}

main().then(summarize, (e) => { console.error(e); failCount += 1; summarize(); });
