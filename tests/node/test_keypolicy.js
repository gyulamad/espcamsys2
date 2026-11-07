'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const kp = require('../../nodejs/camera-relay/lib/keypolicy');

// ── keyStrengthProblem ──

test('keyStrengthProblem: a strong random hex key returns null', () => {
  assertEqual(kp.keyStrengthProblem('camKey', 'a1b2c3d4e5f6a7b8c9d0e1f2'), null);
  assertEqual(kp.keyStrengthProblem('controlKey', '0'.repeat(48)), null);
});

test('keyStrengthProblem: the example.config.js template value is rejected', () => {
  assertTrue(kp.keyStrengthProblem('camKey', 'change-me'));
  assertTrue(/template or weak/.test(kp.keyStrengthProblem('camKey', 'change-me')));
});

test('keyStrengthProblem: case-insensitive match for known weak values', () => {
  for (const v of ['Change-Me', 'CHANGE-ME', 'CHANGEME', 'Test', 'SECRET']) {
    assertTrue(kp.keyStrengthProblem('camKey', v), v);
  }
});

test('keyStrengthProblem: template prefixes are rejected even with a strong-looking tail', () => {
  for (const v of ['change-me-1234567890abcdef', 'replace-this-please123', 'todo-real-key-here12345', 'xxx-key-1234567890ab']) {
    assertTrue(kp.keyStrengthProblem('camKey', v), v);
  }
});

test('keyStrengthProblem: too short is rejected (less than MIN_KEY_LENGTH)', () => {
  assertTrue(kp.keyStrengthProblem('camKey', 'short1234'));
  assertEqual(kp.keyStrengthProblem('camKey', 'x'.repeat(kp.MIN_KEY_LENGTH - 1)).includes('too short'), true);
  assertEqual(kp.keyStrengthProblem('camKey', 'x'.repeat(kp.MIN_KEY_LENGTH)), null);
});

test('keyStrengthProblem: empty string is rejected', () => {
  assertTrue(kp.keyStrengthProblem('camKey', '').includes('empty'));
});

test('keyStrengthProblem: non-strings are rejected', () => {
  for (const bad of [undefined, null, 42, [], {}]) {
    assertTrue(kp.keyStrengthProblem('camKey', bad).includes('not a string'));
  }
});

test('keyStrengthProblem: the field name appears in the message', () => {
  assertTrue(kp.keyStrengthProblem('controlKey', 'change-me').startsWith('controlKey'));
});

// ── keysAreEqualAndNonEmpty ──

test('keysAreEqualAndNonEmpty: two identical non-empty keys are equal', () => {
  assertTrue(kp.keysAreEqualAndNonEmpty('same', 'same'));
});

test('keysAreEqualAndNonEmpty: different keys are not equal', () => {
  assertTrue(!kp.keysAreEqualAndNonEmpty('cam-key-1', 'control-key-2'));
});

test('keysAreEqualAndNonEmpty: an empty key on either side is not equal', () => {
  assertTrue(!kp.keysAreEqualAndNonEmpty('', ''));
  assertTrue(!kp.keysAreEqualAndNonEmpty('a', ''));
  assertTrue(!kp.keysAreEqualAndNonEmpty('', 'b'));
});

test('keysAreEqualAndNonEmpty: non-strings return false (no throw)', () => {
  assertTrue(!kp.keysAreEqualAndNonEmpty(undefined, 'b'));
  assertTrue(!kp.keysAreEqualAndNonEmpty('a', null));
  assertTrue(!kp.keysAreEqualAndNonEmpty(42, 'b'));
});

summarize();
