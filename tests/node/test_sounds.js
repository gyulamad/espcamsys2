'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const sounds = require('../../nodejs/camera-relay/lib/sounds');
const fx = require('./sound_fixtures');

test('isSoundName: plain names with a known extension are sounds', () => {
  for (const ok of ['siren.wav', 'Alarm_1.mp3', 'a.ogg', 'x-y.z.wav', 'SIREN.WAV', '1.mp3', 'a'.repeat(60) + '.wav']) assertTrue(sounds.isSoundName(ok), ok);
});

test('isSoundName: nothing that could leave the folder, hide, or be another kind of file', () => {
  const bad = ['', '.wav', '.hidden.wav', '../x.wav', 'a/b.wav', 'a\\b.wav', '/etc/passwd', 'a..wav', 'a b.wav', 'a.wav ', 'a.wav\n',
    'siren', 'siren.txt', 'siren.wav.exe', 'siren.php', 'a.mp4', 'a'.repeat(61) + '.wav', '~x.wav', '-rf.wav', 'a\u0000.wav'];
  for (const name of bad) assertTrue(!sounds.isSoundName(name), JSON.stringify(name));
  for (const notText of [undefined, null, 5, {}, [], ['a.wav']]) assertTrue(!sounds.isSoundName(notText), String(notText));
});

test('isSoundName: names that mean something to JavaScript are only ever plain names', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assertTrue(!sounds.isSoundName(name), name);
  assertTrue(!sounds.isSoundName('constructor.wav.constructor'));
});

test('contentTypeOf: from the extension, case-insensitively; null for what is not a sound', () => {
  assertEqual(sounds.contentTypeOf('a.wav'), 'audio/wav');
  assertEqual(sounds.contentTypeOf('a.MP3'), 'audio/mpeg');
  assertEqual(sounds.contentTypeOf('a.ogg'), 'audio/ogg');
  assertEqual(sounds.contentTypeOf('a.html'), null);
  assertEqual(sounds.contentTypeOf('../a.wav'), null);
});

test('checkSound: a real WAV, an MP3 (tagged or bare) and an OGG are accepted', () => {
  assertEqual(sounds.checkSound('a.wav', fx.wav()), { ok: true });
  assertEqual(sounds.checkSound('a.mp3', fx.mp3()), { ok: true });
  assertEqual(sounds.checkSound('a.mp3', fx.mp3Frame()), { ok: true });
  assertEqual(sounds.checkSound('a.ogg', fx.ogg()), { ok: true });
});

test('checkSound: the first bytes must be the format the extension says', () => {
  for (const [name, buf] of [['a.wav', fx.mp3()], ['a.mp3', fx.wav()], ['a.ogg', fx.wav()], ['a.wav', fx.html()], ['a.mp3', fx.html()], ['a.ogg', fx.html()]]) {
    const r = sounds.checkSound(name, buf);
    assertTrue(!r.ok && /not a (WAV|MP3|OGG) file/.test(r.error), `${name}: ${JSON.stringify(r)}`);
  }
  // RIFF without WAVE (an AVI, say) is not a WAV
  const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(100)]);
  assertTrue(!sounds.checkSound('a.wav', avi).ok);
});

test('checkSound: size limits — too small, exactly the largest, one byte too large', () => {
  assertTrue(!sounds.checkSound('a.ogg', fx.ogg(sounds.MIN_SOUND_BYTES - 1)).ok);
  assertTrue(sounds.checkSound('a.ogg', fx.ogg(sounds.MIN_SOUND_BYTES)).ok);
  assertTrue(sounds.checkSound('a.ogg', fx.ogg(sounds.MAX_SOUND_BYTES)).ok);
  assertTrue(/too large/.test(sounds.checkSound('a.ogg', fx.ogg(sounds.MAX_SOUND_BYTES + 1)).error));
});

test('checkSound: a bad name or a body that is not bytes is refused, with a reason', () => {
  assertTrue(/name must be/.test(sounds.checkSound('../a.wav', fx.wav()).error));
  for (const body of [undefined, null, 'RIFFxxxxWAVE', {}, 5]) assertTrue(/raw sound file/.test(sounds.checkSound('a.wav', body).error), String(body));
});

test('the largest sound fits through the web server: below Apache\'s 2 MiB request limit with room to spare', () => {
  assertTrue(sounds.MAX_SOUND_BYTES <= 1024 * 1024 && sounds.MAX_SOUND_BYTES < 2097152);
});

test('describeSounds: only real sound names, sorted, nothing else', () => {
  const entries = [
    { name: 'b.wav', bytes: 10 }, { name: 'a.mp3', bytes: 5 }, { name: '.hidden.wav', bytes: 1 }, { name: 'x.wav.tmp', bytes: 1 },
    { name: 'notes.txt', bytes: 1 }, { name: 'c.ogg', bytes: -1 }, { name: 'd.ogg', bytes: 1.5 }, null, { bytes: 3 },
  ];
  assertEqual(sounds.describeSounds(entries), [{ name: 'a.mp3', bytes: 5 }, { name: 'b.wav', bytes: 10 }]);
  assertEqual(sounds.describeSounds([]), []);
});

summarize();
