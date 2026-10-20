'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const dl = require('../../nodejs/camera-relay/lib/detectorlink');
const protocol = require('../../nodejs/camera-relay/lib/protocol');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const STATUS = { ip: '10.0.0.5', gpio: { pin: 13, high: false } };
const keyOk = (k) => k === 'right';

function req(over = {}) {
  return { url: '/detector/detector-1/uplink', headers: { 'x-api-key': 'right', upgrade: 'espcam-detector/1', connection: 'Upgrade' }, ...over };
}

// ── the address ─────────────────────────────────────────────────────────

test('matchPath: the id of an uplink address, nothing else', () => {
  assertEqual(dl.matchPath('/detector/detector-1/uplink'), 'detector-1');
  assertEqual(dl.matchPath('/detector/a.b_C-9/uplink?x=1'), 'a.b_C-9');
  assertEqual(dl.matchPath('/detector/x/stream'), null);
  assertEqual(dl.matchPath('/detector//uplink'), null);
  assertEqual(dl.matchPath('/detector/bad%20id/uplink'), null);
  assertEqual(dl.matchPath('/detector/' + 'a'.repeat(65) + '/uplink'), null);
  assertEqual(dl.matchPath('/detector/' + 'a'.repeat(64) + '/uplink'), 'a'.repeat(64));
  assertEqual(dl.matchPath('/detector/a/uplink/extra'), null);
  assertEqual(dl.matchPath(undefined), null);
});

// ── judging the request ─────────────────────────────────────────────────

test('checkUpgrade: a good request is accepted and names the detector', () => {
  assertEqual(dl.checkUpgrade(req(), keyOk), { ok: true, id: 'detector-1' });
});

test('checkUpgrade: the protocol name is compared without regard to case or spaces', () => {
  assertEqual(dl.checkUpgrade(req({ headers: { 'x-api-key': 'right', upgrade: ' ESPCAM-Detector/1 ' } }), keyOk).ok, true);
});

test('checkUpgrade: a wrong address is 404, and the key is not even looked at', () => {
  let asked = false;
  const r = dl.checkUpgrade(req({ url: '/nope' }), () => { asked = true; return true; });
  assertEqual(r.status, 404);
  assertEqual(asked, false, 'nothing is revealed before the address is right');
  assertTrue(/DETECTOR_ID/.test(r.error), 'the message says what the address should be');
});

test('checkUpgrade: no key and a wrong key are 401 with different, helpful messages', () => {
  const none = dl.checkUpgrade(req({ headers: { upgrade: 'espcam-detector/1' } }), keyOk);
  assertEqual(none.status, 401);
  assertTrue(/missing key/.test(none.error) && /X-Api-Key/.test(none.error), none.error);
  const wrong = dl.checkUpgrade(req({ headers: { 'x-api-key': 'nope', upgrade: 'espcam-detector/1' } }), keyOk);
  assertEqual(wrong.status, 401);
  assertTrue(/wrong key/.test(wrong.error) && /API_KEY/.test(wrong.error) && /camKey/.test(wrong.error), wrong.error);
  assertTrue(!wrong.error.includes('nope') && !wrong.error.includes('right'), 'neither key is ever echoed');
});

test('checkUpgrade: the right key but another protocol is 426', () => {
  assertEqual(dl.checkUpgrade(req({ headers: { 'x-api-key': 'right', upgrade: 'websocket' } }), keyOk).status, 426);
  assertEqual(dl.checkUpgrade(req({ headers: { 'x-api-key': 'right' } }), keyOk).status, 426);
  assertEqual(dl.checkUpgrade(req({ headers: { 'x-api-key': 'right', upgrade: ['a', 'b'] } }), keyOk).status, 426, 'a repeated header is not trusted');
});

test('checkUpgrade: copes with a request that has no headers at all', () => {
  assertEqual(dl.checkUpgrade({ url: '/detector/d/uplink' }, keyOk).status, 401);
  assertEqual(dl.checkUpgrade(null, keyOk).status, 404);
});

// ── the answers ─────────────────────────────────────────────────────────

test('acceptResponse is a 101 that names the protocol and ends the head', () => {
  const r = dl.acceptResponse();
  assertTrue(r.startsWith('HTTP/1.1 101 Switching Protocols\r\n'));
  assertTrue(r.includes('Upgrade: espcam-detector/1\r\n') && r.includes('Connection: Upgrade\r\n'));
  assertTrue(r.endsWith('\r\n\r\n'), 'nothing follows the head: the next bytes on the wire are the stream');
});

test('refusalResponse: status line, exact length, JSON body saying why, then closed', () => {
  const r = dl.refusalResponse(401, 'wrong key: "x"');
  const [head, body] = r.split('\r\n\r\n');
  assertTrue(head.startsWith('HTTP/1.1 401 Unauthorized'));
  assertTrue(head.includes('Content-Type: application/json') && head.includes('Connection: close'));
  assertEqual(JSON.parse(body), { error: 'wrong key: "x"' });
  assertTrue(head.includes(`Content-Length: ${Buffer.byteLength(body)}`));
});

test('refusalResponse: a 426 names the protocol that is wanted, an unknown status still has a reason', () => {
  assertTrue(dl.refusalResponse(426, 'x').includes('Upgrade: espcam-detector/1'));
  assertTrue(!dl.refusalResponse(401, 'x').includes('Upgrade:'));
  assertTrue(dl.refusalResponse(599, 'x').startsWith('HTTP/1.1 599 Error'));
});

test('refusalResponse: the length counts bytes, not characters', () => {
  const r = dl.refusalResponse(503, 'túl sok');
  const body = r.split('\r\n\r\n')[1];
  assertTrue(r.includes(`Content-Length: ${Buffer.byteLength(body)}`));
  assertTrue(Buffer.byteLength(body) > body.length);
});

// ── the messages ────────────────────────────────────────────────────────

test('encodeMessage / decodeMessage: status and picture survive the round trip', () => {
  const r = dl.decodeMessage(dl.encodeMessage(STATUS, JPEG));
  assertEqual(r.ok, true);
  assertEqual(r.kind, 'frame');
  assertEqual(r.status, STATUS);
  assertTrue(Buffer.compare(r.jpeg, JPEG) === 0);
});

test('a status-only message (no picture) is fine', () => {
  const r = dl.decodeMessage(dl.encodeMessage(STATUS, null));
  assertEqual(r.ok, true);
  assertEqual(r.jpeg, null);
  assertEqual(dl.decodeMessage(dl.encodeMessage(STATUS, Buffer.alloc(0))).jpeg, null);
});

test('the message layout is exactly what the firmware writes', () => {
  const m = dl.encodeMessage('{"a":1}', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assertEqual([...m.slice(0, 3)], [1, 0, 7], 'type 1, then the status length as two big-endian bytes');
  assertEqual(m.slice(3, 10).toString(), '{"a":1}');
  assertEqual([...m.slice(10)], [0xff, 0xd8, 0xff, 0xd9]);
  const wire = dl.frameMessage(m);
  assertEqual(wire.readUInt32BE(0), m.length, 'the length prefix is big-endian and counts the message only');
});

test('framed messages come out of the camera push protocol\'s drainFrames()', () => {
  const wire = Buffer.concat([dl.frameMessage(dl.encodeMessage(STATUS, JPEG)), dl.frameMessage(dl.encodeMessage(STATUS, null))]);
  const { frames, rest } = protocol.drainFrames(wire, dl.MAX_MESSAGE_BYTES);
  assertEqual(frames.length, 2);
  assertEqual(rest.length, 0);
  assertEqual(dl.decodeMessage(frames[1]).jpeg, null);
});

test('decodeMessage: a type this relay does not know is to be ignored, not an error', () => {
  assertEqual(dl.decodeMessage(Buffer.from([9, 1, 2, 3])), { ok: true, kind: 'unknown', type: 9 });
});

test('decodeMessage: refuses what cannot be a frame message, saying why', () => {
  const bad = (buf) => dl.decodeMessage(buf);
  assertEqual(bad(Buffer.alloc(0)).ok, false);
  assertEqual(bad('text').ok, false, 'not a Buffer');
  assertTrue(/header/.test(bad(Buffer.from([1, 0])).error));
  assertTrue(/out of range/.test(bad(Buffer.from([1, 0, 0])).error), 'zero-length status');
  assertTrue(/out of range/.test(bad(Buffer.from([1, 0xff, 0xff])).error), 'status longer than the limit');
  assertTrue(/only 2/.test(bad(Buffer.from([1, 0, 5, 0x7b, 0x7d])).error), 'status longer than the message');
  assertTrue(/not valid JSON/.test(bad(dl.encodeMessage('{nope', null)).error));
});

test('decodeMessage: the picture must be a JPEG of sane size', () => {
  const withPic = (pic) => dl.decodeMessage(Buffer.concat([dl.encodeMessage(STATUS, null), pic]));
  assertTrue(/not a JPEG/.test(withPic(Buffer.from('hello world')).error));
  assertTrue(/not a JPEG/.test(withPic(Buffer.from([0xff, 0xd8, 0xff])).error), 'three bytes is no picture');
  const big = Buffer.alloc(dl.MAX_JPEG_BYTES + 1, 0xff);
  assertTrue(/at most/.test(withPic(big).error));
  const max = Buffer.alloc(dl.MAX_JPEG_BYTES, 0xff); max[1] = 0xd8;
  assertEqual(withPic(max).ok, true, 'exactly the limit is fine');
});

test('JSON that is valid but not an object still decodes: judging the numbers is parseStatus()\'s job', () => {
  const r = dl.decodeMessage(dl.encodeMessage('[1,2]', null));
  assertEqual(r.ok, true);
  assertEqual(r.status, [1, 2]);
});

test('limits are consistent: a maximal message is within the frame cap', () => {
  assertEqual(dl.MAX_MESSAGE_BYTES, 3 + dl.MAX_STATUS_BYTES + dl.MAX_JPEG_BYTES);
  assertTrue(protocol.isFrameLengthValid(dl.MAX_MESSAGE_BYTES, dl.MAX_MESSAGE_BYTES));
  assertTrue(!protocol.isFrameLengthValid(dl.MAX_MESSAGE_BYTES + 1, dl.MAX_MESSAGE_BYTES));
});

summarize();
