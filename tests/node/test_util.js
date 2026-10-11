'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assertEqual, summarize } = require('./framework');
const { envOr, errorMessage, errorTrace, consoleMethodFor, writeFileAtomic } = require('../../nodejs/camera-relay/lib/util');

test('envOr: a set variable wins over the config value', () => {
  assertEqual(envOr({ PORT: '9000' }, 'PORT', 8080), '9000');
});

test('envOr: a variable set to the empty string still wins (it is a deliberate override)', () => {
  assertEqual(envOr({ CONTROL_KEY: '' }, 'CONTROL_KEY', 'from-config'), '');
});

test('envOr: an unset variable falls back to the config value, even if that is undefined', () => {
  assertEqual(envOr({}, 'PORT', 8080), 8080);
  assertEqual(envOr({}, 'PORT', undefined), undefined);
});

test('errorMessage: the message of an Error, the value itself for anything else', () => {
  assertEqual(errorMessage(new Error('boom')), 'boom');
  assertEqual(errorMessage('plain string'), 'plain string');
  assertEqual(errorMessage(null), null);
});

test('errorTrace: the stack of an Error, the string form of anything else', () => {
  assertEqual(errorTrace(new Error('boom')).startsWith('Error: boom'), true);
  assertEqual(errorTrace('plain string'), 'plain string');
  assertEqual(errorTrace(undefined), 'undefined');
});

test('consoleMethodFor: errors and warnings keep their stream, the rest is plain output', () => {
  assertEqual(consoleMethodFor('ERROR'), 'error');
  assertEqual(consoleMethodFor('WARN'), 'warn');
  assertEqual(consoleMethodFor('INFO'), 'log');
  assertEqual(consoleMethodFor('DEBUG'), 'log');
});

test('writeFileAtomic: writes the content and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-'));
  const file = path.join(dir, 'state.json');
  try {
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assertEqual(fs.readFileSync(file, 'utf8'), 'two');
    assertEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

summarize();
