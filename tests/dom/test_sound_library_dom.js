#!/usr/bin/env node
'use strict';
// test_sound_library_dom.js — the alarm sound library of the settings page (php/cameras/js/sound-library.js) in jsdom,
// with a scripted fetch (no server): what it draws from the list, what each button asks of the server, what it says
// when the server refuses, and that nothing it is told can become markup.
//   * the list: a row per sound with its size; none yet -> a hint; a failing list -> the reason, as text
//   * a name or size the server sends is shown as TEXT (a hostile name makes no element and runs nothing)
//   * PLAY plays that sound from sounds.php in this browser; ON RELAY asks sounds-admin.php?action=play (and says why
//     when the relay machine's player could not start); DELETE asks first, then deletes and re-reads the list
//   * UPLOAD: no file / the wrong kind / too large / a full library are said at once, without a request; a good file is
//     sent as the raw body under a safe name, a name that exists asks before replacing
//   * every change goes out with the dashboard's own header, as a POST; onChange hears the names after every list
// Needs the jsdom package (cd tests/dom && npm install); skips if it is missing.
//
//   node tests/dom/test_sound_library_dom.js

const path = require('path');
const { closeWindow } = require('./dom_helpers');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); } else { fail += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!JSDOM) { console.log('jsdom is not installed (cd tests/dom && npm install) — skipping the sound library DOM test'); finished = true; process.exit(0); }

const SCRIPT = path.join(__dirname, '../../php/cameras/js/sound-library.js');
const HEADERS = { 'X-Requested-With': 'camdash' };

// A scripted server: `listing` is what sounds.php answers; `answers` maps "action:name" to what sounds-admin.php answers.
function makeServer() {
  const server = {
    requests: [],
    listing: { status: 200, body: { sounds: [{ name: 'siren.wav', bytes: 2048 }, { name: 'beep.mp3', bytes: 300 }], maxBytes: 1048576, maxSounds: 3 } },
    answers: {},
    fetch(url, init = {}) {
      server.requests.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
      const respond = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error('no json')) : Promise.resolve(body)) });
      if (url === 'sounds.php') return respond(server.listing.status, server.listing.body);
      const m = /^sounds-admin\.php\?action=(\w+)&name=(.+)$/.exec(url);
      const a = m && server.answers[`${m[1]}:${decodeURIComponent(m[2])}`];
      return a ? respond(a.status, a.body) : respond(200, { ok: true });
    },
  };
  return server;
}

async function mountLibrary(server, extra = {}) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="box"></div></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(require('fs').readFileSync(SCRIPT, 'utf8'));
  const plays = [];
  const toasts = [];
  const changes = [];
  const confirms = [];
  const state = { confirmAnswer: true };
  const library = w.CamSoundLibrary.mount(w.document.getElementById('box'), {
    fetch: (u, i) => server.fetch(u, i),
    notify: (text, kind) => toasts.push([kind, text]),
    confirm: (text) => { confirms.push(text); return state.confirmAnswer; },
    onChange: (names) => changes.push(names),
    run: (button, fn) => fn(),
    createAudio: (url) => { const a = { url, paused: false, play: () => { plays.push(url); return Promise.resolve(); }, pause() { this.paused = true; } }; return a; },
    ...extra,
  });
  await library.refresh();
  return { dom, w, d: w.document, library, plays, toasts, changes, confirms, state };
}

const buttonsOf = (d, row, label) => [...d.querySelectorAll('.sound-row')][row].querySelectorAll('button')[label];
const setFile = (w, d, name, size) => {
  const input = d.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [new w.File([new Uint8Array(size)], name)], configurable: true });
  return input;
};

async function main() {
  // ── the list ──
  let server = makeServer();
  let t = await mountLibrary(server);
  const rows = [...t.d.querySelectorAll('.sound-row')];
  check('a row for each sound, with its name and its size', rows.length === 2 && rows[0].querySelector('.nm').firstChild.textContent === 'siren.wav' && rows[0].querySelector('small').textContent === '2.0 KB' && rows[1].querySelector('small').textContent === '300 B', rows.map((r) => r.textContent).join(' | '));
  check('each row has PLAY, ON RELAY and DELETE', rows.every((r) => [...r.querySelectorAll('button')].map((b) => b.textContent).join('|') === '▶ PLAY|🔊 ON RELAY|🗑 DELETE'));
  check('onChange hears the names once the list is read', JSON.stringify(t.changes) === JSON.stringify([['siren.wav', 'beep.mp3']]), JSON.stringify(t.changes));
  check('the limits are told in words', /WAV, MP3 or OGG, up to 1\.0 MB each, at most 3 sounds/.test(t.d.querySelector('.help:last-child').textContent), t.d.querySelector('#box').lastChild.textContent);
  check('the list was asked for with the dashboard\'s own header', JSON.stringify(server.requests[0]) === JSON.stringify({ url: 'sounds.php', method: 'GET', headers: HEADERS, body: undefined }));
  closeWindow(t.dom);

  server = makeServer(); server.listing.body = { sounds: [], maxBytes: 1048576, maxSounds: 3 };
  t = await mountLibrary(server);
  check('no sounds yet: a hint instead of a list', t.d.querySelectorAll('.sound-row').length === 0 && /No sounds yet/.test(t.d.querySelector('#box').textContent));
  closeWindow(t.dom);

  server = makeServer(); server.listing = { status: 502, body: { error: 'Could not reach the relay' } };
  t = await mountLibrary(server);
  check('a list that cannot be read says why, as text', /Could not load the sounds: Could not reach the relay/.test(t.d.querySelector('#box').textContent) && t.changes.length === 0, t.d.querySelector('#box').textContent);
  closeWindow(t.dom);

  server = makeServer(); server.listing = { status: 200, body: { nope: 1 } };
  t = await mountLibrary(server);
  check('an answer that is not a list is not drawn', /Could not load the sounds/.test(t.d.querySelector('#box').textContent) && t.d.querySelectorAll('.sound-row').length === 0);
  closeWindow(t.dom);

  // ── text only ──
  server = makeServer();
  const evil = '<img src=x onerror="window.__pwned=1">.wav';
  server.listing.body = { sounds: [{ name: evil, bytes: 1 }], maxBytes: 1048576, maxSounds: 3 };
  t = await mountLibrary(server);
  check('a hostile name is shown as text: no element, nothing ran', t.d.querySelectorAll('#box img').length === 0 && t.w.__pwned === undefined && t.d.querySelector('.sound-row .nm').firstChild.textContent === evil, t.d.querySelector('#box').innerHTML.slice(0, 200));
  closeWindow(t.dom);

  // ── PLAY (this browser) ──
  server = makeServer();
  t = await mountLibrary(server);
  buttonsOf(t.d, 1, 0).click();
  check('PLAY plays that sound from sounds.php in this browser, and asks the server nothing', JSON.stringify(t.plays) === JSON.stringify(['sounds.php?name=beep.mp3']) && server.requests.length === 1, JSON.stringify(t.plays));
  buttonsOf(t.d, 0, 0).click();
  check('...and a second PLAY stops the first', t.plays.length === 2);
  closeWindow(t.dom);

  server = makeServer();
  t = await mountLibrary(server, { createAudio: () => ({ play: () => Promise.reject(new Error('NotSupported')), pause() {} }) });
  buttonsOf(t.d, 0, 0).click();
  await sleep(10);
  check('a browser that cannot play it says so', t.toasts.some(([kind, text]) => kind === 'error' && /could not play siren\.wav/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  // ── ON RELAY ──
  server = makeServer();
  t = await mountLibrary(server);
  buttonsOf(t.d, 0, 1).click();
  await sleep(10);
  const playReq = server.requests.find((r) => /action=play/.test(r.url));
  check('ON RELAY is a POST to sounds-admin.php?action=play with the sound\'s name and the dashboard header', playReq && playReq.url === 'sounds-admin.php?action=play&name=siren.wav' && playReq.method === 'POST' && playReq.headers['X-Requested-With'] === 'camdash' && playReq.body === undefined, JSON.stringify(playReq));
  check('...and says it is playing', t.toasts.some(([kind, text]) => kind === 'ok' && /Playing siren\.wav on the relay machine/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  server = makeServer(); server.answers['play:siren.wav'] = { status: 502, body: { error: 'ffplay could not start (spawn ffplay ENOENT)' } };
  t = await mountLibrary(server);
  buttonsOf(t.d, 0, 1).click();
  await sleep(10);
  check('when the relay machine cannot play, the reason is told', t.toasts.some(([kind, text]) => kind === 'error' && /ffplay could not start/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  server = makeServer(); server.fetch = (u, i) => (/action=play/.test(u) ? Promise.reject(new Error('net')) : makeServer().fetch(u, i));
  t = await mountLibrary(server);
  buttonsOf(t.d, 0, 1).click();
  await sleep(10);
  check('a dashboard that cannot be reached is told as such', t.toasts.some(([kind, text]) => kind === 'error' && /Could not reach the dashboard server/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  // ── DELETE ──
  server = makeServer();
  t = await mountLibrary(server);
  t.state.confirmAnswer = false;
  buttonsOf(t.d, 0, 2).click();
  await sleep(10);
  check('DELETE asks first; "no" sends nothing', t.confirms.length === 1 && /Delete the sound siren\.wav/.test(t.confirms[0]) && !server.requests.some((r) => /action=delete/.test(r.url)));
  t.state.confirmAnswer = true;
  server.listing.body = { sounds: [{ name: 'beep.mp3', bytes: 300 }], maxBytes: 1048576, maxSounds: 3 };
  buttonsOf(t.d, 0, 2).click();
  await sleep(20);
  const delReq = server.requests.find((r) => /action=delete/.test(r.url));
  check('"yes" is a POST to sounds-admin.php?action=delete, then the list is read again and shown', delReq && delReq.url === 'sounds-admin.php?action=delete&name=siren.wav' && delReq.method === 'POST' && t.d.querySelectorAll('.sound-row').length === 1 && JSON.stringify(t.changes[t.changes.length - 1]) === JSON.stringify(['beep.mp3']), JSON.stringify(t.changes));
  check('...and says it is deleted', t.toasts.some(([kind, text]) => kind === 'ok' && /Deleted siren\.wav/.test(text)));
  closeWindow(t.dom);

  server = makeServer(); server.answers['delete:siren.wav'] = { status: 409, body: { error: 'the sound siren.wav is chosen for when a recording starts — choose another' } };
  t = await mountLibrary(server);
  const before = server.requests.length;
  buttonsOf(t.d, 0, 2).click();
  await sleep(20);
  check('a sound an alarm uses: the server\'s reason is shown and the list is NOT re-read', t.toasts.some(([kind, text]) => kind === 'error' && /chosen for when a recording starts/.test(text)) && server.requests.length === before + 1 && t.d.querySelectorAll('.sound-row').length === 2);
  closeWindow(t.dom);

  // ── UPLOAD ──
  server = makeServer();
  t = await mountLibrary(server);
  const upload = () => t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1];
  const requestsBefore = () => server.requests.length;
  let n = requestsBefore();
  upload().click(); await sleep(10);
  check('UPLOAD with no file chosen says so and asks nothing', t.toasts.some(([, text]) => /Choose a sound file first/.test(text)) && server.requests.length === n);
  setFile(t.w, t.d, 'notes.txt', 5000); upload().click(); await sleep(10);
  check('the wrong kind of file is refused at once', t.toasts.some(([, text]) => /must be a \.wav, \.mp3, \.ogg file/.test(text)) && server.requests.length === n);
  setFile(t.w, t.d, 'big.wav', 2 * 1048576); upload().click(); await sleep(10);
  check('a file that is too large is refused at once, with sizes', t.toasts.some(([, text]) => /too large \(2\.0 MB\).*at most 1\.0 MB/.test(text)) && server.requests.length === n);
  closeWindow(t.dom);

  server = makeServer(); server.listing.body = { sounds: [{ name: 'a.wav', bytes: 100 }, { name: 'b.wav', bytes: 100 }, { name: 'c.wav', bytes: 100 }], maxBytes: 1048576, maxSounds: 3 };
  t = await mountLibrary(server);
  n = server.requests.length;
  setFile(t.w, t.d, 'd.wav', 5000); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(10);
  check('a full library takes no new name', t.toasts.some(([, text]) => /already 3 sounds/.test(text)) && server.requests.length === n);
  closeWindow(t.dom);

  server = makeServer();
  t = await mountLibrary(server);
  setFile(t.w, t.d, 'My New Siren.WAV', 5000);
  server.listing.body = { sounds: [{ name: 'siren.wav', bytes: 2048 }, { name: 'beep.mp3', bytes: 300 }, { name: 'My_New_Siren.wav', bytes: 5000 }], maxBytes: 1048576, maxSounds: 3 };
  t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(20);
  const up = server.requests.find((r) => /action=upload/.test(r.url));
  check('a good file is POSTed as the raw body under a safe name, with the dashboard header', up && up.url === 'sounds-admin.php?action=upload&name=My_New_Siren.wav' && up.method === 'POST' && up.headers['Content-Type'] === 'application/octet-stream' && up.headers['X-Requested-With'] === 'camdash' && up.body && up.body.size === 5000, JSON.stringify(up && { url: up.url, headers: up.headers }));
  check('...and the list shows it, the file field is emptied, and it says so', t.d.querySelectorAll('.sound-row').length === 3 && t.toasts.some(([kind, text]) => kind === 'ok' && /Uploaded My_New_Siren\.wav/.test(text)) && JSON.stringify(t.changes[t.changes.length - 1]).includes('My_New_Siren.wav'), JSON.stringify(t.toasts));
  check('...and no question was asked for a new name', t.confirms.length === 0);
  closeWindow(t.dom);

  server = makeServer();
  t = await mountLibrary(server);
  t.state.confirmAnswer = false;
  setFile(t.w, t.d, 'siren.wav', 5000); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(10);
  check('a name that exists asks before replacing; "no" sends nothing', /exists already\. Replace it\?/.test(t.confirms[0] || '') && !server.requests.some((r) => /action=upload/.test(r.url)));
  t.state.confirmAnswer = true;
  server.answers['upload:siren.wav'] = { status: 200, body: { ok: true, replaced: true } };
  setFile(t.w, t.d, 'siren.wav', 5000); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(20);
  check('"yes" replaces and says "Replaced"', t.toasts.some(([kind, text]) => kind === 'ok' && /Replaced siren\.wav/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  server = makeServer(); server.answers['upload:ok.wav'] = { status: 400, body: { error: 'this is not a WAV file (its first bytes say otherwise)' } };
  t = await mountLibrary(server);
  setFile(t.w, t.d, 'ok.wav', 5000); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(20);
  check('a refusal of the server is shown as it is, and the list is not re-read', t.toasts.some(([kind, text]) => kind === 'error' && /not a WAV file/.test(text)) && t.d.querySelectorAll('.sound-row').length === 2);
  closeWindow(t.dom);

  server = makeServer(); server.answers['upload:ok.wav'] = { status: 500, body: undefined };
  t = await mountLibrary(server);
  setFile(t.w, t.d, 'ok.wav', 5000); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click(); await sleep(20);
  check('an answer that is not JSON is reported by its status', t.toasts.some(([kind, text]) => kind === 'error' && /Error 500/.test(text)), JSON.stringify(t.toasts));
  closeWindow(t.dom);

  // ── the busy indicator wraps every action ──
  server = makeServer();
  const wrapped = [];
  t = await mountLibrary(server, { run: (button, fn) => { wrapped.push(button.textContent); return fn(); } });
  buttonsOf(t.d, 0, 1).click(); buttonsOf(t.d, 0, 2).click(); t.d.querySelectorAll('button')[t.d.querySelectorAll('button').length - 1].click();
  await sleep(10);
  check('ON RELAY, DELETE and UPLOAD run inside the page\'s busy indicator', ['🔊 ON RELAY', '🗑 DELETE', '⬆ UPLOAD'].every((b) => wrapped.includes(b)), JSON.stringify(wrapped));
  closeWindow(t.dom);
}

main()
  .catch((err) => check('the test ran without an unexpected error', false, String((err && err.stack) || err)))
  .finally(() => {
    finished = true;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  });
