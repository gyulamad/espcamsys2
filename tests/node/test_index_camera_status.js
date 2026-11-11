'use strict';

// test_index_camera_status.js — how the dashboard page (php/cameras/index.php) keeps the REC pills, FILES counts, switches
// and the "camera offline" covers current: from the map pushed on the mux.php connection; status.php is asked once,
// after a command of the page, and never on a timer. While the connection is down the switch pills say NO DATA. Runs
// exactly the block between its <camera-status-source> markers against stand-ins for the page (no PHP, no browser).

const fs = require('fs');
const path = require('path');
const { assertEqual, assertTrue } = require('./framework');
const CamOffline = require('../../php/cameras/js/camera-offline');   // the real one: it is what the page runs

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <camera-status-source>\n([\s\S]*?)\/\/ <\/camera-status-source>/.exec(page);
assertTrue(!!m, 'the page has a <camera-status-source> block');

// The shared test() is synchronous; the polling is async, so these tests run one after the other here, each awaited.
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of queue) {
    try { await fn(); pass += 1; console.log(`[PASS] ${name}`); } catch (err) { fail += 1; console.error(`[FAIL] ${name} -- ${err.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}
const flush = () => new Promise((r) => setImmediate(r));

function run({ answers = [] } = {}) {
  const log = [];
  const clock = { now: 1000000 };
  const fetches = [];
  const chips = [];   // what each camera's Wi-Fi chip was told: [element id, the reading]
  const els = {};     // the page's elements, one per id (the covers keep their `hidden` between calls, as on the page)
  const pillOf = (id) => els['sw-pill-' + id];
  const devices = []; // what each camera's board line was told: [element id, the device facts]
  const env = {
    document: { getElementById: (id) => (els[id] = els[id] || { id, hidden: true }) },
    CamOffline,
    CamWifi: { render: (el, wifi) => chips.push([el && el.id, wifi]) },
    CamDeviceInfo: { render: (el, device) => devices.push([el && el.id, device]) },
    isStatusMap: (data) => !!data && typeof data === 'object' && !Array.isArray(data) && !data.error,
    getAllCameraIds: () => ['a', 'b'],
    setFilesCount: (id, n) => log.push(`files ${id} ${n}`),
    applySwitchState: (id, off) => log.push(`switch ${id} ${off}`),
    applyRecordingState: (id, rec, end) => log.push(`recording ${id} ${rec} ${end}`),
    fetch: async (url) => {
      fetches.push(url);
      const answer = answers.shift() || { ok: true, json: {} };
      if (answer.throws) throw new Error('relay unreachable');
      return { ok: answer.ok, json: async () => answer.json };
    },
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${m[1]}\nreturn { pollAllStatuses, applyCameraStatuses, onLiveCameraStatus, showCameraStatusProblem, cameraDataIsDown };`)(...names.map((n) => env[n]));
  return { api, log, clock, fetches, chips, devices, els, pillOf };
}

const MAP = { a: { recording: true, recordingEndAt: 99, recordingCount: 3, recordingOff: 'off until 8:00' } };

test('a pushed map is applied to every camera; one the relay does not know has no footage and no switch', () => {
  const t = run();
  t.api.onLiveCameraStatus(MAP);
  assertEqual(t.log, ['recording a true 99', 'files a 3', 'switch a off until 8:00', 'files b 0', 'switch b null']);
});

test('every camera\'s Wi-Fi chip is given that camera\'s reading; a camera the relay does not know gets none', () => {
  const t = run();
  const wifi = { ssid: 'HomeNet', rssi: -61, ageMs: 900 };
  t.api.onLiveCameraStatus({ a: { recording: false, wifi } });
  assertEqual(t.chips, [['wifi-a', wifi], ['wifi-b', undefined]]);
});

test('a camera whose answer has no Wi-Fi (an older relay or firmware) is given nothing to show', () => {
  const t = run();
  t.api.onLiveCameraStatus({ a: { recording: false }, b: { recording: false, wifi: null } });
  assertEqual(t.chips, [['wifi-a', undefined], ['wifi-b', null]]);
});

// The cover of a camera's picture is the element `offline-<id>`; it is hidden as the page delivers it.
const covered = (t) => ['a', 'b'].map((id) => !t.els['offline-' + id].hidden);

test('a camera the relay says is offline gets its cover shown, one that is online does not', () => {
  const t = run();
  t.api.onLiveCameraStatus({ a: { online: false }, b: { online: true } });
  assertEqual(covered(t), [true, false]);
});

test('the cover goes when the camera is back, comes again when it drops, and each camera has its own', () => {
  const t = run();
  t.api.onLiveCameraStatus({ a: { online: false }, b: { online: true } });
  t.api.onLiveCameraStatus({ a: { online: true }, b: { online: true } });
  assertEqual(covered(t), [false, false], 'a is back');
  t.api.onLiveCameraStatus({ a: { online: true }, b: { online: false } });
  assertEqual(covered(t), [false, true], 'b dropped');
});

test('nothing is covered on a guess: a camera missing from the map, or one with no `online` (an older relay)', () => {
  const t = run();
  t.api.onLiveCameraStatus({ a: { recording: false } });
  assertEqual(covered(t), [false, false]);
  t.api.onLiveCameraStatus({ a: { online: false }, b: { online: false } });
  t.api.onLiveCameraStatus({ b: { online: false } });
  assertEqual(covered(t), [false, true], 'a left the map: it is not known to be offline any more');
});

test('a pushed answer and a polled one both cover an offline camera', async () => {
  const pushed = run();
  pushed.api.onLiveCameraStatus({ a: { online: false } });
  assertEqual(covered(pushed), [true, false], 'pushed');
  const polled = run({ answers: [{ ok: true, json: { b: { online: false } } }] });
  await polled.api.pollAllStatuses();
  assertEqual(covered(polled), [false, true], 'polled');
});

test('an answer that is not a genuine map, or a failed poll, leaves the covers as they are', async () => {
  const t = run({ answers: [{ ok: false, json: {} }, { ok: true, json: { error: 'Could not reach relay' } }, { throws: true }] });
  t.api.onLiveCameraStatus({ a: { online: false } });
  for (const bad of [{ error: 'x' }, [], null]) t.api.onLiveCameraStatus(bad);
  for (let i = 0; i < 3; i++) await t.api.pollAllStatuses();
  assertEqual(covered(t), [true, false], 'the relay could not be reached: the cover of a is not lifted on a guess');
});

test('the cover does not change what is shown about recording, files or the switch', () => {
  const t = run();
  t.api.onLiveCameraStatus({ a: { online: false, recording: true, recordingEndAt: 99, recordingCount: 3, recordingOff: null }, b: { online: true } });
  assertEqual(t.log, ['recording a true 99', 'files a 3', 'switch a null', 'recording b undefined undefined', 'files b undefined', 'switch b null']);
});

test('every camera\'s board line is given that camera\'s device facts; a camera the relay does not know, or an older relay, gets none', () => {
  const t = run();
  const device = { ip: '192.168.1.50', connectedForMs: 5000, fw: 'abc', uptimeMs: 9000, heapBytes: 81920 };
  t.api.onLiveCameraStatus({ a: { recording: false, device } });
  assertEqual(t.devices, [['dev-a', device], ['dev-b', undefined]]);
  const u = run();
  u.api.onLiveCameraStatus({ a: { recording: false }, b: { recording: false, device: null } });
  assertEqual(u.devices, [['dev-a', undefined], ['dev-b', null]]);
});

test('a pushed answer that is not a genuine map (error, list, null) changes nothing', () => {
  const t = run();
  for (const bad of [{ error: 'x' }, [], null, 'text', 5]) t.api.onLiveCameraStatus(bad);
  assertEqual(t.log, []);
});

test('there is no timer: the block asks status.php only when the page calls pollAllStatuses (after one of its own commands)', async () => {
  const t = run({ answers: [{ ok: true, json: MAP }] });
  t.api.onLiveCameraStatus(MAP);
  t.clock.now += 60000;
  await flush();
  assertEqual(t.fetches, [], 'pushes arriving, nothing asks');
  await t.api.pollAllStatuses();
  assertEqual(t.fetches, ['status.php'], 'one ask, when the page says so');
  assertTrue(!/setInterval|setTimeout/.test(m[1]), 'the block starts no timer');
});

test('asking status.php once applies a genuine map', async () => {
  const t = run({ answers: [{ ok: true, json: MAP }] });
  await t.api.pollAllStatuses();
  assertEqual(t.log[0], 'recording a true 99');
});

test('asking once: an error status, an error-shaped body, a list and an unreachable relay change nothing and do not throw', async () => {
  const t = run({ answers: [{ ok: false, json: MAP }, { ok: true, json: { error: 'Could not reach relay' } }, { ok: true, json: [] }, { throws: true }] });
  for (let i = 0; i < 4; i++) await t.api.pollAllStatuses();
  assertEqual(t.log, []);
});

// ── the connection is down ──
test('the connection is down: every camera\'s switch pill and the ALL pill say NO DATA, with neither the on nor the off look', () => {
  const t = run();
  t.api.onLiveCameraStatus(MAP);
  assertEqual(t.api.cameraDataIsDown(), false);
  t.api.showCameraStatusProblem();
  assertEqual(t.api.cameraDataIsDown(), true);
  for (const id of ['a', 'b']) assertEqual([t.pillOf(id).textContent, t.pillOf(id).className], ['NO DATA', 'switch-pill']);
  assertEqual([t.els['switch-all-pill'].textContent, t.els['switch-all-pill'].className], ['NO DATA', 'switch-pill']);
});

test('the connection is down: what is known about the footage is left alone (the FILES count, the covers, the REC countdown)', () => {
  const t = run();
  t.api.onLiveCameraStatus(MAP);
  t.log.length = 0;
  t.api.showCameraStatusProblem();
  assertEqual(t.log, [], 'no count, switch state or recording state was touched');
});

test('the next pushed map ends it: the page draws the real state again', () => {
  const t = run();
  t.api.showCameraStatusProblem();
  t.api.onLiveCameraStatus(MAP);
  assertEqual(t.api.cameraDataIsDown(), false);
});

test('a map that is not genuine does not end it (an error-shaped answer is not news)', () => {
  const t = run();
  t.api.showCameraStatusProblem();
  for (const bad of [{ error: 'x' }, [], null]) t.api.onLiveCameraStatus(bad);
  assertEqual(t.api.cameraDataIsDown(), true);
});

test('an answer to the one-off ask ends it too: the relay was reached', async () => {
  const t = run({ answers: [{ ok: true, json: MAP }] });
  t.api.showCameraStatusProblem();
  await t.api.pollAllStatuses();
  assertEqual(t.api.cameraDataIsDown(), false);
});

test('a failed one-off ask does not end it', async () => {
  const t = run({ answers: [{ throws: true }, { ok: false, json: MAP }] });
  t.api.showCameraStatusProblem();
  await t.api.pollAllStatuses();
  await t.api.pollAllStatuses();
  assertEqual(t.api.cameraDataIsDown(), true);
});

runAll();
