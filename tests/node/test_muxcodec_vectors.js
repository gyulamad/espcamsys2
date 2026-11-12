'use strict';

// test_muxcodec_vectors.js — the wire format of GET /mux against the SAME golden bytes the PHP side is checked
// against (tests/fixtures/mux_codec_vectors.json, tests/php/test_mux_codec_vectors.php), plus a seeded fuzz.
//   - the relay's encoder (nodejs/camera-relay/lib/muxcodec.js) writes exactly those bytes;
//   - the browser's parser (php/cameras/js/mux-codec.js) reads them back, however they are cut into chunks;
//   - bytes that are not this format are refused with a ProtocolError and with nothing else: a bug must never
//     look like a bad peer, and a bad peer must never crash the page.
// The fuzz is deterministic (a fixed seed per case, printed on failure) so a red run can be replayed.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const enc = require('../../nodejs/camera-relay/lib/muxcodec');
const dec = require('../../php/cameras/js/mux-codec');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/mux_codec_vectors.json'), 'utf8'));
const FUZZ_ROUNDS = 300;

// Small seeded generator (mulberry32): the same numbers on every run and every machine.
function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive) => Math.floor(next() * maxExclusive);
  const bytes = (n) => Buffer.from(Array.from({ length: n }, () => int(256)));
  return { int, bytes };
}

// What a page would do: push every chunk, collect every message. Throws what the parser throws.
function parse(bytes, chunkSizes) {
  const parser = dec.createParser();
  const out = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i += 1) {
    const size = chunkSizes[i % chunkSizes.length];
    out.push(...parser.push(new Uint8Array(bytes.subarray(at, at + size))));
    at += size;
  }
  return out;
}

// The bytes of one message written here, by hand, so that types the relay never writes (an unknown one) can be made too.
function rawMessage(type, source, payload) {
  const name = Buffer.from(source, 'utf8');
  const head = Buffer.alloc(7);
  head.writeUInt32BE(3 + name.length + payload.length, 0);
  head.writeUInt8(1, 4);
  head.writeUInt8(type, 5);
  head.writeUInt8(name.length, 6);
  return Buffer.concat([head, name, payload]);
}

// The same message through the relay's own encoder; null for a type the relay does not write.
function relayMessage({ type, source, payloadHex }) {
  const payload = Buffer.from(payloadHex, 'hex');
  if (type === enc.TYPE_HEARTBEAT) return enc.encodeHeartbeat();
  if (type === enc.TYPE_FRAME) return enc.encodeFrame(source, payload);
  if (type === enc.TYPE_STATE) return enc.encodeState(source, payload);
  return null;
}

const plain = (messages) => messages.map((m) => ({ type: m.type, source: m.source, payloadHex: Buffer.from(m.payload).toString('hex') }));
const randomChunks = (random, n) => Array.from({ length: n }, () => 1 + random.int(40));
const CHUNKINGS = [[1], [2], [3], [7], [64], [1 << 20], [1, 5, 2, 9]];

// Runs fn and reports what it threw, or null.
function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('the fixture has every kind of vector', () => {
  assertTrue(vectors.valid.length >= 10 && vectors.invalid.length >= 10 && vectors.incomplete.length >= 4);
  for (const v of [...vectors.valid, ...vectors.invalid, ...vectors.incomplete]) assertTrue(/^([0-9a-f]{2})*$/.test(v.hex), v.name + ': hex');
});

test('valid vectors: the relay\'s encoder writes exactly these bytes', () => {
  for (const v of vectors.valid) {
    const written = v.messages.map(relayMessage);
    if (written.includes(null)) continue;   // a type the relay never writes: only the parsers are checked
    assertEqual(Buffer.concat(written).toString('hex'), v.hex, v.name);
  }
});

test('valid vectors: the browser parser reads these messages, whatever the chunking', () => {
  for (const v of vectors.valid) {
    for (const sizes of CHUNKINGS) {
      assertEqual(plain(parse(Buffer.from(v.hex, 'hex'), sizes)), v.messages, `${v.name}, chunks ${sizes}`);
    }
  }
});

test('invalid vectors: the parser refuses them with a ProtocolError, whatever the chunking', () => {
  for (const v of vectors.invalid) {
    for (const sizes of CHUNKINGS) {
      const error = thrown(() => parse(Buffer.from(v.hex, 'hex'), sizes));
      assertTrue(error instanceof dec.ProtocolError, `${v.name}, chunks ${sizes}: got ${error}`);
    }
  }
});

test('incomplete vectors: nothing comes out and nothing is refused', () => {
  for (const v of vectors.incomplete) {
    for (const sizes of CHUNKINGS) {
      assertEqual(parse(Buffer.from(v.hex, 'hex'), sizes), [], `${v.name}, chunks ${sizes}`);
    }
  }
});

test('fuzz: random messages cut at random places come out whole, in order, byte for byte', () => {
  for (let seed = 1; seed <= FUZZ_ROUNDS; seed += 1) {
    const random = createRandom(seed);
    const expected = [];
    const stream = [];
    for (let n = random.int(6); n >= 0; n -= 1) {
      const type = [enc.TYPE_FRAME, enc.TYPE_STATE, enc.TYPE_HEARTBEAT, 4 + random.int(250)][random.int(4)];
      const source = type === enc.TYPE_HEARTBEAT ? '' : 'cam:' + random.bytes(random.int(20)).toString('hex');
      const payload = type === enc.TYPE_HEARTBEAT ? Buffer.alloc(0) : random.bytes(random.int(3000));
      stream.push(rawMessage(type, source, payload));
      expected.push({ type, source, payloadHex: payload.toString('hex') });
    }
    assertEqual(plain(parse(Buffer.concat(stream), randomChunks(random, 7))), expected, `seed ${seed}`);
  }
});

test('fuzz: random garbage is refused or waited for, and never throws anything but a ProtocolError', () => {
  let refused = 0;
  for (let seed = 1; seed <= FUZZ_ROUNDS * 4; seed += 1) {
    const random = createRandom(seed);
    // half of the cases start like a real message so the parser gets past the length check into the body
    const head = random.int(2) === 0 ? Buffer.from([0, 0, 0, 3 + random.int(60), random.int(4), random.int(4), random.int(100)]) : Buffer.alloc(0);
    const bytes = Buffer.concat([head, random.bytes(random.int(400))]);
    const error = thrown(() => parse(bytes, randomChunks(random, 5)));
    if (error === null) continue;
    refused += 1;
    assertTrue(error instanceof dec.ProtocolError, `seed ${seed}: ${error && error.stack}`);
  }
  assertTrue(refused > 100, 'the garbage must actually reach the refusals, or this test proves nothing: ' + refused);
});

summarize();
