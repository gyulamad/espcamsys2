'use strict';

// Unit tests for the pure part of php/cameras/lib/recordings-list.js — the code the dashboard's per-camera
// FILES panels and the ALL FILES page share: reading a clip's recording time from its name, the
// newest-first order across cameras, tagging and filtering what recordings.php returns, merging the
// answers of several cameras, and the URLs that go to recordings.php.
// (The list on a page — rows, buttons, selection, deleting — is tested in test_recordings_list_page.js.)

const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const list = require(path.join(__dirname, '../../php/cameras/lib/recordings-list.js'));

const stamp = (iso) => iso.replace(/[:.]/g, '-');   // how the relay writes the time into a name (server.js)
const clip = (cam, iso) => `${cam}_${stamp(iso)}.mp4`;

// ── recordedAtMs ─────────────────────────────────────────────────────────

test('recordedAtMs reads the time the relay put in a clip name', () => {
  const iso = '2026-10-23T09:35:22.123Z';
  assertEqual(list.recordedAtMs(clip('cam1', iso)), Date.parse(iso));
});

test('recordedAtMs works for camera ids that contain underscores, dots and dashes', () => {
  const iso = '2026-01-02T03:04:05.006Z';
  for (const cam of ['front_door', 'cam.2', 'a-b_c.d']) {
    assertEqual(list.recordedAtMs(clip(cam, iso)), Date.parse(iso), cam);
  }
});

test('recordedAtMs is null for a name with no time, or one that is not a real moment', () => {
  assertEqual(list.recordedAtMs('cam1-20260101-000000.mp4'), null);
  assertEqual(list.recordedAtMs('cam1.mp4'), null);
  assertEqual(list.recordedAtMs(''), null);
  assertEqual(list.recordedAtMs(undefined), null);
  assertEqual(list.recordedAtMs('cam1_2026-13-45T25-61-61-999Z.mp4'), null, 'month 13');
  assertEqual(list.recordedAtMs('cam1_2026-02-31T00-00-00-000Z.mp4'), null, 'February 31st rolls over, so it is refused');
});

// ── sortNewestFirst ──────────────────────────────────────────────────────

test('sortNewestFirst puts the newest clip first, whichever camera it is from', () => {
  const files = [
    { cam: 'a', filename: clip('a', '2026-10-01T10:00:00.000Z') },
    { cam: 'b', filename: clip('b', '2026-10-03T10:00:00.000Z') },
    { cam: 'a', filename: clip('a', '2026-10-02T10:00:00.000Z') },
  ];
  assertEqual(list.sortNewestFirst(files).map((f) => f.filename), [
    clip('b', '2026-10-03T10:00:00.000Z'),
    clip('a', '2026-10-02T10:00:00.000Z'),
    clip('a', '2026-10-01T10:00:00.000Z'),
  ]);
});

test('sortNewestFirst does not change the list it was given', () => {
  const files = [
    { cam: 'a', filename: clip('a', '2026-10-01T10:00:00.000Z') },
    { cam: 'a', filename: clip('a', '2026-10-02T10:00:00.000Z') },
  ];
  const before = JSON.stringify(files);
  list.sortNewestFirst(files);
  assertEqual(JSON.stringify(files), before);
});

test('sortNewestFirst: clips without a readable time go last, in a fixed order', () => {
  const dated = { cam: 'a', filename: clip('a', '2026-10-01T10:00:00.000Z') };
  const x = { cam: 'b', filename: 'old-2.mp4' };
  const y = { cam: 'a', filename: 'old-1.mp4' };
  const first = list.sortNewestFirst([x, y, dated]);
  const second = list.sortNewestFirst([dated, y, x]);
  assertEqual(first.map((f) => f.filename), [dated.filename, 'old-1.mp4', 'old-2.mp4']);
  assertEqual(second, first, 'the same answer whatever order the cameras answered in');
});

test('sortNewestFirst: the same moment on two cameras is ordered by camera, then name — not by chance', () => {
  const iso = '2026-10-01T10:00:00.000Z';
  const files = [{ cam: 'b', filename: clip('b', iso) }, { cam: 'a', filename: clip('a', iso) }];
  assertEqual(list.sortNewestFirst(files).map((f) => f.cam), ['a', 'b']);
  assertEqual(list.sortNewestFirst(files.slice().reverse()).map((f) => f.cam), ['a', 'b']);
});

test('sortNewestFirst of nothing is nothing', () => {
  assertEqual(list.sortNewestFirst([]), []);
});

// ── tagFiles ─────────────────────────────────────────────────────────────

test('tagFiles tags every clip with its camera and keeps name, size and seen', () => {
  assertEqual(list.tagFiles('cam1', [{ filename: 'a.mp4', sizeBytes: 5, seen: false }]),
    [{ cam: 'cam1', filename: 'a.mp4', sizeBytes: 5, seen: false, person: false, scan: null }]);
});

test('tagFiles: a relay that does not say "seen" means seen (nothing is bold by mistake)', () => {
  assertEqual(list.tagFiles('c', [{ filename: 'a.mp4', sizeBytes: 1 }])[0].seen, true);
  assertEqual(list.tagFiles('c', [{ filename: 'a.mp4', sizeBytes: 1, seen: true }])[0].seen, true);
});

test('tagFiles drops names that are not plain recording names, and entries that are not objects', () => {
  const hostileNames = [
    "x');window.__pwned=1;('.mp4", '"><img src=x onerror=alert(1)>.mp4', '../../etc/passwd', 'a/b.mp4', 'a.txt', '', 'a.mp4 ', 'a.mp4\n',
  ];
  const entries = [...hostileNames.map((filename) => ({ filename })), null, undefined, 42, 'a.mp4', {}, { filename: 7 }, { filename: ['a.mp4'] }];
  assertEqual(list.tagFiles('c', entries), [], 'nothing hostile gets through');
  assertEqual(list.tagFiles('c', [{ filename: 'bad/.mp4' }, { filename: 'ok_1.mp4' }]).map((f) => f.filename), ['ok_1.mp4'], 'the good one stays');
});

test('tagFiles turns a size that is not a whole non-negative number into 0', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, 'big', null, undefined]) {
    assertEqual(list.tagFiles('c', [{ filename: 'a.mp4', sizeBytes: bad }])[0].sizeBytes, 0, String(bad));
  }
  assertEqual(list.tagFiles('c', [{ filename: 'a.mp4', sizeBytes: 0 }])[0].sizeBytes, 0);
});

// ── mergeResults ─────────────────────────────────────────────────────────

test('mergeResults joins every camera newest first and names the cameras that could not be read', () => {
  const merged = list.mergeResults([
    { cam: 'a', files: [{ cam: 'a', filename: clip('a', '2026-10-01T00:00:00.000Z') }] },
    { cam: 'b', files: null },
    { cam: 'c', files: [{ cam: 'c', filename: clip('c', '2026-10-02T00:00:00.000Z') }] },
  ]);
  assertEqual(merged.files.map((f) => f.cam), ['c', 'a']);
  assertEqual(merged.failed, ['b']);
});

test('mergeResults: a camera with no clips is not a failure', () => {
  assertEqual(list.mergeResults([{ cam: 'a', files: [] }]), { files: [], failed: [] });
});

// ── URLs and text ────────────────────────────────────────────────────────

test('urls go to recordings.php with camera and file name encoded', () => {
  assertEqual(list.recordingUrl('cam 1', 'deleteAll=1'), 'recordings.php?cam=cam%201&deleteAll=1');
  assertEqual(list.downloadUrl('c', 'a b&c.mp4'), 'recordings.php?cam=c&download=a%20b%26c.mp4');
  assertEqual(list.playUrl('c', 'a.mp4'), 'recordings.php?cam=c&play=a.mp4');
});

test('formatBytes uses B, KB and MB', () => {
  assertEqual(list.formatBytes(0), '0 B');
  assertEqual(list.formatBytes(1023), '1023 B');
  assertEqual(list.formatBytes(1024), '1.0 KB');
  assertEqual(list.formatBytes(1536), '1.5 KB');
  assertEqual(list.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('the default file-name rule is the one CamLogic::SAFE_FILENAME_REGEX has', () => {
  const php = require('fs').readFileSync(path.join(__dirname, '../../php/cameras/lib/Logic.php'), 'utf8');
  const m = /const SAFE_FILENAME_REGEX = '([^']*)';/.exec(php);
  assertTrue(!!m, 'Logic.php has the rule');
  // PHP single quotes keep the backslash as written, so the text is already a JS-readable pattern
  assertEqual(list.SAFE_FILENAME.source, new RegExp(m[1]).source);
});

// ── person check: what the list shows ────────────────────────────────────

test('tagFiles keeps "person" only when it is exactly true, and the scan state only in its known shapes', () => {
  const t = (extra) => list.tagFiles('c', [{ filename: 'a.mp4', sizeBytes: 1, ...extra }])[0];
  assertEqual([t({ person: true }).person, t({ person: 'yes' }).person, t({}).person], [true, false, false]);
  assertEqual(t({ scan: { state: 'processing' } }).scan, { state: 'processing' });
  assertEqual(t({ scan: { state: 'queued', evil: '<b>' } }).scan, { state: 'queued' });
  assertEqual(t({ scan: { state: 'error', reason: 'no model' } }).scan, { state: 'error', reason: 'no model' });
  assertEqual(t({ scan: { state: 'error', reason: 5 } }).scan, { state: 'error', reason: '' });
  for (const bad of [null, 'processing', { state: 'weird' }, { state: 5 }, []]) assertEqual(t({ scan: bad }).scan, null, JSON.stringify(bad));
});

test('scanLabel says what is going on, and why a check failed', () => {
  assertEqual(list.scanLabel(null), '');
  assertEqual(list.scanLabel({ state: 'processing' }), '⏳ processing…');
  assertEqual(list.scanLabel({ state: 'queued' }), '⏳ waiting to be checked…');
  assertEqual(list.scanLabel({ state: 'error', reason: 'no model' }), '⚠ check failed: no model');
  assertEqual(list.scanLabel({ state: 'error', reason: '' }), '⚠ check failed');
});

test('hasPendingScan: queued or processing keeps the list reloading, a failure does not', () => {
  assertEqual(list.hasPendingScan([{ scan: null }, { scan: { state: 'error', reason: '' } }]), false);
  assertEqual(list.hasPendingScan([{ scan: null }, { scan: { state: 'queued' } }]), true);
  assertEqual(list.hasPendingScan([{ scan: { state: 'processing' } }]), true);
  assertEqual(list.hasPendingScan([]), false);
});

test('thumbUrl names the camera and the clip, encoded', () => {
  assertEqual(list.thumbUrl('cam 1', 'a b.mp4'), 'recordings.php?cam=cam%201&thumb=a%20b.mp4');
});

summarize();
