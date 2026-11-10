#!/usr/bin/env node
'use strict';
// test_person_scan_e2e.js — end-to-end check of "sort out footage without a person" against a REAL server.js,
// real HTTP and real files, with tests/e2e/fake_person_scan.py standing in for the YOLO detector (the verdict
// is the text inside the fake clip):
//   - switched off (the default): the routes answer 409 and nothing is touched
//   - a clip with a person keeps its place, gets a thumbnail the list reports (person: true) and serves as JPEG
//   - a clip with nobody in it is moved to <camera>/no-person/ and leaves the list (action 'move')
//   - a detector crash keeps the clip and the list says why (scan.error); a retry is possible
//   - a clip checked once is not checked again; "sort out all" only queues the unchecked ones
//   - the list shows "processing" while the detector works; deleting a clip removes its thumbnail
//   - the routes need the dashboard key; unsafe names are refused; a missing clip is 404
//   - the sensitivity (personScanConfidence): config.js sets it, a save from the settings page applies to the next
//     clip with no restart, an invalid one is refused, and the saved value wins over config.js after a restart
//   - with action 'delete' a clip with nobody in it is removed for good
//   - the archive (<camera>/no-person/): GET .../archive counts its clips, DELETE .../archive removes them for
//     good — needs the right key, leaves the listed clips, other files, folders and links alone, and is not
//     mistaken for a clip name
//   - browsing the archive: GET .../archive/files lists its clips, GET .../archive/<clip> serves one (with Range),
//     POST .../archive/<clip>/restore puts it back into the list — never over a recording of the same name,
//     never for a name that is not an archived clip file, and only with the dashboard key
// Needs python3 (skips if missing). Writes a temporary config.js (the real one is restored). Own ports.
// Usage:  node tests/e2e/test_person_scan_e2e.js        Exit code 0 if all passed.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const RECORDINGS_DIR = path.join(RELAY_DIR, 'recordings');
const FAKE = path.join(__dirname, 'fake_person_scan.py');
const PORT = Number(process.env.E2E_SCAN_PORT || 19350);
const PUSH_PORT = PORT + 1;
const CONTROL_KEY = 'e2e-scan-control-key';
const CAM = 'e2e-scan-cam';
const CAM_DIR = path.join(RECORDINGS_DIR, CAM);

let passCount = 0, failCount = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); }
}

const py = spawnSync('python3', ['-V']);
if (py.error) { console.log('python3 not found on PATH — skipping the person-scan end-to-end test'); finished = true; process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scan-'));
const modelFile = path.join(tmp, 'person.onnx');
fs.writeFileSync(modelFile, 'not a real model — the fake detector never reads it');
const savedConfig = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;

function writeConfig(personScan) {
  fs.writeFileSync(CONFIG_PATH, `module.exports = { port: 8080, pushPort: 8081, camKey: 'k', controlKey: '${CONTROL_KEY}', personScan: ${JSON.stringify(personScan)} };\n`);
}
function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: RELAY_DIR, env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), LOG_FILE: path.join(tmp, 'relay.log'), SYSTEM_SETTINGS_FILE: path.join(tmp, 'sys.json'), SETTINGS_FILE: path.join(tmp, 'settings.json') }) });
    let out = '', settled = false;
    const on = (d) => { out += d.toString(); if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve({ child, output: () => out }); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (c) => { if (!settled) { settled = true; reject(new Error(`relay exited early (${c}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready:\n${out}`)); } }, 6000).unref();
  });
}
const stopRelay = (r) => new Promise((resolve) => {
  if (!r || r.child.exitCode !== null) return resolve();
  r.child.once('exit', resolve); r.child.kill('SIGTERM'); setTimeout(() => { r.child.kill('SIGKILL'); resolve(); }, 2000);
});
function request(method, urlPath, { key = CONTROL_KEY } = {}) {
  return new Promise((resolve, reject) => {
    const headers = key ? { 'X-Control-Key': key } : {};
    if (method === 'POST') headers['Content-Length'] = 0;
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); let json = null; try { json = JSON.parse(raw.toString()); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, raw, json }); });
    });
    req.on('error', reject); req.end();
  });
}
const clip = (name, text) => fs.writeFileSync(path.join(CAM_DIR, name), text);
const list = async () => (await request('GET', `/recordings/${CAM}`)).json || [];
const entry = async (name) => (await list()).find((f) => f.filename === name);
const names = async () => (await list()).map((f) => f.filename).sort();
const scan = (name) => request('POST', `/recordings/${CAM}/${name}/scan`);
const exists = (...p) => fs.existsSync(path.join(CAM_DIR, ...p));

const scanConfig = (extra) => ({ enabled: true, auto: false, action: 'move', model: modelFile, python: 'python3', script: FAKE, ...extra });

(async () => {
  let relay = null;
  try {
    fs.rmSync(CAM_DIR, { recursive: true, force: true });
    fs.mkdirSync(CAM_DIR, { recursive: true });

    // ── switched off ──
    writeConfig({});
    relay = await startRelay();
    clip('a_person.mp4', 'PERSON');
    let r = await scan('a_person.mp4');
    check('switched off: sorting out answers 409 and says why', r.status === 409 && /switched off/.test(r.json.error), JSON.stringify(r.json));
    r = await request('POST', `/recordings/${CAM}/scan`);
    check('switched off: sort out all answers 409 too', r.status === 409);
    check('switched off: the clip is untouched', exists('a_person.mp4') && !exists('a_person.mp4.thumb.jpg'));
    await stopRelay(relay);

    // ── switched on, action move (the script path / model are the fake ones) ──
    writeConfig(scanConfig({}));
    relay = await startRelay();
    check('the relay starts with the person check on without complaints', !/\[config\] personScan/.test(relay.output()));
    clip('b_empty.mp4', 'EMPTY'); clip('c_crash.mp4', 'CRASH'); clip('d_slow_person.mp4', 'SLOW PERSON'); clip('e_empty.mp4', 'EMPTY');

    r = await request('POST', `/recordings/${CAM}/a_person.mp4/scan`, { key: null });
    check('the routes need the dashboard key (401 without)', r.status === 401 || r.status === 403, String(r.status));
    check('unsafe names are refused', (await scan('..%2F..%2Fx.mp4')).status === 400 || (await scan('x.txt')).status === 400);
    check('a clip that does not exist is 404', (await scan('nothing.mp4')).status === 404);

    r = await scan('a_person.mp4');
    check('sorting out one clip is accepted (202)', r.status === 202 && r.json.scan === 'queued', JSON.stringify(r.json));
    check('a person clip gets a thumbnail and the list says person: true',
      !!(await waitFor(async () => (await entry('a_person.mp4')) && (await entry('a_person.mp4')).person === true)) && exists('a_person.mp4.thumb.jpg'));
    check('…the thumbnail is served as a JPEG', await (async () => { const t = await request('GET', `/recordings/${CAM}/a_person.mp4/thumbnail`); return t.status === 200 && /image\/jpeg/.test(t.headers['content-type']) && t.raw[0] === 0xff; })());
    check('…the clip stays in the list', (await names()).includes('a_person.mp4'));
    check('a clip without a person has no thumbnail (404)', (await request('GET', `/recordings/${CAM}/b_empty.mp4/thumbnail`)).status === 404);
    r = await scan('a_person.mp4');
    check('a clip already checked is not checked again', r.json.scan === 'done', JSON.stringify(r.json));

    await scan('b_empty.mp4');
    check('a clip with nobody in it is moved to no-person/ and leaves the list',
      !!(await waitFor(async () => exists('no-person', 'b_empty.mp4') && !exists('b_empty.mp4'))) && !(await names()).includes('b_empty.mp4'));

    await scan('c_crash.mp4');
    const failed = await waitFor(async () => { const e = await entry('c_crash.mp4'); return e && e.scan && e.scan.state === 'error' ? e : null; });
    check('a detector crash keeps the clip and the list says why', !!failed && exists('c_crash.mp4') && /boom/.test(failed.scan.reason), JSON.stringify(failed && failed.scan));
    check('…the failure was logged as a warning', /person check of c_crash\.mp4: error/.test(relay.output()));

    // processing is visible, and two requests for the same clip do not run it twice
    await scan('d_slow_person.mp4');
    const second = await scan('d_slow_person.mp4');
    const busy = await waitFor(async () => { const e = await entry('d_slow_person.mp4'); return e && e.scan && e.scan.state === 'processing'; }, 3000);
    check('the list shows "processing" while the detector works', !!busy);
    check('asking again while it works is a duplicate', second.json.scan === 'duplicate', JSON.stringify(second.json));
    check('…and then it finishes with a person', !!(await waitFor(async () => (await entry('d_slow_person.mp4')) && (await entry('d_slow_person.mp4')).person === true, 8000)));

    // sort out all queues only the clips not yet checked (a_person and d_slow_person already have a picture)
    r = await request('POST', `/recordings/${CAM}/scan`);
    check('sort out all queues only the unchecked clips (e_empty and the crashed one)', r.status === 202 && r.json.queued === 2, JSON.stringify(r.json));
    check('…e_empty is moved aside', !!(await waitFor(async () => exists('no-person', 'e_empty.mp4'))));
    await sleep(300);

    // deleting a clip removes its thumbnail
    r = await request('DELETE', `/recordings/${CAM}/a_person.mp4`);
    check('deleting a clip removes its thumbnail too', r.status === 200 && !exists('a_person.mp4') && !exists('a_person.mp4.thumb.jpg'));
    await stopRelay(relay);

    // ── action delete ──
    writeConfig(scanConfig({ action: 'delete' }));
    relay = await startRelay();
    clip('f_empty.mp4', 'EMPTY'); clip('g_crash.mp4', 'CRASH');
    await scan('f_empty.mp4'); await scan('g_crash.mp4');
    check("action 'delete': a clip with nobody in it is removed for good", !!(await waitFor(async () => !exists('f_empty.mp4'))) && !exists('no-person', 'f_empty.mp4'));
    await waitFor(async () => { const e = await entry('g_crash.mp4'); return e && e.scan && e.scan.state === 'error'; });
    check("…but a crashed check never deletes", exists('g_crash.mp4'));
    await stopRelay(relay);

    // ── the sensitivity (personScanConfidence): set in the settings, applied to the next clip, kept over a restart ──
    // The fake detector finds a clip "SCORE:x" to have a person when --confidence is at most x.
    const SYS_FILE = path.join(tmp, 'sys.json');
    const save = (body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const q = nodeHttp.request(`http://127.0.0.1:${PORT}/system-settings`, { method: 'POST', headers: { 'X-Control-Key': CONTROL_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json }); });
      });
      q.on('error', reject); q.end(data);
    });
    writeConfig(scanConfig({ confidence: 0.9 }));
    relay = await startRelay();
    clip('h_score.mp4', 'SCORE:0.5'); await scan('h_score.mp4');
    check('sensitivity from config.js (0.9): a person scored 0.5 is not enough — the clip is sorted out', !!(await waitFor(async () => exists('no-person', 'h_score.mp4'))));
    r = await save({ personScanConfidence: '0.3' });
    check('a new sensitivity is saved without a restart', r.status === 200 && r.json.changed[0] === 'personScanConfidence' && r.json.restartRequired === false, JSON.stringify(r.json));
    clip('i_score.mp4', 'SCORE:0.5'); await scan('i_score.mp4');
    check('...and counts from the next clip on: the same 0.5 now IS a person, the clip stays', !!(await waitFor(async () => (await entry('i_score.mp4') || {}).person === true)) && exists('i_score.mp4'));
    r = await save({ personScanConfidence: '1.5' });
    check('an invalid sensitivity is refused (400) and the running one is kept', r.status === 400 && /personScanConfidence/.test(r.json.error));
    clip('k_score.mp4', 'SCORE:0.2'); await scan('k_score.mp4');
    check('...0.2 is still below 0.3: sorted out', !!(await waitFor(async () => exists('no-person', 'k_score.mp4'))));
    await stopRelay(relay);
    relay = await startRelay();
    clip('j_score.mp4', 'SCORE:0.4'); await scan('j_score.mp4');
    check('after a restart the SAVED sensitivity (0.3) wins over config.js (0.9)', !!(await waitFor(async () => (await entry('j_score.mp4') || {}).person === true)) && !/personScan\./.test(relay.output()), relay.output().slice(-300));
    await stopRelay(relay);
    fs.rmSync(SYS_FILE, { force: true });

    // ── the archive: counted and deleted for good ──
    writeConfig(scanConfig({}));
    relay = await startRelay();
    fs.rmSync(path.join(CAM_DIR, 'no-person'), { recursive: true, force: true });
    const archive = () => request('GET', `/recordings/${CAM}/archive`);
    const wipe = (opts) => request('DELETE', `/recordings/${CAM}/archive`, opts);
    check('no archive folder yet: the archive is empty', (await archive()).json.count === 0);
    fs.mkdirSync(path.join(CAM_DIR, 'no-person', 'folder.mp4'), { recursive: true });
    for (const n of ['arch_1.mp4', 'arch_2.mp4', 'arch_3.mp4']) fs.writeFileSync(path.join(CAM_DIR, 'no-person', n), 'EMPTY');
    fs.writeFileSync(path.join(CAM_DIR, 'no-person', 'notes.txt'), 'mine');
    const outside = path.join(tmp, 'outside.mp4');
    fs.writeFileSync(outside, 'outside the archive');
    fs.symlinkSync(outside, path.join(CAM_DIR, 'no-person', 'link.mp4'));
    clip('listed.mp4', 'PERSON');
    r = await archive();
    check('the archive counts only its plain clip files (3), not folders, links or other files', r.status === 200 && r.json.count === 3, JSON.stringify(r.json));
    check('…and its clips are not in the list of recordings', !(await names()).some((n) => n.startsWith('arch_')));
    // browse, play, restore
    r = await request('GET', `/recordings/${CAM}/archive/files`);
    check('GET archive/files lists the archived clips (names and sizes, no folder, link or other file)',
      r.status === 200 && JSON.stringify(r.json.map((f) => f.filename).sort()) === JSON.stringify(['arch_1.mp4', 'arch_2.mp4', 'arch_3.mp4']) && r.json.every((f) => f.sizeBytes === 5), JSON.stringify(r.json));
    r = await request('GET', `/recordings/${CAM}/archive/files`, { key: null });
    check('listing the archive needs the key', [401, 403].includes(r.status), String(r.status));
    r = await request('GET', `/recordings/${CAM}/archive/arch_1.mp4`);
    check('an archived clip can be downloaded', r.status === 200 && r.raw.toString() === 'EMPTY', `${r.status} ${r.raw}`);
    check('…and read in parts (Range)', await (async () => {
      const part = await new Promise((resolve, reject) => {
        const q = nodeHttp.request(`http://127.0.0.1:${PORT}/recordings/${CAM}/archive/arch_1.mp4`, { headers: { 'X-Control-Key': CONTROL_KEY, Range: 'bytes=0-1' } }, (res) => {
          const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
        });
        q.on('error', reject); q.end();
      });
      return part.status === 206 && part.body === 'EM';
    })());
    r = await request('GET', `/recordings/${CAM}/archive/arch_1.mp4`, { key: null });
    check('downloading an archived clip needs the key', [401, 403].includes(r.status), String(r.status));
    for (const bad of ['nothing.mp4', 'notes.txt', 'link.mp4', 'folder.mp4', '..%2Flisted.mp4', 'x.txt']) {
      const got = await request('GET', `/recordings/${CAM}/archive/${bad}`);
      check(`downloading ${bad} from the archive is refused (404)`, got.status === 404, String(got.status));
      const rest = await request('POST', `/recordings/${CAM}/archive/${bad}/restore`);
      check(`restoring ${bad} is refused (404) and touches nothing`, rest.status === 404 && exists('no-person', 'notes.txt') && exists('no-person', 'link.mp4') && fs.existsSync(outside), String(rest.status));
    }
    r = await request('POST', `/recordings/${CAM}/archive/arch_1.mp4/restore`, { key: null });
    check('restoring needs the dashboard key', [401, 403].includes(r.status) && exists('no-person', 'arch_1.mp4') && !exists('arch_1.mp4'), String(r.status));
    clip('arch_2.mp4', 'a recording with the same name');
    r = await request('POST', `/recordings/${CAM}/archive/arch_2.mp4/restore`);
    check('a recording of the same name is never overwritten (409)', r.status === 409 && fs.readFileSync(path.join(CAM_DIR, 'arch_2.mp4'), 'utf8') === 'a recording with the same name' && exists('no-person', 'arch_2.mp4'), String(r.status));
    fs.rmSync(path.join(CAM_DIR, 'arch_2.mp4'));
    r = await request('POST', `/recordings/${CAM}/archive/arch_1.mp4/restore`);
    check('restoring a clip puts it back (200)', r.status === 200 && r.json.restored === 'arch_1.mp4' && exists('arch_1.mp4') && !exists('no-person', 'arch_1.mp4'), JSON.stringify(r.json));
    check('…it is in the list again and out of the archive', (await names()).includes('arch_1.mp4') && (await archive()).json.count === 2);
    check('…and the restore was logged', /archive of .*: arch_1\.mp4 restored/.test(relay.output()));
    fs.rmSync(path.join(CAM_DIR, 'arch_1.mp4'));

    r = await request('GET', `/recordings/${CAM}/archive`, { key: null });
    check('reading the count needs the key (401/403 without)', [401, 403].includes(r.status), String(r.status));
    r = await wipe({ key: null });
    check('deleting the archive needs the dashboard key (401/403 without)', [401, 403].includes(r.status) && exists('no-person', 'arch_3.mp4'), String(r.status));
    r = await wipe({ key: 'wrong-key' });
    check('…and the right one', [401, 403].includes(r.status) && exists('no-person', 'arch_2.mp4'), String(r.status));
    r = await wipe();
    check('deleting the archive answers with the deleted names', r.status === 200 && JSON.stringify(r.json.deleted) === JSON.stringify(['arch_2.mp4', 'arch_3.mp4']), JSON.stringify(r.json));
    check('…the clips are gone for good', !exists('no-person', 'arch_2.mp4') && !exists('no-person', 'arch_3.mp4'));
    check('…the listed clip, the folder, the link, its target and the other file are untouched',
      exists('listed.mp4') && exists('no-person', 'folder.mp4') && exists('no-person', 'link.mp4') && fs.existsSync(outside) && exists('no-person', 'notes.txt'));
    check('…the archive now counts 0', (await archive()).json.count === 0);
    check('…and the deletion was logged with the count', /archive of .*: 2 recording\(s\) deleted/.test(relay.output()));
    check('deleting an empty archive is fine', (await wipe()).status === 200);
    check('"archive" is not mistaken for a clip name (400/404 for a real clip route stays)', (await request('GET', `/recordings/${CAM}/archive.mp4`)).status === 404);
    r = await request('GET', '/recordings/..%2Fx/archive');
    check('a camera id that leaves the recordings folder is refused', r.status === 400 || r.status === 404, String(r.status));
    await stopRelay(relay);

    // ── model not installed ──
    writeConfig(scanConfig({ model: path.join(tmp, 'missing.onnx') }));
    relay = await startRelay();
    clip('h_empty.mp4', 'EMPTY');
    await scan('h_empty.mp4');
    const noModel = await waitFor(async () => { const e = await entry('h_empty.mp4'); return e && e.scan && e.scan.state === 'error' ? e : null; });
    check('no model installed: the clip stays and the list says the model is missing', !!noModel && /model is not installed/.test(noModel.scan.reason) && exists('h_empty.mp4'));
    await stopRelay(relay);
  } catch (err) {
    check('the test ran to the end', false, err.stack);
  } finally {
    await stopRelay(relay);
    fs.rmSync(CAM_DIR, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedConfig !== null) fs.writeFileSync(CONFIG_PATH, savedConfig); else fs.rmSync(CONFIG_PATH, { force: true });
    finished = true;
    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exitCode = failCount === 0 ? 0 : 1;
  }
})();
