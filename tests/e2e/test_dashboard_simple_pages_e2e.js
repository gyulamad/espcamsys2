#!/usr/bin/env node
'use strict';
// test_dashboard_simple_pages_e2e.js — the two simple camera pages (simple-list.php, simple-view.php) and
// the dashboard buttons that lead to them, against a REAL PHP server (php -S) with a generated config.php.
// Checks that:
//   - every page behind the login has the navigation bar (dashboard, simple view, simple list), and both simple pages
//     need the dashboard login
//   - the list shows every camera as a thumbnail (a picture without a source: the one mux.php connection paints it,
//     js/mux-pictures.js) that links to its large view, with the
//     safe headers, the scripts and the logic file it needs, and nothing of the relay's address
//   - the dashboard's pictures are links to their camera's large view (no full-screen click there any more);
//     the large view's picture goes full screen on a click (its box and the helper script are on the page)
//   - the large view shows the camera asked for (default: the first), carries the camera list and the
//     slideshow time (the slideshow_seconds setting, or the default when it is unusable) for its script
//   - an unknown camera is 404, an array / traversal id is refused, and no cameras at all is a plain notice
//   - a hostile camera name from config.php stays text on both pages
//   - the scripts are served, and the logic file is the one the unit tests run
//   - the slideshow time saved on the dashboard (data/settings.json) beats config.php
// Needs `php` on PATH (skips if missing). Own port, throwaway dashboard copy, core modules only.
//
// Usage:  node tests/e2e/test_dashboard_simple_pages_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const PHP_PORT = Number(process.env.E2E_SIMPLE_PORT || 19470);
const AUTH = { user: 'e2e-user', pass: 'e2e-pass' };
const HOST = `127.0.0.1:${PHP_PORT}`;
const EVIL_NAME = '"><script>window.__pwned=1</script>';

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

// A throwaway copy of the dashboard with its own config.php. `extra` is PHP array text added to the config.
function makeDashboard(cameras, extra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-simple-'));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${PHP_PORT + 1}', 'relay_control_key' => '', ${extra} 'cameras' => ${cameras}];\n`);
  return dir;
}

let phpLog = '';
function startPhp(docroot) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', HOST, '-t', docroot], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { phpLog += d.toString(); });
    child.stderr.on('data', (d) => { phpLog += d.toString(); });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code}): ${phpLog}`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://${HOST}/`, () => r(true)); q.on('error', () => r(false)); });
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

function get(p, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: HOST };
    if (auth) h.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
    const r = nodeHttp.request(`http://${HOST}/${p}`, { method: 'GET', headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('request timed out')));
    r.end();
  });
}

const safe = (r) => r.headers['x-content-type-options'] === 'nosniff' && r.headers['referrer-policy'] === 'no-referrer'
  && r.headers['content-security-policy'] === "frame-ancestors 'none'" && r.headers['x-frame-options'] === 'DENY'
  && r.headers['cache-control'] === 'no-store';
const detail = (r) => JSON.stringify({ s: r.status, h: r.headers, t: r.text.slice(0, 200) });
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// the data-* attributes of the large view's root element
function viewData(html) {
  const m = html.match(/id="view" data-cameras="([^"]*)" data-current="([^"]*)" data-slideshow-seconds="([^"]*)"/);
  return m ? { cameras: JSON.parse(decodeAttr(m[1])), current: decodeAttr(m[2]), seconds: m[3] } : null;
}

const CAMS = "[['id' => 'cam-a', 'name' => 'Cam A', 'icon' => '🚪'], ['id' => 'cam-b', 'name' => 'Cam B', 'icon' => '🚗'], ['id' => 'cam-c', 'name' => 'Cam C', 'icon' => '📷']]";

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  const dirs = [];
  let php;
  const serve = async (cameras, extra) => {
    await stopProc(php);
    const dir = makeDashboard(cameras, extra);
    dirs.push(dir);
    php = await startPhp(dir);
    return dir;
  };
  try {
    await serve(CAMS, "'slideshow_seconds' => 25,");

    // ── the way in: the dashboard's buttons, and the login ──────────
    let r = await get('index.php');
    const navLink = (href, label) => `<a class="nav-link[^"]*" href="${href}"[^>]*>[^<]*${label}</a>`;
    const NAV_LINKS = new RegExp('<nav class="site-nav" aria-label="Pages">' + [
      navLink('\\./\\?layout=grid', 'DASHBOARD GRID'), navLink('\\./\\?layout=list', 'DASHBOARD LIST'), navLink('simple-view\\.php', 'SIMPLE VIEW'),
      navLink('simple-list\\.php', 'SIMPLE LIST'), navLink('all-recordings\\.php', 'ALL FILES'),
    ].join('') + '<form class="logout-form" method="post" action="logout\\.php" data-page-load="Logging out…"><button class="nav-link nav-logout" type="submit"[^>]*>[^<]*LOG OUT</button></form></nav>');
    check('the dashboard has the navigation bar (dashboard grid / list, simple view, simple list, all files, LOG OUT at its right end) as the first thing in its body, the grid marked, and no copy of those buttons in its header',
      r.status === 200 && /<body>\s*<nav class="site-nav"/.test(r.text) && NAV_LINKS.test(r.text) && r.text.includes('class="nav-link current" href="./?layout=grid" data-nav="dashboard-grid" data-page-load aria-current="page"')
      && (r.text.match(/aria-current/g) || []).length === 1 && r.text.includes('.site-nav { position: sticky; top: 0;')
      && !r.text.includes('id="btn-simple-list"') && !r.text.includes('id="btn-simple-view"') && !r.text.includes('id="btn-grid"') && !r.text.includes('id="btn-list"')
      && !r.text.includes('id="btn-all-files"') && !r.text.includes('id="btn-delete-all"') && !r.text.includes('DELETE ALL FOOTAGE') && (r.text.match(/action="logout\.php"/g) || []).length === 1
      && r.text.includes('src="js/dashboard-layout.js"') && r.text.includes('CamDashboardLayout.wire('), detail(r));
    for (const [query, key] of [['?layout=list', 'dashboard-list'], ['?layout=grid', 'dashboard-grid'], ['?layout=evil%22%3E', 'dashboard-grid'], ['?layout[]=list', 'dashboard-grid']]) {
      const n = await get('index.php' + query);
      check(`index.php${query}: the bar marks ${key} (an unknown value falls back to the grid)`, n.status === 200 && (n.text.match(/aria-current/g) || []).length === 1 && n.text.includes(`data-nav="${key}" data-page-load aria-current="page"`) && !n.text.includes('evil"'), detail(n));
    }
    // the site's address opens SIMPLE LIST; an address that names the dashboard still shows it
    for (const p of ['', '?x=1', '?layout=evil']) {
      const n = await get(p);
      check(`/${p}: the site's address sends the browser to SIMPLE LIST (302, a plain relative address)`, n.status === 302 && n.headers.location === 'simple-list.php' && safe(n), detail(n));
    }
    const anon = await get('', { auth: false });
    check('/ without a login asks for the login first (401), it does not redirect', anon.status === 401 && !anon.headers.location, detail(anon));
    for (const p of ['index.php', 'index.php?layout=grid', 'index.php?layout=list']) {
      const n = await get(p);
      check(`${p}: still the dashboard itself (200, no redirect)`, n.status === 200 && !n.headers.location && n.text.includes('id="grid"'), detail(n));
    }
    // F-27: every page names the icon, and the icon files are served (so no browser guesses /favicon.ico into a 404)
    for (const p of ['index.php?layout=grid', 'simple-list.php', 'simple-view.php', 'all-recordings.php', 'settings-page.php', 'camera-settings-page.php?cam=cam-a']) {
      const n = await get(p);
      check(`${p}: the head names favicon.svg and favicon.ico`, n.status === 200 && n.text.includes('<link rel="icon" href="favicon.svg" type="image/svg+xml">') && n.text.includes('<link rel="icon" href="favicon.ico" sizes="48x48">'), detail(n));
    }
    const svgIcon = await get('favicon.svg');
    check('favicon.svg is served as an SVG picture', svgIcon.status === 200 && /image\/svg\+xml/.test(svgIcon.headers['content-type'] || '') && svgIcon.text.startsWith('<svg'), detail(svgIcon));
    const icoIcon = await get('favicon.ico');
    check('favicon.ico is served (200, an icon file)', icoIcon.status === 200 && /image\/(x-icon|vnd\.microsoft\.icon)/.test(icoIcon.headers['content-type'] || ''), detail(icoIcon));
    for (const [page, input] of [['camera-settings-page.php?cam=cam-a', 'e-icon'], ['settings-page.php', 'c-icon']]) {
      const n = await get(page);
      check(`${page}: the icon input has the chooser bubble — its scripts (catalog first), its style, and the attach call`,
        n.status === 200 && n.text.indexOf('src="js/icon-catalog.js"') > 0 && n.text.indexOf('src="js/icon-catalog.js"') < n.text.indexOf('src="js/icon-picker.js"')
        && n.text.includes('.icon-bubble {') && n.text.includes(`attach($('${input}'), window.CamIconCatalog.GROUPS)`) && n.text.includes(`id="${input}"`), detail(n));
    }
    for (const page of ['all-recordings.php', 'settings-page.php', 'camera-settings-page.php?cam=cam-a']) {
      const n = await get(page);
      const files = page === 'all-recordings.php';
      check(`${page}: the navigation bar is on it${files ? ', with ALL FILES marked' : ', none of its links marked'}, LOG OUT only there, and the old "← DASHBOARD" button is gone`,
        n.status === 200 && /<body>\s*<nav class="site-nav"/.test(n.text) && NAV_LINKS.test(n.text) && (n.text.match(/aria-current/g) || []).length === (files ? 1 : 0)
        && (n.text.match(/action="logout\.php"/g) || []).length === 1 && (!files || n.text.includes('data-nav="all-files" data-page-load aria-current="page"')) && !n.text.includes('← DASHBOARD') && n.text.includes('.site-nav { position: sticky; top: 0;'), detail(n));
    }
    const links = (id) => new RegExp(`<a class="stream-link" href="simple-view\\.php\\?cam=${id}"[^>]*>\\s*<img data-cam="${id}"[^>]*id="img-${id}"`);
    check('dashboard: every camera\'s picture is a link to that camera\'s large view, and a click there no longer goes full screen',
      ['cam-a', 'cam-b', 'cam-c'].every((id) => links(id).test(r.text)) && !r.text.includes('toggleStreamFullscreen') && !/<img[^>]*class="stream"[^>]*onclick=/.test(r.text), detail(r));
    check('dashboard: every camera\'s picture frame has the transparent-until-recording border (class rec-frame) and the page has its style',
      ['cam-a', 'cam-b', 'cam-c'].every((id) => r.text.includes(`<div class="cam-stream-wrap rec-frame" id="wrap-${id}">`)) && r.text.includes('.rec-frame.recording { border-color: var(--accent2)'), detail(r));
    check('dashboard: every camera\'s picture box has its hidden "camera offline" cover (dark, see-through, says so), before the connecting overlay, and the page has its style and script',
      ['cam-a', 'cam-b', 'cam-c'].every((id) => r.text.includes(`<div class="cam-offline" id="offline-${id}" role="status" hidden>`)
        && r.text.indexOf(`id="offline-${id}"`) < r.text.indexOf(`id="overlay-${id}"`) && r.text.indexOf(`id="overlay-${id}"`) < r.text.indexOf(`id="img-${id}"`))
      && (r.text.match(/CAMERA OFFLINE/g) || []).length === 3 && r.text.includes('.cam-offline[hidden] { display: none; }') && r.text.includes('<script src="js/camera-offline.js"></script>'), detail(r));
    check('dashboard: the camera status block shows the cover of a camera that is not connected (applyCameraStatuses)', /CamOffline\.render\(document\.getElementById\('offline-' \+ id\), data, id\)/.test(r.text), detail(r));
    check('dashboard: the recording state also switches the frame (updateCameraRecordButtonState)', /getElementById\('wrap-' \+ id\)[\s\S]{0,200}classList\.toggle\('recording', recording\)/.test(r.text), detail(r));
    for (const page of ['simple-list.php', 'simple-view.php', 'simple-view.php?cam=cam-a']) {
      r = await get(page, { auth: false });
      check(`${page}: without the dashboard login it is just the login prompt`, r.status === 401 && /^Basic realm=/.test(r.headers['www-authenticate'] || '') && !/cam-a|stream\.php/.test(r.text), detail(r));
    }

    // ── the list ────────────────────────────────────────────────────
    r = await get('simple-list.php');
    check('list: 200, an HTML page with the safe headers', r.status === 200 && /text\/html/.test(r.headers['content-type'] || '') && safe(r), detail(r));
    const thumbs = r.text.match(/<a class="thumb rec-frame" data-cam="[^"]*" href="[^"]*"[^>]*><img alt="[^"]*">/g) || [];
    check('list: one thumbnail per camera, each a picture without a source linking to its simple-view.php, no stream.php anywhere', thumbs.length === 3
      && ['cam-a', 'cam-b', 'cam-c'].every((id) => r.text.includes(`href="simple-view.php?cam=${id}"`)) && !r.text.includes('stream.php') && !/<img\b[^>]*\bsrc=/i.test(r.text), thumbs.join(' | '));
    check('list: each caption starts with that camera\'s own icon', r.text.includes('<span class="cap"><span class="cam-icon" aria-hidden="true">🚪</span>Cam A</span>')
      && r.text.includes('<span class="cap"><span class="cam-icon" aria-hidden="true">🚗</span>Cam B</span>'), r.text.slice(0, 200));
    check('list: the cameras\' names are the captions, and the navigation bar (list marked) is the way to the other pages — no second back button', /Cam A/.test(r.text) && /Cam C/.test(r.text)
      && /<body class="simple-list">\s*<nav class="site-nav"/.test(r.text) && r.text.includes('class="nav-link current" href="simple-list.php" data-nav="simple-list" data-page-load aria-current="page"') && !r.text.includes('← DASHBOARD'));
    check('list: every thumbnail has its hidden "camera offline" cover over its picture, and the page has its style',
      (r.text.match(/<img alt="[^"]*"><div class="cam-offline" role="status" hidden>/g) || []).length === 3
      && (r.text.match(/CAMERA OFFLINE/g) || []).length === 3 && r.text.includes('.cam-offline[hidden] { display: none; }'), detail(r));
    check('list: loads camera-offline.js before simple-logic.js, then simple-list.js, no inline handler, nothing of the relay\'s address',
      r.text.indexOf('src="js/camera-offline.js"') !== -1 && r.text.indexOf('src="js/camera-offline.js"') < r.text.indexOf('src="js/simple-logic.js"') && r.text.includes('src="js/simple-list.js"') && !/\son[a-z]+\s*=\s*["']/i.test(r.text) && !r.text.includes(String(PHP_PORT + 1)));

    const inOrder = (html, files) => { let at = -1; return files.every((f) => { const i = html.indexOf(`<script src="js/${f}"></script>`); const ok = i > at; at = i; return ok; }); };
    check('list: the one connection\'s scripts (codec, client, pictures) load in that order before simple-list.js; nothing is polled (no relay-json.js)',
      inOrder(r.text, ['mux-codec.js', 'mux-client.js', 'mux-pictures.js', 'simple-list.js']) && !r.text.includes('relay-json.js'), detail(r));

    // ── the scripts ─────────────────────────────────────────────────
    for (const f of ['camera-offline.js', 'simple-logic.js', 'simple-list.js', 'simple-view.js', 'fullscreen.js', 'relay-json.js', 'mux-codec.js', 'mux-client.js', 'mux-pictures.js', 'icon-catalog.js', 'icon-picker.js', 'dashboard-layout.js']) {
      const js = await get(`js/${f}`);
      check(`js/${f}: served, and byte for byte the file the repo tests`, js.status === 200 && js.text === fs.readFileSync(path.join(DASH_SRC, 'js', f), 'utf8'), `status=${js.status}`);
    }

    // ── the large view ──────────────────────────────────────────────
    r = await get('simple-view.php');
    let d = viewData(r.text);
    check('view: no cam = the first camera; its picture has no source (the mux connection paints it), no stream.php, scripts in order', r.status === 200 && safe(r) && d !== null && d.current === 'cam-a' && r.text.includes('<img id="picture" alt="Cam A"')
      && !r.text.includes('stream.php') && inOrder(r.text, ['mux-codec.js', 'mux-client.js', 'mux-pictures.js', 'fullscreen.js', 'simple-view.js']) && !r.text.includes('relay-json.js'), detail(r));
    check('view: the script gets the camera list (id, name and icon only) and the slideshow time from the setting (25)',
      d !== null && JSON.stringify(d.cameras) === JSON.stringify([{ id: 'cam-a', name: 'Cam A', icon: '🚪' }, { id: 'cam-b', name: 'Cam B', icon: '🚗' }, { id: 'cam-c', name: 'Cam C', icon: '📷' }]) && d.seconds === '25', JSON.stringify(d));
    check('view: pager, status line (time, camera name, recording) and slideshow button are there',
      ['id="prev"', 'id="next"', 'id="clock"', 'id="cam-name">Cam A<', 'id="rec"', 'id="slideshow"'].every((s) => r.text.includes(s)));
    check('view: the "camera offline" cover is inside the picture box (it goes full screen with it), hidden at first',
      /<div class="picture rec-frame" id="picture-box"><img id="picture"[^>]*><div class="cam-offline" id="offline" role="status" hidden>[\s\S]*?CAMERA OFFLINE[\s\S]*?<\/div><\/div>/.test(r.text), r.text.slice(0, 200));
    check('view: loads camera-offline.js before simple-logic.js, fullscreen.js and simple-view.js', r.text.indexOf('src="js/camera-offline.js"') !== -1 && r.text.indexOf('src="js/camera-offline.js"') < r.text.indexOf('src="js/simple-logic.js"') && r.text.includes('src="js/simple-logic.js"') && r.text.includes('src="js/fullscreen.js"') && r.text.includes('src="js/simple-view.js"'));
    check('view: the icon of the camera is in front of its name', r.text.includes('<span class="cam-icon" id="cam-icon" aria-hidden="true">🚪</span><span id="cam-name">Cam A</span>'), r.text.slice(0, 200));
    check('view: the slideshow\'s time-left indicator (bar and seconds) is on the page, hidden until the slideshow runs',
      r.text.includes('id="countdown-bar" aria-hidden="true" hidden>') && /id="countdown"[^>]*\shidden>/.test(r.text) && r.text.includes('id="countdown-fill"'), r.text.slice(0, 200));
    check('view: the navigation bar (view marked) is on the page and the status line has no dashboard / list buttons of its own',
      /<body class="simple-view">\s*<nav class="site-nav"/.test(r.text) && r.text.includes('class="nav-link current" href="simple-view.php" data-nav="simple-view" data-page-load aria-current="page"') && !r.text.includes('▦ LIST') && !r.text.includes('>DASHBOARD<'), r.text.slice(0, 200));
    check('view: the picture is in its own box (what goes full screen on a click)', r.text.includes('<div class="picture rec-frame" id="picture-box"><img id="picture"'));
    r = await get('simple-view.php?cam=cam-c');
    d = viewData(r.text);
    check('view: ?cam=cam-c shows that camera (and the title names it)', r.status === 200 && d && d.current === 'cam-c' && r.text.includes('<img id="picture" alt="Cam C"') && /<title>Cam C — /.test(r.text), detail(r));

    // ── what is refused ─────────────────────────────────────────────
    for (const [label, p, status] of [
      ['an unknown camera', 'simple-view.php?cam=nope', 404],
      ['an id with another case', 'simple-view.php?cam=CAM-A', 404],
      ['a path-traversal id', 'simple-view.php?cam=..%2F..%2Fconfig', 404],
      ['an array instead of a name', 'simple-view.php?cam[]=cam-a', 400],
      ['an array with a key', 'simple-view.php?cam[x]=cam-a', 400],
    ]) {
      r = await get(p);
      check(`view: ${label} is ${status}, with no page and no stream address`, r.status === status && !/<img|stream\.php/.test(r.text), detail(r));
    }

    // ── the slideshow time ──────────────────────────────────────────
    for (const [bad, label] of [["'abc'", 'text'], ['1', 'too small'], ['301', 'too big'], ['-5', 'negative']]) {
      await serve(CAMS, `'slideshow_seconds' => ${bad},`);
      d = viewData((await get('simple-view.php')).text);
      check(`slideshow time: a ${label} value in config.php falls back to the default (10)`, d !== null && d.seconds === '10', JSON.stringify(d));
    }
    const dir = await serve(CAMS, "'slideshow_seconds' => 25,");
    d = viewData((await get('simple-view.php')).text);
    check('slideshow time: 25 from config.php', d !== null && d.seconds === '25');
    fs.mkdirSync(path.join(dir, 'data'), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'data/settings.json'), JSON.stringify({ slideshow_seconds: 40 }));
    d = viewData((await get('simple-view.php')).text);
    check('slideshow time: a value saved on the dashboard (data/settings.json) beats config.php', d !== null && d.seconds === '40', JSON.stringify(d));
    fs.writeFileSync(path.join(dir, 'data/settings.json'), JSON.stringify({ slideshow_seconds: '40; drop' }));
    d = viewData((await get('simple-view.php')).text);
    check('slideshow time: a wrong-typed value in settings.json is ignored', d !== null && d.seconds === '25', JSON.stringify(d));

    // ── a hostile camera name ───────────────────────────────────────
    await serve(`[['id' => 'cam-a', 'name' => ${JSON.stringify(EVIL_NAME).replace(/\$/g, '\\$')}], ['id' => 'cam-b', 'name' => 'B']]`);
    for (const p of ['simple-list.php', 'simple-view.php', 'simple-view.php?cam=cam-a']) {
      r = await get(p);
      check(`${p}: a camera name made of markup stays text`, r.status === 200 && !r.text.includes('<script>window.__pwned') && r.text.includes('&lt;script&gt;'), detail(r));
    }
    d = viewData((await get('simple-view.php')).text);
    check('view: ...and reaches the script exactly as written, as data', d !== null && d.cameras[0].name === EVIL_NAME, JSON.stringify(d));

    // ── no cameras ──────────────────────────────────────────────────
    await serve('[]');
    r = await get('simple-list.php');
    check('no cameras: the list says so, and has no thumbnails', r.status === 200 && /No cameras are configured/.test(r.text) && !/class="thumb"/.test(r.text), detail(r));
    r = await get('simple-view.php');
    check('no cameras: the view says so (200), with no picture and no script', r.status === 200 && /No cameras are configured/.test(r.text) && !/id="picture"|simple-view\.js/.test(r.text), detail(r));
    r = await get('simple-view.php?cam=cam-a');
    check('no cameras: asking for a camera is still just "not found"', r.status === 404, detail(r));
  } finally {
    await stopProc(php);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(summarize, (e) => { console.error(`[FAIL] ${e.stack || e}`); failCount += 1; summarize(); });
