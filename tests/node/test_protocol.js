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

test('encodeControlByte (legacy resume byte kept for old firmware)', () => {
  assertEqual(Array.from(protocol.encodeControlByte(true)), [1]);
  assertEqual(Array.from(protocol.encodeControlByte(false)), [0]);
});

// ── In-band control messages ─────────────────────────────────────────

test('classifyPayload: a JPEG (starts FF D8) is a frame', () => {
  assertEqual(protocol.classifyPayload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), { kind: 'frame' });
});

test('classifyPayload: existing non-JPEG test payloads still count as frames', () => {
  assertEqual(protocol.classifyPayload(Buffer.from('hello')), { kind: 'frame' });
});

test('classifyPayload: alarm for this camera / for all cameras', () => {
  assertEqual(protocol.classifyPayload(Buffer.from([0x00, protocol.MSG_ALARM])), { kind: 'alarm', all: false });
  assertEqual(protocol.classifyPayload(Buffer.from([0x00, protocol.MSG_ALARM_ALL])), { kind: 'alarm', all: true });
});

test('classifyPayload: an unknown control type is "unknown", not a frame (forward compatible)', () => {
  assertEqual(protocol.classifyPayload(Buffer.from([0x00, 0x7f])), { kind: 'unknown' });
  assertEqual(protocol.classifyPayload(Buffer.from([0x00])), { kind: 'unknown' }); // marker with no type
  assertEqual(protocol.classifyPayload(Buffer.from([0x00, 0x01, 0xaa, 0xbb])).kind, 'alarm'); // trailing reserved bytes ignored
});

test('classifyPayload: an empty payload is not mistaken for a control message', () => {
  assertEqual(protocol.classifyPayload(Buffer.alloc(0)), { kind: 'frame' });
});

test('encodeAlarmMessage produces the exact 6 wire bytes the firmware sends', () => {
  assertEqual(Array.from(protocol.encodeAlarmMessage(false)), [0, 0, 0, 2, 0x00, 0x01]);
  assertEqual(Array.from(protocol.encodeAlarmMessage(true)), [0, 0, 0, 2, 0x00, 0x02]);
});

test('an alarm message survives the real framing: drainFrames then classifyPayload', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 9, 9, 9]);
  const stream = Buffer.concat([lengthPrefixed(jpeg), protocol.encodeAlarmMessage(true), lengthPrefixed(jpeg)]);
  const { frames, rest } = protocol.drainFrames(stream);
  assertEqual(frames.map((f) => protocol.classifyPayload(f).kind), ['frame', 'alarm', 'frame']);
  assertEqual(rest.length, 0);
});

summarize();
