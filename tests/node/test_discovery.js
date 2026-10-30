'use strict';

// test_discovery.js — the relay's half of "a camera finds the relay by itself" (lib/discovery.js):
// which datagrams are probes, what the answer looks like, and that only the holder of camKey can
// make a correct one. The firmware's half is tested in tests/cpp/test_relay_find_logic.cpp, against
// the same fixed vector as below, so the two cannot drift apart unnoticed.

const crypto = require('crypto');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const d = require('../../nodejs/camera-relay/lib/discovery');

const NONCE = '0123456789abcdef';
const KEY = 'change-me';
// HMAC-SHA256(key "change-me", "ESPCAM1!0123456789abcdef"), worked out independently of Node with
//   printf 'ESPCAM1!0123456789abcdef' | openssl dgst -sha256 -hmac 'change-me'
// tests/cpp/test_relay_find_logic.cpp holds the same constant.
const VECTOR_MAC = 'fcdee8782d8d0f678cca8814cd2737bcb2b302d2ca3d15a95bf916b08f6b5286';

test('parseProbe accepts exactly "ESPCAM1?" + 16 lowercase hex characters', () => {
  assertEqual(d.parseProbe(Buffer.from('ESPCAM1?' + NONCE)), NONCE);
  assertEqual(d.parseProbe(Buffer.from('ESPCAM1?ffffffffffffffff')), 'ffffffffffffffff');
});

test('parseProbe ignores everything else (the relay stays silent)', () => {
  const bad = [
    '', 'ESPCAM1?', 'ESPCAM1?' + NONCE + '0', 'ESPCAM1?' + NONCE.slice(0, 15),
    'ESPCAM1?' + NONCE.toUpperCase(), 'ESPCAM1?' + 'g'.repeat(16), 'espcam1?' + NONCE,
    'ESPCAM2?' + NONCE, 'ESPCAM1!' + NONCE, ' ESPCAM1?' + NONCE, 'ESPCAM1?' + NONCE + '\n',
    'GET / HTTP/1.1\r\n\r\n', 'x'.repeat(24), 'x'.repeat(2000),
  ];
  for (const s of bad) assertEqual(d.parseProbe(Buffer.from(s, 'latin1')), null, JSON.stringify(s.slice(0, 30)));
  assertEqual(d.parseProbe('ESPCAM1?' + NONCE), null, 'a string is not a datagram');
  assertEqual(d.parseProbe(null), null);
  assertEqual(d.parseProbe(undefined), null);
});

test('the answer is "ESPCAM1!" + nonce + ":" + a 64-character keyed MAC', () => {
  const reply = d.buildReply(NONCE, KEY).toString('latin1');
  assertTrue(/^ESPCAM1!0123456789abcdef:[0-9a-f]{64}$/.test(reply), reply);
  assertEqual(reply.length, 8 + 16 + 1 + 64);
});

test('the MAC is HMAC-SHA256 of "ESPCAM1!" + nonce, keyed with camKey', () => {
  const expected = crypto.createHmac('sha256', KEY).update('ESPCAM1!' + NONCE).digest('hex');
  assertEqual(d.macFor(KEY, NONCE), expected);
  assertEqual(d.buildReply(NONCE, KEY).toString('latin1'), `ESPCAM1!${NONCE}:${expected}`);
});

test('the fixed vector the firmware tests also use', () => {
  assertEqual(d.macFor(KEY, NONCE), VECTOR_MAC);
});

test('a different key, nonce or tag gives a different MAC', () => {
  const base = d.macFor(KEY, NONCE);
  assertTrue(d.macFor('other-key', NONCE) !== base, 'key');
  assertTrue(d.macFor(KEY, 'fedcba9876543210') !== base, 'nonce');
});

test('no answer without a usable key or with a malformed nonce', () => {
  assertEqual(d.buildReply(NONCE, ''), null, 'an unset camKey must not be a key anyone can use');
  assertEqual(d.buildReply(NONCE, undefined), null);
  assertEqual(d.buildReply(NONCE, 123), null);
  assertEqual(d.buildReply('short', KEY), null);
  assertEqual(d.buildReply(NONCE.toUpperCase(), KEY), null);
});

test('verifyReply: accepts the real answer, refuses a wrong key, a replayed nonce and any alteration', () => {
  const good = d.buildReply(NONCE, KEY);
  assertTrue(d.verifyReply(good, NONCE, KEY), 'the real answer');
  assertTrue(!d.verifyReply(good, NONCE, 'other-key'), 'someone who does not know the key cannot be checked by it');
  assertTrue(!d.verifyReply(d.buildReply(NONCE, 'other-key'), NONCE, KEY), 'an answer made with another key');
  assertTrue(!d.verifyReply(good, 'fedcba9876543210', KEY), 'an answer to a different probe (replay)');
  assertTrue(!d.verifyReply(Buffer.concat([good, Buffer.from('0')]), NONCE, KEY), 'longer');
  assertTrue(!d.verifyReply(good.subarray(0, good.length - 1), NONCE, KEY), 'shorter');
  const flipped = Buffer.from(good);
  flipped[flipped.length - 1] ^= 1;
  assertTrue(!d.verifyReply(flipped, NONCE, KEY), 'one changed bit');
  assertTrue(!d.verifyReply(good, NONCE, ''), 'empty key');
  assertTrue(!d.verifyReply('not a buffer', NONCE, KEY), 'not a buffer');
});

test('the answer is small: at most about 4 times the probe (no amplification to speak of)', () => {
  const probe = Buffer.from('ESPCAM1?' + NONCE);
  const reply = d.buildReply(NONCE, KEY);
  assertTrue(reply.length <= probe.length * 4, `${reply.length} bytes for a ${probe.length}-byte probe`);
});

test('resolveDiscoveryPort: default 8082, a number, 0 = off, junk falls back with a warning', () => {
  assertEqual(d.resolveDiscoveryPort(undefined), { port: 8082, warnings: [] });
  assertEqual(d.resolveDiscoveryPort(null), { port: 8082, warnings: [] });
  assertEqual(d.resolveDiscoveryPort(''), { port: 8082, warnings: [] });
  assertEqual(d.resolveDiscoveryPort(9000), { port: 9000, warnings: [] });
  assertEqual(d.resolveDiscoveryPort('9001'), { port: 9001, warnings: [] }, 'an environment variable is text');
  assertEqual(d.resolveDiscoveryPort(0), { port: 0, warnings: [] });
  assertEqual(d.resolveDiscoveryPort('0'), { port: 0, warnings: [] });
  for (const bad of [-1, 65536, 80.5, 'abc', '80x', '-5', '1e3', NaN, true, false, {}, []]) {
    const r = d.resolveDiscoveryPort(bad);
    assertEqual(r.port, 8082, String(bad));
    assertEqual(r.warnings.length, 1, String(bad));
  }
});

summarize();
