'use strict';

// sorter.js — what happens to ONE recording when it is checked for a person: ask the detector, and only
// from a trustworthy "nobody in it" answer move or delete the clip. Everything that can go wrong (clip still
// being written, model missing, detector crashed or timed out, clip deleted meanwhile) ends in an
// 'error' outcome that leaves the clip exactly where it is — footage is only ever removed on a clear "no".
//
// The disk and the detector process are injected (`files`, `runDetector`), so this is unit tested with
// fakes (tests/node/test_sorter.js); server.js passes the real ones.
//
//   outcome: { state: 'person', confidence } | { state: 'moved' } | { state: 'removed' } | { state: 'error', reason }

const personscan = require('./personscan');
const { errorMessage } = require('./util');

// files: { mtimeMs(path), exists(path), move(from, to), remove(clipPath), removeThumbnail(clipPath) }
// runDetector(args) -> Promise<{ code, stdout, stderr, timedOut, spawnError }>
function createSorter({ config, runDetector, files, now = Date.now }) {
  const error = (reason) => ({ state: 'error', reason });

  function checkReady(clipPath) {
    let mtimeMs;
    try {
      mtimeMs = files.mtimeMs(clipPath);
    } catch (e) {
      return 'the recording no longer exists';
    }
    if (!personscan.isSettled(mtimeMs, now(), config.minAgeMs)) return 'the recording is still being written — try again in a moment';
    if (!files.exists(config.model)) return `the person detector model is not installed (expected at ${config.model})`;
    return null;
  }

  function applyNoPerson(clipPath) {
    if (config.action === 'delete') {
      files.remove(clipPath);
      return { state: 'removed' };
    }
    files.move(clipPath, personscan.noPersonPath(clipPath));
    return { state: 'moved' };
  }

  async function sort(clipPath) {
    const notReady = checkReady(clipPath);
    if (notReady) return error(notReady);

    const verdict = personscan.parseScanResult(await runDetector(personscan.buildScanArgs(config, clipPath)));
    if (verdict.kind === 'error') return error(verdict.reason);

    try {
      if (!files.exists(clipPath)) {   // deleted by someone while the detector worked: leave nothing behind
        files.removeThumbnail(clipPath);
        return error('the recording was deleted while it was being checked');
      }
      if (verdict.kind === 'person') return { state: 'person', confidence: verdict.confidence };
      return applyNoPerson(clipPath);
    } catch (e) {
      return error(`could not file the recording: ${errorMessage(e)}`);
    }
  }

  return { sort };
}

module.exports = { createSorter };
