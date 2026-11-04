'use strict';

// test_muxcodec.js — the wire format of GET /mux: the relay's encoder (nodejs/camera-relay/lib/muxcodec.js)
// and the browser's decoder (php/cameras/js/mux-codec.js) must agree byte for byte, whatever way the bytes
// are cut into chunks on their way through PHP, Apache and Tor.

const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');
const enc = require('../../nodejs/camera-relay/lib/muxcodec');
const dec = require('../../php/cameras/js/mux-codec');

const JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
const asText = (u8) => Buffer.from(u8).toString('hex');

function parseAll(bytes, chunkSize) {
  const parser = dec.createParser();
  const out = [];
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(...parser.push(new Uint8Array(bytes.subarray(i, i + chunkSize))));
  return out;
}

test('both sides use the same constants', () => {
  assertEqual(dec.VERSION, enc.VERSION);
  assertEqual(dec.TYPE_FRAME, enc.TYPE_FRAME);
  assertEqual(dec.TYPE_HEARTBEAT, enc.TYPE_HEARTBEAT);
  assertEqual(dec.CONTENT_TYPE, enc.CONTENT_TYPE);
});

test('encodeFrame: length, version, type, source length, source, picture', () => {
  const bytes = enc.encodeFrame('cam:a', JPEG);
  assertEqual(bytes.readUInt32BE(0), 3 + 5 + JPEG.length, 'the length counts everything after itself');
  assertEqual([bytes[4], bytes[5], bytes[6]], [1, 1, 5]);
  assertEqual(bytes.subarray(7, 12).toString('utf8'), 'cam:a');
  assertEqual(asText(bytes.subarray(12)), asText(JPEG));
});

test('encodeHeartbeat: a message with no source and no payload', () => {
  const bytes = enc.encodeHeartbeat();
  assertEqual(asText(bytes), '000000030102' + '00');
});

test('cameraSource names the kind of the source', () => {
  assertEqual(enc.cameraSource('cam1'), 'cam:cam1');
  assertEqual(dec.cameraIdOf('cam:cam1'), 'cam1');
  assertEqual(dec.cameraIdOf('det:cam1'), null, 'a detector picture is not a camera picture');
});

test('a picture survives encode -> decode', () => {
  const [message] = parseAll(enc.encodeFrame('cam:front-door', JPEG), 1000);
  assertEqual([message.type, message.source], [enc.TYPE_FRAME, 'cam:front-door']);
  assertEqual(asText(message.payload), asText(JPEG));
});

test('a non-ASCII source survives (the length is in bytes, not characters)', () => {
  const [message] = parseAll(enc.encodeFrame('cam:á', JPEG), 1000);
  assertEqual(message.source, 'cam:á');
});

test('messages cut into chunks anywhere (even byte by byte) come out whole and in order', () => {
  const stream = Buffer.concat([enc.encodeHeartbeat(), enc.encodeFrame('cam:a', JPEG), enc.encodeFrame('cam:b', Buffer.from([9])), enc.encodeHeartbeat()]);
  for (const size of [1, 2, 3, 5, 7, 11, stream.length]) {
    const got = parseAll(stream, size);
    assertEqual(got.map((m) => [m.type, m.source, asText(m.payload)]), [
      [enc.TYPE_HEARTBEAT, '', ''],
      [enc.TYPE_FRAME, 'cam:a', asText(JPEG)],
      [enc.TYPE_FRAME, 'cam:b', '09'],
      [enc.TYPE_HEARTBEAT, '', ''],
    ], `chunk size ${size}`);
  }
});

test('an incomplete message produces nothing until the rest arrives', () => {
  const bytes = enc.encodeFrame('cam:a', JPEG);
  const parser = dec.createParser();
  assertEqual(parser.push(new Uint8Array(bytes.subarray(0, bytes.length - 1))).length, 0);
  assertEqual(parser.push(new Uint8Array(bytes.subarray(bytes.length - 1))).length, 1);
});

test('a message of an unknown type is returned (the caller skips it) and the next one still reads', () => {
  const unknown = Buffer.from(enc.encodeFrame('x:y', Buffer.from([1, 2, 3])));
  unknown[5] = 99;
  const got = parseAll(Buffer.concat([unknown, enc.encodeFrame('cam:a', JPEG)]), 4);
  assertEqual(got.map((m) => m.type), [99, enc.TYPE_FRAME]);
});

test('the decoder refuses bytes that are not this format', () => {
  const wrongVersion = Buffer.from(enc.encodeHeartbeat());
  wrongVersion[4] = 2;
  assertThrows(() => dec.createParser().push(new Uint8Array(wrongVersion)), 'unknown version');
  assertThrows(() => dec.createParser().push(new Uint8Array([0, 0, 0, 2, 1, 1])), 'length shorter than the fixed part');
  assertThrows(() => dec.createParser().push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 1])), 'absurd length, rejected before waiting for it');
  assertThrows(() => dec.createParser().push(new Uint8Array([0, 0, 0, 4, 1, 1, 9, 0])), 'a source longer than its message');
  let error = null;
  try { dec.createParser().push(new Uint8Array([0, 0, 0, 0])); } catch (e) { error = e; }
  assertTrue(error instanceof dec.ProtocolError, 'a ProtocolError, so the client can tell it from a bug');
});

test('the encoder refuses a source or a picture that is too big', () => {
  assertThrows(() => enc.encodeFrame('c'.repeat(enc.MAX_SOURCE_BYTES + 1), JPEG));
  assertThrows(() => enc.encodeFrame('cam:a', Buffer.alloc(enc.MAX_PAYLOAD_BYTES + 1)));
  assertEqual(enc.encodeFrame('c'.repeat(enc.MAX_SOURCE_BYTES), JPEG).length > 0, true, 'the largest allowed source is accepted');
});

test('the largest picture the encoder accepts is one the decoder accepts', () => {
  const [message] = parseAll(enc.encodeFrame('cam:a', Buffer.alloc(enc.MAX_PAYLOAD_BYTES, 7)), 64 * 1024);
  assertEqual(message.payload.length, enc.MAX_PAYLOAD_BYTES);
});

summarize();
