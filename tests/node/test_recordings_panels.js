'use strict';

// Tests how the dashboard (php/cameras/index.php) hangs its per-camera FILES panels on the shared footage
// list (lib/recordings-list.js), by running exactly the block between its <recordings-panels> markers:
// the "📼 FILES (n)" button count, opening a panel loads that camera's list only, the list is drawn
// the live pictures keep running meanwhile (they are one connection, so nothing needs to make room for the
// footage), a closed panel is never drawn, and DELETE ALL in a panel names a single camera.

const fs = require('fs');
const path = require('path');
const { createFakeDocument } = require('./fake_dom');

let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); return; }
  fail += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`);
}

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <recordings-panels>\n([\s\S]*?)\/\/ <\/recordings-panels>/.exec(page);
if (!m) { console.error('[FAIL] index.php has no <recordings-panels> block'); process.exit(1); }
const list = require(path.join(__dirname, '../../php/cameras/lib/recordings-list.js'));

async function main() {
  const doc = createFakeDocument();
  global.document = doc;
  const addEl = (tag, id) => { const e = doc.createElement(tag); e.id = id; doc.body.append(e); return e; };
  const btn = addEl('button', 'files-btn-cam1'); btn.textContent = '📼 FILES (?)';
  const panel1 = addEl('div', 'files-cam1');
  addEl('div', 'files-cam2');

  const requests = [];
  const confirms = [];
  const clip = 'cam1_2026-10-01T10-00-00-000Z.mp4';
  let unreadable = false;
  const fetchFake = async (url, init = {}) => {
    requests.push(`${init.method || 'GET'} ${url}`);
    if (unreadable) return { ok: false, status: 502, json: async () => ({ error: 'x' }) };
    return { ok: true, status: 200, json: async () => [{ filename: clip, sizeBytes: 1, seen: true }] };
  };
  global.fetch = fetchFake;
  global.confirm = (t) => { confirms.push(t); return true; };
  global.alert = () => {};

  const env = {
    CamRecordingsList: list,
    document: doc,
  };
  const api = new Function(...Object.keys(env), `${m[1]}\nreturn { setFilesCount, recordingsListOf, toggleRecordingsPanel, refreshRecordingsList };`)(...Object.values(env));

  // the FILES button
  api.setFilesCount('cam1', 3);
  check('setFilesCount writes the count on the FILES button', btn.textContent === '📼 FILES (3)');
  for (const bad of [-1, 1.5, NaN, '3', null, undefined]) api.setFilesCount('cam1', bad);
  check('anything that is not a whole number leaves the button as it was', btn.textContent === '📼 FILES (3)');
  let threw = false;
  try { api.setFilesCount('nope', 1); } catch (e) { threw = true; }
  check('a camera without a button is ignored', !threw && btn.textContent === '📼 FILES (3)');

  // a closed panel is never drawn
  await api.refreshRecordingsList('cam1');
  check('refreshing a CLOSED panel asks for nothing', requests.length === 0);

  // opening
  await api.toggleRecordingsPanel('cam1');
  check('opening a panel loads that camera\'s list, and only that camera\'s', requests.join() === 'GET recordings.php?cam=cam1,GET recordings.php?cam=cam1&archive=1' || requests.join() === 'GET recordings.php?cam=cam1&archive=1,GET recordings.php?cam=cam1', requests.join(','));
  check('…without closing the live pictures: the list asks nothing of the page but the FILES count', !/withPaused|holdForDownload|playersChanged|LiveViewPaused|PlayerHold/.test(m[1]));
  check('…and draws the clip without a camera name (it is one camera)', panel1.querySelectorAll('.files-name').map((e) => e.text()).join() === clip && panel1.querySelectorAll('.files-cam').length === 0);
  check('…with this camera\'s own button ids', !!doc.getElementById('files-sel-all-cam1') && !!doc.getElementById('files-del-selected-cam1'));
  check('…and updates the FILES button to what the list shows', btn.textContent === '📼 FILES (1)');

  // refresh of an open panel, same list object (ticks etc. survive)
  doc.getElementById('files-sel-all-cam1').click();
  await api.refreshRecordingsList('cam1');
  check('refreshing an open panel redraws it and keeps what was ticked', panel1.querySelectorAll('.files-select:checked').length === 1);
  check('one list object per camera', api.recordingsListOf('cam1') === api.recordingsListOf('cam1') && api.recordingsListOf('cam1') !== api.recordingsListOf('cam2'));

  // the video window
  panel1.querySelectorAll('.files-row')[0].querySelectorAll('.cam-btn')[0].click();   // PLAY
  check('PLAY opens the video window', doc.body.querySelector('.files-video-modal') !== null);
  await api.refreshRecordingsList('cam1');
  check('a redraw of the list leaves the window alone', doc.body.querySelector('.files-video-modal') !== null);
  doc.body.querySelector('.files-video-close').click();
  check('closing the window removes it', doc.body.querySelector('.files-video-modal') === null);

  // a list that could not be read must not change the count
  unreadable = true;
  await api.refreshRecordingsList('cam1');
  check('an unreadable list says so and leaves the FILES count alone', panel1.text() === 'Could not load recordings.' && btn.textContent === '📼 FILES (1)');
  unreadable = false;

  // DELETE ALL of a panel is about this camera only
  await api.refreshRecordingsList('cam1');
  requests.length = 0;
  doc.getElementById('files-delete-all-cam1').dispatch('click');
  await new Promise((r) => setTimeout(r, 5));
  check('DELETE ALL in a camera panel says "this camera" and posts only for it',
    confirms.length === 1 && confirms[0].includes('this camera') && requests.filter((r) => r.startsWith('POST')).join() === 'POST recordings.php?cam=cam1&deleteAll=1', requests.join(','));

  // closing
  await api.toggleRecordingsPanel('cam1');
  check('pressing FILES again closes the panel', !panel1.classes().includes('open'));

  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
main().catch((e) => { console.error('[FAIL] test crashed:', e); finished = true; process.exitCode = 1; });
