'use strict';

// Tests the footage list as a page runs it (php/cameras/lib/recordings-list.js, used by BOTH the dashboard's
// per-camera FILES panel and the ALL FILES page), against a fake recordings.php and a small fake page
// (tests/node/fake_dom.js — nothing to install). What is checked:
//   - the all-cameras list: every camera's clips in one list, newest first, each row naming its camera,
//     with the same row buttons and bottom buttons as a camera's own panel
//   - one camera's panel: the same list without the camera name
//   - one camera that cannot be read does not blank the rest; nothing readable says so
//   - selecting (all / all seen / ticks kept across a reload), downloading and deleting the selection,
//     play, GET and DEL, DELETE ALL — each going to recordings.php with the right camera and file name,
//     the anti-forgery header on every change, and a confirmation before anything is deleted
//   - names that are not plain recording names never become an element
//
// Usage:  node tests/node/test_recordings_list_page.js

const path = require('path');
const { createFakeDocument } = require('./fake_dom');

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); return; }
  failCount += 1;
  console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

const stamp = (iso) => iso.replace(/[:.]/g, '-');
const name = (cam, iso) => `${cam}_${stamp(iso)}.mp4`;

// ── fakes ────────────────────────────────────────────────────────────────

// A fake recordings.php: per camera a list of clips; answers the list GET and the three POSTs; records every request.
function fakeServer(initial, options = {}) {
  const clips = JSON.parse(JSON.stringify(initial));
  const requests = [];
  const failingDeletes = new Set(options.failingDeletes || []);
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  async function fetch(url, init = {}) {
    const u = new URL(url, 'http://dash/');
    const cam = u.searchParams.get('cam');
    const method = init.method || 'GET';
    requests.push({ method, cam, query: u.search, headers: init.headers || {} });
    if (options.unreadable && options.unreadable.includes(cam)) return reply(502, { error: 'Could not reach relay' });
    if (!clips[cam]) return reply(404, 'Camera not found');
    if (method === 'GET') return reply(200, clips[cam]);
    const del = u.searchParams.get('delete');
    if (del !== null) {
      if (failingDeletes.has(`${cam}/${del}`)) return reply(502, { error: 'relay said no' });
      clips[cam] = clips[cam].filter((f) => f.filename !== del);
    }
    if (u.searchParams.has('deleteAll')) clips[cam] = [];
    const seen = u.searchParams.get('seen');
    if (seen !== null) clips[cam].forEach((f) => { if (f.filename === seen) f.seen = true; });
    return reply(200, { ok: true });
  }
  return { fetch, requests, clips, posts: () => requests.filter((r) => r.method === 'POST') };
}

function page() {
  const doc = createFakeDocument();
  global.document = doc;
  const panel = doc.createElement('div');
  panel.id = 'files-x';
  doc.body.append(panel);
  return { doc, panel };
}

const list = require(path.join(__dirname, '../../php/cameras/lib/recordings-list.js'));
const LABELS = { cam1: '🚪 Front', cam2: '🌿 Back', cam3: '🚗 Drive' };

const A = name('cam1', '2026-10-01T10:00:00.000Z');
const B = name('cam2', '2026-10-03T10:00:00.000Z');
const C = name('cam1', '2026-10-02T10:00:00.000Z');
const D = name('cam3', '2026-10-04T10:00:00.000Z');
const fleet = () => ({
  cam1: [{ filename: A, sizeBytes: 1024, seen: true }, { filename: C, sizeBytes: 2048, seen: false }],
  cam2: [{ filename: B, sizeBytes: 3 * 1024 * 1024, seen: false }],
  cam3: [{ filename: D, sizeBytes: 10, seen: true }],
});

function build(server, extra = {}) {
  const { doc, panel } = page();
  const events = { paused: 0, downloads: 0, players: 0, loaded: [], confirms: [], alerts: [] };
  const answers = { confirm: true };
  const view = list.create(Object.assign({
    panel, prefix: 'all', cams: ['cam1', 'cam2', 'cam3'], camLabel: (c) => LABELS[c],
    deleteAllConfirm: 'Delete ALL for EVERY camera?', fetch: server.fetch, downloadPauseMs: 0,
    hooks: {
      withPaused: async (fn) => { events.paused += 1; return fn(); },
      holdForDownload: () => { events.downloads += 1; },
      playersChanged: () => { events.players += 1; },
      loaded: (files, failed) => { events.loaded.push({ files: files.length, failed }); },
      confirm: (t) => { events.confirms.push(t); return answers.confirm; },
      alert: (t) => { events.alerts.push(t); },
    },
  }, extra));
  return { doc, panel, view, events, answers };
}

const rows = (panel) => panel.querySelectorAll('.files-row');
const names = (panel) => panel.querySelectorAll('.files-name').map((e) => e.text());
const byId = (doc, id) => doc.getElementById(id);

async function main() {
  // ── the all-cameras list ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    check('the list asks recordings.php once per camera, with GET', same(server.requests.map((r) => `${r.method} ${r.cam}`).sort(), ['GET cam1', 'GET cam2', 'GET cam3']));
    check('every camera\'s clips are in the one list, newest first', same(names(panel), [D, B, C, A]), show(names(panel)));
    check('each row names its camera', same(panel.querySelectorAll('.files-cam').map((e) => e.text()), ['🚗 Drive', '🌿 Back', '🚪 Front', '🚪 Front']));
    check('each row shows the file size', same(panel.querySelectorAll('.files-size').map((e) => e.text()), ['10 B', '3.0 MB', '2.0 KB', '1.0 KB']));
    check('the header counts the clips', panel.querySelector('.files-panel-header').text().startsWith('4 recordings'));
    check('every row has PLAY, GET, DEL buttons as a camera\'s own panel does',
      rows(panel).every((r) => same(r.querySelectorAll('.cam-btn').map((b) => b.text()), ['▶ PLAY', '⬇ GET', '🗑 DEL'])));
    check('only the clips nobody has seen are marked unseen', same(rows(panel).map((r) => r.classes().includes('unseen')), [false, true, true, false]));
    check('the bottom buttons are the same as a camera\'s own panel',
      same(panel.querySelector('.files-panel-footer').querySelectorAll('.cam-btn').map((b) => b.text()),
        ['☑ SELECT ALL', '☑ SELECT ALL SEEN', '⬇ DOWNLOAD SELECTED (0)', '🧑 SORT OUT SELECTED (0)', '🗑 DELETE SELECTED (0)']));
    check('download / delete selected start disabled', byId(doc, 'files-dl-selected-all').disabled && byId(doc, 'files-del-selected-all').disabled);
    check('the loaded hook hears of the list', same(events.loaded, [{ files: 4, failed: [] }]));
    check('a GET changes nothing on the server', server.posts().length === 0);
  }

  // ── one camera's panel ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view } = build(server, { prefix: 'cam1', cams: ['cam1'], camLabel: null });
    await view.refresh();
    check('a camera\'s own panel lists only its clips', same(names(panel), [C, A]));
    check('…without a camera name on each row', panel.querySelectorAll('.files-cam').length === 0);
    check('…and its buttons are named after the camera', !!byId(doc, 'files-sel-all-cam1') && !!byId(doc, 'files-del-selected-cam1'));
    check('the header says "2 recordings"; one says "1 recording"', panel.querySelector('.files-panel-header').text().startsWith('2 recordings'));
    const one = build(fakeServer({ cam1: [{ filename: A, sizeBytes: 1, seen: true }] }), { prefix: 'cam1', cams: ['cam1'], camLabel: null });
    await one.view.refresh();
    check('one clip is "1 recording"', one.panel.querySelector('.files-panel-header').text().startsWith('1 recording') && !one.panel.querySelector('.files-panel-header').text().startsWith('1 recordings'));
  }

  // ── nothing, failures ──
  {
    const empty = build(fakeServer({ cam1: [], cam2: [], cam3: [] }));
    await empty.view.refresh();
    check('no clips at all: "No recordings yet." and no buttons', empty.panel.text() === 'No recordings yet.' && empty.panel.querySelectorAll('.cam-btn').length === 0);

    const noCams = build(fakeServer({}), { cams: [] });
    await noCams.view.refresh();
    check('no cameras configured: "No recordings yet." (not an error)', noCams.panel.text() === 'No recordings yet.');

    const partial = build(fakeServer(fleet(), { unreadable: ['cam2'] }));
    await partial.view.refresh();
    check('one unreadable camera: the others are still listed', same(names(partial.panel), [D, C, A]));
    check('…and the list says which camera could not be read', partial.panel.text().includes('Could not load the recordings of: 🌿 Back'));
    check('…and the loaded hook is told', same(partial.events.loaded, [{ files: 3, failed: ['cam2'] }]));

    const dead = build(fakeServer(fleet(), { unreadable: ['cam1', 'cam2', 'cam3'] }));
    await dead.view.refresh();
    check('every camera unreadable: "Could not load recordings." and no buttons', dead.panel.text() === 'Could not load recordings.' && dead.panel.querySelectorAll('.cam-btn').length === 0);

    const broken = build({ fetch: async () => { throw new Error('network down'); } });
    await broken.view.refresh();
    check('a network failure is shown, not thrown', broken.panel.text() === 'Could not load recordings.');

    const notList = build({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ error: 'x' }) }) }, { cams: ['cam1'], camLabel: null });
    await notList.view.refresh();
    check('an answer that is not a list is an error, not "no recordings"', notList.panel.text() === 'Could not load recordings.');
  }

  // ── hostile names ──
  {
    const evil = ["x');window.__pwned=1;('.mp4", '"><img src=x onerror=alert(1)>.mp4', '../../etc/passwd'];
    const server = fakeServer({ cam1: [...evil.map((filename) => ({ filename, sizeBytes: 1, seen: false })), { filename: A, sizeBytes: 1, seen: true }] });
    const { panel, view } = build(server, { cams: ['cam1'] });
    await view.refresh();
    check('names that are not plain recording names never become a row', same(names(panel), [A]));
    check('…and no element anywhere carries them', !panel.descendants().some((e) => evil.some((n) => e.id.includes(n) || (e.value || '').includes(n) || e.text().includes(n))));
  }

  // ── selecting ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view } = build(server);
    await view.refresh();
    const sel = (id) => byId(doc, id);
    sel('files-sel-all-all').click();
    check('SELECT ALL ticks every clip', panel.querySelectorAll('.files-select:checked').length === 4);
    check('…and the buttons say how many', sel('files-del-selected-all').text() === '🗑 DELETE SELECTED (4)' && sel('files-dl-selected-all').text() === '⬇ DOWNLOAD SELECTED (4)' && !sel('files-del-selected-all').disabled);
    check('…and offers to untick', sel('files-sel-all-all').text() === '☐ UNSELECT ALL');
    sel('files-sel-all-all').click();
    check('pressing it again unticks everything', panel.querySelectorAll('.files-select:checked').length === 0 && sel('files-del-selected-all').disabled);
    sel('files-sel-seen-all').click();
    check('SELECT ALL SEEN ticks only the clips already seen', same(view.selected().map((p) => p.filename).sort(), [A, D].sort()));
    check('selection knows camera and file of every tick', same(view.selected().map((p) => p.cam).sort(), ['cam1', 'cam3']));
    await view.refresh();
    check('a reload keeps what was ticked', same(view.selected().map((p) => p.filename).sort(), [A, D].sort()));
  }

  // ── play / get ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    const row = byId(doc, `row-cam2-${B}`);
    check('B starts unseen', row.classes().includes('unseen'));
    row.querySelectorAll('.cam-btn')[0].click();   // PLAY
    const player = byId(doc, `player-cam2-${B}`);
    const video = player.children[0];
    check('PLAY opens a <video> for that camera and clip', video && video.tagName === 'VIDEO' && video.src === `recordings.php?cam=cam2&play=${B}` && video.controls === true);
    check('PLAY marks the clip seen at once', !row.classes().includes('unseen') && row.querySelector('.files-select').dataset.seen === '1');
    check('PLAY tells recordings.php (POST seen, with the anti-forgery header, for that camera)',
      server.posts().some((r) => r.cam === 'cam2' && r.query === `?cam=cam2&seen=${B}` && r.headers['X-Requested-With'] === 'camdash'));
    check('the page is told a player opened', events.players > 0);
    row.querySelectorAll('.cam-btn')[0].click();
    check('PLAY again closes the player', player.children.length === 0 && player.dataset.open === '0');
    const get = row.querySelectorAll('.cam-btn')[1];
    check('GET is a download link for that camera and clip', get.tagName === 'A' && get.href === `recordings.php?cam=cam2&download=${B}`);
    get.click();
    check('GET asks the page to make room for the download', events.downloads === 1);
  }

  // ── deleting ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events, answers } = build(server);
    await view.refresh();
    answers.confirm = false;
    byId(doc, `row-cam1-${A}`).querySelectorAll('.cam-btn')[2].click();
    await new Promise((r) => setImmediate(r));
    check('DEL asks first, and "no" deletes nothing', events.confirms.length === 1 && events.confirms[0].includes(A) && server.posts().length === 0);
    answers.confirm = true;
    byId(doc, `row-cam1-${A}`).querySelectorAll('.cam-btn')[2].click();
    await new Promise((r) => setTimeout(r, 5));
    check('DEL posts delete for that camera and clip, with the anti-forgery header',
      server.posts().length === 1 && server.posts()[0].query === `?cam=cam1&delete=${A}` && server.posts()[0].headers['X-Requested-With'] === 'camdash');
    check('…and the list is reloaded without it', same(names(panel), [D, B, C]));
    check('…inside the page\'s "make room" wrapper', events.paused >= 1);
  }
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events, answers } = build(server);
    await view.refresh();
    byId(doc, 'files-sel-all-all').click();
    await view.deleteAll();
    check('DELETE ALL on the all page asks once, in words that say every camera', events.confirms.length === 1 && events.confirms[0] === 'Delete ALL for EVERY camera?');
    check('…and posts deleteAll for every camera of the list', same(server.posts().map((r) => r.query).sort(), ['?cam=cam1&deleteAll=1', '?cam=cam2&deleteAll=1', '?cam=cam3&deleteAll=1']));
    check('…and the list is then empty', panel.text() === 'No recordings yet.');

    const refused = fakeServer(fleet());
    const r = build(refused);
    await r.view.refresh();
    r.answers.confirm = false;
    await r.view.deleteAll();
    check('"no" to DELETE ALL deletes nothing', refused.posts().length === 0);
  }
  {
    const server = fakeServer(fleet(), { failingDeletes: [`cam2/${B}`] });
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    byId(doc, 'files-sel-all-all').click();
    byId(doc, 'files-del-selected-all').dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    check('DELETE SELECTED asks once with the count', events.confirms.length === 1 && events.confirms[0].startsWith('Delete 4 selected recordings?'), show(events.confirms));
    check('…deletes each clip on its own camera', same(server.posts().map((r) => r.query).sort(),
      [`?cam=cam1&delete=${A}`, `?cam=cam1&delete=${C}`, `?cam=cam2&delete=${B}`, `?cam=cam3&delete=${D}`].sort()));
    check('…a clip that could not be deleted stays listed and stays ticked', same(names(panel), [B]) && same(view.selected(), [{ cam: 'cam2', filename: B }]), show(view.selected()));
    check('…and the user is told how many did not go, and why', events.alerts.length === 1 && events.alerts[0].includes('1 of 4') && events.alerts[0].includes('relay said no'), show(events.alerts));
  }
  {
    const nothing = build(fakeServer(fleet()));
    await nothing.view.refresh();
    byId(nothing.doc, 'files-del-selected-all').dispatch('click');   // (the button is disabled in a browser; the handler must hold up on its own)
    await new Promise((r) => setTimeout(r, 5));
    check('DELETE SELECTED with nothing ticked asks nothing and posts nothing', nothing.events.confirms.length === 0 && nothing.view.selected().length === 0);
  }

  // ── downloading the selection ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    const made = [];
    const realAppend = doc.body.appendChild.bind(doc.body);
    doc.body.appendChild = (n) => { made.push(n); return realAppend(n); };
    panel.querySelectorAll('.files-select').filter((b) => b.dataset.cam === 'cam1').forEach((b) => b.click());
    byId(doc, 'files-dl-selected-all').dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    check('DOWNLOAD SELECTED clicks one hidden link per ticked clip', made.length === 2 && made.every((l) => l.tagName === 'A' && l.clicks === 1));
    check('…each pointing at that clip\'s download', same(made.map((l) => l.href).sort(), [`recordings.php?cam=cam1&download=${A}`, `recordings.php?cam=cam1&download=${C}`].sort()));
    check('…named after the clip, and removed again', made.every((l) => l.download && l.parent === null));
    check('…asks the page to make room once, and marks each clip seen',
      events.downloads === 1 && server.posts().filter((r) => r.query.includes('&seen=')).length === 2);
  }

  // ── the person's picture in large ──
  {
    const E = name('cam1', '2026-10-05T10:00:00.000Z');
    const server = fakeServer({ cam1: [{ filename: E, sizeBytes: 5, seen: true, person: true }, { filename: A, sizeBytes: 5, seen: true }] });
    const { doc, panel, view } = build(server, { prefix: 'cam1', cams: ['cam1'], camLabel: null });
    await view.refresh();
    const thumbs = panel.querySelectorAll('.files-thumb-btn');
    check('only a clip with a person has a picture, and it is a button', thumbs.length === 1 && thumbs[0].tagName === 'BUTTON' && thumbs[0].type === 'button');
    check('…its picture is the clip\'s thumbnail', panel.querySelector('.files-thumb').src === `recordings.php?cam=cam1&thumb=${E}`);
    check('nothing is open before a click', doc.body.querySelector('.files-lightbox') === null);
    thumbs[0].click();
    const box = doc.body.querySelector('.files-lightbox');
    check('a click opens the same picture in large, over the page, with the clip name', !!box && box.querySelector('.files-lightbox-caption').text() === E
      && box.descendants().some((e) => e.tagName === 'IMG' && e.src === `recordings.php?cam=cam1&thumb=${E}`) && box.parent === doc.body);
    thumbs[0].click();
    check('clicking again never stacks a second one', doc.body.querySelectorAll('.files-lightbox').length === 1);
    doc.key('a');
    check('another key leaves it open', !!doc.body.querySelector('.files-lightbox'));
    doc.key('Escape');
    check('Escape closes it and stops listening', doc.body.querySelector('.files-lightbox') === null && (doc.listeners.keydown || []).length === 0);
    thumbs[0].click();
    doc.body.querySelector('.files-lightbox').click();
    check('a click on the picture closes it too', doc.body.querySelector('.files-lightbox') === null && (doc.listeners.keydown || []).length === 0);
    check('looking at a picture changes nothing on the server', server.posts().length === 0);
  }

  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((e) => { console.error('[FAIL] test crashed:', e); process.exitCode = 1; finished = true; });
