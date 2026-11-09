#!/usr/bin/env node
'use strict';
// test_files_list_layout_browser.js — where the buttons of the footage list's rows (PLAY / GET / DEL, RESTORE in the
// archive) are, in a REAL browser: it needs a layout engine (which jsdom does not have). The page is the real
// all-recordings.php's own <style> (its PHP parts expanded by the real CamLayout, so the real list style and the page's
// own rules meet as they do for the person), with the real lib/recordings-list.js drawing the rows from a faked
// recordings.php (an answer per request, no relay needed).
//
//   - on a small screen (320 / 360 / 390 / 600 px wide, the page in a phone's viewport):
//       - the page does not scroll sideways — nothing runs off the screen, whatever the row carries (a person's
//         picture, a "check failed" note, a long file size)
//       - every row's buttons are on ONE line of their own, below the name and size, floated right: their right end is
//         the row's right end, and they start at the same place in every row (the size's width no longer moves them)
//       - the file name is not squeezed away: it is shown in full (it may use several lines)
//   - on a wide screen (768 / 1280 px) the buttons stay where they were: on the line of the name and size, at its right end
//   - the archive's rows (PLAY / GET / RESTORE) are laid out the same way
//
// Needs `php` (to read the page's style through the real CamLayout) and the playwright package with a browser
// (npm install playwright in any folder on NODE_PATH, or globally); says SKIP and passes if either is missing.
//
// Usage:  node tests/dom/test_files_list_layout_browser.js
// Exit code: 0 if every check passed (or something needed is missing), 1 otherwise.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const ORIGIN = 'http://camdash.test';
const SMALL_WIDTHS = [320, 360, 390, 600];
const WIDE_WIDTHS = [768, 1280];
const SUBPIXEL = 1.5;   // layout positions are fractional; "the same place" means the same to a pixel and a half

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

// The <style> of the real all-recordings.php, its PHP parts (CamLayout::...()) expanded by the real CamLayout.
function pageStyle() {
  const php = [
    'require "' + DASH_SRC + '/lib/Layout.php";',
    '$src = file_get_contents("' + DASH_SRC + '/all-recordings.php");',
    'preg_match("/<style>(.*?)<\\/style>/s", $src, $m);',
    'echo preg_replace_callback("/<\\?= (CamLayout::\\w+\\(\\)) \\?>/", static function ($x) { return eval("return " . $x[1] . ";"); }, $m[1]);',
  ].join(' ');
  const r = spawnSync('php', ['-r', php], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('php failed: ' + r.stderr);
  return r.stdout;
}

const stamp = (day) => `cam1_2026-11-0${day}T14-05-09-000Z.mp4`;
// Footage that makes a row hard to lay out: the shortest and a very long size, a person's picture (96 px wide) and a
// "check failed" note (long text), and plain rows between them; the first one unseen.
const FILES = [
  { filename: stamp(6), sizeBytes: 10, seen: false },
  { filename: stamp(5), sizeBytes: 3355443, seen: false, person: true },
  { filename: stamp(4), sizeBytes: 2048, seen: true },
  { filename: stamp(3), sizeBytes: 155189248, seen: true, scan: { state: 'error', reason: 'timeout' } },
  { filename: stamp(2), sizeBytes: 12345678, seen: true },
];
const ARCHIVED = [
  { filename: stamp(1), sizeBytes: 5, seen: true },
  { filename: `cam1_2026-10-3${1}T14-05-09-000Z.mp4`, sizeBytes: 155189248, seen: true },
];
const THUMB = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54"><rect width="96" height="54" fill="#456"/></svg>';

function pageHtml() {
  const script = fs.readFileSync(path.join(DASH_SRC, 'lib/recordings-list.js'), 'utf8');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${pageStyle()}</style></head><body><main>
  <div class="files-panel open" id="files-all"><div class="files-empty">Loading…</div></div>
</main><script>${script}</script>
<script>
  window.list = CamRecordingsList.create({ panel: document.getElementById('files-all'), prefix: 'all', cams: ['cam1'], camLabel: () => '🚪 Front door' });
  window.listed = window.list.refresh();
</script></body></html>`;
}

// What recordings.php answers: the archive's count, the archive's list, a person's picture, or the list.
function fakeRecordings(route) {
  const q = new URL(route.request().url()).searchParams;
  if (q.has('thumb')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: THUMB });
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (q.has('archiveList')) return json(ARCHIVED);
  if (q.has('archive')) return json({ count: ARCHIVED.length });
  return json(FILES);
}

// What a row looks like on the screen: boxes of its parts, in CSS pixels.
const MEASURE = () => {
  const box = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
  const rows = (all) => all.map((row) => {
    const name = row.querySelector('.files-name');
    return {
      row: box(row),
      name: Object.assign(box(name), { clipped: name.scrollWidth > name.clientWidth + 1, text: name.textContent }),
      size: box(row.querySelector('.files-size')),
      hasScan: row.querySelector('.files-scan') !== null,
      buttons: [...row.querySelectorAll('.files-actions .cam-btn')].map(box),
      allButtons: row.querySelectorAll('.cam-btn').length,
    };
  });
  // The archive (when open) is drawn inside the panel too, but its rows end in RESTORE, not DEL: told apart here.
  const inArchive = (row) => row.closest('.files-archive') !== null;
  const everyRow = [...document.querySelectorAll('#files-all .files-row')];
  return {
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    main: rows(everyRow.filter((row) => !inArchive(row))),
    archive: rows(everyRow.filter(inArchive)),
  };
};

const near = (a, b) => Math.abs(a - b) <= SUBPIXEL;
const describe = (r) => `row at ${Math.round(r.row.top)}: buttons ${r.buttons.map((b) => `${Math.round(b.left)}-${Math.round(b.right)}@${Math.round(b.top)}`).join(' ')}, row right ${Math.round(r.row.right)}`;

function checkSmall(width, m) {
  const label = `${width}px`;
  check(`${label}: the page does not scroll sideways (the header's four buttons with an archive included)`, m.scrollWidth <= m.viewport, `scrollWidth ${m.scrollWidth} > ${m.viewport}`);
  check(`${label}: every row has its three buttons in the actions box`, m.main.length === 5 && m.main.every((r) => r.buttons.length === 3 && r.allButtons === 3));
  for (const [kind, rows] of [['rows', m.main], ['archive rows', m.archive]]) {
    if (rows.length === 0) continue;
    if (!rows.every((r) => r.buttons.length === 3)) { check(`${label}: ${kind}: the buttons can be measured (three in each actions box)`, false); continue; }
    check(`${label}: ${kind}: the buttons are on one line`, rows.every((r) => r.buttons.every((b) => near(b.top, r.buttons[0].top))), rows.map(describe).join(' | '));
    check(`${label}: ${kind}: the buttons are floated right (their right end is the row's)`, rows.every((r) => near(r.buttons[2].right, r.row.right)), rows.map(describe).join(' | '));
    check(`${label}: ${kind}: the buttons start at the same place in every row`, rows.every((r) => r.buttons.every((b, i) => near(b.left, rows[0].buttons[i].left))), rows.map(describe).join(' | '));
    check(`${label}: ${kind}: the buttons are on a line of their own, below the name and the size`, rows.every((r) => r.buttons[0].top >= r.name.bottom - SUBPIXEL && r.buttons[0].top >= r.size.bottom - SUBPIXEL), rows.map(describe).join(' | '));
    check(`${label}: ${kind}: the buttons stay inside the screen`, rows.every((r) => r.buttons[0].left >= 0 && r.buttons[2].right <= m.viewport), rows.map(describe).join(' | '));
    check(`${label}: ${kind}: the file name is shown in full, not squeezed or cut`, rows.every((r) => r.name.width >= 60 && !r.name.clipped), rows.map((r) => `${r.name.text}: ${Math.round(r.name.width)}px${r.name.clipped ? ' cut' : ''}`).join(' | '));
  }
  // (a row with a "check failed" note has the note after the size when both fit one line, so it is left out here)
  const plain = m.main.filter((r) => !r.hasScan);
  check(`${label}: the size is at the right end of the row, whether or not it shares the line with the name`, plain.length === 4 && plain.every((r) => near(r.size.right, r.row.right)), plain.map((r) => `${Math.round(r.size.right)}/${Math.round(r.row.right)}`).join(' '));
}

function checkWide(width, m) {
  const label = `${width}px`;
  check(`${label}: the page does not scroll sideways`, m.scrollWidth <= m.viewport);
  if (!m.main.every((r) => r.buttons.length === 3)) { check(`${label}: the buttons can be measured (three in each actions box)`, false); return; }
  check(`${label}: the buttons stay on the line of the name and size, to their right`,
    m.main.every((r) => r.buttons.length === 3 && r.buttons[0].left >= r.size.right && r.buttons[0].top < r.name.bottom && r.buttons[0].bottom > r.name.top), m.main.map(describe).join(' | '));
  check(`${label}: the buttons end at the row's right end`, m.main.every((r) => near(r.buttons[2].right, r.row.right)));
  check(`${label}: a row without a picture is one line high`, m.main.filter((r, i) => i !== 1).every((r) => r.row.bottom - r.row.top < 30), m.main.map((r) => Math.round(r.row.bottom - r.row.top)).join(' '));
  check(`${label}: the names are one line, cut with an ellipsis if need be, as before`, m.main.every((r) => r.name.bottom - r.name.top < 30));
}

async function measureAt(browser, width, { openArchive }) {
  const small = width <= 700;
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, isMobile: small, hasTouch: small });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/recordings.php**`, fakeRecordings);
  await page.route(`${ORIGIN}/index.html`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }));
  await page.goto(`${ORIGIN}/index.html`);
  await page.evaluate(() => window.listed);
  await page.waitForSelector('.files-row');
  await page.waitForFunction(() => [...document.querySelectorAll('.files-thumb')].every((i) => i.complete));
  if (openArchive) {
    await page.click('#files-browse-archive-all');
    await page.waitForSelector('.files-archive .files-row');
  }
  const m = await page.evaluate(MEASURE);
  await page.close();
  return { m, errors };
}

async function main() {
  if (!chromium) { console.log('SKIP: the playwright package is not installed (npm install playwright), so the list was not laid out in a browser.'); finished = true; return; }
  if (spawnSync('php', ['-v']).status !== 0) { console.log('SKIP: php was not found on PATH.'); finished = true; return; }

  let browser = null;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log('SKIP: no browser could be started for playwright (' + String(e.message).split('\n')[0] + ').');
    finished = true;
    return;
  }

  try {
    const page = fs.readFileSync(path.join(DASH_SRC, 'all-recordings.php'), 'utf8');
    check('the real all-files page has the list panel this test copies, and draws it with the shared list style',
      /<div class="files-panel open" id="files-all">/.test(page) && page.includes('CamLayout::recordingsListStyle()'));

    const errors = [];
    for (const width of SMALL_WIDTHS) {
      const { m, errors: e } = await measureAt(browser, width, { openArchive: true });
      errors.push(...e);
      checkSmall(width, m);
    }
    for (const width of WIDE_WIDTHS) {
      const { m, errors: e } = await measureAt(browser, width, { openArchive: false });
      errors.push(...e);
      checkWide(width, m);
    }
    check('no error was raised on the page', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('the test ran to its end', false, e.stack || String(e));
  } finally {
    await browser.close();
  }
  summarize();
}

main().catch((e) => { console.error(e); finished = true; process.exitCode = 1; });
