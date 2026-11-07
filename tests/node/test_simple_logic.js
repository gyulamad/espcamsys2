'use strict';

// test_simple_logic.js — the rules of the simple camera pages (php/cameras/js/simple-logic.js):
// thumbnail fitting, the pager, and the slideshow with its recording > motion > rest priority.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const S = require('../../php/cameras/js/simple-logic');

const { IDLE, MOTION, RECORDING } = S.PRIORITY;
const IDS = ['a', 'b', 'c', 'd'];
const prio = (o) => Object.assign({ a: IDLE, b: IDLE, c: IDLE, d: IDLE }, o);

// ── fitThumbnails ────────────────────────────────────────────────────

test('fitThumbnails: one camera fills the screen as far as its shape allows', () => {
  const r = S.fitThumbnails({ width: 800, height: 600, count: 1, aspect: 4 / 3, gap: 8, minWidth: 160 });
  assertEqual(r, { cols: 1, width: 800, height: 600 });
});

test('fitThumbnails: a wide, low screen limits the picture by its height, a tall one by its width', () => {
  assertEqual(S.fitThumbnails({ width: 1280, height: 720, count: 1, aspect: 4 / 3, gap: 8, minWidth: 160 }), { cols: 1, width: 960, height: 720 });
  assertEqual(S.fitThumbnails({ width: 600, height: 2000, count: 1, aspect: 4 / 3, gap: 8, minWidth: 160 }), { cols: 1, width: 600, height: 450 });
});

test('fitThumbnails: picks the number of columns that makes the thumbnails biggest', () => {
  // 4 cameras, 1200x700, no gap: 1 column = 233 wide, 2 columns (2 rows of 350 high) = 466, 3 columns = 400, 4 columns = 300
  assertEqual(S.fitThumbnails({ width: 1200, height: 700, count: 4, aspect: 4 / 3, gap: 0, minWidth: 100 }), { cols: 2, width: 466, height: 350 });
});

test('fitThumbnails: of equally big layouts the one with fewer columns is kept', () => {
  assertEqual(S.fitThumbnails({ width: 1000, height: 1000, count: 2, aspect: 1, gap: 0, minWidth: 100 }).cols, 1);
});

test('fitThumbnails: the result never overflows the screen when it can avoid it', () => {
  for (let count = 1; count <= 24; count += 1) {
    const r = S.fitThumbnails({ width: 1280, height: 720, count, aspect: 4 / 3, gap: 8, minWidth: 120 });
    const rows = Math.ceil(count / r.cols);
    assertTrue(rows * r.height + (rows - 1) * 8 <= 720, `count ${count}: ${r.cols} cols of ${r.width}x${r.height} overflow the height`);
    assertTrue(r.width * r.cols + (r.cols - 1) * 8 <= 1280, `count ${count}: too wide`);
    assertTrue(r.width >= 120, `count ${count}: too small`);
  }
});

test('fitThumbnails: never smaller than the minimum — the page scrolls instead', () => {
  const r = S.fitThumbnails({ width: 800, height: 300, count: 30, aspect: 4 / 3, gap: 8, minWidth: 160 });
  assertTrue(r.width >= 160, `width ${r.width}`);
  assertEqual(r.cols, Math.floor((800 + 8) / (160 + 8)));   // 4 columns of the most that fit
  assertTrue(Math.ceil(30 / r.cols) * r.height > 300, 'taller than the screen: it scrolls');
});

test('fitThumbnails: a screen narrower than the minimum still gets one column of the minimum', () => {
  const r = S.fitThumbnails({ width: 100, height: 500, count: 3, minWidth: 160 });
  assertEqual(r.cols, 1);
  assertEqual(r.width, 160);
});

test('fitThumbnails: never more columns than cameras', () => {
  const r = S.fitThumbnails({ width: 4000, height: 300, count: 2, aspect: 4 / 3, gap: 8, minWidth: 100 });
  assertTrue(r.cols <= 2);
});

test('fitThumbnails: nonsense input gives the minimum size, not NaN', () => {
  for (const bad of [{ width: 0, height: 0, count: 3 }, { width: 500, height: 500, count: 0 }, { width: NaN, height: 5, count: 2 }, { width: 500, height: 500, count: 2, aspect: 0 }]) {
    const r = S.fitThumbnails(Object.assign({ minWidth: 160 }, bad));
    assertTrue(Number.isInteger(r.cols) && Number.isInteger(r.width) && Number.isInteger(r.height) && r.cols >= 1 && r.width >= 1, JSON.stringify(r));
  }
});

// ── neighbor ─────────────────────────────────────────────────────────

test('neighbor: next and previous, wrapping at both ends', () => {
  assertEqual(S.neighbor(IDS, 'b', 1), 'c');
  assertEqual(S.neighbor(IDS, 'b', -1), 'a');
  assertEqual(S.neighbor(IDS, 'd', 1), 'a');
  assertEqual(S.neighbor(IDS, 'a', -1), 'd');
});

test('neighbor: a lone camera is its own neighbour; an unknown id starts at the first; no cameras = null', () => {
  assertEqual(S.neighbor(['x'], 'x', 1), 'x');
  assertEqual(S.neighbor(['x'], 'x', -1), 'x');
  assertEqual(S.neighbor(IDS, 'nope', 1), 'a');
  assertEqual(S.neighbor(IDS, 'nope', -1), 'a');
  assertEqual(S.neighbor([], 'a', 1), null);
});

// ── inMotion / priorities ────────────────────────────────────────────

const det = (over) => Object.assign({ online: true, report: { scene: { motion: 500, motionAtLeast: 300 } } }, over);

test('inMotion: the threshold in force (motionLimit, raised by the auto-calibration) counts, not the one that was set', () => {
  const scene = (o) => det({ report: { scene: Object.assign({ motion: 500, motionAtLeast: 300 }, o) } });
  assertEqual(S.inMotion(scene({ motionLimit: 650 })), false, '500 is above MOTION_THRESH but under the limit in force: the detector does not call it motion either');
  assertEqual(S.inMotion(scene({ motionLimit: 500 })), true);
  assertEqual(S.inMotion(scene({ motionLimit: 0 })), false, 'a limit of 0: the motion check is off');
  assertEqual(S.inMotion(scene({})), true, 'no motionLimit (older relay): the set threshold');
  assertEqual(S.inMotion(scene({ motionLimit: 'x' })), true, 'not a number: the set threshold');
});

test('inMotion: at or above the threshold of an online detector', () => {
  assertEqual(S.inMotion(det()), true);
  assertEqual(S.inMotion(det({ report: { scene: { motion: 300, motionAtLeast: 300 } } })), true);
  assertEqual(S.inMotion(det({ report: { scene: { motion: 299, motionAtLeast: 300 } } })), false);
});

test('inMotion: off (threshold 0), offline, no report or odd values are never motion', () => {
  assertEqual(S.inMotion(det({ report: { scene: { motion: 50, motionAtLeast: 0 } } })), false);
  assertEqual(S.inMotion(det({ online: false })), false);
  assertEqual(S.inMotion(det({ online: 'yes' })), false);
  assertEqual(S.inMotion(det({ report: null })), false);
  assertEqual(S.inMotion(det({ report: {} })), false);
  assertEqual(S.inMotion(det({ report: { scene: { motion: '900', motionAtLeast: 300 } } })), false);
  assertEqual(S.inMotion(det({ report: { scene: { motion: NaN, motionAtLeast: 300 } } })), false);
  assertEqual(S.inMotion(null), false);
  assertEqual(S.inMotion(undefined), false);
});

test('isRecording: only a plain true counts; an unknown camera and a failed request are "not recording"', () => {
  const status = { a: { recording: true }, b: { recording: false }, c: {}, d: { recording: 'yes' }, e: { recording: 1 } };
  assertEqual(['a', 'b', 'c', 'd', 'e', 'x'].map((id) => S.isRecording(status, id)), [true, false, false, false, false, false]);
  assertEqual(S.isRecording(null, 'a'), false);
  assertEqual(S.isRecording(undefined, 'a'), false);
  assertEqual(S.isRecording({}, 'a'), false);
});

test('priorities: recording beats motion beats idle; a failed request counts as idle', () => {
  const status = { a: { recording: true }, b: { recording: false }, c: { recording: true } };
  const detectors = { b: det(), c: det(), d: det({ online: false }) };
  assertEqual(S.priorities(IDS, status, detectors), { a: RECORDING, b: MOTION, c: RECORDING, d: IDLE });
  assertEqual(S.priorities(IDS, null, null), prio({}));
  assertEqual(S.priorities(IDS, status, null), { a: RECORDING, b: IDLE, c: RECORDING, d: IDLE });
});

test('priorities: only a real true counts as recording', () => {
  assertEqual(S.priorities(['a'], { a: { recording: 'true' } }, null), { a: IDLE });
  assertEqual(S.priorities(['a'], { a: { recording: 1 } }, null), { a: IDLE });
  assertEqual(S.priorities(['a'], { a: null }, null), { a: IDLE });
});

test('isOffline: only a plain online: false counts (no answer, no camera, an older relay: not known to be offline)', () => {
  assertEqual(S.isOffline({ a: { online: false } }, 'a'), true);
  assertEqual(S.isOffline({ a: { online: true } }, 'a'), false);
  for (const status of [null, undefined, {}, { a: null }, { a: {} }, { a: { online: 0 } }, { a: { online: 'false' } }, { a: { online: null } }]) {
    assertEqual(S.isOffline(status, 'a'), false, JSON.stringify(status));
  }
});

test('priorities: a camera that is not connected is below idle, even when it is "recording"', () => {
  const status = { a: { online: false, recording: true }, b: { online: true }, c: {}, d: { online: false } };
  assertEqual(S.priorities(IDS, status, null), { a: S.PRIORITY.OFFLINE, b: IDLE, c: IDLE, d: S.PRIORITY.OFFLINE });
});

test('nextByPriority: cameras that are not connected are skipped; when all are, they take turns', () => {
  const OFFLINE = S.PRIORITY.OFFLINE;
  assertEqual(S.nextByPriority(IDS, 'a', prio({ b: OFFLINE, c: OFFLINE })), 'd');
  assertEqual(S.nextByPriority(IDS, 'b', prio({ b: OFFLINE, c: OFFLINE })), 'd', 'standing on an offline camera: on to an online one');
  assertEqual(S.nextByPriority(IDS, 'a', prio({ b: OFFLINE, c: OFFLINE, d: OFFLINE })), 'a', 'the only one online stays');
  const all = { a: OFFLINE, b: OFFLINE, c: OFFLINE, d: OFFLINE };
  assertEqual(S.nextByPriority(IDS, 'a', all), 'b');
});

test('createSlideshow: shows no countdown when the other cameras are not connected, and never jumps to one', () => {
  const OFFLINE = S.PRIORITY.OFFLINE;
  const show = S.createSlideshow(['a', 'b'], 'a', 5000, 0);
  const gone = { a: IDLE, b: OFFLINE };
  assertEqual(show.remainingMs(1000, gone), null);
  assertEqual(show.tick(0, gone), null);
  assertEqual(show.tick(9000, gone), null, 'it stays on the one camera that is there');
});

// ── nextByPriority ───────────────────────────────────────────────────

test('nextByPriority: with nothing going on every camera takes its turn, in order', () => {
  assertEqual(S.nextByPriority(IDS, 'a', prio({})), 'b');
  assertEqual(S.nextByPriority(IDS, 'd', prio({})), 'a');
});

test('nextByPriority: cameras that are not recording are skipped while others record', () => {
  assertEqual(S.nextByPriority(IDS, 'a', prio({ a: RECORDING, c: RECORDING })), 'c');
  assertEqual(S.nextByPriority(IDS, 'c', prio({ a: RECORDING, c: RECORDING })), 'a');
});

test('nextByPriority: recording has priority over motion', () => {
  assertEqual(S.nextByPriority(IDS, 'a', prio({ b: MOTION, c: RECORDING })), 'c');
  assertEqual(S.nextByPriority(IDS, 'c', prio({ b: MOTION, c: RECORDING })), 'c');   // alone: stays
});

test('nextByPriority: motion has priority over the rest', () => {
  assertEqual(S.nextByPriority(IDS, 'a', prio({ b: MOTION, d: MOTION })), 'b');
  assertEqual(S.nextByPriority(IDS, 'b', prio({ b: MOTION, d: MOTION })), 'd');
  assertEqual(S.nextByPriority(IDS, 'd', prio({ b: MOTION, d: MOTION })), 'b');
});

test('nextByPriority: from an idle camera the next prioritised one in order is chosen, wrapping', () => {
  assertEqual(S.nextByPriority(IDS, 'c', prio({ a: RECORDING, b: RECORDING })), 'a');
  assertEqual(S.nextByPriority(IDS, 'a', prio({ b: RECORDING, d: RECORDING })), 'b');
});

test('nextByPriority: an unknown current camera starts from the top of the list; no cameras = null', () => {
  assertEqual(S.nextByPriority(IDS, 'gone', prio({})), 'a');
  assertEqual(S.nextByPriority(IDS, 'gone', prio({ c: MOTION })), 'c');
  assertEqual(S.nextByPriority([], 'a', {}), null);
});

// ── jumpTarget ───────────────────────────────────────────────────────

test('jumpTarget: a camera that has just started recording is shown at once', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({ c: RECORDING })), 'c');
});

test('jumpTarget: motion that has just started is shown at once, from an idle camera', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({ b: MOTION })), 'b');
});

test('jumpTarget: a camera that was already recording at the last look does not pull the view again', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({ c: RECORDING }), prio({ c: RECORDING })), null);
});

test('jumpTarget: motion does not pull the view away from a recording camera, recording does', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({ a: RECORDING }), prio({ a: RECORDING, b: MOTION })), null);
  assertEqual(S.jumpTarget(IDS, 'a', prio({ a: RECORDING }), prio({ a: RECORDING, b: RECORDING })), 'b');
});

test('jumpTarget: a camera that goes from motion to recording counts as new', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({ b: MOTION }), prio({ b: RECORDING })), 'b');
});

test('jumpTarget: of several new ones the most interesting wins, then the first in order', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({ b: MOTION, d: RECORDING })), 'd');
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({ c: RECORDING, d: RECORDING })), 'c');
});

test('jumpTarget: the current camera itself never needs a jump; with no previous look all count as new', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({ a: RECORDING })), null);
  assertEqual(S.jumpTarget(IDS, 'a', null, prio({ b: RECORDING })), 'b');
});

test('jumpTarget: nothing happening, or things calming down, is no reason to jump', () => {
  assertEqual(S.jumpTarget(IDS, 'a', prio({}), prio({})), null);
  assertEqual(S.jumpTarget(IDS, 'a', prio({ b: RECORDING }), prio({})), null);
});

// ── createSlideshow ──────────────────────────────────────────────────

test('slideshow: stays for the interval, then moves to the next camera', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  assertEqual(s.tick(1000, prio({})), null);
  assertEqual(s.tick(9999, prio({})), null);
  assertEqual(s.tick(10000, prio({})), 'b');
  assertEqual(s.current(), 'b');
  assertEqual(s.tick(19999, prio({})), null);
  assertEqual(s.tick(20000, prio({})), 'c');
});

test('slideshow: a camera that starts recording is shown at once and gets a full interval', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  assertEqual(s.tick(2000, prio({})), null);
  assertEqual(s.tick(3000, prio({ c: RECORDING })), 'c');
  assertEqual(s.tick(12999, prio({ c: RECORDING })), null);
  assertEqual(s.tick(13000, prio({ c: RECORDING })), null);   // the only recording camera: it stays
  assertEqual(s.current(), 'c');
});

test('slideshow: with several recording cameras it alternates between them only', () => {
  const s = S.createSlideshow(IDS, 'b', 5000, 0);
  const p = prio({ a: RECORDING, c: RECORDING });
  assertEqual(s.tick(100, p), 'a');          // both just started recording: the first one in order
  assertEqual(s.tick(5100, p), 'c');         // b and d are skipped
  assertEqual(s.tick(10100, p), 'a');
});

test('slideshow: moving cameras are shown before idle ones, recording ones before moving ones', () => {
  const s = S.createSlideshow(IDS, 'a', 5000, 0);
  assertEqual(s.tick(100, prio({ d: MOTION })), 'd');
  assertEqual(s.tick(5100, prio({ d: MOTION })), null);                 // alone: stays
  assertEqual(s.tick(6000, prio({ b: MOTION, d: MOTION })), 'b');       // new motion on a camera as interesting as this one: at once
  assertEqual(s.tick(10999, prio({ b: MOTION, d: MOTION })), null);
  assertEqual(s.tick(11000, prio({ b: MOTION, d: MOTION })), 'd');
  assertEqual(s.tick(11100, prio({ b: MOTION, d: MOTION, c: RECORDING })), 'c');
  assertEqual(s.tick(16100, prio({ b: MOTION, d: MOTION, c: RECORDING })), null);   // the only recording camera: it stays
});

test('slideshow: when the action is over it goes back to every camera', () => {
  const s = S.createSlideshow(IDS, 'a', 5000, 0);
  assertEqual(s.tick(100, prio({ c: RECORDING })), 'c');
  assertEqual(s.tick(5100, prio({})), 'd');
  assertEqual(s.tick(10100, prio({})), 'a');
});

test('slideshow: a pager click shows that camera for a full interval', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  s.show('c', 8000);
  assertEqual(s.current(), 'c');
  assertEqual(s.tick(17999, prio({})), null);
  assertEqual(s.tick(18000, prio({})), 'd');
});

test('slideshow: an unknown start camera starts at the first; no cameras never throws', () => {
  assertEqual(S.createSlideshow(IDS, 'nope', 1000, 0).current(), 'a');
  const empty = S.createSlideshow([], 'a', 1000, 0);
  assertEqual(empty.current(), null);
  assertEqual(empty.tick(5000, {}), null);
});

test('slideshow: a lone camera never switches', () => {
  const s = S.createSlideshow(['x'], 'x', 1000, 0);
  assertEqual(s.tick(5000, { x: IDLE }), null);
  assertEqual(s.tick(9000, { x: RECORDING }), null);
  assertEqual(s.current(), 'x');
});

// ── person detected + the live view the slideshow needs ──────────────

test('personSeen: only an online detector with person.detected === true', () => {
  const d = (over) => Object.assign({ online: true, report: { person: { detected: true } } }, over);
  assertEqual(S.personSeen(d()), true);
  assertEqual(S.personSeen(d({ online: false })), false);
  assertEqual(S.personSeen(d({ report: { person: { detected: false } } })), false);
  assertEqual(S.personSeen(d({ report: { person: { detected: 'true' } } })), false);
  assertEqual(S.personSeen(d({ report: null })), false);
  assertEqual(S.personSeen(null), false);
});

test('priorities: a person beats motion, recording beats a person', () => {
  const person = { online: true, report: { person: { detected: true }, scene: { motion: 500, motionAtLeast: 300 } } };
  const moving = { online: true, report: { scene: { motion: 500, motionAtLeast: 300 } } };
  const p = S.priorities(['a', 'b', 'c'], { c: { recording: true } }, { a: person, b: moving, c: person });
  assertEqual(p, { a: S.PRIORITY.PERSON, b: S.PRIORITY.MOTION, c: S.PRIORITY.RECORDING });
});

test('viewRequests: asks "on" for resting detectors, "keep" for wanted ones, skips the rest', () => {
  const dets = {
    a: { view: { supported: true, wanted: false } },
    b: { view: { supported: true, wanted: true } },
    c: { view: { supported: false, wanted: false } },
    d: { online: true },
  };
  assertEqual(S.viewRequests(['a', 'b', 'c', 'd', 'e'], dets, {}, 1000, 20000),
    [{ id: 'a', action: 'on' }, { id: 'b', action: 'keep' }]);
});

test('viewRequests: not again before keepMs; again after; no answer yet asks nobody', () => {
  const dets = { a: { view: { supported: true, wanted: true } } };
  assertEqual(S.viewRequests(['a'], dets, { a: 1000 }, 20999, 20000), []);
  assertEqual(S.viewRequests(['a'], dets, { a: 1000 }, 21000, 20000), [{ id: 'a', action: 'keep' }]);
  assertEqual(S.viewRequests(['a'], null, {}, 0, 20000), []);
});

// ── slideshow time left ──────────────────────────────────────────────

test('remainingMs: counts down from the full interval to 0 and never below', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  assertEqual(s.remainingMs(0, prio({})), 10000);
  assertEqual(s.remainingMs(2500, prio({})), 7500);
  assertEqual(s.remainingMs(10000, prio({})), 0);
  assertEqual(s.remainingMs(15000, prio({})), 0, 'late looks do not go negative');
});

test('remainingMs: starts over after the camera changes — by time, by a jump, or by the viewer', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  assertEqual(s.tick(10000, prio({})), 'b');
  assertEqual(s.remainingMs(10000, prio({})), 10000);
  assertEqual(s.remainingMs(14000, prio({})), 6000);
  s.show('c', 14000);                                   // the viewer pressed PREV / NEXT
  assertEqual(s.remainingMs(14000, prio({})), 10000);
  const recording = prio({ a: RECORDING, d: RECORDING });
  assertEqual(s.tick(15000, recording), 'a');   // cameras started recording: the first of them is shown at once
  assertEqual(s.remainingMs(15000, recording), 10000);
});

test('remainingMs: null when the slideshow has nowhere to go (one camera, or the only recording one)', () => {
  assertEqual(S.createSlideshow(['a'], 'a', 10000, 0).remainingMs(1000, prio({})), null);
  const s = S.createSlideshow(IDS, 'c', 10000, 0);
  assertEqual(s.remainingMs(1000, prio({ c: RECORDING })), null, 'the others are skipped while it records');
  assertEqual(s.remainingMs(1000, prio({ c: RECORDING, a: RECORDING })), 9000, 'but another recording camera is a destination');
});

test('remainingMs: asking never changes anything (it is only a look)', () => {
  const s = S.createSlideshow(IDS, 'a', 10000, 0);
  s.remainingMs(9000, prio({}));
  s.remainingMs(20000, prio({}));
  assertEqual(s.current(), 'a');
  assertEqual(s.tick(10000, prio({})), 'b');
});

test('countdown: whole seconds rounded up and the part of the time that is left', () => {
  assertEqual(S.countdown(10000, 10000), { seconds: 10, fraction: 1 });
  assertEqual(S.countdown(9001, 10000), { seconds: 10, fraction: 0.9001 });
  assertEqual(S.countdown(1, 10000), { seconds: 1, fraction: 0.0001 }, 'never says 0 while there is time');
  assertEqual(S.countdown(0, 10000), { seconds: 0, fraction: 0 });
});

test('countdown: out-of-range values are clamped, anything unusable is nothing to show', () => {
  assertEqual(S.countdown(-5, 10000), { seconds: 0, fraction: 0 });
  assertEqual(S.countdown(99999, 10000), { seconds: 10, fraction: 1 });
  for (const bad of [null, undefined, NaN, Infinity, '5000', {}]) assertEqual(S.countdown(bad, 10000), null, String(bad));
  for (const bad of [0, -1, NaN, undefined, null]) assertEqual(S.countdown(5000, bad), null, String(bad));
});

// ── formatClock ──────────────────────────────────────────────────────

test('formatClock: HH:MM:SS with leading zeros', () => {
  assertEqual(S.formatClock(new Date(2026, 0, 2, 3, 4, 5)), '03:04:05');
  assertEqual(S.formatClock(new Date(2026, 0, 2, 23, 59, 59)), '23:59:59');
});

summarize();
