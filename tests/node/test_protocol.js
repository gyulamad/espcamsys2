'use strict';

const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');
const protocol = require('../../nodejs/camera-relay/lib/protocol');

test('findAuthLineEnd finds the newline index', () => {
  assertEqual(protocol.findAuthLineEnd(Buffer.from('cam1\tkey123\n')), 11);
});

test('findAuthLineEnd returns -1 without a newline yet', () => {
  assertEqual(protocol.findAuthLineEnd(Buffer.from('cam1\tkey123')), -1);
});

test('isAuthLineTooLong', () => {
  assertTrue(!protocol.isAuthLineTooLong(200));
  assertTrue(protocol.isAuthLineTooLong(300));
});

test('parseAuthLine parses id and key', () => {
  assertEqual(protocol.parseAuthLine(Buffer.from('cam1\tsecret')), { id: 'cam1', key: 'secret' });
});

test('parseAuthLine strips a trailing \\r (CRLF line endings)', () => {
  assertEqual(protocol.parseAuthLine(Buffer.from('cam1\tsecret\r')), { id: 'cam1', key: 'secret' });
});

test('parseAuthLine rejects a missing id', () => {
  assertEqual(protocol.parseAuthLine(Buffer.from('\tsecret')), null);
});

test('parseAuthLine rejects a line with no tab separator', () => {
  assertEqual(protocol.parseAuthLine(Buffer.from('cam1secret')), null);
});

test('isFrameLengthValid rejects zero and oversized lengths', () => {
  assertTrue(!protocol.isFrameLengthValid(0));
  assertTrue(!protocol.isFrameLengthValid(6 * 1024 * 1024));
  assertTrue(protocol.isFrameLengthValid(1024));
});

function lengthPrefixed(payload) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([lenBuf, payload]);
}

test('drainFrames extracts one complete frame', () => {
  const { frames, rest } = protocol.drainFrames(lengthPrefixed(Buffer.from('hello')));
  assertEqual(frames.map((f) => f.toString()), ['hello']);
  assertEqual(rest.length, 0);
});

test('drainFrames extracts multiple frames buffered together', () => {
  const buf = Buffer.concat([lengthPrefixed(Buffer.from('aaa')), lengthPrefixed(Buffer.from('bb'))]);
  const { frames, rest } = protocol.drainFrames(buf);
  assertEqual(frames.map((f) => f.toString()), ['aaa', 'bb']);
  assertEqual(rest.length, 0);
});

test('drainFrames leaves a partial trailing frame in `rest`', () => {
  const full = lengthPrefixed(Buffer.from('aaa'));
  const partial = full.slice(0, full.length - 1); // one byte short of complete
  const { frames, rest } = protocol.drainFrames(partial);
  assertEqual(frames.length, 0);
  assertEqual(rest.length, partial.length);
});

test('drainFrames leaves a partial length prefix in `rest`', () => {
  const buf = Buffer.from([0, 0, 1]); // only 3 of the 4 length bytes
  const { frames, rest } = protocol.drainFrames(buf);
  assertEqual(frames.length, 0);
  assertEqual(rest.length, 3);
});

test('drainFrames throws on a zero-length frame prefix', () => {
  const bad = Buffer.alloc(4); // length 0
  assertThrows(() => protocol.drainFrames(bad));
});

test('drainFrames throws on an oversized frame prefix', () => {
  const bad = Buffer.alloc(4);
  bad.writeUInt32BE(6 * 1024 * 1024, 0);
  assertThrows(() => protocol.drainFrames(bad));
});

test('encodeControlByte', () => {
  assertEqual(Array.from(protocol.encodeControlByte(true)), [1]);
  assertEqual(Array.from(protocol.encodeControlByte(false)), [0]);
});

summarize();
