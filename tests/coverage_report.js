#!/usr/bin/env node
'use strict';

// coverage_report.js — turns the V8 coverage data of the Node.js unit tests
// into a line-coverage report for the relay's logic and applies the minimum.
//
// Usage: node tests/node/coverage_report.js <coverage-dir> <repo-root> <min-percent> [lib|server]
//
// run_tests.sh --coverage N runs the Node.js tests with NODE_V8_COVERAGE set to
// a directory; Node itself then writes one JSON file per process when it exits
// (the relay processes the e2e tests start write theirs when they are stopped). No package (nyc, c8, ...) is needed — this script reads
// those files directly. Needs a Node that writes block coverage this way
// (Node 12 or newer).
//
// Two areas, each judged against its own data directory:
//   lib    (default)  every nodejs/camera-relay/lib/**/*.js, run by the unit
//                     tests in tests/node/. A lib file that no test loads has no
//                     data at all and fails the check instead of silently
//                     counting as nothing.
//   server            nodejs/camera-relay/server.js, which only the end-to-end
//                     tests (tests/e2e/) run, as a separate relay process.
//
// How a line is judged: lines holding only whitespace or comments are ignored.
// Every other line is "covered" if any of its code ran in any test process, and
// "uncovered" if all of its code sat in code V8 saw run zero times (a function
// never called, a branch never taken). That is the same rule c8 uses.
//
// Exit code: 0 if coverage >= min-percent, 1 if below it or no data, 2 on bad usage.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const [covDir, rootDir, minArg, modeArg = 'lib'] = process.argv.slice(2);
const minPercent = Number(minArg);
if (!covDir || !rootDir || minArg === undefined || !Number.isFinite(minPercent) || !['lib', 'server'].includes(modeArg)) {
  console.error('usage: coverage_report.js <coverage-dir> <repo-root> <min-percent> [lib|server]');
  process.exit(2);
}

const relayDir = path.resolve(rootDir, 'nodejs', 'camera-relay');
const libDir = path.join(relayDir, 'lib');
const serverFile = path.join(relayDir, 'server.js');
// Which scripts V8 reported on are ours to measure, and what the area is called.
const isMeasured = modeArg === 'server'
  ? (f) => f === serverFile
  : (f) => f.startsWith(libDir + path.sep) && f.endsWith('.js');
const NAME = modeArg === 'server'
  ? 'Relay server (nodejs/camera-relay/server.js, run by the end-to-end tests)'
  : 'Relay Node.js logic (nodejs/camera-relay/lib)';

// ── which characters of a source file are code (not whitespace / comment) ──

const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of',
  'void', 'delete', 'throw', 'new', 'instanceof', 'yield', 'await']);
const REGEX_PRECEDING_CHARS = '(,=:[!&|?{};+-*%<>~^';
const isIdChar = (c) => /[A-Za-z0-9_$]/.test(c);

// Returns a Uint8Array, 1 for every character that is code. Strings, template
// literals and regex literals count as code; comments and whitespace do not.
function codeMask(src) {
  const mask = new Uint8Array(src.length);
  const n = src.length;
  const tplStack = []; // brace depth inside each open `${ ... }`
  let i = 0;
  let last = '';       // last significant (code) character
  let lastWord = '';   // the identifier ending at `last`, if any

  const mark = (from, to) => { for (let k = from; k < to; k++) if (!/\s/.test(src[k])) mask[k] = 1; };

  // Scans a template literal body starting at i (just after ` or after a
  // closing } of ${...}); stops after the closing ` or at the next ${.
  function scanTemplate() {
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; mark(start, i); last = '`'; lastWord = ''; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; mark(start, i); tplStack.push(0); last = '{'; lastWord = ''; return true; }
      i++;
    }
    mark(start, Math.min(i, n));
    return false;
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '/' && d === '/') {                       // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {                       // block comment
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {                       // string
      const start = i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i = Math.min(i + 1, n);
      mark(start, i); last = c; lastWord = '';
      continue;
    }
    if (c === '`') { i++; const s = i - 1; mark(s, i); scanTemplate(); continue; }
    if (c === '/') {                                    // regex literal or division
      const regexAllowed = last === '' || REGEX_PRECEDING_CHARS.includes(last) ||
        (isIdChar(last) && REGEX_PRECEDING_WORDS.has(lastWord));
      if (regexAllowed) {
        const start = i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { i++; break; }
          i++;
        }
        mark(start, i); last = '/'; lastWord = '';
        continue;
      }
    }
    if (tplStack.length) {                              // inside ${ ... }
      if (c === '{') tplStack[tplStack.length - 1]++;
      else if (c === '}') {
        if (tplStack[tplStack.length - 1] === 0) {
          tplStack.pop(); mark(i, i + 1); i++;
          while (scanTemplate()) { /* the next ${ is entered inside scanTemplate */ break; }
          continue;
        }
        tplStack[tplStack.length - 1]--;
      }
    }
    mark(i, i + 1);
    if (isIdChar(c)) { lastWord = isIdChar(last) ? lastWord + c : c; } else { lastWord = ''; }
    last = c;
    i++;
  }
  return mask;
}

// ── V8 coverage -> per-character "ran" flags for one process ────────────────

// ranges: every {startOffset,endOffset,count} of the script. Outer ranges are
// painted first, inner ones on top, so each character ends up with the count
// of the innermost range around it.
function paintCounts(len, ranges) {
  const counts = new Int32Array(len);
  const sorted = ranges.map((r, idx) => ({ r, idx }))
    .sort((a, b) => (a.r.startOffset - b.r.startOffset) || (b.r.endOffset - a.r.endOffset) || (a.idx - b.idx));
  for (const { r } of sorted) {
    const to = Math.min(r.endOffset, len);
    for (let k = Math.max(0, r.startOffset); k < to; k++) counts[k] = r.count;
  }
  return counts;
}

// file -> { lines: Map(lineNo -> covered?) }  merged across processes
const measured = new Map();   // file -> Map(line -> bool), only lines with code
const sources = new Map();    // file -> { src, mask, lineStarts }

function loadSource(file) {
  if (!sources.has(file)) {
    const src = fs.readFileSync(file, 'utf8');
    const lineStarts = [0];
    for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
    sources.set(file, { src, mask: codeMask(src), lineStarts });
  }
  return sources.get(file);
}

const jsonFiles = fs.existsSync(covDir)
  ? fs.readdirSync(covDir).filter((f) => f.endsWith('.json')).map((f) => path.join(covDir, f))
  : [];
if (jsonFiles.length === 0) {
  console.log('FAIL: no V8 coverage files in ' + covDir + ' — the Node.js tests produced no coverage data');
  process.exit(1);
}

for (const jf of jsonFiles) {
  let data;
  try { data = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch (e) {
    console.log('FAIL: unreadable coverage file ' + jf);
    process.exit(1);
  }
  for (const script of data.result || []) {
    if (!script.url || !script.url.startsWith('file:')) continue;
    let file;
    try { file = fileURLToPath(script.url); } catch (e) { continue; }
    if (!isMeasured(file)) continue; // tests, node internals, the other area ...

    const { src, mask, lineStarts } = loadSource(file);
    const ranges = [];
    for (const fn of script.functions) for (const r of fn.ranges) ranges.push(r);
    const counts = paintCounts(src.length, ranges);

    const lines = measured.get(file) || new Map();
    for (let ln = 0; ln < lineStarts.length; ln++) {
      const from = lineStarts[ln];
      const to = ln + 1 < lineStarts.length ? lineStarts[ln + 1] : src.length;
      let hasCode = false, ran = false;
      for (let k = from; k < to; k++) {
        if (!mask[k]) continue;
        hasCode = true;
        if (counts[k] > 0) { ran = true; break; }
      }
      if (hasCode) lines.set(ln + 1, lines.get(ln + 1) === true || ran);
    }
    measured.set(file, lines);
  }
}

// ── report ──────────────────────────────────────────────────────────────

function ranges(nums) {
  const r = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    r.push(j > i ? nums[i] + '-' + nums[j] : String(nums[i]));
    i = j;
  }
  return r.join(', ');
}

function listLibFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listLibFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const measuredFiles = modeArg === 'server' ? [serverFile] : (fs.existsSync(libDir) ? listLibFiles(libDir) : []);
if (measuredFiles.length === 0 || !measuredFiles.every((f) => fs.existsSync(f))) {
  console.log('FAIL: nothing to measure under ' + relayDir);
  process.exit(1);
}

console.log(NAME + ' — line coverage (union of all Node.js test processes):');
let total = 0, covered = 0, missingData = false;
for (const file of measuredFiles) {
  const rel = path.relative(rootDir, file);
  const lines = measured.get(file);
  if (!lines || lines.size === 0) {
    console.log('  ' + rel.padEnd(52) + ' NO DATA (no test loads this file?)');
    missingData = true;
    continue;
  }
  const nums = [...lines.keys()].sort((a, b) => a - b);
  const miss = nums.filter((l) => !lines.get(l));
  const cov = nums.length - miss.length;
  total += nums.length;
  covered += cov;
  console.log('  ' + rel.padEnd(52) + ' ' + (100 * cov / nums.length).toFixed(1).padStart(5) + '%  (' + cov + '/' + nums.length + ')');
  if (miss.length) console.log('      uncovered lines: ' + ranges(miss));
}
const pct = total ? 100 * covered / total : 0;
console.log('  ' + 'TOTAL'.padEnd(52) + ' ' + pct.toFixed(1).padStart(5) + '%  (' + covered + '/' + total + ')');

if (missingData || total === 0) {
  console.log('FAIL: ' + NAME + ' has a measured file with no coverage data');
  process.exit(1);
}
if (pct < minPercent) {
  console.log('FAIL: ' + NAME + ' coverage ' + pct.toFixed(1) + '% is below the required ' + minPercent + '%');
  process.exit(1);
}
console.log('ok: ' + NAME + ' coverage ' + pct.toFixed(1) + '% >= required ' + minPercent + '%');
