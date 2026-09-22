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

test('encodeCommandFrame starts with the command frame tag', () => {
  const frame = protocol.encodeCommandFrame({ ai_enabled: false, live_peek_until_epoch: 0 });
  assertEqual(frame[0], protocol.COMMAND_FRAME_TAG);
});

test('encodeCommandFrame never collides with a legacy control byte tag', () => {
  // 0x00/0x01 are reserved for encodeControlByte() on this same socket —
  // the whole point of the tag byte is that a reader can always tell the
  // two message kinds apart.
  assertTrue(protocol.COMMAND_FRAME_TAG !== 0x00 && protocol.COMMAND_FRAME_TAG !== 0x01);
});

test('encodeCommandFrame length prefix matches the JSON payload length', () => {
  const command = { ai_enabled: true, live_peek_until_epoch: 1234567890 };
  const frame = protocol.encodeCommandFrame(command);
  const declaredLen = frame.readUInt16BE(1);
  const json = frame.slice(3, 3 + declaredLen);
  assertEqual(declaredLen, Buffer.byteLength(JSON.stringify(command), 'utf8'));
  assertEqual(JSON.parse(json.toString('utf8')), command);
});

test('encodeCommandFrame emits compact JSON (no whitespace)', () => {
  // The device-side decoder is a fixed-format substring scan, not a real
  // JSON parser (see logic.h) — it depends on this exact `"key":value`
  // spacing with no extra whitespace anywhere.
  const frame = protocol.encodeCommandFrame({ ai_enabled: false, live_peek_until_epoch: 0 });
  const declaredLen = frame.readUInt16BE(1);
  const json = frame.slice(3, 3 + declaredLen).toString('utf8');
  assertEqual(json, '{"ai_enabled":false,"live_peek_until_epoch":0}');
});

test('encodeCommandFrame throws if the JSON payload would exceed the length-prefix cap', () => {
  const huge = { ai_enabled: false, live_peek_until_epoch: 0, padding: 'x'.repeat(protocol.MAX_COMMAND_FRAME_LEN) };
  assertThrows(() => protocol.encodeCommandFrame(huge));
});

summarize();
