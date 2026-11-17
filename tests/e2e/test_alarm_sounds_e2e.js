#!/usr/bin/env node
'use strict';
// test_alarm_sounds_e2e.js — end-to-end check of the alarm sounds against a REAL relay (server.js, a throwaway copy
// with its own config.js and sounds folder), real HTTP, real files and a real GET /mux viewer. A fake audio player
// (tests/e2e/fake_sound_player.js) stands in for the speaker: it writes down what it was asked to play.
//
//   - the sound library: needs the keys; upload takes a real WAV, MP3 and OGG and refuses a renamed web page, a wrong
//     name, a too large file and a 21st sound; list, download (with the right type), replace, delete
//   - the settings: a sound can only be chosen if it is in the folder; deleting a chosen one is refused (409)
//     until the alarm no longer uses it; the six settings apply at once
//   - "play it here": runs the player on the file; a player that fails is answered 502 with the reason; one that is
//     busy 409
//   - a recording STARTS: the chosen sound goes to the relay's player and to a /mux?alarms=1 viewer, each only if
//     its switch is ON; nothing when no sound is chosen; one sound for several cameras at once
//   - a person is FOUND in a fresh recording (real ffmpeg encode, a fake detector): the person sound plays
//   - a viewer that connects later does not get the old events replayed as new ones (it sees the numbers)
//
// Needs ffmpeg and python3 (skips with a message if not). Own ports, throwaway folders.
// Usage:  node tests/e2e/test_alarm_sounds_e2e.js        Exit code: 0 if every check passed.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const muxViewer = require('./mux_viewer');
const fx = require('../node/sound_fixtures');
const sounds = require('../../nodejs/camera-relay/lib/sounds');

const RELAY_SRC = path.join(__dirname, '../../nodejs/camera-relay');
const PORT = Number(process.env.E2E_SOUNDS_PORT || 19900);
const CAM_KEY = 'e2e-sounds-camera-key';
const CONTROL = 'e2e-sounds-control-key';
const CAM_A = 'cam-a';
const CAM_B = 'cam-b';

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); } else { fail += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(25); }
}

for (const [tool, args] of [['ffmpeg', ['-version']], ['python3', ['--version']]]) {
  if (spawnSync(tool, args).error) { console.log(`${tool} not found on PATH — skipping the alarm sounds end-to-end test`); finished = true; process.exit(0); }
}
if (!fs.existsSync(path.join(RELAY_SRC, 'node_modules', 'express'))) { console.error('[FAIL] relay dependencies are not installed (npm install in nodejs/camera-relay)'); finished = true; process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sounds-'));
const PLAYER_LOG = path.join(tmp, 'played.log');
const relayDir = path.join(tmp, 'relay');
fs.mkdirSync(relayDir);
spawnSync('cp', ['-r', path.join(RELAY_SRC, 'lib'), path.join(RELAY_SRC, 'server.js'), path.join(RELAY_SRC, 'package.json'), path.join(RELAY_SRC, 'testimage.jpg'), relayDir]);
fs.symlinkSync(path.join(RELAY_SRC, 'node_modules'), path.join(relayDir, 'node_modules'));
fs.mkdirSync(path.join(relayDir, 'models'));
fs.writeFileSync(path.join(relayDir, 'models', 'person.onnx'), 'not a model: the fake detector never reads it');   // the relay only checks that the file is there
fs.writeFileSync(path.join(relayDir, 'config.js'), `module.exports = {
  port: ${PORT}, pushPort: ${PORT + 1}, camKey: '${CAM_KEY}', controlKey: '${CONTROL}', preRollSeconds: 1,
  alarmSounds: { player: [${JSON.stringify(process.execPath)}, ${JSON.stringify(path.join(__dirname, 'fake_sound_player.js'))}], timeoutSeconds: 10 },
  personScan: { enabled: true, python: 'python3', script: ${JSON.stringify(path.join(__dirname, 'fake_person_always.py'))} },
};\n`);

let relay = null;
let relayOutput = '';
function startRelay(playerMode = '') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FAKE_PLAYER_LOG: PLAYER_LOG, FAKE_PLAYER_MODE: playerMode };
    for (const k of ['PORT', 'PUSH_PORT', 'CAM_KEY', 'CONTROL_KEY', 'SOUNDS_DIR', 'SETTINGS_FILE', 'LOG_FILE', 'SWITCH_FILE', 'RELAY_SUPERVISED']) delete env[k];
    const child = spawn('node', ['server.js'], { cwd: relayDir, env });
    relay = child;
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error(`relay not ready:\n${relayOutput}`)); } }, 8000);
    const on = (c) => {
      relayOutput += c;
      if (done || !relayOutput.includes(`raw push) listening on :${PORT + 1}`)) return;
      done = true; clearTimeout(t);
      waitFor(() => http('GET', '/sounds', { headers: { 'X-Control-Key': CONTROL } }).then((r) => r.status === 200, () => false), 5000).then(resolve);   // the web port too
    };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}):\n${relayOutput}`)); } });
  });
}
const stopRelay = () => new Promise((resolve) => {
  if (!relay || relay.exitCode !== null || relay.signalCode !== null) return resolve();   // none, or already gone
  relay.once('exit', resolve);
  relay.kill('SIGTERM');
});

function http(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const h = { ...headers };
    if (data) h['Content-Length'] = data.length;
    const req = nodeHttp.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const KEY = { 'X-Control-Key': CONTROL };
const JSONH = { 'X-Control-Key': CONTROL, 'Content-Type': 'application/json' };
const upload = (name, bytes, headers = KEY) => http('PUT', `/sounds/${name}`, { headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
const save = (values) => http('POST', '/system-settings', { headers: JSONH, body: values });
const played = () => (fs.existsSync(PLAYER_LOG) ? fs.readFileSync(PLAYER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const clearPlayed = () => fs.writeFileSync(PLAYER_LOG, '');
const soundsDir = path.join(relayDir, 'sounds');

// A real JPEG for the camera pushes, so that ffmpeg can encode the recording.
const JPEG = path.join(tmp, 'frame.jpg');
spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', JPEG]);
const frame = fs.readFileSync(JPEG);
const pushFrame = (cam) => http('POST', `/upload/${cam}?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: frame });
const record = (cam, seconds) => http('POST', `/record/${cam}?seconds=${seconds}`, { headers: KEY });

async function main() {
  await startRelay();
  clearPlayed();

  // ── the library ──
  let r = await http('GET', '/sounds');
  check('the list of sounds needs the key', r.status === 401);
  r = await http('GET', '/sounds', { headers: KEY });
  check('a new relay has an empty library (and no folder was made by looking)', r.status === 200 && r.json.sounds.length === 0 && r.json.maxBytes === sounds.MAX_SOUND_BYTES && r.json.maxSounds === sounds.MAX_SOUNDS && !fs.existsSync(soundsDir));

  const wav = fx.wav({ ms: 300 });
  check('uploading needs the key', (await upload('siren.wav', wav, {})).status === 401);
  r = await upload('siren.wav', wav);
  check('a real WAV is accepted and stored in the sounds folder', r.status === 200 && r.json.ok && r.json.replaced === false && r.json.bytes === wav.length && fs.readFileSync(path.join(soundsDir, 'siren.wav')).equals(wav), JSON.stringify(r.json));
  check('an MP3 and an OGG are accepted too', (await upload('beep.mp3', fx.mp3())).status === 200 && (await upload('chime.ogg', fx.ogg())).status === 200);
  r = await upload('siren.wav', fx.wav({ ms: 100 }));
  check('uploading the same name again replaces the sound', r.status === 200 && r.json.replaced === true);
  await upload('siren.wav', wav);

  r = await upload('page.wav', fx.html());
  check('a web page renamed .wav is refused (400) and nothing is stored', r.status === 400 && /not a WAV/.test(r.json.error) && !fs.existsSync(path.join(soundsDir, 'page.wav')), JSON.stringify(r.json));
  check('a wrong extension is refused (400)', (await upload('notes.txt', wav)).status === 400);
  check('a name with a dot-dot or a leading dot is refused (400)', (await upload('..%2Fevil.wav', wav)).status === 400 && (await upload('.hidden.wav', wav)).status === 400);
  check('nothing was written outside the folder', !fs.existsSync(path.join(relayDir, 'evil.wav')) && !fs.existsSync(path.join(tmp, 'evil.wav')));
  r = await upload('big.ogg', fx.ogg(sounds.MAX_SOUND_BYTES + 1));
  check('a file over the size limit is refused (413) and nothing is stored', r.status === 413 && !fs.existsSync(path.join(soundsDir, 'big.ogg')), `${r.status} ${r.raw.toString().slice(0, 80)}`);
  check('an empty upload is refused (400)', (await upload('empty.wav', Buffer.alloc(0))).status === 400);

  r = await http('GET', '/sounds', { headers: KEY });
  check('the list shows the three sounds, sorted, with their sizes', r.json.sounds.map((s) => s.name).join() === 'beep.mp3,chime.ogg,siren.wav' && r.json.sounds[2].bytes === wav.length, JSON.stringify(r.json));
  r = await http('GET', '/sounds/siren.wav', { headers: KEY });
  check('a sound is served as it was uploaded, with its audio type and no sniffing', r.status === 200 && r.raw.equals(wav) && r.headers['content-type'] === 'audio/wav' && r.headers['x-content-type-options'] === 'nosniff', JSON.stringify(r.headers));
  check('MP3 and OGG have their own types', (await http('GET', '/sounds/beep.mp3', { headers: KEY })).headers['content-type'] === 'audio/mpeg' && (await http('GET', '/sounds/chime.ogg', { headers: KEY })).headers['content-type'] === 'audio/ogg');
  check('a sound is served only with the key', (await http('GET', '/sounds/siren.wav')).status === 401);
  check('a missing sound is 404; a bad name is 400', (await http('GET', '/sounds/none.wav', { headers: KEY })).status === 404 && (await http('GET', '/sounds/passwd', { headers: KEY })).status === 400 && (await http('GET', '/sounds/..%2Fconfig.js', { headers: KEY })).status === 400);

  // fill the library to its limit
  for (let i = 0; i < sounds.MAX_SOUNDS - 3; i += 1) await upload(`fill${i}.ogg`, fx.ogg());
  r = await upload('onetoomany.ogg', fx.ogg());
  check(`a ${sounds.MAX_SOUNDS + 1}st sound is refused (409) — but a sound can still be replaced`, r.status === 409 && (await upload('fill0.ogg', fx.ogg(100))).status === 200, JSON.stringify(r.json));
  for (let i = 0; i < sounds.MAX_SOUNDS - 3; i += 1) await http('DELETE', `/sounds/fill${i}.ogg`, { headers: KEY });

  // ── the settings ──
  r = await save({ alarmSoundRecordStart: 'nothere.wav' });
  check('a sound that is not in the folder cannot be chosen (400)', r.status === 400 && /upload it first/.test(r.json.error), JSON.stringify(r.json));
  r = await save({ alarmSoundRecordStart: '../siren.wav' });
  check('a name with a path in it cannot be chosen (400)', r.status === 400);
  r = await http('GET', '/system-settings', { headers: KEY });
  const startField = r.json.fields.find((f) => f.key === 'alarmSoundRecordStart');
  check('the settings page is told which sounds there are', startField.type === 'sound' && startField.options.join() === 'beep.mp3,chime.ogg,siren.wav' && startField.value === '', JSON.stringify(startField));
  r = await save({ alarmSoundRecordStart: 'siren.wav' });
  check('choosing an existing sound is saved at once, no restart', r.status === 200 && r.json.restartRequired === false && r.json.changed.length === 1, JSON.stringify(r.json));
  r = await http('DELETE', '/sounds/siren.wav', { headers: KEY });
  check('a sound an alarm uses cannot be deleted (409), and it says which alarm', r.status === 409 && /when a recording starts/.test(r.json.error) && fs.existsSync(path.join(soundsDir, 'siren.wav')), JSON.stringify(r.json));
  check('deleting needs the key', (await http('DELETE', '/sounds/beep.mp3')).status === 401);
  r = await http('DELETE', '/sounds/beep.mp3', { headers: KEY });
  check('a sound nothing uses is deleted', r.status === 200 && !fs.existsSync(path.join(soundsDir, 'beep.mp3')));
  check('deleting it again is 404', (await http('DELETE', '/sounds/beep.mp3', { headers: KEY })).status === 404);

  // ── play it here (the "test" button) ──
  check('"play it here" needs the key', (await http('POST', '/sounds/siren.wav/play')).status === 401);
  check('"play it here" for a missing sound is 404, for a bad name 400', (await http('POST', '/sounds/none.wav/play', { headers: KEY })).status === 404 && (await http('POST', '/sounds/x/play', { headers: KEY })).status === 400);
  clearPlayed();
  r = await http('POST', '/sounds/siren.wav/play', { headers: KEY });
  check('"play it here" runs the player on that file', r.status === 200 && !!(await waitFor(() => played().length === 1)) && played()[0] === path.join(soundsDir, 'siren.wav'), `${r.status} ${JSON.stringify(played())}`);

  // ── a recording starts ──
  await sleep(300);
  clearPlayed();
  await pushFrame(CAM_A); await pushFrame(CAM_B);
  const viewer = await muxViewer.view(PORT, '?alarms=1', KEY);
  check('a /mux viewer that asks for alarms=1 is welcome and gets the (empty) alarm list first', viewer.status === 200 && !!(await waitFor(() => muxViewer.alarmStates(viewer).length >= 1)) && muxViewer.readings(muxViewer.alarmStates(viewer)[0]).events.length === 0);
  check('a /mux request that asks for nothing is still refused (400)', (await muxViewer.view(PORT, '', KEY)).status === 400);

  r = await record(CAM_A, 2);
  check('a recording is started', r.status === 200 && r.json.recording === true, JSON.stringify(r.json));
  const alarmList = () => { const s = muxViewer.alarmStates(viewer); return s.length ? muxViewer.readings(s[s.length - 1]) : { events: [] }; };
  const starts = () => alarmList().events.filter((e) => e.kind === 'recordStart');
  check('the browsers are told: a recordStart event with the camera and the sound', !!(await waitFor(() => starts().length === 1)) && JSON.stringify(Object.assign({}, starts()[0], { at: 0 })) === JSON.stringify({ seq: 1, at: 0, kind: 'recordStart', camId: CAM_A, sound: 'siren.wav' }), JSON.stringify(alarmList()));
  check('the relay machine plays the chosen sound', !!(await waitFor(() => played().length === 1)) && played()[0] === path.join(soundsDir, 'siren.wav'), JSON.stringify(played()));
  r = await record(CAM_A, 2);
  check('extending a recording is not a new start: no second alarm', r.json.extended === true && (await sleep(400), starts().length === 1 && played().length === 1));
  await http('POST', `/record/${CAM_A}/stop`, { headers: KEY });

  // several cameras at once: one sound on the speaker, one event per camera for the browsers (which play one)
  await sleep(300);
  clearPlayed();
  await http('POST', '/record/all?seconds=2', { headers: KEY });
  check('two cameras starting together: the speaker plays ONE sound', !!(await waitFor(() => played().length >= 1)) && (await sleep(500), played().length === 1), JSON.stringify(played()));
  check('…and the browsers get an event for each camera', !!(await waitFor(() => starts().length === 3)), JSON.stringify(alarmList()));
  await http('POST', `/record/${CAM_A}/stop`, { headers: KEY });
  await http('POST', `/record/${CAM_B}/stop`, { headers: KEY });

  // the places can be switched off one by one
  await sleep(300);
  await save({ alarmSoundRecordStartRelay: 'false' });
  clearPlayed();
  const before = starts().length;
  await record(CAM_B, 1);
  check('with "relay machine" OFF only the browsers are told', !!(await waitFor(() => starts().length === before + 1)) && (await sleep(400), played().length === 0));
  await http('POST', `/record/${CAM_B}/stop`, { headers: KEY });
  await sleep(300);
  await save({ alarmSoundRecordStartRelay: 'true', alarmSoundRecordStartBrowser: 'false' });
  const before2 = starts().length;
  await record(CAM_B, 1);
  check('with "browser" OFF only the relay machine plays', !!(await waitFor(() => played().length === 1)) && (await sleep(400), starts().length === before2));
  await http('POST', `/record/${CAM_B}/stop`, { headers: KEY });
  await sleep(300);
  await save({ alarmSoundRecordStart: '', alarmSoundRecordStartBrowser: 'true' });
  clearPlayed();
  const before3 = starts().length;
  await record(CAM_B, 1);
  check('with no sound chosen the recording starts in silence', (await sleep(600), played().length === 0 && starts().length === before3));
  await http('POST', `/record/${CAM_B}/stop`, { headers: KEY });

  // ── a person is found in a fresh recording ──
  r = await save({ alarmSoundRecordStart: '', alarmSoundPersonDetected: 'chime.ogg' });
  await waitFor(async () => (await http('GET', `/recordings/${CAM_B}`, { headers: KEY })).status === 200, 3000);
  await sleep(500);
  clearPlayed();
  const beforePerson = alarmList().events.length;
  await record(CAM_A, 1);
  for (let i = 0; i < 4; i += 1) { await pushFrame(CAM_A); await sleep(250); }
  const person = await waitFor(() => alarmList().events.find((e) => e.kind === 'personDetected'), 15000);
  check('a person found in a fresh recording: the browsers get a personDetected event for that camera', !!person && person.camId === CAM_A && person.sound === 'chime.ogg', JSON.stringify(alarmList()) + relayOutput.slice(-600));
  check('…and the relay machine plays the person sound', !!(await waitFor(() => played().includes(path.join(soundsDir, 'chime.ogg')))), JSON.stringify(played()));
  check('…and no recordStart alarm came with it (none is chosen)', alarmList().events.slice(beforePerson).every((e) => e.kind === 'personDetected'));

  // ── a viewer that connects later ──
  const late = await muxViewer.view(PORT, '?alarms=1', KEY);
  await waitFor(() => muxViewer.alarmStates(late).length >= 1);
  const lateList = muxViewer.readings(muxViewer.alarmStates(late)[0]);
  const last = alarmList();
  check('a viewer that connects later gets the current list with its numbers (it decides what is new), and the relay\'s epoch', lateList.events.length === last.events.length && lateList.epoch === last.epoch && lateList.events.every((e, i) => e.seq === last.events[i].seq) && typeof lateList.now === 'number');
  late.close();

  // ── a speaker that does not work ──
  viewer.close();
  await stopRelay();
  await startRelay('fail');
  clearPlayed();
  r = await http('POST', '/sounds/siren.wav/play', { headers: KEY });
  check('a player that fails is answered 502 with the reason (the page can show why it is silent)', r.status === 502 && /exited with code 1: no soundcards found/.test(r.json.error), JSON.stringify(r.json));
  check('…and the relay log has one WARN line about it', /could not be played on this machine: .*no soundcards found/.test(relayOutput), relayOutput.slice(-300));
  await stopRelay();
  await startRelay('slow');
  clearPlayed();
  r = await http('POST', '/sounds/siren.wav/play', { headers: KEY });
  const second = await http('POST', '/sounds/siren.wav/play', { headers: KEY });
  check('one sound at a time on the relay machine: while it plays, another is refused (409)', r.status === 200 && second.status === 409 && /already playing/.test(second.json.error), `${r.status} ${second.status}`);
  check('the settings and the sounds survive a restart (saved choice is still there)', await (async () => {
    await stopRelay(); await startRelay();
    const s = await http('GET', '/system-settings', { headers: KEY });
    return s.json.fields.find((f) => f.key === 'alarmSoundPersonDetected').value === 'chime.ogg';
  })());
}

main()
  .catch((err) => { check('the test ran to the end', false, err && err.stack ? err.stack : String(err)); })
  .finally(async () => {
    await stopRelay();
    fs.rmSync(tmp, { recursive: true, force: true });
    finished = true;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
