'use strict';

// logwriter.js — appends text to the log file, keeping it from growing
// without limit.
//
// - Writes are queued and happen strictly one after another, so entries land
//   in the order they were produced and two entries can never interleave.
// - When a write would take the file past `maxBytes`, the file is rotated
//   first: camera.log -> camera.log.1 -> camera.log.2 ... (the oldest of
//   `keep` rotated files is deleted). An entry is never split across files.
//   Worst-case disk use is therefore (keep + 1) * maxBytes — it can't fill
//   the Pi's SD card.
// - A failed write rejects THAT call (so /log can tell the camera to retry)
//   but never poisons the queue: later writes still go through.
// - appendSync() is the crash path: when the process is about to die from an
//   uncaught exception there is no time to wait for the queue, so the last
//   words are written synchronously.

const fs = require('fs');
const path = require('path');

class LogWriter {
  constructor({ file, maxBytes, keep, fsImpl = fs }) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.fs = fsImpl;
    this._chain = Promise.resolve();
    this.fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.size = this.fs.statSync(file).size;
    } catch (err) {
      this.size = 0; // no log yet
    }
  }

  // Queues `text` for appending. Resolves when it is on disk.
  append(text) {
    const done = this._chain.then(() => this._write(text, false));
    this._chain = done.catch(() => {}); // a failure must not block later writes
    return done;
  }

  // Writes immediately and synchronously (see header). Throws on failure.
  appendSync(text) {
    this._write(text, true);
  }

  _write(text, sync) {
    const bytes = Buffer.byteLength(text);
    this._rotateIfNeeded(bytes);
    if (sync) {
      this.fs.appendFileSync(this.file, text);
      this.size += bytes;
      return undefined;
    }
    return this.fs.promises.appendFile(this.file, text).then(() => { this.size += bytes; });
  }

  _rotateIfNeeded(incomingBytes) {
    if (this.size === 0 || this.size + incomingBytes <= this.maxBytes) return;
    // Shift the older files up one place, dropping the oldest, then move the current file to .1
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try {
        this.fs.renameSync(from, to); // overwrites `to`; for i === keep that deletes the oldest
      } catch (err) {
        if (err.code !== 'ENOENT') throw err; // a missing file in the chain is normal
      }
    }
    this.size = 0;
  }
}

module.exports = { LogWriter };
