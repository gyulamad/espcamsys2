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

test('encodeRelayGreeting: legacy resume byte, then the in-band-alarm and Wi-Fi-report capability bytes', () => {
  assertEqual(Array.from(protocol.encodeRelayGreeting()), [0x01, 0x02, 0x03]);
  assertEqual(protocol.RELAY_CAP_INBAND_ALARM, 0x02);
});

test('the capability byte is not one old firmware acts on (it only understood 0x00 pause / 0x01 resume)', () => {
  assertTrue(protocol.RELAY_CAP_INBAND_ALARM !== 0x00 && protocol.RELAY_CAP_INBAND_ALARM !== 0x01);
});

// ── Wi-Fi report (MSG_WIFI) ───────────────────────────────────────────────

function wifiPayload(rssi, ssidBytes) {
  return Buffer.concat([Buffer.from([protocol.CONTROL_MARKER, protocol.MSG_WIFI, rssi & 0xff]), Buffer.from(ssidBytes)]);
}

test('classifyPayload: a Wi-Fi report carries the signal (signed) and the name', () => {
  assertEqual(protocol.classifyPayload(wifiPayload(-61, 'HomeNet')), { kind: 'wifi', ssid: 'HomeNet', rssi: -61 });
});

test('classifyPayload: a Wi-Fi report with a multi-byte name', () => {
  assertEqual(protocol.classifyPayload(wifiPayload(-70, 'Café')).ssid, 'Café');
});

test('classifyPayload: a Wi-Fi report whose name is not UTF-8 has ssid null (never replacement characters)', () => {
  assertEqual(protocol.classifyPayload(wifiPayload(-61, [0xff, 0xfe, 0x41])), { kind: 'wifi', ssid: null, rssi: -61 });
});

test('classifyPayload: a Wi-Fi report with no name at all is an empty name, not a crash', () => {
  assertEqual(protocol.classifyPayload(wifiPayload(-61, '')), { kind: 'wifi', ssid: '', rssi: -61 });
});

test('classifyPayload: a Wi-Fi report too short to hold the signal byte is unknown (ignored)', () => {
  assertEqual(protocol.classifyPayload(Buffer.from([protocol.CONTROL_MARKER, protocol.MSG_WIFI])), { kind: 'unknown' });
});

test('encodeWifiMessage: length prefix + marker + type + signal + name, and it reads back', () => {
  const bytes = protocol.encodeWifiMessage('HomeNet', -61);
  assertEqual(bytes.readUInt32BE(0), bytes.length - 4);
  assertEqual(protocol.classifyPayload(bytes.slice(4)), { kind: 'wifi', ssid: 'HomeNet', rssi: -61 });
});

test('encodeWifiMessage: the exact bytes the camera firmware pins in tests/cpp/test_alarm_logic.cpp', () => {
  assertEqual(Array.from(protocol.encodeWifiMessage('Home', -61)), [0x00, 0x00, 0x00, 0x07, 0x00, 0x03, 0xc3, 0x48, 0x6f, 0x6d, 0x65]);
});

test('encodeWifiMessage: goes through the frame splitter like any other message', () => {
  const { drainFrames } = protocol;
  const out = drainFrames(protocol.encodeWifiMessage('HomeNet', -61));
  assertEqual(out.frames.length, 1);
  assertEqual(protocol.classifyPayload(out.frames[0]).kind, 'wifi');
});

summarize();
