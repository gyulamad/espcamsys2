#!/usr/bin/env node
'use strict';
// test_camera_settings_e2e.js — end-to-end check of the camera settings page's backend: a REAL
// relay and a REAL PHP dashboard (php -S) with a generated config.php, plus a small simulated BOARD
// that speaks the protocol the firmware speaks (settings_sync.h; its exact URLs and bodies are pinned
// by tests/cpp/test_settings_sync_glue.cpp): it reports its settings, asks for a queued change with the
// camera key, and answers applied / rejected.
//
//   - a change is checked on the dashboard first (unknown / locked / bad values / unmet requirements
//     are refused and nothing is queued), then queued on the relay; the board gets it with the camera key
//   - what the board reports shows on the page; the answer clears the queued change and is shown
//   - a newer change replaces an older one; an old answer never cancels a newer change
//   - cameras can be added, renamed and removed (config.php keeps everything else); names and icons are
//     escaped on the dashboard; removing a camera withdraws a change still queued for it
//
// Needs `php` on PATH (skips if not). Own ports, throwaway folders. Core modules only.
// Usage:  node tests/e2e/test_camera_settings_e2e.js     Exit code 0 if all passed (or php is missing).

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RELAY_SRC = path.join(__dirname, '../../nodejs/camera-relay');
const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_CAMSET_PORT || 19420);
const PHP_PORT = BASE, RELAY_PORT = BASE + 1, PUSH_PORT = BASE + 2;
const CAM_KEY = 'e2e-camera-key-0001';
const CONTROL = 'e2e-control-key-0001';
const AUTH = 'Basic ' + Buffer.from('dash-user:dash-pass-0001').toString('base64');

let passCount = 0, failCount = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('[FAIL] the test ended without finishing'); process.exitCode = 1; } });
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (spawnSync('php', ['-v']).error) { console.log('php not found on PATH — skipping the camera settings end-to-end test'); finished = true; process.exit(0); }

function http(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== null) { h['Content-Type'] = h['Content-Type'] || (typeof body === 'string' ? 'text/plain' : 'application/json'); h['Content-Length'] = Buffer.byteLength(payload); }
    else if (method === 'POST' || method === 'PUT') h['Content-Length'] = 0;
    const req = nodeHttp.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers: h }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
async function waitUp(port, path_, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${port}${path_}`, (res) => { res.resume(); r(true); }); q.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}
const dash = (method, p, { auth = true, ajax = true, body } = {}) => http(PHP_PORT, method, `/${p}`, { headers: Object.assign(auth ? { Authorization: AUTH } : {}, ajax ? { 'X-Requested-With': 'camdash' } : {}), body });

// ── the simulated board ──
const board = {
  id: 'cam-a',
  key: CAM_KEY,
  req(method, suffix, body, key = this.key) { return http(RELAY_PORT, method, `/device-settings/recorder/${this.id}/${suffix}`, { headers: key ? { 'X-Api-Key': key } : {}, body }); },
  report(rev, result, message, line, key) { return this.req('POST', 'report', `${rev}\n${result}\n${message}\n${line}`, key); },
  ask(key) { return this.req('GET', 'change', undefined, key); },
};
// The detector board of cam-a: the same protocol, on the relay's detector endpoints (F-29 T7c).
const detBoard = {
  id: 'det-1',
  key: CAM_KEY,
  req(method, suffix, body, key = this.key) { return http(RELAY_PORT, method, `/device-settings/detector/${this.id}/${suffix}`, { headers: key ? { 'X-Api-Key': key } : {}, body }); },
  report(rev, result, message, line, key) { return this.req('POST', 'report', `${rev}\n${result}\n${message}\n${line}`, key); },
  ask(key) { return this.req('GET', 'change', undefined, key); },
};
const REPORT = 'WIFI=extender-1\\:********;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;CAMERA_ID=cam-a;API_KEY=********;'
  + 'PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;'
  + 'LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000';

// The person detector paired with cam-a (its 'detector' in config.php, the dashboard's ⚙ CALIBRATE page):
// the identity keys it holds in its flash plus its tuned detection values — the same shape the recorder's
// report has, through the relay's detector endpoints.
const DETECTOR_REPORT = 'WIFI=home-net\\:********;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;DETECTOR_ID=det-1;API_KEY=********;'
  + 'PERSON_GPIO=12;OTA_ENABLED=1;SYNC_ENABLED=1;DETECT_THRESH=0.75;CLEAR_THRESH=0.5;DARK_THRESH=40;MOTION_THRESH=300;'
  + 'MOTION_EMA_LEN=0;LOG_MIN_LEVEL=1;LOG_ECHO=1';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-camset-'));
  let relay = null, php = null;
  const relayOut = { text: '' };
  try {
    const relayDir = path.join(tmp, 'relay');
    fs.mkdirSync(relayDir);
    spawnSync('cp', ['-r', path.join(RELAY_SRC, 'lib'), path.join(RELAY_SRC, 'server.js'), path.join(RELAY_SRC, 'package.json'), relayDir]);
    fs.symlinkSync(path.join(RELAY_SRC, 'node_modules'), path.join(relayDir, 'node_modules'));
    fs.writeFileSync(path.join(relayDir, 'config.js'), `module.exports = { port: ${RELAY_PORT}, pushPort: ${PUSH_PORT}, camKey: '${CAM_KEY}', controlKey: '${CONTROL}' };\n`);
    const env = Object.assign({}, process.env);
    for (const k of ['PORT', 'PUSH_PORT', 'CAM_KEY', 'CONTROL_KEY', 'SETTINGS_FILE', 'LOG_FILE', 'SWITCH_FILE', 'DEVICE_SETTINGS_DIR']) delete env[k];
    relay = spawn('node', ['server.js'], { cwd: relayDir, env });
    relay.stdout.on('data', (d) => { relayOut.text += d; }); relay.stderr.on('data', (d) => { relayOut.text += d; });
    check('the relay starts', await waitUp(RELAY_PORT, '/status'));

    const dashDir = path.join(tmp, 'dash');
    fs.mkdirSync(dashDir);
    spawnSync('cp', ['-r', DASH_SRC + '/.', dashDir]);
    fs.writeFileSync(path.join(dashDir, 'config.php'),
      `<?php return ['auth_user' => 'dash-user', 'auth_pass' => 'dash-pass-0001', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${CONTROL}', 'cameras' => [['id' => 'cam-a', 'name' => 'Front door', 'icon' => '🚪', 'detector' => 'det-1'], ['id' => 'cam-b', 'name' => 'Yard', 'icon' => '🌿']]];\n`);
    php = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dashDir], { stdio: 'ignore' });
    check('the dashboard starts', await waitUp(PHP_PORT, '/'));
    const cfg = () => fs.readFileSync(path.join(dashDir, 'config.php'), 'utf8');
    const api = '/camera-settings.php?cam=cam-a';

    // ── access ──
    check('the page needs the login', (await dash('GET', 'camera-settings-page.php?cam=cam-a', { auth: false })).status === 401);
    check('the page loads', (await dash('GET', 'camera-settings-page.php?cam=cam-a')).status === 200);
    // (F-29 T7a) the page follows the Settings Atlas design: category rail, pending-changes tray with
    // ONE apply button, the pending counter in the header, and the link back to the settings hub.
    // (F-37: the LEVEL switch is gone; the Atlas page now always shows every setting.)
    const atlas = (await dash('GET', 'camera-settings-page.php?cam=cam-a')).text;
    check('the page is the Atlas layout: rail, pending tray, one apply, pending counter',
      atlas.includes('id="rail"') && atlas.includes('data-tier="expert"') === false
        && atlas.includes('id="pending-list"') && atlas.includes('id="pending-count"')
        && atlas.includes('id="tray-note"') && (atlas.match(/id="save"/g) || []).length === 1, atlas.length.toString());
    check('the Atlas page carries the Linked settings panel (F-29 T8)', atlas.includes('id="linked"') && atlas.includes('id="linked-list"'));
    check('the Atlas page links back to the settings hub', atlas.includes('settings-page.php'));
    check('every camera card has a settings button that opens its own page', /camera-settings-page\.php\?cam=cam-a/.test((await dash('GET', 'index.php')).text) && /camera-settings-page\.php\?cam=cam-b/.test((await dash('GET', 'index.php')).text));
    check('the API needs the login', (await dash('GET', 'camera-settings.php?cam=cam-a', { auth: false })).status === 401);
    check('…and the dashboard\'s own header', (await dash('GET', 'camera-settings.php?cam=cam-a', { ajax: false })).status === 403);
    check('an unknown camera is a 404', (await dash('GET', 'camera-settings.php?cam=nope')).status === 404);
    check('relay: the state needs the control key', (await http(RELAY_PORT, 'GET', '/device-settings/recorder/cam-a/state')).status === 401
      && (await http(RELAY_PORT, 'GET', '/device-settings/recorder/cam-a/state', { headers: { 'X-Control-Key': CAM_KEY } })).status === 401);
    check('relay: queuing needs the control key (the camera key is not enough)', (await http(RELAY_PORT, 'PUT', '/device-settings/recorder/cam-a/change', { headers: { 'X-Control-Key': CAM_KEY }, body: 'LOG_ECHO=0' })).status === 401);
    check('relay: the board\'s calls need the camera key', (await board.ask('wrong')).status === 401 && (await board.report('0', 'boot', '', 'A=1', 'wrong')).status === 401 && (await board.ask(null)).status === 401);

    // ── before the board has reported ──
    const g0 = await dash('GET', api);
    check('the page data comes with the firmware\'s settings table', g0.status === 200 && g0.json.keys.length >= 15 && g0.json.gpios.length >= 3 && g0.json.camera.name === 'Front door', g0.text.slice(0, 200));
    check('a camera that never reported has no settings to show', g0.json.state.reported === null && g0.json.state.pending === null);
    // (F-29 T8) the linked rules come with the page data even before the board has reported: every one
    // answers "unknown" (the relay's settings were read, but there is no board side to compare yet).
    // Four rules: the alarm-repeat one is offered only once the report says the alarm input is in use.
    check('the page data carries the linked rules, unknown while the board has not reported',
      Array.isArray(g0.json.linked) && g0.json.linked.length === 4 && g0.json.linked.every((r) => r.status === 'unknown'),
      JSON.stringify(g0.json.linked));
    const early = await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '900' } } });
    check('a change before the first report is refused with the reason (nothing to check it against)', early.status === 409 && /not reported/.test(early.json.error), early.text);
    check('nothing was queued', (await board.ask()).status === 404);

    // ── the board reports ──
    check('a malformed report is refused', (await board.req('POST', 'report', 'garbage')).status === 400);
    check('the board\'s boot report is accepted', (await board.report('0', 'boot', '', REPORT)).status === 200);
    const g1 = await dash('GET', api);
    // (F-29 T8) once the board has reported, the linked rules are judged against the relay's REAL values
    // (read with the control key): the fixture's own drift is named - the board's PUSH_PORT (8081) does
    // not match the relay's pushPort - while the other four rules hold.
    {
      const linked = g1.json.linked;
      const push = (linked || []).find((r) => r.formula === 'PUSH_PORT = relay pushPort');
      check('the linked rules are judged against the relay\'s own settings, and a drift is named',
        push !== undefined && push.status === 'problem' && push.problem.includes('PUSH_PORT (8081)') && push.problem.includes(`pushPort (${PUSH_PORT})`)
        && linked.filter((r) => r.status === 'ok').length === 4, JSON.stringify(linked));
    }
    check('the page now shows what the board holds', g1.json.state.reported.settings.LOG_HEARTBEAT === '600' && g1.json.state.reported.settings.CAMERA_ID === 'cam-a');
    check('escaped characters in the report come back unescaped', g1.json.state.reported.settings.WIFI === 'extender-1:********');
    check('a masked secret stays masked', g1.json.state.reported.settings.API_KEY === '********' && !g1.text.includes(CAM_KEY));

    // ── refusals: nothing queued ──
    for (const [what, values, re] of [
      ['a connection setting', { SERVER_HOST: '10.0.0.9' }, /serial port/],
      ['the camera key', { API_KEY: 'another-key-1' }, /serial port/],
      ['an unknown setting', { NOPE: '1' }, /unknown/],
      ['a number out of range', { LOG_HEARTBEAT: '0' }, /LOG_HEARTBEAT/],
      ['text where a number is needed', { LOG_RETRY_MAX: 'abc' }, /LOG_RETRY_MAX/],
      ['a GPIO the board does not allow', { ALARM_GPIO_PIN: '7' }, /ALARM_GPIO_PIN/],
    ]) {
      const r = await dash('POST', api, { body: { values } });
      check(`refused: ${what}`, r.status === 400 && re.test(r.json.error), r.text);
    }
    check('a good value next to a bad one is not queued either (all or nothing)', (await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '900', NOPE: '1' } } })).status === 400);
    check('…nothing is waiting for the board', (await board.ask()).status === 404);
    check('a non-object body is refused', (await dash('POST', api, { body: { values: [1] } })).status === 400);
    check('a value that is not plain is refused', (await dash('POST', api, { body: { values: { LOG_ECHO: [1] } } })).status === 400);

    const same = await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '600', ALARM_ACTIVE: 'low' } } });
    check('values the board already has are "nothing to change" — not queued', same.status === 200 && same.json.queued === false && (await board.ask()).status === 404, same.text);

    // ── a change goes through ──
    const q1 = await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '900', LOG_ECHO: 'off' } } });
    check('a valid change is queued', q1.status === 200 && q1.json.queued === true && q1.json.changed.join() === 'LOG_HEARTBEAT,LOG_ECHO', q1.text);
    const st1 = (await dash('GET', api)).json.state;
    check('the page shows it as waiting, by name — not by value', st1.pending && st1.pending.keys.join() === 'LOG_HEARTBEAT,LOG_ECHO' && !JSON.stringify(st1.pending).includes('900'));
    const got = await board.ask();
    const [rev1, line1] = got.text.split('\n');
    check('the board asks and gets "<number>\\n<line>"', got.status === 200 && /^\d+$/.test(rev1) && line1 === 'LOG_HEARTBEAT=900;LOG_ECHO=0', JSON.stringify(got.text));
    check('another camera is not offered this change', (await http(RELAY_PORT, 'GET', '/device-settings/recorder/cam-b/change', { headers: { 'X-Api-Key': CAM_KEY } })).status === 404);
    check('asking again offers it again until it is answered', (await board.ask()).text === got.text);

    check('the board answers: applied', (await board.report(rev1, 'applied', 'changed: LOG_HEARTBEAT, LOG_ECHO', REPORT.replace('LOG_HEARTBEAT=600', 'LOG_HEARTBEAT=900').replace('LOG_ECHO=1', 'LOG_ECHO=0'))).status === 200);
    const st2 = (await dash('GET', api)).json.state;
    check('the change is no longer waiting, and the page shows the answer', st2.pending === null && st2.last.result === 'applied' && /LOG_HEARTBEAT/.test(st2.last.message));
    check('the page shows the board\'s new values', st2.reported.settings.LOG_HEARTBEAT === '900' && st2.reported.settings.LOG_ECHO === '0');
    check('the board is no longer offered it', (await board.ask()).status === 404);

    // ── the F-14 link-tuning keys on a board that predates them ──
    // The board above runs firmware from before JPEG_Q_DROP / JPEG_Q_MIN / JPEG_Q_MAX / SIZE_DROP and
    // never reports them: a change must not be refused over settings such a board cannot have yet
    // (the version-skew regression — this used to fail with "JPEG_Q_DROP is needed too"). Such a board holds
    // their DEFAULTS (JPEG_Q_DROP 1, JPEG_Q_MIN 12), so giving those again is no change and only the one that differs is queued.
    const f14 = await dash('POST', api, { body: { values: { JPEG_Q_DROP: '1', JPEG_Q_MIN: '12', JPEG_Q_MAX: '40' } } });
    check('the JPEG quality keys queue on a board that predates them — only what differs from the defaults', f14.status === 200 && f14.json.queued === true && f14.json.changed.join() === 'JPEG_Q_MAX', f14.text);
    const gotF14 = await board.ask();
    const [, lineF14] = gotF14.text.split('\n');
    check('the board is offered that change in one line', gotF14.status === 200 && lineF14 === 'JPEG_Q_MAX=40', JSON.stringify(gotF14.text));
    check('…and it can be withdrawn again like any change', (await dash('POST', api, { body: { cancel: true } })).status === 200 && (await board.ask()).status === 404);

    // ── a refusal by the board ──
    await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '1000' } } });
    const [rev2] = (await board.ask()).text.split('\n');
    await board.report(rev2, 'rejected', 'LOG_HEARTBEAT is a surprise', REPORT);
    const st3 = (await dash('GET', api)).json.state;
    check('a change the board refuses is cleared and its reason is shown', st3.pending === null && st3.last.result === 'rejected' && /surprise/.test(st3.last.message));

    // ── a newer change replaces an older one; an old answer never cancels a newer one ──
    await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '1100' } } });
    const [revOld] = (await board.ask()).text.split('\n');
    await dash('POST', api, { body: { values: { LOG_HEARTBEAT: '1200' } } });
    const newer = await board.ask();
    check('a newer change replaces the waiting one (and has a larger number)', newer.text.endsWith('\nLOG_HEARTBEAT=1200\n') && Number(newer.text.split('\n')[0]) > Number(revOld));
    await board.report(revOld, 'applied', 'late answer', REPORT);
    check('a late answer to the OLD change does not cancel the new one', (await board.ask()).status === 200);

    // ── withdraw ──
    const cancel = await dash('POST', api, { body: { cancel: true } });
    check('a queued change can be withdrawn', cancel.status === 200 && (await board.ask()).status === 404 && (await dash('GET', api)).json.state.pending === null, cancel.text);

    // ── the detector of cam-a (F-29 T7c): its page, its table, its change flow ──
    // The person detector paired with cam-a is calibrated and configured from the same Atlas page with
    // &type=detector, addressed by its DETECTOR_ID on the relay's detector endpoints. The backend is the
    // same camera-settings.php; the page's tray flow is covered by the DOM tests.
    const apiDet = '/camera-settings.php?cam=cam-a&type=detector';
    check('the detector page needs the login', (await dash('GET', 'camera-settings-page.php?cam=cam-a&type=detector', { auth: false })).status === 401);
    const detPage = (await dash('GET', 'camera-settings-page.php?cam=cam-a&type=detector')).text;
    check('the detector page loads and is the Atlas layout, with the calibration help',
      detPage.includes('id="rail"') && detPage.includes('id="tierbar"') === false && detPage.includes('id="pending-list"')
        && (detPage.match(/id="save"/g) || []).length === 1 && detPage.includes('id="calib-help"'), detPage.length.toString());
    check('the dashboard card links the detector page', /camera-settings-page\.php\?cam=cam-a&amp;type=detector/.test((await dash('GET', 'index.php')).text));
    check('the detector API needs the login and the dashboard\'s own header',
      (await dash('GET', apiDet, { auth: false })).status === 401 && (await dash('GET', apiDet, { ajax: false })).status === 403);
    const d0 = await dash('GET', apiDet);
    check('the detector\'s API serves the detector firmware\'s own table (PERSON_META and T5b/T5c)',
      d0.status === 200 && d0.json.keys.length >= 90 && d0.json.camera.type === 'detector' && d0.json.camera.deviceId === 'det-1', d0.text.slice(0, 200));
    check('…carrying the Atlas metadata the page builds its rail from',
      d0.json.keys.some((k) => k.name === 'DETECT_THRESH' && k.category === 'Detection' && k.tier === 'basic' && k.apply === 'live' && k.default === '0.6')
        && d0.json.keys.some((k) => k.name === 'STREAM_JPEG_Q' && k.category === 'Picture & live view' && k.apply === 'reboot' && k.default === '80'));
    check('a camera without a paired detector has no detector page data',
      (await dash('GET', 'camera-settings.php?cam=cam-b&type=detector')).status === 404, '');
    check('a change before the detector has reported is refused', (await dash('POST', apiDet, { body: { values: { DETECT_THRESH: '0.5' } } })).status === 409);
    check('the detector board reports: boot', (await detBoard.report('0', 'boot', '', DETECTOR_REPORT)).status === 200);
    const d1 = await dash('GET', apiDet);
    check('the detector page shows what the board holds, its secret masked',
      d1.json.state.reported.settings.DETECT_THRESH === '0.75' && d1.json.state.reported.settings.API_KEY === '********');
    const ema = await dash('POST', apiDet, { body: { values: { MOTION_EMA_LEN: '3000' } } });
    check('the MOTION_EMA pairing is enforced end to end: the margin is demanded with it',
      ema.status === 400 && /MOTION_EMA_PCT/.test(ema.json.error), ema.text);
    const qd = await dash('POST', apiDet, { body: { values: { DETECT_THRESH: '0.5', LOG_MIN_LEVEL: '2' } } });
    check('a detector change is queued', qd.status === 200 && qd.json.queued === true && qd.json.changed.join() === 'DETECT_THRESH,LOG_MIN_LEVEL', qd.text);
    const gotDet = await detBoard.ask();
    const [revDet, lineDet] = gotDet.text.split('\n');
    check('the detector board asks and gets the change in one line', gotDet.status === 200 && /^\d+$/.test(revDet) && lineDet === 'DETECT_THRESH=0.5;LOG_MIN_LEVEL=2', JSON.stringify(gotDet.text));
    check('the detector answers: applied, and the page shows the new values',
      (await detBoard.report(revDet, 'applied', 'changed: DETECT_THRESH, LOG_MIN_LEVEL', DETECTOR_REPORT.replace('DETECT_THRESH=0.75', 'DETECT_THRESH=0.5').replace('LOG_MIN_LEVEL=1', 'LOG_MIN_LEVEL=2'))).status === 200
        && (await dash('GET', apiDet)).json.state.reported.settings.DETECT_THRESH === '0.5');
    check('the recorder\'s change flow was not disturbed by the detector\'s', (await dash('GET', api)).json.state.pending === null && (await board.ask()).status === 404);


    // ── requirements between settings ──
    // (review ARD-009) ALARM_GPIO_PIN, ALARM_ACTIVE, ALARM_ALL_CAMS and
    // LOG_ENABLED are now serial-only locks: a MITM could otherwise disable
    // the alarm feature, invert its level, force all-cameras recording on
    // every alarm, or silence the remote log so the operator never sees the
    // manipulation. The dashboard no longer accepts them through the staging
    // endpoint at all; they must be set at provisioning time over the serial
    // console. The original test staged ALARM_GPIO_PIN=14 + ALARM_ACTIVE=HIGH
    // + ALARM_ALL_CAMS=1 over the relay and verified the board applied it —
    // that path is now expected to refuse with the same 'serial port only'
    // message every other locked key gets.
    await board.report('0', 'boot', '', REPORT.replace('ALARM_GPIO_PIN=13', 'ALARM_GPIO_PIN=-1').replace(';ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0', ''));
    const need = await dash('POST', api, { body: { values: { ALARM_GPIO_PIN: '14' } } });
    check('ALARM_GPIO_PIN is locked: cannot be staged over the relay', need.status === 400 && /serial port/.test(need.json.error), need.text);
    const okAlarm = await dash('POST', api, { body: { values: { ALARM_GPIO_PIN: '14', ALARM_ACTIVE: 'HIGH', ALARM_ALL_CAMS: '1' } } });
    check('…still refused even with the sibling alarm settings', okAlarm.status === 400 && /serial port/.test(okAlarm.json.error), okAlarm.text);
    const silenceLog = await dash('POST', api, { body: { values: { LOG_ENABLED: '0' } } });
    check('LOG_ENABLED is locked: cannot be staged over the relay (would let a MITM silence the log)', silenceLog.status === 400 && /serial port/.test(silenceLog.json.error), silenceLog.text);
    await dash('POST', api, { body: { cancel: true } });

    // ── the log: names, never values ──
    await sleep(200);
    const log = fs.readFileSync(path.join(relayDir, 'logs', 'camera.log'), 'utf8');
    check('the relay log names what was queued and the board\'s answers', /queued a settings change for recorder cam-a: LOG_HEARTBEAT, LOG_ECHO/.test(log) && /cam-a \(recorder\) applied the settings change/.test(log) && /rejected the settings change/.test(log));
    check('…and the detector\'s queueing and answer are named the same way', /queued a settings change for detector det-1: DETECT_THRESH, LOG_MIN_LEVEL/.test(log) && /det-1 \(detector\) applied the settings change/.test(log));
    check('…and holds no setting value', !/LOG_HEARTBEAT=900/.test(log) && !log.includes('extender-1') && !log.includes('DETECT_THRESH=0.5'));

    // ── cameras: add / rename / remove ──
    const sys0 = await dash('GET', 'system-settings.php');
    check('the main settings page data lists the cameras', sys0.status === 200 && sys0.json.cameras.map((c) => c.id).join() === 'cam-a,cam-b');
    const admin = (body, o) => dash('POST', 'camera-admin.php', Object.assign({ body }, o));
    check('camera-admin needs the login and the header', (await admin({}, { auth: false })).status === 401 && (await admin({}, { ajax: false })).status === 403);
    const add = await admin({ action: 'add', id: 'cam-c', name: 'Garage', icon: '🚗' });
    check('a camera can be added', add.status === 200 && add.json.cameras.length === 3 && /CAMERA_ID setting is exactly cam-c/.test(add.json.message), add.text);
    check('it is in config.php, and the other cameras and settings are intact', /cam-c/.test(cfg()) && /cam-a/.test(cfg()) && /dash-pass-0001/.test(cfg()) && /relay_control_key/.test(cfg()));
    check('and it appears on the dashboard with its settings button', /camera-settings-page\.php\?cam=cam-c/.test((await dash('GET', 'index.php')).text));
    check('a duplicate id (any letter case) is refused', (await admin({ action: 'add', id: 'CAM-C', name: 'x', icon: 'y' })).status === 400);
    check('a bad id is refused', (await admin({ action: 'add', id: '../x', name: 'x', icon: 'y' })).status === 400 && (await admin({ action: 'add', id: 'a b', name: 'x', icon: 'y' })).status === 400);
    check('an icon with markup is refused', (await admin({ action: 'add', id: 'cam-d', name: 'x', icon: '<b>' })).status === 400);
    check('an unknown action is refused', (await admin({ action: 'explode' })).status === 400);
    const ren = await admin({ action: 'update', id: 'cam-c', name: 'Garage <door> & "gate"', icon: '🚪' });
    check('a camera can be renamed', ren.status === 200 && ren.json.cameras[2].name === 'Garage <door> & "gate"');
    const html = (await dash('GET', 'index.php')).text;
    check('names with markup characters are escaped on the dashboard', !html.includes('Garage <door>') && /Garage &lt;door&gt;/.test(html));
    check('the id of an entry cannot be changed by "update"', (await admin({ action: 'update', id: 'nope', name: 'x', icon: 'y' })).status === 400);

    await dash('POST', 'camera-settings.php?cam=cam-c', { body: { cancel: true } });
    await http(RELAY_PORT, 'PUT', '/device-settings/recorder/cam-c/change', { headers: { 'X-Control-Key': CONTROL }, body: 'LOG_ECHO=0' });
    check('(a change is waiting for cam-c)', (await http(RELAY_PORT, 'GET', '/device-settings/recorder/cam-c/change', { headers: { 'X-Api-Key': CAM_KEY } })).status === 200);
    const rem = await admin({ action: 'remove', id: 'cam-c' });
    check('a camera can be removed from the dashboard', rem.status === 200 && rem.json.cameras.map((c) => c.id).join() === 'cam-a,cam-b' && !/cam-c/.test(cfg()), rem.text);
    check('removing a camera withdraws a change still waiting for it', (await http(RELAY_PORT, 'GET', '/device-settings/recorder/cam-c/change', { headers: { 'X-Api-Key': CAM_KEY } })).status === 404);
    check('removing an unknown camera is refused', (await admin({ action: 'remove', id: 'cam-c' })).status === 400);
    check('its page is gone', (await dash('GET', 'camera-settings.php?cam=cam-c')).status === 404);
    check('the other cameras and the login are untouched', /cam-a/.test(cfg()) && /cam-b/.test(cfg()) && (await dash('GET', api)).status === 200);
  } catch (err) {
    check('the test ran without an unexpected error', false, err && err.stack);
  } finally {
    if (php) php.kill('SIGKILL');
    if (relay) relay.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

main();
