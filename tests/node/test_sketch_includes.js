'use strict';

// test_sketch_includes.js — a guard for something the desktop tests cannot see: how the ARDUINO TOOLCHAIN
// preprocesses a .ino before compiling it.
//
// Arduino generates a prototype for every function in the sketch and inserts them all before the FIRST
// function definition. So a function whose signature uses a type that comes from a header included
// LATER in the file does not compile ("'TfLiteTensor' does not name a type" — dequantize() takes one).
// It bit the person detector when the remote-logging glue, whose functions are the first in the file, was
// added above the TFLite #includes: every desktop test passed and `arduino-cli compile` failed.
//
// The rule that keeps it from happening: every #include comes BEFORE the first function definition. A
// late include is acceptable only if no function signature can need it: the generated fw_version.h
// (macros only), or a local header whose types appear in no signature (ota.h is included next to the
// code that uses it; its OtaUpdater class is not a parameter or a return type anywhere). Anything else
// — in particular a system or library header — must be up with the other includes.
//
// This reads the sketches as text (comments and strings blanked, so they cannot fool it); it does not
// compile anything.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const ROOT = path.join(__dirname, '../..');
const SKETCHES = [
  'Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino',
  'Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino',
];
const GENERATED_MACRO_ONLY = ['fw_version.h'];   // written by ota-deploy.sh: defines FW_GIT, no types

// Blanks comments and string/char literals (keeping line breaks, so line numbers stay true).
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : '');
      i = src[j] === c ? j + 1 : j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const NOT_A_FUNCTION = /^(if|for|while|switch|else|class|struct|enum|union|namespace|do|try|catch|typedef|using|template|extern|static_assert)\b/;

// The free function definitions of a sketch: [{ line (1-based), signature }]. A definition starts at
// column 0 and ends in "{" (the "{" may be on the next line); prototypes and variables end in ";".
function functionDefinitions(src) {
  const lines = stripCommentsAndStrings(src).split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s/.test(line) || line.startsWith('#') || line.startsWith('}')) continue;
    let stmt = line.trim();
    let k = i;
    while (!/[{;]/.test(stmt) && k + 1 < lines.length && k - i < 8) stmt += ' ' + lines[++k].trim();
    if (NOT_A_FUNCTION.test(stmt)) continue;
    const m = /^([A-Za-z_][^;{}=]*\))\s*(const\s*)?(override\s*)?\{/.exec(stmt);
    if (m) found.push({ line: i + 1, signature: m[1] });
  }
  return found;
}

function includes(src) {
  const out = [];
  stripCommentsAndStrings(src).split('\n').forEach((l, i) => {
    const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(l);
    // (strings are blanked, so read the name from the original line)
    if (m) {
      const orig = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(src.split('\n')[i]);
      out.push({ line: i + 1, name: orig ? orig[1] : m[1] });
    }
  });
  return out;
}

// The type names a header declares (class / struct / enum / union / typedef / using).
function declaredTypeNames(headerText) {
  const text = stripCommentsAndStrings(headerText);
  const names = new Set();
  let m;
  const decl = /\b(?:class|struct|enum(?:\s+class)?|union)\s+([A-Za-z_]\w*)/g;
  while ((m = decl.exec(text))) names.add(m[1]);
  const td = /\btypedef\b[^;]*?\b([A-Za-z_]\w*)\s*;/g;
  while ((m = td.exec(text))) names.add(m[1]);
  const us = /\busing\s+([A-Za-z_]\w*)\s*=/g;
  while ((m = us.exec(text))) names.add(m[1]);
  return names;
}

// Includes after the first function that could break a generated prototype. `sketchDir` is where a
// quoted include is looked up. Returns { first, late: [{ line, name, why }] }.
function lateIncludes(src, sketchDir) {
  const defs = functionDefinitions(src);
  if (defs.length === 0) return { first: null, late: [] };
  const first = defs[0];
  const late = [];
  for (const inc of includes(src).filter((i) => i.line > first.line)) {
    if (GENERATED_MACRO_ONLY.includes(inc.name)) continue;
    const file = sketchDir ? path.join(sketchDir, inc.name) : null;
    if (!file || !fs.existsSync(file)) {
      late.push({ ...inc, why: 'a library or core header (or one that is not in the sketch folder) must come before the first function' });
      continue;
    }
    const types = declaredTypeNames(fs.readFileSync(file, 'utf8'));
    const clash = [];
    for (const f of defs) for (const t of types) if (new RegExp(`\\b${t}\\b`).test(f.signature)) clash.push(`${t} in ${f.signature.split('(')[0].trim().split(/\s+/).pop()}()`);
    if (clash.length) late.push({ ...inc, why: `its types are used in function signatures: ${clash.slice(0, 3).join(', ')}` });
  }
  return { first, late };
}

// ── the checker itself ──────────────────────────────────────────────────

test('functionDefinitions: finds definitions, not prototypes, variables, classes or control flow', () => {
  const src = [
    '#include <a.h>',
    'int g_x = 0;',
    'void proto(int a);',
    'RemoteLog inst(cfg(false), echo, nullptr);',
    'class K {',
    '  void member() {}',
    '};',
    'struct S {',
    '};',
    'float dequantize(const TfLiteTensor *o, int8_t v)',
    '{',
    '  if (v) { return 1; }',
    '}',
    'bool multi(int a,',
    '           int b) {',
    '}',
  ].join('\n');
  const d = functionDefinitions(src);
  assertEqual(d.map((f) => f.line), [10, 14]);
  assertTrue(d[0].signature.startsWith('float dequantize(const TfLiteTensor'));
});

test('functionDefinitions: comments and strings cannot fool it', () => {
  const src = [
    '// void fake() {',
    '/* int also(int x) { */',
    'const char *s = "void inString() {";',
    'void real() {',
    '}',
  ].join('\n');
  assertEqual(functionDefinitions(src).map((f) => f.line), [4]);
});

test('lateIncludes: the bug that broke the build is detected (a function above a header that a later signature needs)', () => {
  const src = [
    '#include <Arduino.h>',
    'void logEcho() {',          // the first function
    '}',
    '#include "tensorflow/lite/micro/micro_interpreter.h"',
    'float dequantize(const TfLiteTensor *o, int8_t v)',
    '{',
    '}',
  ].join('\n');
  const r = lateIncludes(src, '/nonexistent');
  assertEqual(r.first.line, 2);
  assertEqual(r.late.map((i) => i.name), ['tensorflow/lite/micro/micro_interpreter.h']);
  assertTrue(/library or core header/.test(r.late[0].why));
});

test('lateIncludes: includes before the first function, and the generated fw_version.h after it, are fine', () => {
  const src = ['#include <a.h>', '#include "b.h"', 'void f() {', '}', '#include "fw_version.h"', 'void g() {', '}'].join('\n');
  assertEqual(lateIncludes(src, '/nonexistent').late, []);
});

test('lateIncludes: a local header after the first function is fine unless its types are in a signature', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sk-'));
  fs.writeFileSync(path.join(dir, 'tool.h'), 'class Widget { };\nstruct Gadget {};\ntypedef int Handle;\n');
  const ok = ['void f() {', '}', '#include "tool.h"', 'Widget w;', 'void g(int a) {', '}'].join('\n');
  assertEqual(lateIncludes(ok, dir).late, []);
  const bad = ['void f() {', '}', '#include "tool.h"', 'void g(const Widget *w) {', '}'].join('\n');
  const r = lateIncludes(bad, dir);
  assertEqual(r.late.map((i) => i.name), ['tool.h']);
  assertTrue(/Widget in g\(\)/.test(r.late[0].why), r.late[0].why);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lateIncludes: an include named in a comment or a string is not an include', () => {
  const src = ['void f() {', '}', '// #include "x.h"', 'const char *s = "#include <y.h>";'].join('\n');
  assertEqual(lateIncludes(src, '/nonexistent').late, []);
});

test('declaredTypeNames: classes, structs, enums, typedefs and aliases', () => {
  const t = declaredTypeNames('class A {}; struct B; enum class C {}; enum D {}; typedef unsigned long E; using F = int; // class Z');
  assertEqual([...t].sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
});

// ── the real sketches ───────────────────────────────────────────────────

for (const rel of SKETCHES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test(`${path.basename(rel)}: no #include after the first function can break a generated prototype`, () => {
    const { first, late } = lateIncludes(src, path.dirname(path.join(ROOT, rel)));
    assertTrue(first !== null, 'the sketch has functions');
    assertEqual(late.map((i) => `line ${i.line}: #include "${i.name}" is after the first function (line ${first.line}): ${i.why}. ` +
      'Move it up with the other includes: Arduino inserts every function\'s prototype before the first function.'), []);
  });
}

summarize();
