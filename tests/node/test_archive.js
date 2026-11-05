'use strict';

// Tests lib/archive.js — counting and deleting the clips the person check filed under <camera>/no-person/ —
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

summarize();
