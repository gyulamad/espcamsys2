'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');
const { createSoundStore, SoundNameError } = require('../../nodejs/camera-relay/lib/soundstore');
const sounds = require('../../nodejs/camera-relay/lib/sounds');
const fx = require('./sound_fixtures');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soundstore-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(tmp, `lib${n += 1}`);

test('a folder that does not exist yet is an empty library, and is not created by looking', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  assertEqual(store.list(), []);
  assertEqual(store.names(), []);
  assertEqual(store.read('a.wav'), null);
  assertEqual(store.has('a.wav'), false);
  assertEqual(store.remove('a.wav'), false);
  assertTrue(!fs.existsSync(dir), 'reading never creates the folder');
});

test('write creates the folder; list, read and has then find the sound', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  const wav = fx.wav();
  assertEqual(store.write('siren.wav', wav), { replaced: false });
  assertEqual(store.list(), [{ name: 'siren.wav', bytes: wav.length }]);
  assertTrue(store.read('siren.wav').equals(wav));
  assertTrue(store.has('siren.wav'));
});

test('writing a name again replaces the sound and says so; no temporary file is left behind', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  store.write('a.ogg', fx.ogg(100));
  assertEqual(store.write('a.ogg', fx.ogg(200)), { replaced: true });
  assertEqual(store.list(), [{ name: 'a.ogg', bytes: 200 }]);
  assertEqual(fs.readdirSync(dir), ['a.ogg']);
});

test('remove deletes one sound and answers whether there was one', () => {
  const store = createSoundStore(freshDir());
  store.write('a.wav', fx.wav());
  store.write('b.wav', fx.wav());
  assertEqual(store.remove('a.wav'), true);
  assertEqual(store.remove('a.wav'), false);
  assertEqual(store.names(), ['b.wav']);
});

test('list shows only sounds: other files, folders, dot-files and half-written uploads are not offered', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  store.write('real.wav', fx.wav());
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.hidden.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'half.wav.tmp'), 'x');
  fs.mkdirSync(path.join(dir, 'folder.wav'));
  assertEqual(store.names(), ['real.wav']);
});

test('pathOf refuses every name that is not a sound\'s, and never leaves the folder', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  for (const bad of ['../x.wav', '/etc/passwd', 'a/b.wav', '', '.wav', 'a..wav', 'x.txt', undefined, null, 5]) {
    assertThrows(() => store.pathOf(bad), JSON.stringify(bad));
    assertThrows(() => store.read(bad), `read ${JSON.stringify(bad)}`);
    assertThrows(() => store.write(bad, fx.wav()), `write ${JSON.stringify(bad)}`);
    assertThrows(() => store.remove(bad), `remove ${JSON.stringify(bad)}`);
  }
  try { store.pathOf('../x.wav'); } catch (err) { assertTrue(err instanceof SoundNameError); }
  assertEqual(store.pathOf('a.wav'), path.join(path.resolve(dir), 'a.wav'));
});

test('a symlink in the folder is not a sound: not listed, not read, not served, and writing replaces the link itself', () => {
  const dir = freshDir();
  const store = createSoundStore(dir);
  const secret = path.join(tmp, 'secret.wav');
  fs.writeFileSync(secret, fx.wav());
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(secret, path.join(dir, 'link.wav'));
  assertEqual(store.names(), []);
  assertEqual(store.read('link.wav'), null);
  assertEqual(store.has('link.wav'), false);
  assertEqual(store.remove('link.wav'), false);
  const before = fs.readFileSync(secret);
  store.write('link.wav', fx.wav({ ms: 50 }));
  assertTrue(fs.readFileSync(secret).equals(before), 'the file the link pointed at was not written through');
  assertTrue(!fs.lstatSync(path.join(dir, 'link.wav')).isSymbolicLink(), 'the link was replaced by a real file');
});

test('a relative folder is resolved once, so the store keeps working after a chdir', () => {
  const dir = freshDir();
  const rel = path.relative(process.cwd(), dir);
  const store = createSoundStore(rel);
  store.write('a.wav', fx.wav());
  const here = process.cwd();
  process.chdir(os.tmpdir());
  try { assertEqual(store.names(), ['a.wav']); } finally { process.chdir(here); }
});

test('the library names are exactly what lib/sounds.js allows', () => {
  const store = createSoundStore(freshDir());
  store.write('ok.mp3', fx.mp3());
  assertTrue(store.names().every((name) => sounds.isSoundName(name)));
});

summarize();
