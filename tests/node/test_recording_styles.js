'use strict';

// test_recording_styles.js — the dashboard's recordings list must make seen and unseen footage easy to tell
// apart: unseen is bold AND bright, seen is normal weight AND a readable gray. (Weight alone looked almost the
// same on phones and in some browsers.) This reads the <style> block of php/cameras/index.php and the shared list style in lib/Layout.php as text — no PHP,
// no browser needed — and checks the rules a human would otherwise have to eyeball.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

// The colours (:root) are the dashboard page's own; the list's rules live in CamLayout::recordingsListStyle()
// (lib/Layout.php), which the dashboard and the ALL FILES page share.
const read = (rel) => fs.readFileSync(path.join(__dirname, '../../php/cameras', rel), 'utf8');
const SOURCE = read('index.php') + '\n' + read('lib/Layout.php');
const PANEL_BACKGROUND = '#0d1019';   // .files-panel: rgba(0,0,0,.25) over --surface (#111520), rounded
const MIN_CONTRAST = 4.5;             // WCAG AA for normal text
const MIN_SEEN_UNSEEN_DISTANCE = 1.5; // contrast ratio between the two colours: clearly not "almost the same"

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(SOURCE);
  assertTrue(match, `no CSS rule for "${selector}"`);
  return match[1];
}

function declaration(body, property) {
  const match = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body);
  return match ? match[1] : null;
}

function resolveColor(value) {
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (!variable) return value;
  const root = declaration(ruleBody(':root'), variable[1]);
  assertTrue(root, `${variable[1]} is not defined in :root`);
  return root.replace(/\/\*.*?\*\//g, '').trim();
}

function luminance(hex) {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assertTrue(channels, `not a #rrggbb colour: ${hex}`);
  const [r, g, b] = channels.slice(1).map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const cells = ['.files-name', '.files-size'];
const unseenCells = ['.files-row.unseen .files-name, .files-row.unseen .files-size'];

for (const cell of cells) {
  test(`seen ${cell}: normal weight and a gray colour`, () => {
    const body = ruleBody(cell);
    assertEqual(declaration(body, 'font-weight'), '400');
    const color = resolveColor(declaration(body, 'color'));
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    assertTrue(Math.max(r, g, b) - Math.min(r, g, b) <= 24, `${color} is not gray`);
  });

  test(`seen ${cell}: readable on the panel background`, () => {
    const color = resolveColor(declaration(ruleBody(cell), 'color'));
    assertTrue(contrast(color, PANEL_BACKGROUND) >= MIN_CONTRAST, `${color} contrast ${contrast(color, PANEL_BACKGROUND).toFixed(2)}`);
  });
}

test('unseen name and size: bold and in the bright text colour', () => {
  const body = ruleBody(unseenCells[0]);
  assertEqual(declaration(body, 'font-weight'), '700');
  assertEqual(declaration(body, 'color'), 'var(--text)');
});

test('seen and unseen colours are clearly different, not "almost the same"', () => {
  const seen = resolveColor(declaration(ruleBody('.files-name'), 'color'));
  const unseen = resolveColor(declaration(ruleBody(unseenCells[0]), 'color'));
  assertTrue(contrast(unseen, seen) >= MIN_SEEN_UNSEEN_DISTANCE, `${unseen} vs ${seen}: ${contrast(unseen, seen).toFixed(2)}`);
});

test('name and size share one seen colour (no drift between the two rules)', () => {
  assertEqual(declaration(ruleBody('.files-size'), 'color'), declaration(ruleBody('.files-name'), 'color'));
});

test('the ALL FILES page defines the same seen colour as the dashboard, so its list is as readable', () => {
  const seen = (text) => /--seen:\s*(#[0-9a-fA-F]{6})/.exec(text)[1].toLowerCase();
  assertEqual(seen(read('all-recordings.php')), seen(read('index.php')));
});

test('the ALL FILES page defines every colour variable the shared list style uses', () => {
  const css = /recordingsListStyle\(\): string[\s\S]*?<<<'CSS'\n([\s\S]*?)\nCSS;/.exec(read('lib/Layout.php'))[1];
  const used = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  const page = read('all-recordings.php');
  for (const v of used) assertTrue(new RegExp(`${v}\\s*:`).test(page), `all-recordings.php does not define ${v}`);
});

test('the camera name cell has one fixed width, so the thumbnails next to it line up in every row', () => {
  const body = ruleBody('.files-cam');
  const width = declaration(body, 'width');
  assertTrue(/^\d+(\.\d+)?(ch|em|rem|px)$/.test(width), `not a fixed width: ${width}`);
  assertEqual(declaration(body, 'flex'), `0 0 ${width}`);   // it neither grows nor shrinks with the name
});

test('a camera name longer than its cell is cut with an ellipsis, not wrapped or overflowing', () => {
  const body = ruleBody('.files-cam');
  assertEqual(declaration(body, 'overflow'), 'hidden');
  assertEqual(declaration(body, 'text-overflow'), 'ellipsis');
  assertEqual(declaration(body, 'white-space'), 'nowrap');
});

// ── the row's buttons on a small screen (the layout itself is tried in a browser: tests/dom/test_files_list_layout_browser.js) ──

// The rules of the list's small-screen block, as { selector: body }.
function smallScreenRules() {
  const block = /@media \(max-width: 700px\) \{([\s\S]*?)\n  \}/.exec(read('lib/Layout.php'));
  assertTrue(block, 'no @media (max-width: 700px) block in the list style');
  const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');   // a comment after one rule must not become the start of the next selector
  return Object.fromEntries([...css.matchAll(/([^{}\n][^{}]*?)\s*\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]]));
}

test('the row\'s buttons are one box: a flex line that sits at the right end and never shrinks', () => {
  const body = ruleBody('.files-actions');
  assertEqual(declaration(body, 'display'), 'flex');
  assertEqual(declaration(body, 'margin-left'), 'auto');
  assertEqual(declaration(body, 'flex-shrink'), '0');
});

test('small screen: the row wraps and its buttons get a line of their own, floated right', () => {
  const rules = smallScreenRules();
  assertEqual(declaration(rules['.files-row'], 'flex-wrap'), 'wrap');
  assertEqual(declaration(rules['.files-actions'], 'flex'), '0 0 100%');
  assertEqual(declaration(rules['.files-actions'], 'justify-content'), 'flex-end');
});

test('small screen: the file name may use several lines and is not squeezed below a readable width', () => {
  const body = smallScreenRules()['.files-name'];
  assertEqual(declaration(body, 'white-space'), 'normal');
  assertTrue(/^\d+ch$/.test(declaration(body, 'min-width')), `min-width: ${declaration(body, 'min-width')}`);
});

test('small screen: the size stays at the right and the panel header wraps instead of running off the screen', () => {
  const rules = smallScreenRules();
  assertEqual(declaration(rules['.files-size'], 'margin-left'), 'auto');
  assertEqual(declaration(rules['.files-panel-header'], 'flex-wrap'), 'wrap');
});

test('the small-screen block comes after the base rules it overrides (the cascade is by order)', () => {
  const css = read('lib/Layout.php');
  const at = (s) => css.indexOf(s);
  assertTrue(at('@media (max-width: 700px) {') > Math.max(at('.files-row {'), at('.files-name {'), at('.files-size {'), at('.files-actions {'), at('.files-panel-header {')));
});

test('.cam-btn has an explicit line-height, so a glyph from a fallback font (the 🗑 of DEL) cannot make one button taller than its neighbours', () => {
  const lineHeight = declaration(ruleBody('.cam-btn'), 'line-height');
  assertTrue(lineHeight && lineHeight !== 'normal', `.cam-btn line-height is ${lineHeight === null ? 'not set' : '"' + lineHeight + '"'}; "normal" lets the emoji font set the button's height`);
});

summarize();
