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
  const archive = Object.assign({}, options.archive || {});   // camera -> number of archived clips
  const archivedFiles = JSON.parse(JSON.stringify(options.archiveFiles || {}));   // camera -> archived clips (when the test browses them)
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  async function fetch(url, init = {}) {
    const u = new URL(url, 'http://dash/');
    const cam = u.searchParams.get('cam');
    const method = init.method || 'GET';
    requests.push({ method, cam, query: u.search, headers: init.headers || {} });
    if (options.unreadable && options.unreadable.includes(cam)) return reply(502, { error: 'Could not reach relay' });
    if (!clips[cam]) return reply(404, 'Camera not found');
    if (u.searchParams.has('archive')) {
      if (options.archiveUnreadable && options.archiveUnreadable.includes(cam)) return reply(502, { error: 'Could not reach relay' });
      return reply(200, { count: archivedFiles[cam] ? archivedFiles[cam].length : (archive[cam] || 0) });
    }
    if (u.searchParams.has('archiveList')) {
      if (options.archiveListUnreadable && options.archiveListUnreadable.includes(cam)) return reply(502, { error: 'Could not reach relay' });
      return reply(200, archivedFiles[cam] || []);
    }
    const restore = u.searchParams.get('restore');
    if (restore !== null) {
      if (options.failingRestores && options.failingRestores.includes(`${cam}/${restore}`)) return reply(409, { error: 'a recording with this name exists already — nothing was overwritten' });
      const hit = (archivedFiles[cam] || []).find((f) => f.filename === restore);
      if (!hit) return reply(404, {});
      archivedFiles[cam] = archivedFiles[cam].filter((f) => f !== hit);
      clips[cam].push(Object.assign({ seen: false }, hit));
      return reply(200, { restored: restore });
    }
    if (u.searchParams.has('deleteArchive')) {
      if (options.failingArchiveDeletes && options.failingArchiveDeletes.includes(cam)) return reply(500, { error: 'disk said no' });
      archive[cam] = 0;
      return reply(200, { deleted: [] });
    }
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
  return { fetch, requests, clips, archive, posts: () => requests.filter((r) => r.method === 'POST') };
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
// What the archive's own section contains (the fake DOM models only single-class selectors).
const inArchive = (panel, selector) => { const box = panel.querySelector('.files-archive'); return box ? box.querySelectorAll(selector) : []; };

async function main() {
  // ── the all-cameras list ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    check('the list asks recordings.php once per camera for its clips and once for its archive, with GET',
      same(server.requests.map((r) => `${r.method} ${r.cam}${r.query.includes('archive') ? ' archive' : ''}`).sort(),
        ['GET cam1', 'GET cam1 archive', 'GET cam2', 'GET cam2 archive', 'GET cam3', 'GET cam3 archive']));
    check('every camera\'s clips are in the one list, newest first', same(names(panel), [D, B, C, A]), show(names(panel)));
    check('each row names its camera', same(panel.querySelectorAll('.files-cam').map((e) => e.text()), ['🚗 Drive', '🌿 Back', '🚪 Front', '🚪 Front']));
    check('a camera name is also the tooltip of its cell, as the cell cuts a long name short', same(panel.querySelectorAll('.files-cam').map((e) => e.title), ['🚗 Drive', '🌿 Back', '🚪 Front', '🚪 Front']));
    check('each row shows the file size', same(panel.querySelectorAll('.files-size').map((e) => e.text()), ['10 B', '3.0 MB', '2.0 KB', '1.0 KB']));
    check('the header counts the clips', panel.querySelector('.files-panel-header').text().startsWith('4 recordings'));
    check('every row has PLAY, GET, DEL buttons as a camera\'s own panel does',
      rows(panel).every((r) => same(r.querySelectorAll('.cam-btn').map((b) => b.text()), ['▶ PLAY', '⬇ GET', '🗑 DEL'])));
    check('a row\'s three buttons are in ONE actions box, last in the row, so the stylesheet can float them right as a group',
      rows(panel).every((r) => {
        const boxes = r.querySelectorAll('.files-actions');
        return boxes.length === 1 && boxes[0].querySelectorAll('.cam-btn').length === 3 && r.querySelectorAll('.cam-btn').length === 3;
      }));
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

  // ── the archive (what the person check sorted out) ──
  {
    const btnOf = (doc) => byId(doc, 'files-delete-archive-all');
    const header = (panel) => panel.querySelector('.files-panel-header');

    const none = build(fakeServer(fleet()));
    await none.view.refresh();
    check('an empty archive: no DELETE ARCHIVE button', btnOf(none.doc) === null);

    const server = fakeServer(fleet(), { archive: { cam1: 3, cam2: 0, cam3: 4 } });
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    const btn = btnOf(doc);
    check('the button shows how many clips are archived, over every camera of the list', !!btn && btn.text() === '🗄 DELETE ARCHIVE (7)', btn && btn.text());
    check('…next to SORT OUT ALL (and BROWSE ARCHIVE), before DELETE ALL', same(header(panel).querySelectorAll('.cam-btn').map((b) => b.text()), ['🧑 SORT OUT ALL', '📂 BROWSE ARCHIVE', '🗄 DELETE ARCHIVE (7)', '🗑 DELETE ALL']));
    check('…its hover text says how to check the archive first', btn.title.includes('no-person') && btn.title.includes('INSTALL.md') && btn.title.includes('cannot be undone'));
    check('…and is a danger button', btn.classes().includes('danger'));

    const posts = () => server.posts().map((r) => `${r.cam} ${r.query}`);
    {
      const a = build(fakeServer(fleet(), { archive: { cam1: 2 } }));
      await a.view.refresh();
      a.answers.confirm = false;
      btnOf(a.doc).click();
      await new Promise((r) => setTimeout(r, 5));
      check('answering no to the question deletes nothing', a.events.confirms.length === 1 && a.events.confirms[0].includes('2 archived recordings') && a.events.confirms[0].includes('cannot be undone'));
    }

    btn.click();
    await new Promise((r) => setTimeout(r, 5));
    check('yes: every camera gets its own deleteArchive POST, with the anti-forgery header',
      same(posts().sort(), ['cam1 ?cam=cam1&deleteArchive=1', 'cam2 ?cam=cam2&deleteArchive=1', 'cam3 ?cam=cam3&deleteArchive=1'])
      && server.posts().every((r) => r.headers['X-Requested-With'] === 'camdash'), show(posts()));
    check('…the question named the number', events.confirms[events.confirms.length - 1].includes('7 archived recordings'));
    check('…the list reloads and the button is gone', btnOf(doc) === null && server.archive.cam1 === 0 && server.archive.cam3 === 0);
    check('…the clips themselves are untouched', same(names(panel), [D, B, C, A]));
  }
  {
    // one archive delete fails: the others go, the user is told
    const server = fakeServer(fleet(), { archive: { cam1: 1, cam2: 1 }, failingArchiveDeletes: ['cam2'] });
    const { doc, view, events } = build(server);
    await view.refresh();
    byId(doc, 'files-delete-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    check('a failing archive delete is reported with its reason and how many failed', events.alerts.length === 1 && events.alerts[0].includes('Could not delete the archive') && events.alerts[0].includes('(1 of 3)') && events.alerts[0].includes('disk said no'), show(events.alerts));
    check('…the camera that worked is emptied, the one that failed still shows its clips', server.archive.cam1 === 0 && server.archive.cam2 === 1 && byId(doc, 'files-delete-archive-all').text() === '🗄 DELETE ARCHIVE (1)');
  }
  {
    // everything was sorted out: no clips left, the archive can still be deleted
    const server = fakeServer({ cam1: [], cam2: [], cam3: [] }, { archive: { cam1: 5 } });
    const { doc, panel, view } = build(server);
    await view.refresh();
    check('no clips but an archive: the button is there, SORT OUT ALL and DELETE ALL are not',
      same(panel.querySelectorAll('.cam-btn').map((b) => b.text()), ['📂 BROWSE ARCHIVE', '🗄 DELETE ARCHIVE (5)']) && panel.text().includes('No recordings yet.'), show(panel.querySelectorAll('.cam-btn').map((b) => b.text())));
    byId(doc, 'files-delete-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    check('…and deleting it leaves the plain "No recordings yet."', panel.text() === 'No recordings yet.' && panel.querySelectorAll('.cam-btn').length === 0);
  }
  {
    // an archive that cannot be read must not break the list
    const server = fakeServer(fleet(), { archive: { cam1: 2 }, archiveUnreadable: ['cam2'] });
    const { doc, panel, view } = build(server);
    await view.refresh();
    check('an unreadable archive counts as 0 and the list still loads', same(names(panel), [D, B, C, A]) && byId(doc, 'files-delete-archive-all').text() === '🗄 DELETE ARCHIVE (2)');
    const junk = build({ fetch: async (url) => (String(url).includes('archive=1')
      ? { ok: true, status: 200, json: async () => ({ count: '<img src=x>' }) }
      : { ok: true, status: 200, json: async () => [{ filename: A, sizeBytes: 1, seen: true }] }) }, { cams: ['cam1'], camLabel: null });
    await junk.view.refresh();
    check('a count that is not a whole number shows no button', byId(junk.doc, 'files-delete-archive-all') === null && names(junk.panel).length === 1);
  }

  // ── browsing and restoring the archive ──
  {
    const X1 = name('cam1', '2026-09-01T10:00:00.000Z');
    const X2 = name('cam3', '2026-09-03T10:00:00.000Z');
    const X3 = name('cam1', '2026-09-02T10:00:00.000Z');
    const archived = () => ({ cam1: [{ filename: X1, sizeBytes: 2048 }, { filename: X3, sizeBytes: 5 }], cam3: [{ filename: X2, sizeBytes: 3 * 1024 * 1024 }] });
    const browseBtn = (doc) => byId(doc, 'files-browse-archive-all');
    const archiveNames = (panel) => inArchive(panel, '.files-name').map((e) => e.text());
    const listNames = (panel) => names(panel).filter((n) => !archiveNames(panel).includes(n));   // the normal list only

    const server = fakeServer(fleet(), { archiveFiles: archived() });
    const { doc, panel, view, events, answers } = build(server);
    await view.refresh();
    check('the archive is not listed (nor even asked for) until BROWSE ARCHIVE is pressed', panel.querySelector('.files-archive') === null && !server.requests.some((r) => r.query.includes('archiveList')));

    browseBtn(doc).click();
    await new Promise((r) => setTimeout(r, 5));
    check('BROWSE ARCHIVE lists the archived clips of every camera, newest first, under the header', same(archiveNames(panel), [X2, X3, X1]), show(archiveNames(panel)));
    check('…asking each camera once with GET archiveList', same(server.requests.filter((r) => r.query.includes('archiveList')).map((r) => `${r.method} ${r.cam}`).sort(), ['GET cam1', 'GET cam2', 'GET cam3']));
    check('…each archived row names its camera and shows its size', same(inArchive(panel, '.files-cam').map((e) => e.text()), ['🚗 Drive', '🚪 Front', '🚪 Front']) && same(inArchive(panel, '.files-size').map((e) => e.text()), ['3.0 MB', '5 B', '2.0 KB']));
    check('…each archived row can be played, downloaded and restored — and not deleted one by one',
      inArchive(panel, '.files-row').every((r) => same(r.querySelectorAll('.cam-btn').map((b) => b.text()), ['▶ PLAY', '⬇ GET', '♻ RESTORE'])));
    check('…and their buttons are in an actions box too, laid out like the list\'s own',
      inArchive(panel, '.files-row').every((r) => r.querySelectorAll('.files-actions').length === 1 && r.querySelectorAll('.files-actions')[0].querySelectorAll('.cam-btn').length === 3));
    check('…the title says how many', panel.querySelector('.files-archive-title').text() === 'Archive: 3 recordings that the person check sorted out');
    check('…the normal list is still there and the button now hides the archive', same(listNames(panel), [D, B, C, A]) && browseBtn(doc).text() === '📂 HIDE ARCHIVE');
    check('…GET points at archiveDownload (never at the recordings)', panel.querySelector('.files-archive').descendants().filter((e) => e.tagName === 'A').every((a) => a.href.includes('archiveDownload=') && !a.href.includes('&download=')));

    // playing
    const play = inArchive(panel, '.files-row')[0].querySelectorAll('.cam-btn')[0];
    play.click();
    const archiveModal = () => doc.body.querySelector('.files-video-modal');
    const archiveVideo = archiveModal() && archiveModal().descendants().find((e) => e.tagName === 'VIDEO');
    check('PLAY opens the video window on the archive URL', !!archiveVideo && archiveVideo.src === `recordings.php?cam=cam3&archivePlay=${encodeURIComponent(X2)}`, archiveVideo && archiveVideo.src);
    check('…and changes nothing on the server', server.posts().length === 0);
    archiveModal().querySelector('.files-video-close').click();
    check('…CLOSE closes the window', archiveModal() === null);

    // restoring
    const restoreBtn = inArchive(panel, '.files-row')[0].querySelectorAll('.cam-btn')[2];
    answers.confirm = false;
    restoreBtn.click();
    await new Promise((r) => setTimeout(r, 5));
    check('answering no to RESTORE restores nothing', server.posts().length === 0 && events.confirms[events.confirms.length - 1] === `Restore ${X2} to the recordings?`);
    answers.confirm = true;
    restoreBtn.click();
    await new Promise((r) => setTimeout(r, 5));
    check('RESTORE posts restore for that camera and clip, with the anti-forgery header',
      same(server.posts().map((r) => `${r.cam} ${r.query}`), [`cam3 ?cam=cam3&restore=${encodeURIComponent(X2)}`]) && server.posts()[0].headers['X-Requested-With'] === 'camdash', show(server.posts()));
    check('…the clip is back in the list and out of the archive, and the archive stays open', listNames(panel).includes(X2) && same(archiveNames(panel), [X3, X1]), show([listNames(panel), archiveNames(panel)]));
    check('…the delete button count follows', byId(doc, 'files-delete-archive-all').text() === '🗄 DELETE ARCHIVE (2)');
  }
  {
    // a restore the relay refuses is reported, nothing else changes
    const X = name('cam1', '2026-09-01T10:00:00.000Z');
    const server = fakeServer(fleet(), { archiveFiles: { cam1: [{ filename: X, sizeBytes: 1 }] }, failingRestores: [`cam1/${X}`] });
    const { doc, panel, view, events } = build(server);
    await view.refresh();
    byId(doc, 'files-browse-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    inArchive(panel, '.files-row')[0].querySelectorAll('.cam-btn')[2].click();
    await new Promise((r) => setTimeout(r, 5));
    check('a refused restore says why (nothing overwritten) and the clip stays in the archive', events.alerts.length === 1 && events.alerts[0].includes('Could not restore the recording') && events.alerts[0].includes('nothing was overwritten')
      && inArchive(panel, '.files-name').length === 1);
  }
  {
    // the last archived clip restored: the archive section and its buttons go away
    const X = name('cam1', '2026-09-01T10:00:00.000Z');
    const server = fakeServer(fleet(), { archiveFiles: { cam1: [{ filename: X, sizeBytes: 1 }] } });
    const { doc, panel, view } = build(server);
    await view.refresh();
    byId(doc, 'files-browse-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    inArchive(panel, '.files-row')[0].querySelectorAll('.cam-btn')[2].click();
    await new Promise((r) => setTimeout(r, 5));
    check('restoring the last archived clip closes the archive and removes its buttons', panel.querySelector('.files-archive') === null && byId(doc, 'files-browse-archive-all') === null && byId(doc, 'files-delete-archive-all') === null && names(panel).includes(X));
  }
  {
    // an archive that cannot be listed, hostile names
    const X = name('cam1', '2026-09-01T10:00:00.000Z');
    const evil = ["x');window.__pwned=1;('.mp4", '"><img src=x onerror=alert(1)>.mp4', '../../etc/passwd'];
    const server = fakeServer(fleet(), { archive: { cam1: 1, cam2: 1 }, archiveFiles: { cam1: [...evil.map((filename) => ({ filename, sizeBytes: 1 })), { filename: X, sizeBytes: 1 }] }, archiveListUnreadable: ['cam2'] });
    const { doc, panel, view } = build(server);
    await view.refresh();
    byId(doc, 'files-browse-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    check('archived names that are not plain recording names never become a row or an id', same(inArchive(panel, '.files-name').map((e) => e.text()), [X])
      && !panel.descendants().some((e) => evil.some((n) => e.id.includes(n) || (e.href || '').includes(n) || e.text().includes(n))));
    check('an archive that cannot be listed for one camera says so and still shows the others', panel.text().includes('Could not load the archive of: 🌿 Back') && inArchive(panel, '.files-row').length === 1);
    byId(doc, 'files-browse-archive-all').click();
    await new Promise((r) => setTimeout(r, 5));
    check('HIDE ARCHIVE closes it again', panel.querySelector('.files-archive') === null && byId(doc, 'files-browse-archive-all').text() === '📂 BROWSE ARCHIVE');
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
    const modalOf = () => doc.body.querySelector('.files-video-modal');
    const videoOf = (m) => m.descendants().find((e) => e.tagName === 'VIDEO');
    const row = byId(doc, `row-cam2-${B}`);
    check('B starts unseen', row.classes().includes('unseen'));
    check('the rows have no player squeezed in under them, and no window is open before a click', byId(doc, `player-cam2-${B}`) === null && modalOf() === null);
    row.querySelectorAll('.cam-btn')[0].click();   // PLAY
    const modal = modalOf();
    check('PLAY opens the clip in a modal window over the page (not inside the list)', !!modal && modal.parent === doc.body && !panel.descendants().includes(modal));
    check('the window is a dialog named after the clip, with the clip name as its title', modal.role === 'dialog' && modal.ariaModal === 'true' && modal.ariaLabel === B && modal.querySelector('.files-video-title').text() === B);
    const video = videoOf(modal);
    check('it holds a <video> for that camera and clip with controls, autoplay and inline playback (phones)', video.src === `recordings.php?cam=cam2&play=${B}` && video.controls === true && video.autoplay === true && video.playsInline === true);
    check('the page behind is locked from scrolling while it is open', doc.body.classes().includes('files-modal-open'));
    check('PLAY marks the clip seen at once', !row.classes().includes('unseen') && row.querySelector('.files-select').dataset.seen === '1');
    check('PLAY tells recordings.php (POST seen, with the anti-forgery header, for that camera)',
      server.posts().some((r) => r.cam === 'cam2' && r.query === `?cam=cam2&seen=${B}` && r.headers['X-Requested-With'] === 'camdash'));
    check('the page is told the window opened', events.players > 0);

    // every other clip behaves the same way: the same large window, never a small inline player
    byId(doc, `row-cam1-${A}`).querySelectorAll('.cam-btn')[0].click();
    check('another clip\'s PLAY replaces the window with its own (never a second one, never a small player)', doc.body.querySelectorAll('.files-video-modal').length === 1 && videoOf(modalOf()).src === `recordings.php?cam=cam1&play=${A}` && modalOf().querySelector('.files-video-title').text() === A);
    check('…and does not change anything on the server for an already seen clip beyond marking it', server.posts().filter((r) => r.query.includes(`seen=${A}`)).length === 1);

    videoOf(modalOf()).click();
    check('a tap on the video (play / pause) leaves the window open', modalOf() !== null);
    const before = events.players;
    await view.refresh();
    check('the list reloading underneath leaves the window alone', modalOf() !== null && videoOf(modalOf()).src === `recordings.php?cam=cam1&play=${A}`);

    const closeBtn = modalOf().querySelector('.files-video-close');
    check('CLOSE is a real labelled button (its size is the stylesheet\'s: 44px, tested in test_layout.php)', closeBtn.tagName === 'BUTTON' && closeBtn.type === 'button' && closeBtn.text() === '✕ CLOSE' && closeBtn.ariaLabel === `Close the video ${A}`);
    closeBtn.click();
    check('CLOSE removes the window (which stops the video), unlocks the page, stops listening for keys and tells the page', modalOf() === null && !doc.body.classes().includes('files-modal-open') && (doc.listeners.keydown || []).length === 0 && events.players > before);

    row.querySelectorAll('.cam-btn')[0].click();
    check('PLAY again opens it again', modalOf() !== null);
    check('another key leaves it open', (doc.key('a'), modalOf() !== null));
    doc.key('Escape');
    check('Escape closes it', modalOf() === null && !doc.body.classes().includes('files-modal-open') && (doc.listeners.keydown || []).length === 0);
    row.querySelectorAll('.cam-btn')[0].click();
    modalOf().click();
    check('a tap beside the video (on the backdrop) closes it too', modalOf() === null && (doc.listeners.keydown || []).length === 0);

    const get = row.querySelectorAll('.cam-btn')[1];
    check('GET is a download link for that camera and clip', get.tagName === 'A' && get.href === `recordings.php?cam=cam2&download=${B}`);
    get.click();
    check('GET asks the page to make room for the download', events.downloads === 1);
  }

  // ── opened from a link: playClip (the person notification) ──
  {
    const server = fakeServer(fleet());
    const { doc, panel, view } = build(server);
    await view.refresh();
    const modalOf = () => doc.body.querySelector('.files-video-modal');
    const row = byId(doc, `row-cam2-${B}`);
    let scrolled = null;
    row.scrollIntoView = (o) => { scrolled = o; };
    check('playClip finds the clip', view.playClip('cam2', B) === true);
    const video = modalOf().descendants().find((e) => e.tagName === 'VIDEO');
    check('playClip opens the clip in the same modal window as the PLAY button', !!modalOf() && video.src === `recordings.php?cam=cam2&play=${B}` && modalOf().parent === doc.body);
    check('playClip marks the clip seen, like PLAY', !row.classes().includes('unseen') && server.posts().some((r) => r.query === `?cam=cam2&seen=${B}`));
    check('playClip scrolls the row to the top, behind the window', same(scrolled, { block: 'start' }));
    check('the rest of the list is still there, every other clip behind the window', rows(panel).length === Object.values(fleet()).flat().length && rows(panel).length > 1);
    const posts = server.posts().length;
    check('playClip again does not restart the clip or report it seen twice', view.playClip('cam2', B) === true && doc.body.querySelectorAll('.files-video-modal').length === 1 && server.posts().length === posts);
    modalOf().querySelector('.files-video-close').click();
    check('closing it leaves the list as it was', modalOf() === null && rows(panel).length > 1);
    check('a clip that is not in the list: false, nothing opened, nothing sent', view.playClip('cam2', 'cam2_1999-01-01T00-00-00-000Z.mp4') === false && view.playClip('nocam', B) === false && modalOf() === null && server.posts().length === posts);
    check('a row without scrollIntoView (an old browser) still plays', (() => { const r2 = byId(doc, `row-cam1-${A}`); r2.scrollIntoView = undefined; return view.playClip('cam1', A) === true && modalOf() !== null; })());
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
