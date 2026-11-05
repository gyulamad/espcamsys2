'use strict';

// test_index_camera_status.js — how the dashboard page (php/cameras/index.php) keeps the REC pills, FILES counts and
// switches current: the map pushed on the mux.php connection when it comes, status.php polled otherwise. Runs
// exactly the block between its <camera-status-source> markers against stand-ins for the page (no PHP, no browser).

const fs = require('fs');
const path = require('path');
const { assertEqual, assertTrue } = require('./framework');

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
  const env = {
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
  return { api, log, clock, fetches };
}

const MAP = { a: { recording: true, recordingEndAt: 99, recordingCount: 3, recordingOff: 'off until 8:00' } };

test('a pushed map is applied to every camera; one the relay does not know has no footage and no switch', () => {
  const t = run();
  t.api.onLiveCameraStatus(MAP);
  assertEqual(t.log, ['recording a true 99', 'files a 3', 'switch a off until 8:00', 'files b 0', 'switch b null']);
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
