'use strict';

// test_sketch_setup_credentials.js — a guard for the optional build-time default master password of the setup
// WiFi (F-21), which the desktop C++ tests cannot see because it lives in how the .ino files are put together.
//
// setup_logic.h only reads the macro SETUP_DEFAULT_PASSWORD_OVERRIDE; WHO defines it is the sketch: it includes
// the git-ignored setup_credentials.local.h if there is one. That include has to come BEFORE the first include
// of anything that pulls in setup_logic.h (setup_mode.h does): after it, the built-in password would already
// be baked in and the override silently ignored. And a sketch built without the file must still build, so the
// include is guarded by __has_include. This reads the sketches as text; it does not compile anything.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const ROOT = path.join(__dirname, '../..');
const SKETCHES = [
  'Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino',
  'Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino',
];
const LOCAL = 'setup_credentials.local.h';

// The line number (1-based) of the first line matching `re`, or 0.
function lineOf(src, re) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 0;
}

for (const sketch of SKETCHES) {
  const src = fs.readFileSync(path.join(ROOT, sketch), 'utf8');
  const name = path.basename(sketch);

  test(`${name}: the local credentials file is optional (guarded by __has_include)`, () => {
    const guard = lineOf(src, new RegExp(`^#\\s*if\\s+__has_include\\("${LOCAL}"\\)`));
    const inc = lineOf(src, new RegExp(`^#\\s*include\\s+"${LOCAL}"`));
    assertTrue(guard > 0, 'the include is inside #if __has_include("' + LOCAL + '")');
    assertTrue(inc > guard, 'the include comes right after its guard');
    assertTrue(inc - guard <= 2, 'and nothing else sits between them');
  });

  test(`${name}: the local credentials file is included before anything that reads the macro`, () => {
    const inc = lineOf(src, new RegExp(`^#\\s*include\\s+"${LOCAL}"`));
    const setup = lineOf(src, /^#\s*include\s+"setup_(mode|boot|form|logic)\.h"/);
    assertTrue(inc > 0 && setup > 0, 'both includes are there');
    assertTrue(inc < setup, 'the override is defined before setup_logic.h is first included (line ' + inc + ' before ' + setup + ')');
  });
}

test('the example credentials file is committed and is not ignored; the real one is', () => {
  const example = path.join(ROOT, 'Arduino/templates/setup_credentials.example.h');
  assertTrue(fs.existsSync(example), 'Arduino/templates/setup_credentials.example.h exists');
  assertTrue(/#define\s+SETUP_DEFAULT_PASSWORD_OVERRIDE\s+"/.test(fs.readFileSync(example, 'utf8')), 'and defines the macro');
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assertTrue(ignore.includes('Arduino/*/setup_credentials.local.h'), 'the local files are gitignored');
  assertTrue(!ignore.some((l) => /setup_credentials\.example\.h|^Arduino\/templates\/\*\.h$|^\*\.h$/.test(l)), 'the example is not');
});

summarize();
