'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { parseIntInRange, isSafeFilename, parseEnabledFlag } = require('../../nodejs/camera-relay/lib/validation');

test('parseIntInRange accepts a value inside the range', () => {
  assertEqual(parseIntInRange('10', 1, 20), 10);
});

test('parseIntInRange rejects a value below the minimum', () => {
  assertEqual(parseIntInRange('0', 1, 20), null);
});

test('parseIntInRange rejects a value above the maximum', () => {
  assertEqual(parseIntInRange('21', 1, 20), null);
});

test('parseIntInRange rejects non-numeric input', () => {
  assertEqual(parseIntInRange('abc', 1, 20), null);
});

test('parseIntInRange rejects a missing value', () => {
  assertEqual(parseIntInRange(undefined, 1, 20), null);
});

test('parseIntInRange accepts boundary values', () => {
  assertEqual(parseIntInRange('1', 1, 3600), 1);
  assertEqual(parseIntInRange('3600', 1, 3600), 3600);
});

test('isSafeFilename accepts a relay-generated recording name', () => {
  assertTrue(isSafeFilename('cam1_2024-01-01T00-00-00-000Z.mp4'));
});

test('isSafeFilename rejects path traversal attempts', () => {
  assertTrue(!isSafeFilename('../../etc/passwd'));
  assertTrue(!isSafeFilename('sub/dir.mp4'));
});

test('isSafeFilename rejects the wrong extension', () => {
  assertTrue(!isSafeFilename('video.mov'));
});

test('parseEnabledFlag parses "1" and "0"', () => {
  assertEqual(parseEnabledFlag('1'), true);
  assertEqual(parseEnabledFlag('0'), false);
});

test('parseEnabledFlag rejects anything else', () => {
  assertEqual(parseEnabledFlag('true'), null);
  assertEqual(parseEnabledFlag(undefined), null);
  assertEqual(parseEnabledFlag(''), null);
});

summarize();
