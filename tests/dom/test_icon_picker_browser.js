#!/usr/bin/env node
'use strict';
// test_icon_picker_browser.js — the icon chooser bubble of the camera settings page (js/icon-picker.js, js/icon-catalog.js,
// CamLayout::iconPickerStyle) in a REAL browser: it needs a layout engine (where the bubble is, which icon is in which
// row, who has the focus), which jsdom does not have. The pages are the real camera-settings-page.php's and
// settings-page.php's own <style> and their icon rows, with the real scripts.
//
//   - a click on the icon input opens the bubble under it, with the search bar on top and the icons below
//   - typing in the search narrows the icons (name, search words), no match says so, hostile text is only text
//   - a click on an icon, or Enter in the search, puts it in the input (the page's input / change handlers run),
//     and closes the bubble with the focus back on the input
//   - Esc, a click outside and Tab out close it; a click on the input opens it again; typing a custom icon by hand works
//   - the arrow keys move through the icons (and up from the first row to the search bar)
//   - the bubble stays on the screen on a phone-wide window, and the input keeps its width
//
// Needs `php` (to read the page's style through the real CamLayout) and the playwright package with a browser
// (npm install playwright in any folder on NODE_PATH, or globally); says SKIP and passes if either is missing.
//
// Usage:  node tests/dom/test_icon_picker_browser.js
// Exit code: 0 if every check passed (or something needed is missing), 1 otherwise.

const fs = require('fs');
const os = require('os');
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

// The page: the real settings page's <style> (PHP parts expanded by the real CamLayout), its icon row, and the same
// two script tags and attach() call it has — nothing else of the page (it needs a relay to fill itself).
// The <style> of one of the real pages, its PHP parts (CamLayout::...()) expanded by the real CamLayout.
function pageStyle(file) {
  const php = [
    'require "' + DASH_SRC + '/lib/Layout.php";',
    '$src = file_get_contents("' + DASH_SRC + '/' + file + '");',
    'preg_match("/<style>(.*?)<\\/style>/s", $src, $m);',
    'echo preg_replace_callback("/<\\?= (CamLayout::\\w+\\(\\)) \\?>/", static function ($x) { return eval("return " . $x[1] . ";"); }, $m[1]);',
  ].join(' ');
  const r = spawnSync('php', ['-r', php], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('php failed: ' + r.stderr);
  return r.stdout;
}

function buildPage(dir) {
  const style = pageStyle('camera-settings-page.php');
  const page = fs.readFileSync(path.join(DASH_SRC, 'camera-settings-page.php'), 'utf8');
  const hasRow = /<div class="inline">\s*<input id="e-icon" class="icon" maxlength="8" aria-label="Icon" autocomplete="off">\s*<input id="e-name"/.test(page);
  const wired = /window\.CamIconPicker\.attach\(\$\('e-icon'\), window\.CamIconCatalog\.GROUPS\)/.test(page)
    && page.includes('<script src="js/icon-catalog.js"></script>') && page.includes('<script src="js/icon-picker.js"></script>');
  fs.mkdirSync(path.join(dir, 'js'));
  for (const f of ['icon-catalog.js', 'icon-picker.js']) fs.copyFileSync(path.join(DASH_SRC, 'js', f), path.join(dir, 'js', f));
  fs.writeFileSync(path.join(dir, 'page.html'), `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${style}</style></head><body><main>
<fieldset id="entry"><legend>On the dashboard</legend>
<div class="inline">
  <input id="e-icon" class="icon" maxlength="8" aria-label="Icon" autocomplete="off" value="📷">
  <input id="e-name" maxlength="60" aria-label="Name" autocomplete="off" value="Garage">
  <button class="btn" id="e-save">SAVE NAME</button>
</div></fieldset>
<p id="below">text below</p>
<script src="js/icon-catalog.js"></script>
<script src="js/icon-picker.js"></script>
<script>
  window.events = [];
  const $ = (id) => document.getElementById(id);
  $('e-icon').addEventListener('input', () => window.events.push('input:' + $('e-icon').value));
  $('e-icon').addEventListener('change', () => window.events.push('change:' + $('e-icon').value));
  window.CamIconPicker.attach($('e-icon'), window.CamIconCatalog.GROUPS);
</script></main></body></html>`);
  return { hasRow, wired };
}

// The main settings page: its add-a-camera row (the real markup, copied) in the real style, with its fixed save bar.
function buildSettingsPage(dir) {
  const style = pageStyle('settings-page.php');
  const page = fs.readFileSync(path.join(DASH_SRC, 'settings-page.php'), 'utf8');
  const row = page.match(/<div class="add">[\s\S]*?<\/div>/);
  const wired = /window\.CamIconPicker\.attach\(\$\('c-icon'\), window\.CamIconCatalog\.GROUPS\)/.test(page)
    && page.includes('<script src="js/icon-catalog.js"></script>') && page.includes('<script src="js/icon-picker.js"></script>');
  fs.writeFileSync(path.join(dir, 'settings.html'), `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${style}</style></head><body><main>
<fieldset class="cams"><legend>Cameras on the dashboard</legend>
<div style="height:520px"></div>
${row ? row[0] : ''}
</fieldset></main>
<div class="savebar"><button class="btn primary" id="save">APPLY</button></div>
<script src="js/icon-catalog.js"></script>
<script src="js/icon-picker.js"></script>
<script>
  const $ = (id) => document.getElementById(id);
  window.CamIconPicker.attach($('c-icon'), window.CamIconCatalog.GROUPS);
</script></body></html>`);
  return { found: !!row, wired };
}

async function main() {
  if (!chromium) { console.log('SKIP: the playwright package is not installed (npm install playwright), so the bubble was not tried in a browser.'); finished = true; return; }
  if (spawnSync('php', ['-v']).status !== 0) { console.log('SKIP: php was not found on PATH.'); finished = true; return; }

  let browser = null;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log('SKIP: no browser could be started for playwright (' + String(e.message).split('\n')[0] + ').');
    finished = true;
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camdash-iconpicker-'));
  try {
    const { hasRow, wired } = buildPage(dir);
    check('the real page has the icon row this test copies, and loads and attaches the picker', hasRow && wired);

    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('file://' + path.join(dir, 'page.html'));

    const bubble = page.locator('.icon-bubble');
    const input = page.locator('#e-icon');
    const search = page.locator('.icon-search');
    const choices = page.locator('.icon-choice');
    const events = () => page.evaluate(() => window.events.slice());
    const focused = () => page.evaluate(() => (document.activeElement ? (document.activeElement.id || document.activeElement.className) : ''));
    const box = (sel) => page.locator(sel).first().boundingBox();

    // ── closed to begin with; the input is where it was ─────────────
    check('closed at the start: no bubble to see, the input says it can open one', !(await bubble.isVisible()) && (await input.getAttribute('aria-expanded')) === 'false' && (await input.getAttribute('aria-haspopup')) === 'dialog');
    const before = await box('#e-icon');
    check('the input keeps its place in the row and its width (90px)', Math.abs(before.width - 90) < 1.5, JSON.stringify(before));

    // ── open ────────────────────────────────────────────────────────
    await input.click();
    check('a click on the input opens the bubble, and says so', (await bubble.isVisible()) && (await input.getAttribute('aria-expanded')) === 'true');
    check('the search bar has the focus: type to find', (await focused()) === 'icon-search');
    const total = await choices.count();
    check('every icon of the catalog is offered, in groups with titles', total >= 100 && (await page.locator('.icon-group').count()) >= 5, String(total));
    const b = await box('.icon-bubble');
    const s = await box('.icon-search');
    const firstIcon = await box('.icon-choice');
    const inputBox = await box('#e-icon');
    check('the bubble is under the input, with the search bar on top of the icons', b.y >= inputBox.y + inputBox.height && s.y < firstIcon.y && s.y >= b.y, JSON.stringify({ b, s, firstIcon }));
    check('the bubble is fully on the screen', b.x >= 0 && b.x + b.width <= 1000 && b.y + b.height <= 700, JSON.stringify(b));
    check('the icon that is set is marked', (await page.locator('.icon-choice.selected').count()) === 1 && (await page.locator('.icon-choice.selected').getAttribute('data-icon')) === '📷');
    check('every icon button has a name for screen readers and a tooltip', (await page.locator('.icon-choice:not([aria-label]):not([title])').count()) === 0);
    check('the icons are drawn (not empty boxes): a button is as wide as the style says', Math.abs(firstIcon.width - 40) < 1.5, JSON.stringify(firstIcon));

    // ── search ──────────────────────────────────────────────────────
    await search.fill('door');
    const doorIcons = await choices.evaluateAll((els) => els.map((e) => e.dataset.icon));
    check('typing "door" narrows the icons to the matches, the best first, without group titles', doorIcons[0] === '🚪' && doorIcons.length < 10 && (await page.locator('.icon-group').count()) === 0, JSON.stringify(doorIcons));
    await search.fill('living sofa');
    check('several words must all fit', JSON.stringify(await choices.evaluateAll((els) => els.map((e) => e.dataset.icon))) === JSON.stringify(['🛋️']));
    await search.fill('zzzz');
    check('no match says so', (await choices.count()) === 0 && (await page.locator('.icon-empty').textContent()) === 'No icon found');
    await search.fill('');
    check('an empty search brings every icon and the groups back', (await choices.count()) === total && (await page.locator('.icon-group').count()) >= 5);
    await search.fill('<img src=x onerror="window.pwned=1"><b>x</b>');
    check('hostile text in the search is only text: nothing is added to the page, nothing runs', (await page.locator('.icon-bubble img, .icon-bubble b').count()) === 0 && (await page.evaluate(() => window.pwned)) === undefined && (await choices.count()) === 0);
    await search.fill('');

    // ── choose by click ─────────────────────────────────────────────
    await search.fill('garage');
    await page.locator('.icon-choice[data-icon="🚗"]').click();
    check('a click on an icon puts it in the input', (await input.inputValue()) === '🚗');
    check('…announces it like typing (input and change, with the new value) so the page notices', JSON.stringify(await events()) === JSON.stringify(['input:🚗', 'change:🚗']), JSON.stringify(await events()));
    check('…closes the bubble and gives the focus back to the input', !(await bubble.isVisible()) && (await focused()) === 'e-icon' && (await input.getAttribute('aria-expanded')) === 'false');
    check('…and the focus going back does not open it again', !(await bubble.isVisible()));

    // ── open again, Esc, outside, Tab ───────────────────────────────
    await input.click();
    check('a click on the input opens it again, and the chosen icon is the marked one', (await bubble.isVisible()) && (await page.locator('.icon-choice.selected').getAttribute('data-icon')) === '🚗' && (await search.inputValue()) === '');
    await page.keyboard.press('Escape');
    check('Esc closes the bubble and gives the focus back to the input', !(await bubble.isVisible()) && (await focused()) === 'e-icon');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('X');
    check('after Esc the input is a plain input again: a custom icon can be typed, the bubble stays closed', (await input.inputValue()) === 'X' && !(await bubble.isVisible()));
    await input.click();
    check('a click on the focused input opens the bubble', await bubble.isVisible());
    await page.mouse.click(600, 600);
    check('a click outside closes it', !(await bubble.isVisible()));
    await input.click();
    await page.keyboard.press('Tab');   // from the search bar to the first icon: still inside
    check('Tab inside the bubble stays inside', (await bubble.isVisible()) && (await focused()) === 'icon-choice');
    await page.locator('#e-name').focus();
    check('moving the focus to another field closes it', !(await bubble.isVisible()));
    await page.locator('#e-name').click();
    check('the neighbouring field works as usual (clicking it opens nothing)', !(await bubble.isVisible()) && (await focused()) === 'e-name');

    // ── Enter chooses the first match ───────────────────────────────
    await input.click();
    await search.fill('dog');
    await page.keyboard.press('Enter');
    check('Enter in the search chooses the first match', (await input.inputValue()) === '🐶' && !(await bubble.isVisible()));
    await input.click();
    await search.fill('zzzz');
    await page.keyboard.press('Enter');
    check('Enter with nothing found chooses nothing and keeps the bubble', (await input.inputValue()) === '🐶' && (await bubble.isVisible()));
    await page.keyboard.press('Escape');

    // ── arrow keys ──────────────────────────────────────────────────
    await input.click();
    await page.keyboard.press('ArrowDown');
    check('ArrowDown in the search goes to the first icon', (await focused()) === 'icon-choice' && (await page.evaluate(() => document.activeElement.dataset.icon)) === '📷');
    await page.keyboard.press('ArrowRight');
    check('ArrowRight goes to the next icon', (await page.evaluate(() => document.activeElement.dataset.icon)) === '📹');
    await page.keyboard.press('ArrowDown');
    const cols = await page.evaluate(() => { const l = Array.from(document.querySelectorAll('.icon-choice')); return l.filter((c) => c.offsetTop === l[0].offsetTop).length; });
    const all = await choices.evaluateAll((els) => els.map((e) => e.dataset.icon));
    check('ArrowDown goes one row down (the icons in a row: ' + cols + ')', (await page.evaluate(() => document.activeElement.dataset.icon)) === all[1 + cols], String(cols));
    await page.keyboard.press('ArrowUp');
    check('ArrowUp goes one row up', (await page.evaluate(() => document.activeElement.dataset.icon)) === '📹');
    await page.keyboard.press('ArrowUp');
    check('ArrowUp from the first row goes back to the search bar', (await focused()) === 'icon-search');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');   // a native button: Enter chooses it
    check('Enter on a focused icon chooses it', (await input.inputValue()) === '📷' && !(await bubble.isVisible()));

    // ── a phone-wide window ─────────────────────────────────────────
    await page.setViewportSize({ width: 360, height: 640 });
    await input.click();
    const small = await box('.icon-bubble');
    check('on a 360px wide window the bubble is still fully on the screen', small.x >= 0 && small.x + small.width <= 360, JSON.stringify(small));
    check('…and the search bar and the first icons are both visible', (await box('.icon-search')).y + 20 < 640 && (await box('.icon-choice')).y + 40 <= 640);
    const arrowX = await page.evaluate(() => parseFloat(document.querySelector('.icon-bubble').style.getPropertyValue('--arrow-x')));
    const inputNow = await box('#e-icon');
    check('…and its arrow still points at the input', small.x + arrowX + 6 >= inputNow.x && small.x + arrowX + 6 <= inputNow.x + inputNow.width, JSON.stringify({ small, arrowX, inputNow }));
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.waitForTimeout(100);
    const wide = await box('.icon-bubble');
    check('widening the window while it is open puts it back under the input', Math.abs(wide.x - (await box('#e-icon')).x) < 1.5 && (await page.evaluate(() => document.querySelector('.icon-bubble').style.left)) === '', JSON.stringify(wide));
    await page.keyboard.press('Escape');

    // ── the main settings page: the new camera's icon ───────────────
    const settings = buildSettingsPage(dir);
    check('the real settings page has the add-a-camera row this test copies, and loads and attaches the picker', settings.found && settings.wired);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('file://' + path.join(dir, 'settings.html'));
    await page.locator('#c-icon').scrollIntoViewIfNeeded();
    const cBefore = await box('#c-icon');
    check('the new camera\'s icon input keeps its width (80px) in the add row', Math.abs(cBefore.width - 80) < 1.5, JSON.stringify(cBefore));
    await page.locator('#c-icon').click();
    check('a click on it opens the bubble, with the search bar in focus', (await page.locator('.icon-bubble').isVisible()) && (await focused()) === 'icon-search');
    await page.locator('.icon-search').fill('tractor');
    await page.locator('.icon-choice').first().click();
    check('a chosen icon goes into the new camera\'s icon input', (await page.locator('#c-icon').inputValue()) === '🚜' && !(await page.locator('.icon-bubble').isVisible()));
    await page.locator('#c-icon').click();
    const sb = await box('.savebar');
    const bb = await box('.icon-bubble');
    const overlap = Math.max(0, Math.min(bb.y + bb.height, sb.y + sb.height) - Math.max(bb.y, sb.y));
    const probe = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? !!el.closest('.icon-bubble') : false; }, { x: bb.x + bb.width / 2, y: Math.min(bb.y + bb.height - 8, sb.y + 8) });
    check('where the bubble and the fixed save bar meet, the bubble is on top', overlap === 0 || probe, JSON.stringify({ bb, sb, overlap, probe }));
    await page.keyboard.press('Escape');

    check('no error was raised on the page', errors.length === 0, errors.join(' | '));
    await page.close();
  } catch (e) {
    check('the test ran without an unexpected error', false, e && e.stack ? e.stack : String(e));
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarize();
}

main();
