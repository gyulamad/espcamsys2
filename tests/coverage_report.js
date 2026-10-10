#!/usr/bin/env node
// coverage_report.js — merges gcov results from every C++ test binary and
// reports line coverage of the Recorder sketch's testable code.
//
// Usage: node tests/coverage_report.js <build-dir> <repo-root> <min-percent>
//
// Why a script and not plain `gcov`: the code under test lives in headers
// (logic.h, remote_log.h) and a block extracted from the .ino, and several
// test binaries include the same header. Running gcov per binary gives one
// partial report per binary that overwrite each other; line coverage must be
// the UNION across binaries. This sums per-line hit counts from gcov's JSON
// output (gcov >= 9) and a line counts as covered if any binary ran it.
//
// What is measured (the rest of the .ino — setup(), loop(), camera, WiFi —
// needs real hardware and cannot run on a desktop):
//   Arduino/ESP32_CAM_Recorder/logic.h
//   Arduino/ESP32_CAM_Recorder/remote_log.h
//   tests/cpp/build/log_glue.inc   (the remote-logging block of the .ino)
//
// Exit code: 0 if coverage >= min-percent, 1 if below it or no data.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [buildDir, rootDir, minArg] = process.argv.slice(2);
const minPercent = Number(minArg);
if (!buildDir || !rootDir || !Number.isFinite(minPercent)) {
    console.error('usage: coverage_report.js <build-dir> <repo-root> <min-percent>');
    process.exit(2);
}

const recorderDir = path.join(rootDir, 'Arduino', 'ESP32_CAM_Recorder');
const measured = [
    path.join(recorderDir, 'logic.h'),
    path.join(recorderDir, 'remote_log.h'),
    path.join(buildDir, 'log_glue.inc'),
].map((p) => path.resolve(p));

// file -> Map(line -> total hit count across all test binaries)
const hits = new Map(measured.map((f) => [f, new Map()]));

const gcdas = fs.readdirSync(buildDir).filter((f) => f.endsWith('.gcda'));
if (gcdas.length === 0) {
    console.error('FAIL: no .gcda files in ' + buildDir + ' — no coverage data was produced');
    process.exit(1);
}

for (const gcda of gcdas) {
    let out;
    try {
        out = execFileSync('gcov', ['--json-format', '--stdout', '-o', buildDir, path.join(buildDir, gcda)],
            { cwd: buildDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        console.error('FAIL: gcov failed on ' + gcda + ' (gcov >= 9 is required for --json-format)');
        console.error(String(e.stderr || e.message));
        process.exit(1);
    }
    for (const doc of out.split('\n').filter((l) => l.startsWith('{'))) {
        for (const f of JSON.parse(doc).files || []) {
            const abs = path.resolve(buildDir, f.file);
            const lines = hits.get(abs);
            if (!lines) continue; // test code, framework.h, system headers: not measured
            for (const l of f.lines) {
                lines.set(l.line_number, (lines.get(l.line_number) || 0) + l.count);
            }
        }
    }
}

// Collapses [3,4,5,9] into "3-5, 9".
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

let total = 0, covered = 0, missingData = false;
console.log('Line coverage (union of all C++ test binaries):');
for (const file of measured) {
    const lines = hits.get(file);
    const name = path.relative(rootDir, file);
    if (lines.size === 0) {
        console.log('  ' + name.padEnd(52) + ' NO DATA (not compiled into any test?)');
        missingData = true;
        continue;
    }
    const nums = [...lines.keys()].sort((a, b) => a - b);
    const miss = nums.filter((n) => lines.get(n) === 0);
    const cov = nums.length - miss.length;
    total += nums.length;
    covered += cov;
    console.log('  ' + name.padEnd(52) + ' ' + (100 * cov / nums.length).toFixed(1).padStart(5) + '%  (' + cov + '/' + nums.length + ')');
    if (miss.length) console.log('      uncovered lines: ' + ranges(miss));
}

const pct = total ? 100 * covered / total : 0;
console.log('  ' + 'TOTAL'.padEnd(52) + ' ' + pct.toFixed(1).padStart(5) + '%  (' + covered + '/' + total + ')');

if (missingData) {
    console.log('FAIL: a measured file has no coverage data');
    process.exit(1);
}
if (pct < minPercent) {
    console.log('FAIL: coverage ' + pct.toFixed(1) + '% is below the required ' + minPercent + '%');
    process.exit(1);
}
console.log('coverage ' + pct.toFixed(1) + '% >= required ' + minPercent + '%: ok');
