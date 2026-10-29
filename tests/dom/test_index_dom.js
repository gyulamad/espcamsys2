#!/usr/bin/env node
'use strict';
// test_index_dom.js — F-05: nothing that comes from the relay or from config.php may turn into markup
// or script on the dashboard page. Loads the REAL page (served by a real PHP server) into jsdom with
// scripts running, in front of a hostile fake relay, and checks that:
//   - a camera whose id in config.php is an attack string is not on the page at all, and a camera
//     with a hostile NAME shows it as plain text
//   - no inline handler on the page contains a camera id any more (ids travel in data-cam attributes)
//   - hostile recording names from the relay never reach the browser (recordings.php drops them), and
//     — with that filter bypassed on purpose — the page still refuses them (no element, no script)
//   - the error overlay and the RESTORE / RETRY buttons show a hostile message as text
//   - the file list still works: rows, ticking, DELETE SELECTED (n), PLAY inserts a <video>
//   - nothing ran: window.__pwned was never set, and no <script>/<img onerror> came from data
// Needs `php` and the jsdom package (cd tests/dom && npm install); skips if either is missing.
//
// Usage:  node tests/dom/test_index_dom.js
// Exit code: 0 if every check passed (or something needed is missing), 1 otherwise.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_DOM_PORT || 19390);
const RELAY_PORT = PHP_PORT + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const GOOD_FILE = 'cam1-20260101-000000.mp4';
const EVIL_FILES = [
  "x');window.__pwned='file1';('.mp4",
  '"><img src=x onerror="window.__pwned=\'file2\'">.mp4',
  '<script>window.__pwned="file3"</script>.mp4',
  '../../etc/passwd',
];
const EVIL_ID = "a');window.__pwned='id';('";
const EVIL_NAME = '"><img src=x onerror="window.__pwned=\'name\'"><script>window.__pwned="name2"</script>';
const EVIL_MSG = '<img src=x onerror="window.__pwned=\'overlay\'"><b>bold</b>';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny fetch() built on Node's http module, so the test does not depend on the Node version (the
// global fetch only exists from Node 18). Gives back what the page uses of a response: ok, status,
// headers.get(), json(), text(). opts: { method, headers, body }.
function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
        text: () => Promise.resolve(data),
        json: () => Promise.resolve().then(() => JSON.parse(data)),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
// The same, shaped like a ready answer (used where the test hands the page a made-up reply).
const fakeResponse = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: () => Promise.resolve(JSON.stringify(obj)), json: () => Promise.resolve(obj) });
const basic = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');

function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dom-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  const cams = [
    { id: 'cam1', name: 'Front door', icon: '📷' },
    { id: 'cam2', name: EVIL_NAME, icon: '📷' },
    { id: EVIL_ID, name: 'evil id', icon: '📷' },
  ];
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ${'['}'auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'cameras' => json_decode(${JSON.stringify(JSON.stringify(cams))}, true)${']'};\n`);
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = http.get(`${BASE}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error('php -S not ready in 5s'));
    })();
  });
}
function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 1500);
  });
}
// The relay says hostile things everywhere it can.
function startRelay() {
  const hostileList = [
    { filename: GOOD_FILE, sizeBytes: 2048, seen: false },
    ...EVIL_FILES.map((f) => ({ filename: f, sizeBytes: '<img src=x onerror="window.__pwned=\'size\'">', seen: false })),
  ];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (/^\/recordings\/[^/]+$/.test(req.url.split('?')[0]) && req.method === 'GET') res.end(JSON.stringify(hostileList));
      else res.end('{}');
    });
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 16) { console.log(`SKIP: this test needs Node 16 or newer (this is ${process.version}).`); finished = true; return; }
  if (!JSDOM) { console.log('SKIP: the jsdom package is not installed, or does not run on this Node (cd tests/dom && npm install).'); finished = true; return; }
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP: php is not installed.'); finished = true; return; }
  let php; let relay; let dir; let dom;
  try {
    relay = await startRelay();
    dir = makeDashboard();
    php = await startPhp(dir);

    const html = await (await nodeFetch(`${BASE}/index.php`, { headers: { Authorization: basic } })).text();
    check('the page loads', html.includes('<main>'), html.slice(0, 120));
    check('the attack camera id is not in the page source at all', !html.includes('__pwned') || !html.includes(EVIL_ID.slice(0, 6) + "');"), 'source contains the id');

    const rawList = await (await nodeFetch(`${BASE}/recordings.php?cam=cam1`, { headers: { Authorization: basic } })).json();
    check('recordings.php hands the browser only the clean entry, with plain types', JSON.stringify(rawList) === JSON.stringify([{ filename: GOOD_FILE, sizeBytes: 2048, seen: false }]), JSON.stringify(rawList));

    // The browser side: scripts run, fetch goes to the real PHP; raw=true skips PHP's list filter on purpose.
    let bypassFilter = false;
    dom = new JSDOM(html, {
      url: `${BASE}/index.php`, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        window.__pwned = undefined;
        window.confirm = () => false;
        window.alert = () => {};
        window.fetch = (u, opts = {}) => {
          const url = new URL(u, `${BASE}/index.php`).toString();
          if (bypassFilter && /recordings\.php\?cam=[^&]+$/.test(url)) {
            const raw = [{ filename: GOOD_FILE, sizeBytes: 2048, seen: false }, ...EVIL_FILES.map((f) => ({ filename: f, sizeBytes: 1, seen: false })), { filename: 5 }, null];
            return Promise.resolve(fakeResponse(raw));
          }
          return nodeFetch(url, { method: opts.method, body: opts.body, headers: { ...(opts.headers || {}), Authorization: basic } });
        };
      },
    });
    const w = dom.window;
    const d = w.document;
    await sleep(800);

    // ── what config.php can inject ──
    const camIds = Array.from(d.querySelectorAll('.cam-card, [data-cam]')).map((e) => e.dataset.cam).filter(Boolean);
    check('the camera with the attack id is dropped; the good ones are on the page', d.getElementById('img-cam1') && d.getElementById('img-cam2') && !d.querySelector('[id*="__pwned"]') && !camIds.some((c) => c.includes("'")), JSON.stringify(camIds));
    // The name appears as the card's title text and in two alt="" attributes; all three must carry it as plain characters.
    const ownText = (e) => Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
    const titleEl = Array.from(d.querySelectorAll('body *:not(script)')).find((e) => ownText(e).includes('onerror="window.__pwned'));
    check('a hostile camera NAME is shown as plain text in the card title (only the icon span is an element)', !!titleEl && titleEl.children.length === 1 && titleEl.children[0].textContent === '📷', titleEl ? titleEl.outerHTML.slice(0, 200) : 'not found');
    check('...and in the alt text of the picture, without breaking out of the attribute', d.getElementById('img-cam2').getAttribute('alt') === EVIL_NAME, d.getElementById('img-cam2').outerHTML.slice(0, 200));
    const leaks = [];
    for (const el of d.querySelectorAll('*')) {
      if (el.tagName === 'SCRIPT' && el.textContent.includes('__pwned')) leaks.push('<script> ' + el.textContent.slice(0, 40));
      for (const a of Array.from(el.attributes)) if (a.value.includes('__pwned') && a.name !== 'alt') leaks.push(`${el.tagName}[${a.name}]`);
    }
    check('no script, handler or attribute other than alt came out of the hostile name', leaks.length === 0 && d.querySelectorAll('img[src="x"]').length === 0, leaks.join(', '));
    const handlerAttrs = [];
    for (const el of d.querySelectorAll('*')) for (const a of Array.from(el.attributes)) if (a.name.startsWith('on')) handlerAttrs.push(a.value);
    check('no inline handler contains a camera id (ids travel in data-cam)', handlerAttrs.length > 0 && !handlerAttrs.some((v) => /'cam\d'|cam1|cam2/.test(v)), handlerAttrs.filter((v) => /cam\d/.test(v)).join(' | '));
    check('the per-camera buttons carry the id in data-cam', d.querySelector('#rec-btn-cam1').dataset.cam === 'cam1' && d.querySelector('#files-btn-cam2').dataset.cam === 'cam2');

    // ── the overlay and its buttons ──
    w.showOverlay('cam1', '⚠', EVIL_MSG, true);
    const ov = d.getElementById('overlay-cam1');
    check('a hostile overlay message is text: no <img>, no <b>', ov.querySelectorAll('img, b, script').length === 0 && ov.textContent.includes('<img src=x'), ov.innerHTML);
    let reloaded = null;
    w.reloadStream = (id) => { reloaded = id; };
    ov.querySelector('button').click();
    check('RETRY works and passes the id', reloaded === 'cam1', String(reloaded));
    w.toggleHide('cam1');
    const restore = Array.from(d.getElementById('overlay-cam1').querySelectorAll('button')).find((b) => /RESTORE/.test(b.textContent));
    check('hiding a camera shows a RESTORE button', !!restore);
    if (restore) { restore.click(); check('RESTORE brings the feed back', d.getElementById('img-cam1').dataset.hidden !== '1'); }

    // ── the list: through PHP's filter ──
    await w.toggleRecordingsPanel('cam1');
    await sleep(400);
    let panel = d.getElementById('files-cam1');
    let rows = panel.querySelectorAll('.files-row');
    check('PHP dropped every hostile name: only the one real recording is listed', rows.length === 1 && rows[0].querySelector('.files-name').textContent === GOOD_FILE, `rows=${rows.length} ${panel.textContent.slice(0, 200)}`);
    check('the row looks right (unseen, size as text, three action controls)', rows[0].classList.contains('unseen') && /2\.0 KB/.test(rows[0].textContent) && rows[0].querySelectorAll('button, a').length === 3);
    check('...and its header counts it', /1 recording\b/.test(panel.querySelector('.files-panel-header').textContent));

    // ── the list: PHP's filter bypassed on purpose ──
    bypassFilter = true;
    await w.refreshRecordingsList('cam1');
    await sleep(400);
    panel = d.getElementById('files-cam1');
    rows = panel.querySelectorAll('.files-row');
    check('even without PHP\'s filter the page lists only the clean name', rows.length === 1 && rows[0].querySelector('.files-name').textContent === GOOD_FILE, `rows=${rows.length}`);
    check('...and no hostile element exists anywhere in the panel', panel.querySelectorAll('img, script, [onerror]').length === 0 && !panel.innerHTML.includes('onerror'), panel.innerHTML.slice(0, 300));
    bypassFilter = false;
    await w.refreshRecordingsList('cam1');
    await sleep(300);

    // ── the list still works ──
    panel = d.getElementById('files-cam1');
    const box = panel.querySelector('.files-select');
    box.checked = true;
    box.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('ticking a row updates DELETE SELECTED (1)', /DELETE SELECTED \(1\)/.test(d.getElementById('files-del-selected-cam1').textContent) && !d.getElementById('files-del-selected-cam1').disabled);
    panel.querySelector('.files-row .cam-btn').click();   // PLAY
    await sleep(100);
    const video = d.getElementById(`player-cam1-${GOOD_FILE}`).querySelector('video');
    check('PLAY inserts a <video> for that file', !!video && video.getAttribute('src') === `recordings.php?cam=cam1&play=${GOOD_FILE}` && video.hasAttribute('controls'), video && video.outerHTML);
    panel.querySelector('.files-row .cam-btn').click();   // PLAY again = close
    check('PLAY again closes the player', !d.getElementById(`player-cam1-${GOOD_FILE}`).querySelector('video'));
    check('the GET link points at the download', panel.querySelector('a.cam-btn').getAttribute('href') === `recordings.php?cam=cam1&download=${GOOD_FILE}`);

    // ── press every control of the list, the way a user would: injected handlers would run now ──
    for (const el of Array.from(d.getElementById('files-cam1').querySelectorAll('button, a, input'))) {
      if (el.tagName === 'A') el.addEventListener('click', (ev) => ev.preventDefault());
      el.click();
    }
    await sleep(300);

    // ── nothing ran ──
    await sleep(300);
    check('NO script from any hostile data ran (window.__pwned was never set)', w.__pwned === undefined, String(w.__pwned));
    check('the page source has no innerHTML / outerHTML / insertAdjacentHTML left', !/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(fs.readFileSync(path.join(DASH_SRC, 'index.php'), 'utf8')));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    if (dom) dom.window.close();
    await stopProc(php);
    if (relay) relay.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  summarize();
}
main();
