'use strict';

// sound_fixtures.js — small, valid-looking sound files for the tests (shared by the unit and the end-to-end tests).
// Real enough for the relay's checks (the right first bytes, a sensible size) and, for the WAV, a real one that a
// player can decode: a short tone made here, so no sound file has to be kept in the repository.

// A real mono 16-bit PCM WAV: `ms` milliseconds of a sine wave. 8 kHz keeps it tiny.
function wav({ ms = 200, hz = 880, rate = 8000 } = {}) {
  const samples = Math.round((rate * ms) / 1000);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);        // fmt chunk size
  head.writeUInt16LE(1, 20);         // PCM
  head.writeUInt16LE(1, 22);         // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);  // byte rate
  head.writeUInt16LE(2, 32);         // block align
  head.writeUInt16LE(16, 34);        // bits per sample
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Not decodable, but starts like the format says — enough for the checks that only look at the first bytes.
const padded = (start, bytes) => Buffer.concat([Buffer.from(start), Buffer.alloc(Math.max(0, bytes - start.length))]);
const mp3 = (bytes = 256) => padded([0x49, 0x44, 0x33, 0x03, 0x00], bytes);        // "ID3" tag header
const mp3Frame = (bytes = 256) => padded([0xff, 0xfb, 0x90, 0x00], bytes);          // an MPEG frame sync
const ogg = (bytes = 256) => padded(Buffer.from('OggS\0\u0002', 'latin1'), bytes);
const html = () => Buffer.from('<html><script>alert(1)</script></html>'.padEnd(100, ' '));

module.exports = { wav, mp3, mp3Frame, ogg, html };
