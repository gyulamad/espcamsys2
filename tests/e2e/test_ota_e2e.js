#!/usr/bin/env node
'use strict';
// test_ota_e2e.js — end-to-end check of the firmware the relay hands to the boards
// (server-driven OTA update), against a REAL `server.js` process, real HTTP and the
// real files on disk.
//
//   - publishing (PUT /ota/<type>?version=) needs the CONTROL key; refused without one,
//     and disabled (503) when no control key is configured
//   - a body that is not an ESP32 image (wrong first byte, tiny, truncated), a bad type
//     or a bad version is refused and publishes nothing
//   - boards ask GET /ota/<type>/version with the CAMERA key: 404 before anything is
//     published, "<version>\n<md5>\n" after; the camera key cannot publish
//   - the download is byte-for-byte what was published, with Content-Length and the md5
//     the version reply announced
//   - the relay log says who published what, that a device is downloading, that it
//     "now runs X (was Y)", and WARNs with the reason a board reports (?err=); polls
//     that change nothing add nothing
//   - GET /ota/status: updated / pending per device, per type, last error
//   - a new upload replaces the old one; everything survives a relay restart
//   - path-traversal ids and types are refused
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway
// folders in a temp dir. Core modules only.
//
// Usage:  node tests/e2e/test_ota_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const crypto = require('crypto');
const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_OTA_PORT || 19340);
const PUSH_PORT = Number(process.env.E2E_OTA_PUSH_PORT || 19341);
const KEY = 'e2e-ota-key';
const CONTROL = 'e2e-ota-control';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('[FAIL] the test ended without finishing (no summary was reached)');
    process.exitCode = 1;
  }
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

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-ota-switch-${process.pid}.json`) }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve({ child, output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 5s:\n${out}`)); } }, 5000).unref();
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

// An HTTP request; the answer carries the raw bytes (`buf`) as well as the text and, when it is, the JSON.
function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const get = (urlPath, key) => request('GET', urlPath, { headers: key === undefined ? {} : { 'X-Api-Key': key } });
const getControl = (urlPath, key) => request('GET', urlPath, { headers: key === undefined ? {} : { 'X-Control-Key': key } });
const publish = (type, version, body, key) => request('PUT', `/ota/${type}${version === null ? '' : `?version=${version}`}`, {
  headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, key === undefined ? {} : { 'X-Control-Key': key }),
  body,
});
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
// A fake app image: starts with the ESP32 magic byte, the rest is deterministic noise.
function fakeImage(size, seed) {
  const b = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i += 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; }
  b[0] = 0xE9;
  return b;
}
const statusLines = (text) => text.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ota-'));
  const dir = path.join(tmp, 'firmware');
  const logFile = path.join(tmp, 'camera.log');
  const env = { FIRMWARE_DIR: dir, LOG_FILE: logFile, CONTROL_KEY: CONTROL, SETTINGS_FILE: path.join(tmp, 'settings.json') };
  let relay = null;
  try {
    relay = await startRelay(env);
    const imgA = fakeImage(300000, 1);
    const imgB = fakeImage(310000, 2);

    // ── nothing published yet ──
    const none = await get('/ota/recorder/version?id=cam1&fw=old1', KEY);
    check('before anything is published the version answer is 404', none.status === 404, JSON.stringify(none.text));
    check('...and a download is a 404 too', (await get('/ota/recorder/firmware.bin?id=cam1', KEY)).status === 404);

    // ── authentication ──
    check('publishing without a control key is refused', (await publish('recorder', 'v1', imgA)).status === 401);
    check('publishing with the wrong control key is refused', (await publish('recorder', 'v1', imgA, 'nope')).status === 401);
    check('the camera key cannot publish', (await publish('recorder', 'v1', imgA, KEY)).status === 401);
    check('asking for the version without a key is refused', (await get('/ota/recorder/version?id=cam1&fw=x')).status === 401);
    check('asking with the wrong key is refused', (await get('/ota/recorder/version?id=cam1&fw=x', 'nope')).status === 401);
    check('downloading without a key is refused', (await get('/ota/recorder/firmware.bin?id=cam1')).status === 401);
    check('the control key is not the camera key', (await get('/ota/recorder/version?id=cam1&fw=x', CONTROL)).status === 401);
    check('the status needs the control key', (await getControl('/ota/status')).status === 401);
    check('the camera key cannot read the status', (await getControl('/ota/status', KEY)).status === 401);
    check('nothing was published by those refusals', !fs.existsSync(path.join(dir, 'recorder.bin')));

    // ── things that must not be published ──
    const notImage = Buffer.alloc(300000, 0x41);
    const r1 = await publish('recorder', 'v1', notImage, CONTROL);
    check('a body that does not start with the ESP32 image byte is refused', r1.status === 400 && /0xE9/.test(r1.text), JSON.stringify(r1.text));
    const r2 = await publish('recorder', 'v1', imgA.subarray(0, 5000), CONTROL);
    check('a truncated/tiny image is refused', r2.status === 400 && /too small/.test(r2.text), JSON.stringify(r2.text));
    check('an empty body is refused', (await publish('recorder', 'v1', Buffer.alloc(0), CONTROL)).status === 400);
    check('an image over 2 MiB is refused', (await publish('recorder', 'v1', fakeImage(2 * 1024 * 1024 + 1, 3), CONTROL)).status === 400);
    const huge = await publish('recorder', 'v1', fakeImage(3 * 1024 * 1024 + 1000, 4), CONTROL);
    check('an upload over the 3 MB request limit is a clear 413', huge.status === 413 && !!huge.json && /too large/.test(huge.json.error), `${huge.status} ${huge.text.slice(0, 80)}`);
    check('a missing version is refused', (await publish('recorder', null, imgA, CONTROL)).status === 400);
    check('a version with a "+" is refused', (await publish('recorder', 'a%2Bb', imgA, CONTROL)).status === 400);
    check('a version with a path in it is refused', (await publish('recorder', '..%2Fx', imgA, CONTROL)).status === 400);
    check('an unknown type is refused', (await publish('toaster', 'v1', imgA, CONTROL)).status === 400);
    check('none of that published anything', !fs.existsSync(path.join(dir, 'recorder.bin')) && !fs.existsSync(path.join(dir, 'recorder.json')));
    check('a refused version request for the wrong type is a 400, not a crash', (await get('/ota/toaster/version?id=cam1', KEY)).status === 400);
    check('a version request without an id is a 400', (await get('/ota/recorder/version?fw=x', KEY)).status === 400);
    check('an id with a path in it is a 400', (await get('/ota/recorder/version?id=..%2F..%2Fx&fw=x', KEY)).status === 400);
    check('a path-traversal type cannot reach another file', (await get('/ota/..%2Fdevice-settings/version?id=cam1', KEY)).status >= 400);

    // ── publish, ask, download ──
    const pub = await publish('recorder', 'v1.0-abc', imgA, CONTROL);
    check('publishing a good image works', pub.status === 200 && pub.json && pub.json.ok === true, JSON.stringify(pub.text));
    check('...and answers with the version, size and md5', pub.json && pub.json.version === 'v1.0-abc' && pub.json.size === imgA.length && pub.json.md5 === md5(imgA), JSON.stringify(pub.json));
    check('the image is stored exactly as sent', fs.existsSync(path.join(dir, 'recorder.bin')) && fs.readFileSync(path.join(dir, 'recorder.bin')).equals(imgA));
    check('no temporary files are left behind', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), JSON.stringify(fs.readdirSync(dir)));

    const ver = await get('/ota/recorder/version?id=cam1&fw=old1', KEY);
    check('a board now gets the version and md5, one per line', ver.status === 200 && ver.text === `v1.0-abc\n${md5(imgA)}\n`, JSON.stringify(ver.text));
    check('the version answer is plain text', /text\/plain/.test(ver.headers['content-type'] || ''));
    check('the key also works as ?key= (the sketches use the header, curl may not)', (await get(`/ota/recorder/version?id=cam1&fw=old1&key=${KEY}`)).status === 200);
    check('the other type is still 404', (await get('/ota/detector/version?id=cam9&fw=old1', KEY)).status === 404);

    const dl = await get('/ota/recorder/firmware.bin?id=cam1', KEY);
    check('the download is byte-for-byte the published image', dl.status === 200 && dl.buf.equals(imgA), `status ${dl.status}, ${dl.buf.length} bytes`);
    check('...with an exact Content-Length (a board needs it before flashing)', Number(dl.headers['content-length']) === imgA.length);
    check('...and its md5 is the one the version answer announced', md5(dl.buf) === ver.text.split('\n')[1]);
    check('the download works without an id too', (await get('/ota/recorder/firmware.bin', KEY)).status === 200);

    // ── the log ──
    await sleep(300);
    const log1 = readLog(logFile);
    check('the log says what was published (version, size)', /published recorder firmware v1\.0-abc \(300000 bytes/.test(log1), log1);
    check('the log says the refused upload and why', /refused: the image is too small/.test(log1) || /refused: this is not an ESP32/.test(log1), log1);
    check('the log names the device that is downloading', /cam1 is downloading recorder firmware v1\.0-abc \(300000 bytes\)/.test(log1), log1);
    check('the log notes the first time a device checks, with what it runs', /cam1 \(recorder\) is checking for firmware, it runs old1/.test(log1), log1);

    const countBefore = (readLog(logFile).match(/cam1/g) || []).length;
    for (let i = 0; i < 3; i += 1) await get('/ota/recorder/version?id=cam1&fw=old1', KEY);
    await sleep(200);
    check('polls that change nothing add nothing to the log', (readLog(logFile).match(/cam1/g) || []).length === countBefore);

    // ── status: pending, then updated ──
    await get('/ota/recorder/version?id=cam2&fw=v1.0-abc', KEY);
    await get('/ota/recorder/version?id=cam1&fw=old1&err=md5_failed', KEY);
    let st = await getControl('/ota/status', CONTROL);
    check('the status is plain text', st.status === 200 && /text\/plain/.test(st.headers['content-type'] || ''));
    let rows = statusLines(st.text);
    const cam1 = rows.find((r) => r[0] === 'cam1');
    const cam2 = rows.find((r) => r[0] === 'cam2');
    check('a device behind the published version is pending, with what it runs and its last error',
      cam1 && cam1[1] === 'recorder' && cam1[2] === 'v1.0-abc' && cam1[3] === 'old1' && cam1[4] === 'pending' && cam1[6] === 'md5_failed', JSON.stringify(cam1));
    check('a device on the published version is updated', cam2 && cam2[3] === 'v1.0-abc' && cam2[4] === 'updated' && cam2[6] === '-', JSON.stringify(cam2));
    check('every line has the seven tab-separated fields', rows.every((r) => r.length === 7), JSON.stringify(rows));
    await sleep(300);
    check('a failure the board reports is a WARN with the reason', /WARN.*cam1 firmware update failed: md5_failed/.test(readLog(logFile)), readLog(logFile));

    await get('/ota/recorder/version?id=cam1&fw=v1.0-abc', KEY); // the board flashed, rebooted and asks again
    await sleep(300);
    check('"now runs X (was Y)" is logged when the version changes', /cam1 now runs v1\.0-abc \(was old1\)/.test(readLog(logFile)), readLog(logFile));
    rows = statusLines((await getControl('/ota/status', CONTROL)).text);
    const cam1b = rows.find((r) => r[0] === 'cam1');
    check('after the update it is updated and the old error is gone', cam1b && cam1b[4] === 'updated' && cam1b[6] === '-', JSON.stringify(cam1b));

    // ── a bad hint from a board never refuses its check ──
    const odd = await get('/ota/recorder/version?id=cam3&fw=we%20ird%2Bversion&err=bad%0Aerr', KEY);
    check('a malformed fw/err hint is cleaned, not an error', odd.status === 200, JSON.stringify(odd.text));
    await sleep(200);
    check('...and the log line is one clean line', !/\nerr/.test(readLog(logFile)));

    // ── a new upload replaces the old; downgrade is just another upload ──
    const pubB = await publish('recorder', 'v2.0', imgB, CONTROL);
    check('a second upload replaces the first', pubB.status === 200);
    const verB = await get('/ota/recorder/version?id=cam1&fw=v1.0-abc', KEY);
    check('boards are now told the new version and md5', verB.text === `v2.0\n${md5(imgB)}\n`, JSON.stringify(verB.text));
    check('...and download the new bytes', (await get('/ota/recorder/firmware.bin?id=cam1', KEY)).buf.equals(imgB));
    rows = statusLines((await getControl('/ota/status', CONTROL)).text);
    check('devices on the old version are pending again', rows.filter((r) => r[1] === 'recorder').every((r) => r[2] === 'v2.0' && r[4] === 'pending'), JSON.stringify(rows));
    const pubOld = await publish('recorder', 'v1.0-abc', imgA, CONTROL);
    check('publishing the older version again (a downgrade) just works', pubOld.status === 200 && (await get('/ota/recorder/version?id=cam1&fw=v2.0', KEY)).text.startsWith('v1.0-abc\n'));

    // ── the other type is independent ──
    const imgD = fakeImage(320000, 5);
    check('the detector is published separately', (await publish('detector', 'v1.0-abc', imgD, CONTROL)).status === 200);
    check('...and its download is its own image', (await get('/ota/detector/firmware.bin?id=cam4', KEY)).buf.equals(imgD));
    check('...without touching the recorder image', (await get('/ota/recorder/firmware.bin?id=cam1', KEY)).buf.equals(imgA));
    await get('/ota/detector/version?id=cam4&fw=old9', KEY);
    rows = statusLines((await getControl('/ota/status', CONTROL)).text);
    const cam4 = rows.find((r) => r[0] === 'cam4');
    check('the status shows the type per device', cam4 && cam4[1] === 'detector' && cam4[2] === 'v1.0-abc' && cam4[4] === 'pending', JSON.stringify(cam4));

    // ── a damaged info file reads as "nothing published", not a crash ──
    fs.writeFileSync(path.join(dir, 'detector.json'), '{not json');
    check('a damaged info file is a 404, not a crash', (await get('/ota/detector/version?id=cam4&fw=old9', KEY)).status === 404);
    check('...and the relay is still serving', (await get('/ota/recorder/version?id=cam1&fw=x', KEY)).status === 200);
    check('...and republishing repairs it', (await publish('detector', 'v1.0-abc', imgD, CONTROL)).status === 200 && (await get('/ota/detector/version?id=cam4&fw=x', KEY)).status === 200);

    // ── the key never lands in the log ──
    const finalLog = readLog(logFile);
    check('neither key is ever written to the log', !finalLog.includes(KEY) && !finalLog.includes(CONTROL));

    // ── survives a restart ──
    await stopRelay(relay);
    relay = await startRelay(env);
    const again = await get('/ota/recorder/version?id=cam1&fw=x', KEY);
    check('the published firmware survives a relay restart', again.status === 200 && again.text === `v1.0-abc\n${md5(imgA)}\n`, JSON.stringify(again.text));
    check('...and so does the image', (await get('/ota/recorder/firmware.bin?id=cam1', KEY)).buf.equals(imgA));
    await stopRelay(relay);

    // ── publishing is off without a control key ──
    relay = await startRelay(Object.assign({}, env, { CONTROL_KEY: '' }));
    const off = await publish('recorder', 'v9', imgA, CONTROL);
    check('without a configured control key, publishing answers 503', off.status === 503, JSON.stringify(off.text));
    check('...and so does the status', (await getControl('/ota/status', CONTROL)).status === 503);
    check('boards can still ask and download', (await get('/ota/recorder/version?id=cam1&fw=x', KEY)).status === 200);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
