'use strict';

// test_sound_library.js — the pure helpers of the settings page's sound library (php/cameras/js/sound-library.js): file
// names made safe, the checks before an upload, sizes in words. The page part: tests/dom/test_sound_library_dom.js.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const L = require('../../php/cameras/js/sound-library');
const sounds = require('../../nodejs/camera-relay/lib/sounds');

test('formatBytes: bytes, KB and MB; nothing for what is not a size', () => {
  assertEqual([L.formatBytes(0), L.formatBytes(1023), L.formatBytes(1024), L.formatBytes(1536), L.formatBytes(1048576), L.formatBytes(2621440)],
    ['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB', '2.5 MB']);
  for (const bad of [-1, NaN, Infinity, undefined, null, 'x']) assertEqual(L.formatBytes(bad), '', String(bad));
});

test('safeName: names the library accepts come out as they are (the extension in lower case)', () => {
  assertEqual(L.safeName('siren.wav'), 'siren.wav');
  assertEqual(L.safeName('Alarm-1_final.MP3'), 'Alarm-1_final.mp3');
  assertEqual(L.safeName('a.OGG'), 'a.ogg');
});

test('safeName: anything else in the name becomes _, and the folder part of a path is dropped', () => {
  assertEqual(L.safeName('My Siren (1).wav'), 'My_Siren_1_.wav');
  assertEqual(L.safeName('C:\\Users\\me\\Music\\ding dong.mp3'), 'ding_dong.mp3');
  assertEqual(L.safeName('/home/me/a b.ogg'), 'a_b.ogg');
  assertEqual(L.safeName('héllo wörld.wav'), 'h_llo_w_rld.wav');
});

test('safeName: never starts with a dot or a dash, never has "..", never is too long', () => {
  assertEqual(L.safeName('.hidden.wav'), 'hidden.wav');
  assertEqual(L.safeName('--x.wav'), 'x.wav');
  assertEqual(L.safeName('a..b...c.wav'), 'a.b.c.wav');
  const long = L.safeName('x'.repeat(200) + '.mp3');
  assertEqual(long.length, 64);
  assertTrue(long.endsWith('.mp3'));
});

test('safeName: not a sound format, or nothing left of the name: null', () => {
  for (const bad of ['siren.txt', 'siren', '.wav', '...wav', '___.wav', '', null, undefined, 'a.wav.exe', 'a.flac']) assertEqual(L.safeName(bad), null, String(bad));
});

test('safeName: whatever comes out is a name the relay accepts', () => {
  for (const input of ['My Siren (1).wav', '../../etc/passwd.wav', '.a.ogg', 'x'.repeat(100) + '.mp3', 'a  b.WAV', 'ü.ogg', 'a\u0000b.wav', 'a\nb.mp3']) {
    const out = L.safeName(input);
    assertTrue(out === null || sounds.isSoundName(out), `${JSON.stringify(input)} -> ${out}`);
  }
});

const state = (extra = {}) => ({ maxBytes: 1048576, maxSounds: 3, sounds: [{ name: 'a.wav' }], ...extra });

test('checkUpload: a good file is named and says whether it replaces a sound', () => {
  assertEqual(L.checkUpload({ name: 'New Sound.mp3', size: 5000 }, state()), { name: 'New_Sound.mp3', replaces: false });
  assertEqual(L.checkUpload({ name: 'a.wav', size: 5000 }, state()), { name: 'a.wav', replaces: true });
});

test('checkUpload: no file, the wrong kind, too small, too large — each with its own words', () => {
  assertTrue(/Choose a sound file/.test(L.checkUpload(undefined, state()).error));
  assertTrue(/must be a .wav, .mp3, .ogg file/.test(L.checkUpload({ name: 'a.txt', size: 5000 }, state()).error));
  assertTrue(/too small/.test(L.checkUpload({ name: 'a.wav', size: 10 }, state()).error));
  assertTrue(/too large \(2\.0 MB\).*at most 1\.0 MB/.test(L.checkUpload({ name: 'a.wav', size: 2 * 1048576 }, state()).error));
  assertEqual(L.checkUpload({ name: 'a.wav', size: 1048576 }, state()).name, 'a.wav');
});

test('checkUpload: a full library takes a replacement but not a new name', () => {
  const full = state({ sounds: [{ name: 'a.wav' }, { name: 'b.wav' }, { name: 'c.wav' }] });
  assertTrue(/already 3 sounds/.test(L.checkUpload({ name: 'd.wav', size: 5000 }, full).error));
  assertEqual(L.checkUpload({ name: 'b.wav', size: 5000 }, full), { name: 'b.wav', replaces: true });
});

test('the limits agree with the relay', () => {
  assertEqual(L.EXTENSIONS, Object.keys(sounds.FORMATS));
});

summarize();
