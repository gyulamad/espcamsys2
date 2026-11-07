#!/usr/bin/env node
'use strict';
// test_all_recordings_e2e.js — end-to-end check of the ALL FILES page (php/cameras/all-recordings.php) with a
// REAL PHP dashboard (php -S) in front of a fake relay that holds some footage:
//   - the page needs the login, and is served with the list script (lib/recordings-list.js) and the file-name
//     rule inside it — and that script file itself is never served on its own
//   - the cameras are handed to the page as data: a hostile camera name cannot end the script or become markup
//   - the page's data source is the per-camera recordings.php list (one request per camera), unchanged: every
//     camera answers its own list, and a camera that is not configured is refused
//   - the page's DELETE goes through recordings.php too: it is refused without the dashboard header, and with
//     it reaches the relay for that camera and file only
//   - the dashboard's navigation bar has the ALL FILES link to the page
//
// Needs `php` on PATH (skips if not). Own ports, throwaway folders. Core modules only.
// Usage:  node tests/e2e/test_all_recordings_e2e.js     Exit code 0 if all passed (or php is missing).

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_ALLREC_PORT || 19440);
const PHP_PORT = BASE, RELAY_PORT = BASE + 1;
const AUTH = 'Basic ' + Buffer.from('dash-user:dash-pass-0001').toString('base64');
const EVIL_NAME = '</script><img src=x onerror="window.__pwned=1">';

let passCount = 0, failCount = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (spawnSync('php', ['-v']).error) { console.log('php not found on PATH — skipping the all-recordings end-to-end test'); finished = true; process.exit(0); }

function request(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (method === 'POST') h['Content-Length'] = 0;
    const req = nodeHttp.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers: h }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}
async function waitUp(port, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); r(true); }); q.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}
const dash = (method, p, { auth = true, ajax = false } = {}) =>
  request(PHP_PORT, method, `/${p}`, Object.assign(auth ? { Authorization: AUTH } : {}, ajax ? { 'X-Requested-With': 'camdash' } : {}));

// A fake relay: /recordings/:cam lists, DELETE /recordings/:cam/:file deletes. Remembers what it was asked.
function startFakeRelay(clips) {
  const asked = [];
  const server = nodeHttp.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const m = /^\/recordings\/([^/]+)(?:\/([^/]+))?$/.exec(req.url);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!m || !clips[m[1]]) return send(404, { error: 'no such camera' });
    if (req.method === 'GET' && !m[2]) return send(200, clips[m[1]]);
    if (req.method === 'DELETE' && m[2]) { clips[m[1]] = clips[m[1]].filter((f) => f.filename !== m[2]); return send(200, { ok: true }); }
    return send(405, { error: 'unexpected' });
  });
  return new Promise((resolve) => server.listen(RELAY_PORT, '127.0.0.1', () => resolve({ server, asked })));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-allrec-'));
  let php = null, relay = null;
  try {
    const A = 'cam-a_2026-10-01T10-00-00-000Z.mp4', B = 'cam-b_2026-10-02T10-00-00-000Z.mp4';
    relay = await startFakeRelay({ 'cam-a': [{ filename: A, sizeBytes: 10, seen: true }], 'cam-b': [{ filename: B, sizeBytes: 20, seen: false }] });

    const dashDir = path.join(tmp, 'dash');
    fs.mkdirSync(dashDir);
    spawnSync('cp', ['-r', DASH_SRC + '/.', dashDir]);
    fs.writeFileSync(path.join(dashDir, 'config.php'),
      `<?php return ['auth_user' => 'dash-user', 'auth_pass' => 'dash-pass-0001', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => 'e2e-control-key-0001', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪'], ['id' => 'cam-b', 'name' => ${JSON.stringify(EVIL_NAME).replace(/\$/g, '\\$')}, 'icon' => '🌿']]];\n`);
    php = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dashDir], { stdio: 'ignore' });
    check('the dashboard starts', await waitUp(PHP_PORT));

    // the page
    check('the page needs the login', (await dash('GET', 'all-recordings.php', { auth: false })).status === 401);
    const page = await dash('GET', 'all-recordings.php');
    check('the page loads', page.status === 200, String(page.status));
    check('the page carries the footage list script and the file-name rule', page.text.includes('CamRecordingsList') && page.text.includes('CamRecordingsList.SAFE_FILENAME = new RegExp('));
    check('the page has its list panel and the navigation bar with the way back to the dashboard', page.text.includes('id="files-all"') && page.text.includes('href="./?layout=grid"'));
    check('both cameras are handed to the page', page.text.includes('"cam-a"') && page.text.includes('"cam-b"') && page.text.includes('Front door'));
    check('a hostile camera name cannot end the script or become markup', !page.text.includes(EVIL_NAME) && !page.text.includes('<img src=x'), 'the raw name is on the page');
    check('the page opens on a clip given in the address (?cam=&play=) in its list, validated by the shared code', page.text.includes('CamRecordingsList.parsePlayRequest(location.search, Object.keys(CAMERA_LABELS))') && page.text.includes('list.playClip(wanted.cam, wanted.filename)') && page.text.includes('.files-video-modal video'));
    const linked = await dash('GET', 'all-recordings.php?cam=cam-a&play=cam-a_2026-11-06T14-05-09-000Z.mp4');
    check('a link with a clip still serves the whole page (list, navigation bar), not a bare video', linked.status === 200 && linked.text.includes('id="files-all"') && linked.text.includes('data-nav="all-files"'));
    check('the lib/ folder is not asked for by the page (its script is inlined)', !/src="lib\//.test(page.text));
    check('the page has a LOG OUT button (in the navigation bar, once)', (page.text.match(/<nav class="site-nav"[\s\S]*action="logout\.php"[\s\S]*<\/nav>/g) || []).length === 1 && (page.text.match(/action="logout\.php"/g) || []).length === 1);
    check('the page is marked as the current one in the bar, and offers DELETE ALL itself (the dashboard has no such button any more)', page.text.includes('data-nav="all-files" aria-current="page"') && page.text.includes('deleteAllConfirm:'));

    // the dashboard links to it
    const home = await dash('GET', 'index.php');
    check('the dashboard\'s navigation bar has the ALL FILES link (and no second one in the header)', home.status === 200 && home.text.includes('data-nav="all-files"') && home.text.includes('href="all-recordings.php"') && !home.text.includes('id="btn-all-files"'));
    check('…and the dashboard still carries the same list script (one copy, shared)', home.text.includes('CamRecordingsList.SAFE_FILENAME = new RegExp('));

    // what the page reads: each camera's own list through recordings.php
    const la = await dash('GET', 'recordings.php?cam=cam-a');
    const lb = await dash('GET', 'recordings.php?cam=cam-b');
    check('each camera answers its own list', la.status === 200 && lb.status === 200 && la.json[0].filename === A && lb.json[0].filename === B && la.json.length === 1 && lb.json.length === 1, JSON.stringify([la.json, lb.json]));
    check('a camera that is not configured is refused', (await dash('GET', 'recordings.php?cam=cam-zzz')).status === 404);
    check('the list needs the login', (await dash('GET', 'recordings.php?cam=cam-a', { auth: false })).status === 401);

    // what the page changes
    relay.asked.length = 0;
    const noHeader = await dash('POST', `recordings.php?cam=cam-a&delete=${A}`);
    check('a delete without the dashboard header is refused and never reaches the relay', noHeader.status >= 400 && !relay.asked.some((a) => a.startsWith('DELETE')), String(noHeader.status));
    const del = await dash('POST', `recordings.php?cam=cam-a&delete=${A}`, { ajax: true });
    check('a delete with it reaches the relay for that camera and file only', del.status === 200 && relay.asked.filter((a) => a.startsWith('DELETE')).join() === `DELETE /recordings/cam-a/${A}`, `${del.status} ${relay.asked.join(' | ')}`);
    check('…and that clip is gone from that camera\'s list, the other camera is untouched',
      (await dash('GET', 'recordings.php?cam=cam-a')).json.length === 0 && (await dash('GET', 'recordings.php?cam=cam-b')).json.length === 1);
  } finally {
    if (php) php.kill();
    if (relay) relay.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
main().catch((e) => { console.error('[FAIL] test crashed:', e); finished = true; process.exitCode = 1; });
