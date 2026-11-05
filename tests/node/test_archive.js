'use strict';

// Tests lib/archive.js — counting, listing, restoring and deleting the clips the person check filed under <camera>/no-person/ —
// against a REAL temporary folder (so symbolic links, folders and odd names behave as they do on the Pi),
// and against a disk that refuses to delete one file.
//
// Usage:  node tests/node/test_archive.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { createArchive } = require('../../nodejs/camera-relay/lib/archive');

const CLIP_A = 'cam1_2026-10-01T10-00-00-000Z.mp4';
const CLIP_B = 'cam1_2026-10-02T10-00-00-000Z.mp4';

// A camera folder with an archive folder holding the given { name: content } files.
function rig(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const cameraDir = path.join(root, 'cam1');
  const archiveDir = path.join(cameraDir, 'no-person');
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(archiveDir, name), content);
  return { root, cameraDir, archiveDir, archive: createArchive({ fs }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const listing = (dir) => fs.readdirSync(dir).sort();

test('a camera without an archive folder has an empty archive', () => {
  const r = rig();
  fs.rmdirSync(r.archiveDir);
  assertEqual(r.archive.count(r.cameraDir), 0);
  assertEqual(r.archive.removeAll(r.cameraDir), { deleted: [], failed: [] });
  r.cleanup();
});

test('count: every archived clip is counted, in no other place', () => {
  const r = rig({ [CLIP_A]: 'a', [CLIP_B]: 'b' });
  fs.writeFileSync(path.join(r.cameraDir, 'cam1_2026-10-03T10-00-00-000Z.mp4'), 'a clip still in the list: not archived');
  assertEqual(r.archive.count(r.cameraDir), 2);
  r.cleanup();
});

test('removeAll: deletes every archived clip and reports their names', () => {
  const r = rig({ [CLIP_B]: 'b', [CLIP_A]: 'a' });
  assertEqual(r.archive.removeAll(r.cameraDir), { deleted: [CLIP_A, CLIP_B], failed: [] });
  assertEqual(listing(r.archiveDir), []);
  assertEqual(r.archive.count(r.cameraDir), 0);
  r.cleanup();
});

test('removeAll: clips of the camera folder itself are never touched', () => {
  const r = rig({ [CLIP_A]: 'a' });
  const listed = path.join(r.cameraDir, CLIP_B);
  fs.writeFileSync(listed, 'b');
  r.archive.removeAll(r.cameraDir);
  assertTrue(fs.existsSync(listed), 'a clip that is still on the dashboard was deleted');
  r.cleanup();
});

test('removeAll: only plain recording names are deleted — other files, folders and links are left alone', () => {
  const r = rig({ [CLIP_A]: 'a', 'notes.txt': 'mine', '.hidden.mp4.bak': 'x', 'a b.mp4': 'space', 'x;rm.mp4': 'semicolon' });
  fs.mkdirSync(path.join(r.archiveDir, 'folder.mp4'));
  fs.writeFileSync(path.join(r.archiveDir, 'folder.mp4', CLIP_B), 'inside a folder');
  const outside = path.join(r.root, 'outside.mp4');
  fs.writeFileSync(outside, 'outside the archive');
  fs.symlinkSync(outside, path.join(r.archiveDir, 'link.mp4'));
  fs.symlinkSync(r.root, path.join(r.archiveDir, 'linked-folder.mp4'));

  assertEqual(r.archive.count(r.cameraDir), 1);
  assertEqual(r.archive.removeAll(r.cameraDir), { deleted: [CLIP_A], failed: [] });
  assertEqual(listing(r.archiveDir), ['.hidden.mp4.bak', 'a b.mp4', 'folder.mp4', 'link.mp4', 'linked-folder.mp4', 'notes.txt', 'x;rm.mp4']);
  assertTrue(fs.existsSync(outside), 'the target of a link was deleted');
  assertTrue(fs.existsSync(path.join(r.archiveDir, 'folder.mp4', CLIP_B)), 'a file inside a folder was deleted');
  r.cleanup();
});

test('removeAll: a clip that cannot be deleted does not stop the others and is reported', () => {
  const r = rig({ [CLIP_A]: 'a', [CLIP_B]: 'b' });
  const refusing = Object.assign(Object.create(fs), {
    unlinkSync: (p) => {
      if (path.basename(p) === CLIP_A) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.unlinkSync(p);
    },
  });
  const result = createArchive({ fs: refusing }).removeAll(r.cameraDir);
  assertEqual(result.deleted, [CLIP_B]);
  assertEqual(result.failed.length, 1);
  assertEqual(result.failed[0].name, CLIP_A);
  assertTrue(result.failed[0].reason.includes('EACCES'));
  assertEqual(listing(r.archiveDir), [CLIP_A]);
  r.cleanup();
});

test('removeAll: a clip that vanished meanwhile counts as deleted, not as a failure', () => {
  const r = rig({ [CLIP_A]: 'a' });
  const gone = Object.assign(Object.create(fs), {
    unlinkSync: (p) => { fs.unlinkSync(p); throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); },
  });
  assertEqual(createArchive({ fs: gone }).removeAll(r.cameraDir), { deleted: [CLIP_A], failed: [] });
  r.cleanup();
});

test('an archive folder that cannot be read is an error, not "empty"', () => {
  const r = rig({ [CLIP_A]: 'a' });
  const denied = Object.assign(Object.create(fs), {
    readdirSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
  });
  let thrown = null;
  try { createArchive({ fs: denied }).count(r.cameraDir); } catch (e) { thrown = e; }
  assertTrue(thrown && thrown.code === 'EACCES', 'the failure was swallowed');
  r.cleanup();
});

// ── browsing ──

test('list: newest first, with size, plain clip files only', () => {
  const r = rig({ [CLIP_A]: 'aaa', [CLIP_B]: 'bbbbb', 'notes.txt': 'x' });
  const t = (iso) => new Date(iso);
  fs.utimesSync(path.join(r.archiveDir, CLIP_A), t('2026-10-01T10:00:00Z'), t('2026-10-01T10:00:00Z'));
  const entries = r.archive.list(r.cameraDir);
  assertEqual(entries.map((e) => e.filename).sort(), [CLIP_A, CLIP_B]);
  assertEqual(entries.map((e) => e.sizeBytes).sort(), [3, 5]);
  assertTrue(entries.every((e) => e.createdAt instanceof Date), 'createdAt missing');
  r.cleanup();
});

test('list: equal times fall back to the name, newest name first, so the order never jumps', () => {
  const r = rig({ [CLIP_A]: 'a', [CLIP_B]: 'b' });
  const fixed = Object.assign(Object.create(fs), { statSync: (p) => Object.assign(fs.statSync(p), { birthtime: new Date(0) }) });
  assertEqual(createArchive({ fs: fixed }).list(r.cameraDir).map((e) => e.filename), [CLIP_B, CLIP_A]);
  r.cleanup();
});

test('list: no archive folder is an empty list; a clip that vanished meanwhile is left out; other failures throw', () => {
  const r = rig({ [CLIP_A]: 'a', [CLIP_B]: 'b' });
  const vanish = Object.assign(Object.create(fs), { statSync: (p) => { if (path.basename(p) === CLIP_A) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return fs.statSync(p); } });
  assertEqual(createArchive({ fs: vanish }).list(r.cameraDir).map((e) => e.filename), [CLIP_B]);
  const broken = Object.assign(Object.create(fs), { statSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
  let thrown = null;
  try { createArchive({ fs: broken }).list(r.cameraDir); } catch (e) { thrown = e; }
  assertTrue(thrown && thrown.code === 'EIO', 'a disk error was swallowed');
  fs.rmSync(r.archiveDir, { recursive: true });
  assertEqual(r.archive.list(r.cameraDir), []);
  r.cleanup();
});

test('pathOf: only an archived plain clip file has a path; names that are not clips, links and folders have none', () => {
  const r = rig({ [CLIP_A]: 'a', 'notes.txt': 'x' });
  fs.symlinkSync(path.join(r.root, 'x.mp4'), path.join(r.archiveDir, 'link.mp4'));
  fs.mkdirSync(path.join(r.archiveDir, 'dir.mp4'));
  assertEqual(r.archive.pathOf(r.cameraDir, CLIP_A), path.join(r.archiveDir, CLIP_A));
  for (const bad of [CLIP_B, 'notes.txt', 'link.mp4', 'dir.mp4', '../' + CLIP_A, '..%2f' + CLIP_A, `${CLIP_A}/..`, '/etc/passwd', '', null, undefined, 5, ['x.mp4']]) {
    assertEqual(r.archive.pathOf(r.cameraDir, bad), null, String(bad));
  }
  r.cleanup();
});

// ── restoring ──

test('restore: the clip moves back next to the listed recordings and leaves the archive', () => {
  const r = rig({ [CLIP_A]: 'footage' });
  assertEqual(r.archive.restore(r.cameraDir, CLIP_A), { state: 'restored' });
  assertEqual(fs.readFileSync(path.join(r.cameraDir, CLIP_A), 'utf8'), 'footage');
  assertEqual(listing(r.archiveDir), []);
  assertEqual(r.archive.count(r.cameraDir), 0);
  r.cleanup();
});

test('restore: a recording of the same name is never overwritten, and the archived clip stays', () => {
  const r = rig({ [CLIP_A]: 'archived' });
  fs.writeFileSync(path.join(r.cameraDir, CLIP_A), 'newer recording with the same name');
  assertEqual(r.archive.restore(r.cameraDir, CLIP_A), { state: 'exists' });
  assertEqual(fs.readFileSync(path.join(r.cameraDir, CLIP_A), 'utf8'), 'newer recording with the same name');
  assertEqual(fs.readFileSync(path.join(r.archiveDir, CLIP_A), 'utf8'), 'archived');
  r.cleanup();
});

test('restore: a clip that is not in the archive is "missing" and nothing is touched', () => {
  const r = rig({ [CLIP_A]: 'a', 'notes.txt': 'mine' });
  const outside = path.join(r.root, 'secret.mp4');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(r.archiveDir, 'link.mp4'));
  for (const bad of [CLIP_B, 'notes.txt', 'link.mp4', '../secret.mp4', '..', null]) {
    assertEqual(r.archive.restore(r.cameraDir, bad), { state: 'missing' }, String(bad));
  }
  assertEqual(listing(r.archiveDir), [CLIP_A, 'link.mp4', 'notes.txt']);
  assertEqual(listing(r.cameraDir), ['no-person']);
  assertTrue(fs.existsSync(outside), 'the target of a link was touched');
  r.cleanup();
});

test('restore: a disk that refuses is an error that keeps the clip (no copy left half-way)', () => {
  const r = rig({ [CLIP_A]: 'a' });
  const noLink = Object.assign(Object.create(fs), { linkSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
  const o = createArchive({ fs: noLink }).restore(r.cameraDir, CLIP_A);
  assertEqual(o.state, 'error');
  assertTrue(o.reason.includes('EACCES'));
  assertEqual(listing(r.archiveDir), [CLIP_A]);
  assertEqual(listing(r.cameraDir), ['no-person']);
  r.cleanup();
});

test('restore: when the archived name cannot be removed, the new name is undone and the clip stays archived', () => {
  const r = rig({ [CLIP_A]: 'a' });
  const noUnlink = Object.assign(Object.create(fs), {
    unlinkSync: (p) => { if (p.includes('no-person')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.unlinkSync(p); },
  });
  const o = createArchive({ fs: noUnlink }).restore(r.cameraDir, CLIP_A);
  assertEqual(o.state, 'error');
  assertEqual(listing(r.archiveDir), [CLIP_A]);
  assertEqual(listing(r.cameraDir), ['no-person']);
  r.cleanup();
});

summarize();
