'use strict';

// Tests the motion-area geometry of the dashboard page (php/cameras/index.php) by running exactly the
// block between its <area-geometry> markers: how the rectangle over the detector's picture moves and
// resizes, and that it can never leave the picture or become smaller than the detector accepts.
// (The PHP echoes in the block are replaced by the firmware's constants: 96 and 10.)

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <area-geometry>\n([\s\S]*?)\/\/ <\/area-geometry>/.exec(page);
assertTrue(!!m, 'the page has an <area-geometry> block');
const consts = ['96', '10'];
const code = m[1].replace(/<\?=[^?]*\?>/g, () => consts.shift());
const g = new Function(`${code}\nreturn { AREA_FRAME, AREA_MIN, AREA_KEYS, isAreaKey, dragArea, effectiveArea, fmtArea, isWholePicture };`)();

const whole = { x0: 0, y0: 0, x1: 96, y1: 96 };
const mid = { x0: 20, y0: 30, x1: 70, y1: 80 };

test('the block uses the firmware constants', () => {
  assertEqual(g.AREA_FRAME, 96);
  assertEqual(g.AREA_MIN, 10);
});

test('moving keeps the size and rounds to whole pixels', () => {
  assertEqual(g.dragArea(mid, 'move', 5, -10), { x0: 25, y0: 20, x1: 75, y1: 70 });
  assertEqual(g.dragArea(mid, 'move', 2.4, 2.6), { x0: 22, y0: 33, x1: 72, y1: 83 });
});

test('moving stops at the picture edges', () => {
  assertEqual(g.dragArea(mid, 'move', 500, 500), { x0: 46, y0: 46, x1: 96, y1: 96 });
  assertEqual(g.dragArea(mid, 'move', -500, -500), { x0: 0, y0: 0, x1: 50, y1: 50 });
  assertEqual(g.dragArea(whole, 'move', 30, 30), whole, 'the whole picture cannot move');
});

test('each edge handle moves only its own edge', () => {
  assertEqual(g.dragArea(mid, 'w', 5, 99), { ...mid, x0: 25 });
  assertEqual(g.dragArea(mid, 'e', -5, 99), { ...mid, x1: 65 });
  assertEqual(g.dragArea(mid, 'n', 99, 5), { ...mid, y0: 35 });
  assertEqual(g.dragArea(mid, 's', 99, -5), { ...mid, y1: 75 });
});

test('a corner handle moves its two edges', () => {
  assertEqual(g.dragArea(mid, 'nw', -10, -10), { x0: 10, y0: 20, x1: 70, y1: 80 });
  assertEqual(g.dragArea(mid, 'se', 10, 10), { x0: 20, y0: 30, x1: 80, y1: 90 });
  assertEqual(g.dragArea(mid, 'ne', 10, -10), { x0: 20, y0: 20, x1: 80, y1: 80 });
  assertEqual(g.dragArea(mid, 'sw', -10, 10), { x0: 10, y0: 30, x1: 70, y1: 90 });
});

test('resizing stops at the picture and at the smallest size, edges never cross', () => {
  assertEqual(g.dragArea(mid, 'nw', -500, -500), { x0: 0, y0: 0, x1: 70, y1: 80 });
  assertEqual(g.dragArea(mid, 'se', 500, 500), { x0: 20, y0: 30, x1: 96, y1: 96 });
  assertEqual(g.dragArea(mid, 'w', 500, 0), { ...mid, x0: 60 }, 'left edge stops 10 before the right one');
  assertEqual(g.dragArea(mid, 'e', -500, 0), { ...mid, x1: 30 }, 'right edge stops 10 after the left one');
  assertEqual(g.dragArea(mid, 'n', 0, 500), { ...mid, y0: 70 });
  assertEqual(g.dragArea(mid, 's', 0, -500), { ...mid, y1: 40 });
});

test('whatever is dragged, the result is a usable area: inside the picture, at least 10 wide and high', () => {
  const handles = ['move', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  for (const start of [whole, mid, { x0: 86, y0: 86, x1: 96, y1: 96 }, { x0: 0, y0: 0, x1: 10, y1: 10 }]) {
    for (const h of handles) {
      for (const d of [-300, -37.5, -1, 0, 0.4, 13, 300]) {
        for (const e of [-300, -9.5, 0, 77]) {
          const a = g.dragArea(start, h, d, e);
          const ok = Object.values(a).every(Number.isInteger) && a.x0 >= 0 && a.y0 >= 0 && a.x1 <= 96 && a.y1 <= 96 && a.x1 - a.x0 >= 10 && a.y1 - a.y0 >= 10;
          assertTrue(ok, `${h} ${d},${e} from ${JSON.stringify(start)} gave ${JSON.stringify(a)}`);
        }
      }
    }
  }
});

test('the pending edges lie over what the detector reports', () => {
  assertEqual(g.effectiveArea(mid, {}), mid);
  assertEqual(g.effectiveArea(mid, { MOTION_X0: 25, MOTION_Y1: 90, DARK_THRESH: 5 }), { x0: 25, y0: 30, x1: 70, y1: 90 });
  assertTrue(g.isAreaKey('MOTION_X1') && !g.isAreaKey('MOTION_THRESH') && !g.isAreaKey('MOTION_HOLD_S'), 'only the four edges');
});

test('areas are written and recognised', () => {
  assertEqual(g.fmtArea(mid), '20,30 – 70,80');
  assertTrue(g.isWholePicture(whole) && !g.isWholePicture(mid));
});

summarize();
