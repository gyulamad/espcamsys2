'use strict';

// archive.js — the archive: the clips the person check found nobody in and filed under
// <camera folder>/no-person/ (personscan.js). They are off the dashboard's lists but still take disk
// space, so this is what counts them and what deletes them for good.
//
// Only regular files with a name the relay itself would have generated (validation.isSafeFilename) are
// ever counted or deleted: a folder, a symbolic link or anything the user put there by hand is left
// alone, and a file name can never reach outside the archive folder.
//
// The disk is injected (`fs`: readdirSync with file types, unlinkSync), so this is unit tested against a
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

  return { count, removeAll };
}

module.exports = { createArchive };
