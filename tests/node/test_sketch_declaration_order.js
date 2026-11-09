'use strict';

// The detector sketch is one .ino file: the Arduino compiler (unlike the desktop glue tests, which pull in only
// parts of it) refuses a global used above the line that declares it. This checks the order for the globals
// that functions in the middle of the file reach for.

const fs = require('fs');
const path = require('path');
const { test, assertTrue, summarize } = require('./framework');

const sketch = fs.readFileSync(path.join(__dirname, '../../Arduino/ESP32_CAM_TFLite_Person/ESP32_CAM_TFLite_Person.ino'), 'utf8');

for (const name of ['g_relayHealth', 'g_cfg', 'g_find']) {
  test(`${name} is declared before its first use`, () => {
    const declaration = new RegExp(`^(?:volatile |static )*\\w[\\w:<>*&]*[ *&]+${name}\\b.*[;=]`, 'm').exec(sketch);
    assertTrue(declaration !== null, `no declaration of ${name}`);
    const firstUse = sketch.search(new RegExp(`\\b${name}\\b`));
    assertTrue(firstUse >= declaration.index, `${name} is used at char ${firstUse}, above its declaration at ${declaration.index}`);
  });
}

summarize();
