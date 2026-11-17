'use strict';

// soundstore.js — the sounds folder on disk: list, read, write and delete sounds by NAME. Everything that turns a
// name into a path goes through pathOf(), so no caller can reach outside the folder whatever it passes (the rules
// themselves are lib/sounds.js). Only regular files count: a symlink dropped into the folder is treated as not
// being there, so the relay never reads (or serves) a file from somewhere else through one.
//
// The folder is created on the first write, so a relay that never gets a sound never makes it.
// Tested against a real temporary folder: tests/node/test_soundstore.js.

const fs = require('fs');
const path = require('path');
const sounds = require('./sounds');
const { writeFileAtomic } = require('./util');

class SoundNameError extends Error {}

function createSoundStore(dir) {
  const root = path.resolve(dir);

  // The file a sound's name stands for. Throws SoundNameError for a name that is not a sound's.
  function pathOf(name) {
    if (!sounds.isSoundName(name)) throw new SoundNameError('not the name of a sound');
    const file = path.resolve(root, name);
    if (path.dirname(file) !== root) throw new SoundNameError('not the name of a sound');
    return file;
  }

  // The regular file for `name`, or null when there is none (or it is not a regular file).
  function regularFile(name) {
    const file = pathOf(name);
    try {
      return fs.lstatSync(file).isFile() ? file : null;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // [{ name, bytes }], sorted. A folder that does not exist yet is an empty library.
  function list() {
    let dirents;
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const entries = dirents
      .filter((d) => d.isFile() && sounds.isSoundName(d.name))
      .map((d) => ({ name: d.name, bytes: fs.statSync(path.join(root, d.name)).size }));
    return sounds.describeSounds(entries);
  }

  const names = () => list().map((s) => s.name);
  const has = (name) => regularFile(name) !== null;

  // The bytes, or null when there is no such sound.
  function read(name) {
    const file = regularFile(name);
    return file === null ? null : fs.readFileSync(file);
  }

  // Stores `buf` under `name` (the caller has checked it: sounds.checkSound), replacing a sound of that name.
  // The file is written whole and renamed into place, so a reader never sees half a sound.   -> { replaced }
  function write(name, buf) {
    const file = pathOf(name);
    const replaced = regularFile(name) !== null;
    fs.mkdirSync(root, { recursive: true });
    writeFileAtomic(file, buf);
    return { replaced };
  }

  // -> true when a sound was deleted, false when there was none
  function remove(name) {
    const file = regularFile(name);
    if (file === null) return false;
    fs.unlinkSync(file);
    return true;
  }

  return { dir: root, pathOf, list, names, has, read, write, remove };
}

module.exports = { createSoundStore, SoundNameError };
