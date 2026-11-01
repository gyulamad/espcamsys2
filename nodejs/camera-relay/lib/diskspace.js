'use strict';

// diskspace.js — how much room is left on the disk that holds the recordings, and whether that is
// below the owner's minimum. The dashboard warns the user (an alert on every page load) so old
// recordings get deleted BEFORE the Pi's disk is full and new recordings fail.
//
// No Express and no direct fs/child_process use: server.js hands in the two ways of asking the
// operating system (`statfs`, `execFile`), so everything here is unit tested with plain `node` and
// fakes — see tests/node/test_diskspace.js.
//
// Why two ways: fs.promises.statfs exists from Node 18.15 on, but the Pi in this project runs
// Node 17 — there `df` is asked instead (never through a shell: the folder is an argument).

const MIB = 1024 * 1024;

// `df -Pk <dir>` output -> free bytes (the "Available" column), or null if it cannot be read.
// POSIX format (-P): one line per filesystem, "Filesystem 1024-blocks Used Available Capacity% Mounted on".
// The filesystem name and mount point may contain spaces, so the numbers are matched from the middle.
function parseDfFreeBytes(text) {
  if (typeof text !== 'string') return null;
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const m = /^.*?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+.+$/.exec(lines[lines.length - 1].trim());
  if (!m) return null;
  const bytes = Number(m[3]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

// fs.statfs() result -> free bytes (what an ordinary user may still use: bavail, not bfree), or null.
function freeBytesFromStatfs(st) {
  if (!st || typeof st !== 'object') return null;
  const bytes = Number(st.bavail) * Number(st.bsize);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

// Free bytes on the disk holding `dir`, or null when the operating system would not say (a failure
// must never take the relay down or raise a false alarm, so it is an answer, not an exception).
//   deps.statfs(dir)         -> Promise of a statfs result; optional (older Node has none)
//   deps.execFile(cmd, args) -> Promise of stdout text
async function readFreeBytes(dir, deps) {
  try {
    if (typeof deps.statfs === 'function') return freeBytesFromStatfs(await deps.statfs(dir));
    return parseDfFreeBytes(await deps.execFile('df', ['-Pk', dir]));
  } catch (err) {
    return null;
  }
}

// What GET /storage answers. minFreeMB 0 means the warning is switched off.
//   -> { known, freeMB?, minFreeMB, low }
function buildStorageView(freeBytes, minFreeMB) {
  if (freeBytes === null) return { known: false, minFreeMB, low: false };
  return {
    known: true,
    freeMB: Math.floor(freeBytes / MIB),
    minFreeMB,
    low: minFreeMB > 0 && freeBytes < minFreeMB * MIB,
  };
}

module.exports = { MIB, parseDfFreeBytes, freeBytesFromStatfs, readFreeBytes, buildStorageView };
