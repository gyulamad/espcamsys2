'use strict';

// test_index_camera_status.js — how the dashboard page (php/cameras/index.php) keeps the REC pills, FILES counts, switches
// and the "camera offline" covers current: the map pushed on the mux.php connection when it comes, status.php polled
// otherwise. Runs exactly the block between its <camera-status-source> markers against stand-ins for the page (no PHP,
// no browser).

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
  const env = {
    document: { getElementById: (id) => (els[id] = els[id] || { id, hidden: true }) },
    CamOffline,
    CamWifi: { render: (el, wifi) => chips.push([el && el.id, wifi]) },
    Date: { now: () => clock.now },
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
  const api = new Function(...names, `${m[1]}\nreturn { pollAllStatuses, applyCameraStatuses, onLiveCameraStatus, cameraStatusIsLive, pollStatusesUnlessLive, CAMERA_STATUS_LIVE_MS };`)(...names.map((n) => env[n]));
  return { api, log, clock, fetches, chips, els };
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

test('a pushed answer that is not a genuine map (error, list, null) changes nothing and does not count as live', () => {
  const t = run();
  for (const bad of [{ error: 'x' }, [], null, 'text', 5]) t.api.onLiveCameraStatus(bad);
  assertEqual([t.log, t.api.cameraStatusIsLive()], [[], false]);
});

test('a pushed map makes the status live for a while, and only a while', () => {
  const t = run();
  assertEqual(t.api.cameraStatusIsLive(), false, 'before the first push');
  t.api.onLiveCameraStatus(MAP);
  assertEqual(t.api.cameraStatusIsLive(), true);
  t.clock.now += t.api.CAMERA_STATUS_LIVE_MS - 1;
  assertEqual(t.api.cameraStatusIsLive(), true);
  t.clock.now += 1;
  assertEqual(t.api.cameraStatusIsLive(), false, 'the pushes stopped');
});

test('the interval asks status.php while nothing is pushed, and stays quiet while pushes arrive', async () => {
  const t = run({ answers: [{ ok: true, json: MAP }, { ok: true, json: MAP }] });
  t.api.pollStatusesUnlessLive();
  await flush();
  assertEqual(t.fetches, ['status.php']);
  t.api.onLiveCameraStatus(MAP);
  t.clock.now += 4000;
  t.api.pollStatusesUnlessLive();
  await flush();
  assertEqual(t.fetches.length, 1, 'a push 4 s ago: no request');
  t.clock.now += 5000;
  t.api.pollStatusesUnlessLive();
  await flush();
  assertEqual(t.fetches.length, 2, 'the pushes stopped: polling takes over again');
});

test('polling status.php applies a genuine map, as it always did', async () => {
  const t = run({ answers: [{ ok: true, json: MAP }] });
  await t.api.pollAllStatuses();
  assertEqual(t.log[0], 'recording a true 99');
  assertEqual(t.api.cameraStatusIsLive(), false, 'an answer to a request is not a push');
});

test('polling: an error status, an error-shaped body, a list and an unreachable relay change nothing and do not throw', async () => {
  const t = run({ answers: [{ ok: false, json: MAP }, { ok: true, json: { error: 'Could not reach relay' } }, { ok: true, json: [] }, { throws: true }] });
  for (let i = 0; i < 4; i++) await t.api.pollAllStatuses();
  assertEqual(t.log, []);
});

runAll();
