'use strict';

// personscan.js — the pure rules of "sort out the recordings that show nobody": what the settings may be,
// the command that asks tools/person_scan.py about one clip, how its answer is read, and where the
// picture of the person and the "no person" clips go. Nothing here touches the disk, a process or the
// clock, so it is unit tested without any of them (tests/node/test_personscan.js).

const path = require('path');

const ACTIONS = ['move', 'delete'];
const NO_PERSON_DIR = 'no-person';
const THUMB_SUFFIX = '.thumb.jpg';
const MAX_REASON_LENGTH = 200;

const DEFAULTS = Object.freeze({
  enabled: false,        // switched on once the model is installed (INSTALL.md, "Sorting out footage without a person")
  auto: true,            // scan every recording right after it is saved
  action: 'move',        // a clip without a person: 'move' it to <camera>/no-person/ (safe) or 'delete' it
  python: 'python3',
  confidence: 0.4,       // 0 < c <= 1; lower keeps more doubtful clips (a missed person costs more than a false alarm)
  stride: 1,             // analyse every Nth frame
  timeoutSeconds: 900,
});

function number(raw, fallback, ok, name, warnings) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n === 'number' && Number.isFinite(n) && ok(n)) return n;
  warnings.push(`personScan.${name} must be a valid number (got ${JSON.stringify(raw)}) — ${fallback} is used`);
  return fallback;
}

// config.js's `personScan` block -> the settings the relay works with, plus warnings for what was refused.
// A bad value never stops the relay: it falls back to the default and says so. Relative paths are
// relative to relayDir (the relay's own folder); the detector script ships in the relay's own tools/ folder.
function resolveScanConfig(raw, relayDir) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const flag = (name) => {
    if (given[name] === undefined) return DEFAULTS[name];
    if (typeof given[name] === 'boolean') return given[name];
    warnings.push(`personScan.${name} must be true or false — ${DEFAULTS[name]} is used`);
    return DEFAULTS[name];
  };
  const text = (name, fallback) => (typeof given[name] === 'string' && given[name].trim() !== '' ? given[name].trim() : fallback);

  let action = DEFAULTS.action;
  if (given.action !== undefined) {
    if (ACTIONS.includes(given.action)) action = given.action;
    else warnings.push(`personScan.action must be one of ${ACTIONS.join(', ')} — '${DEFAULTS.action}' is used`);
  }
  const inRange = (lo, hi) => (n) => n >= lo && n <= hi;
  const stride = number(given.stride, DEFAULTS.stride, (n) => Number.isInteger(n) && n >= 1 && n <= 60, 'stride', warnings);
  return {
    enabled: flag('enabled'),
    auto: flag('auto'),
    action,
    python: text('python', DEFAULTS.python),
    script: path.resolve(relayDir, text('script', path.join('tools', 'person_scan.py'))),
    model: path.resolve(relayDir, text('model', path.join('models', 'person.onnx'))),
    confidence: number(given.confidence, DEFAULTS.confidence, (n) => n > 0 && n <= 1, 'confidence', warnings),
    stride,
    timeoutMs: number(given.timeoutSeconds, DEFAULTS.timeoutSeconds, inRange(10, 86400), 'timeoutSeconds', warnings) * 1000,
    warnings,
  };
}

// <clip>.mp4 -> <clip>.mp4.thumb.jpg: next to the clip like the ".seen" marker, never listed as a recording
// (it does not end in .mp4) and removed with its clip. Its existence IS the "a person was found" record.
function thumbnailPath(clipPath) {
  return clipPath + THUMB_SUFFIX;
}

// The archive of one camera: <camera folder>/no-person/, where clips with nobody in them wait when the
// action is 'move'. The folder is not scanned for the lists, so its clips are off the dashboard but on disk.
function noPersonDir(cameraDir) {
  return path.join(cameraDir, NO_PERSON_DIR);
}

// Where a clip with nobody in it goes when the action is 'move': <camera folder>/no-person/<same name>.
function noPersonPath(clipPath) {
  return path.join(noPersonDir(path.dirname(clipPath)), path.basename(clipPath));
}

// The arguments for the interpreter. Plain argv entries, never a shell string, so a file name cannot
// become a command.
function buildScanArgs(cfg, clipPath) {
  return [
    cfg.script,
    '--model', cfg.model,
    '--video', clipPath,
    '--thumbnail', thumbnailPath(clipPath),
    '--confidence', String(cfg.confidence),
    '--stride', String(cfg.stride),
  ];
}

// What the detector gets to see of the relay's environment: no keys, no config — it only needs to find
// python's libraries, and the Pi still has to serve cameras while it works (it also lowers its own priority).
function scanEnv(parentEnv) {
  return { PATH: parentEnv.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', OMP_NUM_THREADS: '2' };
}

function shortReason(text) {
  const oneLine = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH - 1)}…` : oneLine;
}

// The detector's finished process -> { kind: 'person', confidence } | { kind: 'none' } | { kind: 'error', reason }.
//   run = { code, stdout, stderr, timedOut, spawnError }
// 'none' (nobody in the clip) is accepted ONLY from a clean exit that says {"ok":true,"person":false}; every
// other outcome — a crash, a timeout, no output, nonsense — is an 'error', because 'none' gets a clip removed.
function parseScanResult(run) {
  if (run.spawnError) return { kind: 'error', reason: `the detector could not be started: ${shortReason(run.spawnError)}` };
  if (run.timedOut) return { kind: 'error', reason: 'the detector took too long and was stopped' };
  const lines = String(run.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let answer = null;
  try {
    answer = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch (e) {
    answer = null;
  }
  if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
    const tail = String(run.stderr || '').trim().split('\n').pop();
    return { kind: 'error', reason: shortReason(tail || `the detector gave no usable answer (exit ${run.code})`) };
  }
  if (!answer.ok) return { kind: 'error', reason: shortReason(answer.error || 'the detector gave no reason') };
  if (run.code !== 0 || typeof answer.person !== 'boolean') return { kind: 'error', reason: `the detector answer was not trustworthy (exit ${run.code})` };
  if (!answer.person) return { kind: 'none' };
  return { kind: 'person', confidence: typeof answer.confidence === 'number' ? answer.confidence : null };
}

module.exports = {
  ACTIONS, NO_PERSON_DIR, THUMB_SUFFIX, DEFAULTS,
  resolveScanConfig, thumbnailPath, noPersonDir, noPersonPath, buildScanArgs, scanEnv, parseScanResult,
};
