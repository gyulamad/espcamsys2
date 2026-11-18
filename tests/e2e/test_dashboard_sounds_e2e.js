#!/usr/bin/env node
'use strict';
// test_dashboard_sounds_e2e.js — the alarm sounds through the REAL dashboard (php -S, a generated config.php) in front
// of a REAL relay (a throwaway copy with a fake audio player and its own sounds folder), then the real SETTINGS page
// in jsdom using them. The relay's own rules are tested in test_alarm_sounds_e2e.js; this is about the dashboard's:
//   - the login is needed everywhere; changing needs the dashboard's own header (a cross-site form cannot); the
//     methods are the right ones; a name that is not a sound's, an unknown action, a file over the limit and a
//     missing control key are refused by PHP itself, before the relay is asked anything
//   - upload / list / download / play / delete go through to the relay and its answers are rebuilt: a sound is served
//     with a type decided by its name and nosniff; the relay's reasons (a renamed web page, a sound an alarm uses)
//     reach the page; the relay being down is 502
//   - the settings: the sound choices arrive with the sound files as their options, saving one reaches the relay, a
//     file that is not there cannot be chosen
//   - an alarm event goes relay -> mux.php (rebuilt from checked fields) -> an HTTP client
//   - the real settings page: a sound upload shows in the list and in every choice, a choice can be saved, a used
//     sound cannot be deleted, a free one can
// Needs php, ffmpeg and (for the last part) the jsdom package; skips what is missing.
// Usage:  node tests/e2e/test_dashboard_sounds_e2e.js        Override the port with E2E_SOUNDSDASH_PORT (and the two above it).

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const muxViewer = require('./mux_viewer');
const fx = require('../node/sound_fixtures');
const sounds = require('../../nodejs/camera-relay/lib/sounds');
const { closeWindow, pageScriptLoader } = require('../dom/dom_helpers');

let jsdomModule = null;
// jsdom is installed with the DOM tests (cd tests/dom && npm install), not next to this file
try { jsdomModule = require(require.resolve('jsdom', { paths: [path.join(__dirname, '../dom')] })); } catch (e) { jsdomModule = null; }

const RELAY_SRC = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_SOUNDSDASH_PORT || 19920);
const RELAY_PORT = PHP_PORT + 1;
const PUSH_PORT = PHP_PORT + 2;
const CAM_KEY = 'e2e-sounds-dash-camera-key';
const CONTROL = 'e2e-sounds-dash-control-key';
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASIC = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
const BASE = `http://127.0.0.1:${PHP_PORT}`;

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

for (const [tool, args] of [['php', ['-v']], ['ffmpeg', ['-version']]]) {
  if (spawnSync(tool, args).error) { console.log(`${tool} not found on PATH — skipping the dashboard alarm sounds test`); finished = true; process.exit(0); }
}
if (!fs.existsSync(path.join(RELAY_SRC, 'node_modules', 'express'))) { console.error('[FAIL] relay dependencies are not installed'); finished = true; process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sounds-dash-'));
const PLAYER_LOG = path.join(tmp, 'played.log');
const relayDir = path.join(tmp, 'relay');
const dashDir = path.join(tmp, 'dash');
const soundsDir = path.join(relayDir, 'sounds');
fs.mkdirSync(relayDir);
spawnSync('cp', ['-r', path.join(RELAY_SRC, 'lib'), path.join(RELAY_SRC, 'server.js'), path.join(RELAY_SRC, 'package.json'), relayDir]);
fs.symlinkSync(path.join(RELAY_SRC, 'node_modules'), path.join(relayDir, 'node_modules'));
fs.writeFileSync(path.join(relayDir, 'config.js'), `module.exports = {
  port: ${RELAY_PORT}, pushPort: ${PUSH_PORT}, camKey: '${CAM_KEY}', controlKey: '${CONTROL}', preRollSeconds: 1,
  alarmSounds: { player: [${JSON.stringify(process.execPath)}, ${JSON.stringify(path.join(__dirname, 'fake_sound_player.js'))}], timeoutSeconds: 10 },
};\n`);
fs.mkdirSync(dashDir);
spawnSync('cp', ['-r', DASH_SRC + '/.', dashDir]);
const writeConfig = ({ key = CONTROL, port = RELAY_PORT } = {}) => fs.writeFileSync(path.join(dashDir, 'config.php'),
  `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${port}', ${key ? `'relay_control_key' => '${key}', ` : ''}'cameras' => [['id' => 'cam-a', 'name' => 'Door', 'icon' => '🚪']]];\n`);
writeConfig();

let relay = null; let relayOutput = ''; let php = null;
function startRelay(playerMode = '') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FAKE_PLAYER_LOG: PLAYER_LOG, FAKE_PLAYER_MODE: playerMode };
    for (const k of ['PORT', 'PUSH_PORT', 'CAM_KEY', 'CONTROL_KEY', 'SOUNDS_DIR', 'SETTINGS_FILE', 'LOG_FILE', 'SWITCH_FILE', 'RELAY_SUPERVISED']) delete env[k];
    const child = spawn('node', ['server.js'], { cwd: relayDir, env });
    relay = child;
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('relay not ready: ' + relayOutput)); } }, 8000);
    const on = (c) => {
      relayOutput += c;
      if (done || !relayOutput.includes(`raw push) listening on :${PUSH_PORT}`)) return;
      done = true; clearTimeout(t);
      waitFor(() => rawRelay('GET', '/sounds').then((r) => r.status === 200, () => false), 5000).then(resolve);
    };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`relay exited (${code}): ${relayOutput}`)); } });
  });
}
const stopRelay = () => new Promise((resolve) => {
  if (!relay || relay.exitCode !== null || relay.signalCode !== null) return resolve();   // none, or already gone
  relay.once('exit', resolve);
  relay.kill('SIGTERM');
});
function startPhp() {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dashDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    waitFor(() => new Promise((r) => { const q = nodeHttp.get(`${BASE}/`, (res) => { res.resume(); r(true); }); q.on('error', () => r(false)); }), 5000)
      .then((ok) => (ok ? resolve(child) : reject(new Error('php -S not ready'))));
  });
}

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const h = { ...headers };
    if (data) h['Content-Length'] = data.length;
    const req = nodeHttp.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
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
const rawRelay = (method, urlPath, opts = {}) => request(RELAY_PORT, method, urlPath, { headers: { 'X-Control-Key': CONTROL, ...(opts.headers || {}) }, body: opts.body === undefined ? null : opts.body });
// the dashboard: logged in and sending its own header, unless said otherwise
const dash = (method, urlPath, { auth = true, ajax = true, headers = {}, body = null } = {}) => request(PHP_PORT, method, `/${urlPath}`, {
  headers: { ...(auth ? { Authorization: BASIC } : {}), ...(ajax ? { 'X-Requested-With': 'camdash' } : {}), ...headers }, body });
const adminUrl = (action, name) => `sounds-admin.php?action=${action}&name=${encodeURIComponent(name)}`;
const upload = (name, bytes, opts = {}) => dash('POST', adminUrl('upload', name), { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, ...opts });
const saveSettings = (values) => dash('POST', 'system-settings.php', { headers: { 'Content-Type': 'application/json' }, body: { values } });
const wav = fx.wav({ ms: 300 });
const played = () => (fs.existsSync(PLAYER_LOG) ? fs.readFileSync(PLAYER_LOG, 'utf8').split('\n').filter(Boolean) : []);

async function main() {
  await startRelay();
  php = await startPhp();
  fs.writeFileSync(PLAYER_LOG, '');

  // ── who may do what ──
  check('the list needs the login', (await dash('GET', 'sounds.php', { auth: false })).status === 401);
  check('a sound needs the login', (await dash('GET', 'sounds.php?name=a.wav', { auth: false })).status === 401);
  check('changing needs the login', (await upload('a.wav', wav, { auth: false })).status === 401);
  check('changing needs the dashboard\'s own header (a form on another site cannot send it)', (await upload('a.wav', wav, { ajax: false })).status === 403 && !fs.existsSync(path.join(soundsDir, 'a.wav')));
  check('reading does not (an audio element cannot send it)', (await dash('GET', 'sounds.php', { ajax: false })).status === 200);
  let r = await dash('GET', adminUrl('upload', 'a.wav'));
  check('sounds-admin.php is POST only', r.status === 405 && r.headers.allow === 'POST', String(r.status));
  r = await dash('POST', 'sounds.php');
  check('sounds.php is GET only', r.status === 405 && r.headers.allow === 'GET', String(r.status));

  // ── refused by PHP itself ──
  r = await dash('POST', 'sounds-admin.php?name=a.wav', { body: '' });
  check('no action is refused (400)', r.status === 400 && /action must be one of upload, delete, play/.test(r.json.error), JSON.stringify(r.json));
  check('an unknown action is refused (400)', (await dash('POST', adminUrl('format', 'a.wav'))).status === 400);
  for (const bad of ['../evil.wav', 'a.txt', '.hidden.wav', 'a b.wav']) {
    check(`the name ${JSON.stringify(bad)} is refused (400) and nothing is written`, (await upload(bad, wav)).status === 400);
  }
  check('no name is refused (400)', (await dash('POST', 'sounds-admin.php?action=upload', { body: wav })).status === 400);
  check('a name given twice (an array) is refused (400)', (await dash('POST', 'sounds-admin.php?action=delete&name[]=a.wav')).status === 400);
  check('an empty upload is refused (400)', (await upload('a.wav', Buffer.alloc(0))).status === 400);
  r = await upload('big.ogg', fx.ogg(sounds.MAX_SOUND_BYTES + 1));
  check('a file over the limit is refused (413) by PHP, before the relay', r.status === 413 && !fs.existsSync(path.join(soundsDir, 'big.ogg')), `${r.status} ${r.raw.toString().slice(0, 80)}`);
  check('nothing was stored by any of that', !fs.existsSync(soundsDir) || fs.readdirSync(soundsDir).length === 0);
  check('the relay has not been asked to store anything (no upload line in its log)', !/uploaded the sound|tried to upload/.test(relayOutput));

  // ── upload, list, download ──
  r = await upload('siren.wav', wav);
  check('a real WAV is uploaded through the dashboard', r.status === 200 && r.json.ok === true && r.json.replaced === false && fs.readFileSync(path.join(soundsDir, 'siren.wav')).equals(wav), JSON.stringify(r.json));
  check('the answer is only ok / replaced (nothing else of the relay\'s)', JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(['ok', 'replaced']));
  check('the relay logged who did it', /uploaded the sound siren\.wav/.test(relayOutput) && /owner/.test(relayOutput.split('uploaded the sound siren.wav')[0].split('\n').pop()), relayOutput.slice(-300));
  check('the same name again says it replaced', (await upload('siren.wav', wav)).json.replaced === true);
  check('an MP3 and an OGG too', (await upload('beep.mp3', fx.mp3())).status === 200 && (await upload('chime.ogg', fx.ogg())).status === 200);
  r = await upload('page.wav', fx.html());
  check('a web page renamed .wav is refused, with the relay\'s reason', r.status === 400 && /not a WAV/.test(r.json.error) && !fs.existsSync(path.join(soundsDir, 'page.wav')), JSON.stringify(r.json));

  r = await dash('GET', 'sounds.php');
  check('the list: the three sounds with their sizes and the limits this dashboard holds uploads to', r.status === 200 && r.headers['content-type'] === 'application/json' && JSON.stringify(r.json) === JSON.stringify({ sounds: [{ name: 'beep.mp3', bytes: 256 }, { name: 'chime.ogg', bytes: 256 }, { name: 'siren.wav', bytes: wav.length }], maxBytes: 1048576, maxSounds: 20 }), r.raw.toString().slice(0, 300));
  r = await dash('GET', 'sounds.php?name=siren.wav');
  check('a sound is served as it was uploaded, as audio, never sniffed, kept out of the cache', r.status === 200 && r.raw.equals(wav) && r.headers['content-type'] === 'audio/wav' && r.headers['x-content-type-options'] === 'nosniff' && /no-cache/.test(r.headers['cache-control']) && r.headers['content-length'] === String(wav.length) && r.headers['content-disposition'] === 'inline; filename="siren.wav"', JSON.stringify(r.headers));
  check('MP3 and OGG have their own types', (await dash('GET', 'sounds.php?name=beep.mp3')).headers['content-type'] === 'audio/mpeg' && (await dash('GET', 'sounds.php?name=chime.ogg')).headers['content-type'] === 'audio/ogg');
  r = await dash('GET', 'sounds.php?name=none.wav');
  check('a sound that is not there is 404 as JSON', r.status === 404 && r.headers['content-type'] === 'application/json' && r.json.error, String(r.status));
  check('a bad name is 400 and never reaches the relay', (await dash('GET', 'sounds.php?name=..%2Fconfig.js')).status === 400 && (await dash('GET', 'sounds.php?name=config.php')).status === 400);

  // ── the settings ──
  r = await dash('GET', 'system-settings.php');
  const field = (key) => (r.json.fields || []).find((f) => f.key === key);
  check('the settings arrive with the sound choices, the sound files as their options', r.status === 200 && field('alarmSoundRecordStart') && field('alarmSoundRecordStart').type === 'sound' && JSON.stringify(field('alarmSoundRecordStart').options) === JSON.stringify(['beep.mp3', 'chime.ogg', 'siren.wav']) && field('alarmSoundRecordStart').value === '', r.raw.toString().slice(0, 200));
  check('all six alarm settings are there, in their group; the sounds folder is not (a path the dashboard may not set)', ['alarmSoundRecordStart', 'alarmSoundRecordStartRelay', 'alarmSoundRecordStartBrowser', 'alarmSoundPersonDetected', 'alarmSoundPersonDetectedRelay', 'alarmSoundPersonDetectedBrowser'].every((k) => field(k) && field(k).group === 'Alarm sounds') && !field('soundsDir'));
  check('the switches default to ON', field('alarmSoundRecordStartRelay').value === true && field('alarmSoundRecordStartBrowser').value === true);
  r = await saveSettings({ alarmSoundRecordStart: 'nothere.wav' });
  check('a sound that is not in the folder cannot be chosen', r.status === 400 && r.json && /no sound called "nothere\.wav".*upload it first/.test(r.json.error), `${r.status} ${r.raw.toString().slice(0, 200)}`);
  r = await saveSettings({ soundsDir: '/etc' });
  check('the sounds folder cannot be set from the dashboard', r.status >= 400 && /soundsDir/.test(r.raw.toString()), r.raw.toString().slice(0, 200));
  r = await saveSettings({ alarmSoundRecordStart: 'siren.wav', alarmSoundRecordStartBrowser: 'false' });
  check('a sound and a switch are saved through the dashboard, applied without a restart', r.status === 200 && r.json.ok === true && r.json.restart === 'not-needed' && r.json.changed.length === 2, r.raw.toString().slice(0, 200));
  r = await dash('GET', 'system-settings.php');
  check('...and read back', field('alarmSoundRecordStart').value === 'siren.wav' && field('alarmSoundRecordStartBrowser').value === false);

  // ── delete, play ──
  r = await dash('POST', adminUrl('delete', 'siren.wav'));
  check('a sound an alarm uses cannot be deleted (409) — the relay\'s reason reaches the page', r.status === 409 && /chosen for when a recording starts/.test(r.json.error) && fs.existsSync(path.join(soundsDir, 'siren.wav')), JSON.stringify(r.json));
  r = await dash('POST', adminUrl('play', 'siren.wav'));
  check('PLAY ON RELAY runs the relay machine\'s player on that file', r.status === 200 && r.json.ok === true && !!(await waitFor(() => played().length === 1)) && played()[0] === path.join(soundsDir, 'siren.wav'), `${r.status} ${JSON.stringify(played())}`);
  check('PLAY of a sound that is not there is 404', (await dash('POST', adminUrl('play', 'none.wav'))).status === 404);

  // ── an alarm event: relay -> mux.php -> a client ──
  const JPEG = path.join(tmp, 'frame.jpg');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', JPEG]);
  await request(RELAY_PORT, 'POST', `/upload/cam-a?key=${CAM_KEY}`, { headers: { 'Content-Type': 'image/jpeg' }, body: fs.readFileSync(JPEG) });
  await saveSettings({ alarmSoundRecordStartBrowser: 'true' });
  const viewer = await muxViewer.view(PHP_PORT, '?alarms=1', { Authorization: BASIC }, '/mux.php');
  check('mux.php?alarms=1 alone is a valid request: 200, the mux type', viewer.status === 200 && viewer.headers['content-type'] === muxViewer.CONTENT_TYPE, `${viewer.status} ${viewer.text}`);
  check('the first message is the (empty) alarm list', !!(await waitFor(() => muxViewer.alarmStates(viewer).length >= 1)) && muxViewer.readings(muxViewer.alarmStates(viewer)[0]).events.length === 0);
  await rawRelay('POST', '/record/cam-a?seconds=1');
  const lastList = () => { const s = muxViewer.alarmStates(viewer); return s.length ? muxViewer.readings(s[s.length - 1]) : { events: [] }; };
  const got = await waitFor(() => lastList().events[0]);
  check('a recording start arrives as a recordStart event with the camera and the sound, nothing more', !!got && JSON.stringify(Object.keys(got).sort()) === JSON.stringify(['at', 'camId', 'kind', 'seq', 'sound']) && got.kind === 'recordStart' && got.camId === 'cam-a' && got.sound === 'siren.wav' && got.seq === 1, JSON.stringify(lastList()));
  check('...with the list\'s epoch and clock', Number.isInteger(lastList().epoch) && Number.isInteger(lastList().now));
  viewer.close();
  check('mux.php?alarms=1 needs the login', (await muxViewer.view(PHP_PORT, '?alarms=1', {}, '/mux.php')).status === 401);
  await rawRelay('POST', `/record/cam-a/stop`);

  // ── the real settings page ──
  if (jsdomModule) await settingsPage();
  else console.log('jsdom is not installed — skipping the settings page part');

  // ── delete works once nothing uses the sound ──
  r = await saveSettings({ alarmSoundRecordStart: '' });
  check('choosing none frees the sound', r.status === 200);
  r = await dash('POST', adminUrl('delete', 'siren.wav'));
  check('...and it can be deleted', r.status === 200 && r.json.ok === true && !fs.existsSync(path.join(soundsDir, 'siren.wav')), JSON.stringify(r.json));
  check('deleting it again is 404', (await dash('POST', adminUrl('delete', 'siren.wav'))).status === 404);

  // ── a player that fails, a missing control key, a relay that is down ──
  await stopRelay(); await startRelay('fail');
  r = await dash('POST', adminUrl('play', 'beep.mp3'));
  check('a player that cannot play: 502 with the relay\'s reason', r.status === 502 && /exited with code 1: no soundcards found/.test(r.json.error), JSON.stringify(r.json));
  writeConfig({ key: '' });
  r = await upload('x.wav', wav);
  check('without relay_control_key in config.php changing is refused (503) and says what to do', r.status === 503 && /relay_control_key/.test(r.json.error), JSON.stringify(r.json));
  r = await dash('GET', 'sounds.php');
  check('...and so is reading (the relay wants its key for that too): the relay\'s 401 is passed on as JSON', r.status === 401 && r.json && typeof r.json.error === 'string', `${r.status} ${r.raw.toString().slice(0, 100)}`);
  writeConfig();
  await stopRelay();
  r = await dash('GET', 'sounds.php');
  check('the relay being down: the list is 502, as JSON', r.status === 502 && r.json && /relay/i.test(r.json.error), `${r.status} ${r.raw.toString().slice(0, 100)}`);
  r = await dash('GET', 'sounds.php?name=beep.mp3');
  check('...and so is a sound', r.status === 502 && /relay/i.test(r.json.error));
  r = await upload('x.wav', wav);
  check('...and a change', r.status === 502 && /relay/i.test(r.json.error));
}

// The real settings page in jsdom: the library, the choices, SAVE.
async function settingsPage() {
  await startRelayIfDown();
  const html = (await request(PHP_PORT, 'GET', '/settings-page.php', { headers: { Authorization: BASIC } })).raw.toString();
  check('the settings page loads the sound library script', /<script src="js\/sound-library\.js"><\/script>/.test(html));
  const { JSDOM } = jsdomModule;
  const dom = new JSDOM(html, {
    url: `${BASE}/settings-page.php`, runScripts: 'dangerously', pretendToBeVisual: true,
    resources: pageScriptLoader(jsdomModule, ['toast.js', 'busy.js', 'icon-catalog.js', 'icon-picker.js', 'sound-library.js']),
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = async (u, opts = {}) => {
        let body = opts.body;
        // (jsdom's File has no arrayBuffer(): read the bytes with its FileReader, as a browser page would)
        if (body && typeof body === 'object' && typeof body.size === 'number') {
          body = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(Buffer.from(reader.result)); reader.onerror = reject; reader.readAsArrayBuffer(body); });
        }
        const res = await fetch(new URL(u, `${BASE}/settings-page.php`).toString(), { method: opts.method, body, headers: { ...(opts.headers || {}), Authorization: BASIC } });
        return res;
      };
      window.Audio = class { constructor(url) { this.url = url; } play() { window.__previews.push(this.url); return Promise.resolve(); } pause() {} };
      window.__previews = [];
    },
  });
  const w = dom.window; const d = w.document;
  const selectOf = (key) => d.getElementById('f-' + key);
  const toasts = () => [...d.querySelectorAll('#cam-toasts .cam-toast')].map((t) => t.textContent);
  try {
    await waitFor(() => d.querySelectorAll('.sound-row').length > 0, 6000);
    const legends = [...d.querySelectorAll('fieldset > legend')].map((l) => l.textContent);
    check('the page has an "Alarm sounds" group, between "Person check" and "Network"', legends.includes('Alarm sounds') && legends.indexOf('Alarm sounds') > legends.indexOf('Person check') && legends.indexOf('Alarm sounds') < legends.indexOf('Network'), legends.join(' | '));
    const group = [...d.querySelectorAll('fieldset')].find((f) => f.querySelector('legend').textContent === 'Alarm sounds');
    check('the sound files are listed first in that group, then the eight settings (F-29 T6a added the player lock and the time limit)',
      group.firstElementChild.tagName === 'LEGEND' && group.children[1].classList.contains('sound-library') && group.querySelectorAll('.row').length === 8);
    check('the list shows the sounds on the relay', [...d.querySelectorAll('.sound-row .nm')].map((n) => n.firstChild.textContent).join() === 'beep.mp3,chime.ogg,siren.wav');
    const select = selectOf('alarmSoundRecordStart');
    check('a sound choice is a select: "(no sound)" first, then the files', select.tagName === 'SELECT' && [...select.options].map((o) => o.textContent).join(' | ') === '(no sound) | beep.mp3 | chime.ogg | siren.wav' && select.value === 'siren.wav');
    check('the two places are ON / OFF switches showing what is saved', selectOf('alarmSoundRecordStartRelay').value === 'true' && selectOf('alarmSoundRecordStartBrowser').value === 'true');

    // upload a sound through the page
    const input = d.querySelector('.sound-library input[type=file]');
    Object.defineProperty(input, 'files', { value: [new w.File([wav], 'My Alarm.WAV')], configurable: true });
    [...d.querySelectorAll('.sound-library button')].find((b) => b.textContent === '⬆ UPLOAD').click();
    await waitFor(() => d.querySelectorAll('.sound-row').length === 4, 6000);
    check('an uploaded sound shows in the list under its safe name, and is on the relay', [...d.querySelectorAll('.sound-row .nm')].some((n) => n.firstChild.textContent === 'My_Alarm.wav') && fs.existsSync(path.join(soundsDir, 'My_Alarm.wav')), toasts().join(' | '));
    check('...and in every sound choice, with what was chosen kept', [selectOf('alarmSoundRecordStart'), selectOf('alarmSoundPersonDetected')].every((s) => [...s.options].some((o) => o.value === 'My_Alarm.wav')) && selectOf('alarmSoundRecordStart').value === 'siren.wav');
    check('...and the page has no unsaved changes from it', d.getElementById('save').disabled === true);

    // choose it for the person alarm and save
    selectOf('alarmSoundPersonDetected').value = 'My_Alarm.wav';
    selectOf('alarmSoundPersonDetected').dispatchEvent(new w.Event('input'));
    selectOf('alarmSoundPersonDetectedRelay').value = 'false';
    selectOf('alarmSoundPersonDetectedRelay').dispatchEvent(new w.Event('input'));
    check('choosing marks the choice changed and enables SAVE', selectOf('alarmSoundPersonDetected').classList.contains('changed') && d.getElementById('save').disabled === false);
    d.getElementById('save').click();
    const saved = await waitFor(async () => {
      const s = await dash('GET', 'system-settings.php');
      const f = (k) => s.json.fields.find((x) => x.key === k);
      return f('alarmSoundPersonDetected').value === 'My_Alarm.wav' && f('alarmSoundPersonDetectedRelay').value === false;
    }, 8000);
    check('SAVE reaches the relay: the sound and the switch are saved', !!saved);
    await waitFor(() => selectOf('alarmSoundPersonDetected') && selectOf('alarmSoundPersonDetected').value === 'My_Alarm.wav' && !d.getElementById('save').textContent.includes('...'), 4000);
    await sleep(300);

    // PLAY in this browser
    [...d.querySelectorAll('.sound-row')].find((r) => r.querySelector('.nm').firstChild.textContent === 'beep.mp3').querySelectorAll('button')[0].click();
    check('PLAY previews the sound in the browser from sounds.php', JSON.stringify(w.__previews) === JSON.stringify(['sounds.php?name=beep.mp3']), JSON.stringify(w.__previews));

    // delete a used sound (refused, with the reason) and a free one
    const rowOf = (name) => [...d.querySelectorAll('.sound-row')].find((r) => r.querySelector('.nm').firstChild.textContent === name);
    rowOf('My_Alarm.wav').querySelectorAll('button')[2].click();
    await waitFor(() => toasts().some((t) => /chosen for when a person is found/.test(t)), 6000);
    check('deleting a sound an alarm uses is refused and says which alarm', toasts().some((t) => /chosen for when a person is found in a recording/.test(t)) && fs.existsSync(path.join(soundsDir, 'My_Alarm.wav')), toasts().join(' | '));
    rowOf('chime.ogg').querySelectorAll('button')[2].click();
    await waitFor(() => !rowOf('chime.ogg'), 6000);
    check('deleting a free sound removes it from the list and from every choice', !rowOf('chime.ogg') && !fs.existsSync(path.join(soundsDir, 'chime.ogg')) && ![...selectOf('alarmSoundRecordStart').options].some((o) => o.value === 'chime.ogg'));

    // restore
    await saveSettings({ alarmSoundPersonDetected: '', alarmSoundPersonDetectedRelay: 'true' });
    await rawRelay('DELETE', '/sounds/My_Alarm.wav');
  } finally {
    closeWindow(dom);
  }
}
async function startRelayIfDown() { if (!(await rawRelay('GET', '/sounds').then((r) => r.status === 200, () => false))) await startRelay(); }

main()
  .catch((err) => check('the test ran to the end', false, err && err.stack ? err.stack : String(err)))
  .finally(async () => {
    await stopRelay();
    if (php) php.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    finished = true;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
