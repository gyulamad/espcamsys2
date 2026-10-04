'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { parseIntInRange, isSafeFilename, countRecordingFiles } = require('../../nodejs/camera-relay/lib/validation');

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

test('countRecordingFiles counts exactly the files the recordings list shows (isSafeFilename)', () => {
  const names = ['cam1_2026-10-03T10-00-00-000Z.mp4', 'cam1_2026-10-03T11-00-00-000Z.mp4'];
  assertEqual(countRecordingFiles(names), 2);
  assertEqual(countRecordingFiles([]), 0);
});

test('countRecordingFiles ignores a recording in progress (.tmp_ folder) and anything that is not a recording', () => {
  const names = ['a.mp4', '.tmp_2026-10-03T10-00-00-000Z', 'notes.txt', 'a.mp4.part', '..', 'b.MP4x'];
  assertEqual(countRecordingFiles(names), 1);
});

test('countRecordingFiles agrees with isSafeFilename for every name (they cannot drift apart)', () => {
  const names = ['x.mp4', 'y.mp3', '.hidden.mp4', 'a b.mp4', '../evil.mp4', 'ok-1_2.mp4', ''];
  assertEqual(countRecordingFiles(names), names.filter(isSafeFilename).length);
});

summarize();
