'use strict';

// archive.js — the archive: the clips the person check found nobody in and filed under
// <camera folder>/no-person/ (personscan.js). They are off the dashboard's lists but still take disk
// space, so this is what counts them, lists them, hands one back to the recordings (restore) and
// what deletes them for good.
//
// Only regular files with a name the relay itself would have generated (validation.isSafeFilename) are
// ever counted, listed, restored or deleted: a folder, a symbolic link or anything the user put there by
// hand is left alone, and a file name can never reach outside the archive folder.
//
// The disk is injected (`fs`: readdirSync with file types, statSync, linkSync, unlinkSync), so this is unit tested against a
// real temporary folder and against a disk that refuses (tests/node/test_archive.js); server.js passes
// the real `fs`.

const path = require('path');
const personscan = require('./personscan');
const validation = require('./validation');
const { errorMessage } = require('./util');

function createArchive({ fs }) {
  // Names of the archived clips of one camera, in name order (none if it has no archive folder yet).
  function clipNames(cameraDir) {
    let entries;
    try {
      entries = fs.readdirSync(personscan.noPersonDir(cameraDir), { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
    return entries
      .filter((entry) => entry.isFile() && validation.isSafeFilename(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  function count(cameraDir) {
    return clipNames(cameraDir).length;
  }

  // The archived clips as the dashboard lists them, newest first (the same entry shape as the list of
  // recordings, so one list code draws both): [{ filename, sizeBytes, createdAt }].
  // A clip that disappears while it is being listed is simply left out.
  function list(cameraDir) {
    const dir = personscan.noPersonDir(cameraDir);
    const entries = [];
    for (const name of clipNames(cameraDir)) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        entries.push({ filename: name, sizeBytes: stat.size, createdAt: stat.birthtime });
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
    }
    return entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || (a.filename < b.filename ? 1 : -1));
  }

  // Where an archived clip is on disk, or null when it is not an archived plain clip file (unsafe name,
  // missing, a folder, a link). The route that serves a clip and restore() both go through this.
  function pathOf(cameraDir, name) {
    if (typeof name !== 'string' || !validation.isSafeFilename(name)) return null;
    return clipNames(cameraDir).includes(name) ? path.join(personscan.noPersonDir(cameraDir), name) : null;
  }

  // Hands an archived clip back to the recordings: it moves to <camera folder>/<same name> and is on the
  // dashboard's list again. A recording of that name is NEVER overwritten (link-then-unlink fails on an
  // existing target atomically, where exists-then-rename could lose a clip to a race).
  // -> { state: 'restored' } | { state: 'missing' } | { state: 'exists' } | { state: 'error', reason }
  function restore(cameraDir, name) {
    const from = pathOf(cameraDir, name);
    if (from === null) return { state: 'missing' };
    const to = path.join(cameraDir, name);
    try {
      fs.linkSync(from, to);
    } catch (e) {
      if (e && e.code === 'EEXIST') return { state: 'exists' };
      if (e && e.code === 'ENOENT') return { state: 'missing' };
      return { state: 'error', reason: errorMessage(e) };
    }
    try {
      fs.unlinkSync(from);
    } catch (e) {
      try { fs.unlinkSync(to); } catch (undoFailed) { /* both names stay: no clip is lost */ }
      return { state: 'error', reason: errorMessage(e) };
    }
    return { state: 'restored' };
  }

  // Deletes every archived clip of one camera. One clip that cannot be deleted does not stop the others.
  // -> { deleted: [name, ...], failed: [{ name, reason }, ...] }; a clip that is already gone counts as deleted.
  function removeAll(cameraDir) {
    const dir = personscan.noPersonDir(cameraDir);
    const deleted = [];
    const failed = [];
    for (const name of clipNames(cameraDir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
        deleted.push(name);
      } catch (e) {
        if (e && e.code === 'ENOENT') deleted.push(name);
        else failed.push({ name, reason: errorMessage(e) });
      }
    }
    return { deleted, failed };
  }

  return { count, list, pathOf, restore, removeAll };
}

module.exports = { createArchive };
