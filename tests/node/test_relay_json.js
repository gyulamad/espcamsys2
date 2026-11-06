'use strict';

// test_relay_json.js — php/cameras/js/relay-json.js: the answer of one of the dashboard's JSON pages as a plain
// object, or null whenever it cannot be trusted. fetch is replaced by a stand-in for each case.

const path = require('path');
const { assertEqual, assertTrue } = require('./framework');

const CamRelayJson = require(path.join(__dirname, '../../php/cameras/js/relay-json.js'));

// The shared test() is synchronous; these tests wait for promises, so they run one after the other here.
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of queue) {
    const realFetch = globalThis.fetch;
    try { await fn(); pass += 1; console.log(`[PASS] ${name}`); } catch (err) { fail += 1; console.error(`[FAIL] ${name} -- ${err.message}`); }
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

const answer = (body, { ok = true } = {}) => async (url, options) => ({ ok, json: async () => { if (body instanceof Error) throw body; return body; }, url, options });

test('get: an object answer is returned as it is', async () => {
  globalThis.fetch = answer({ cam1: { recording: true } });
  assertEqual(await CamRelayJson.get('status.php'), { cam1: { recording: true } });
});

test('get: asks the page with the login cookie and never from the browser cache', async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => { seen.push([url, options]); return { ok: true, json: async () => ({}) }; };
  await CamRelayJson.get('status.php');
  assertEqual(seen, [['status.php', { credentials: 'same-origin', cache: 'no-store' }]]);
});

test('get: an HTTP error status is "not known" (null), whatever the body says', async () => {
  globalThis.fetch = answer({ cam1: {} }, { ok: false });
  assertEqual(await CamRelayJson.get('status.php'), null);
});

test('get: an { error } answer, a list, a string, a number and null are all "not known"', async () => {
  for (const body of [{ error: 'relay down' }, [1, 2], 'text', 42, null, undefined]) {
    globalThis.fetch = answer(body);
    assertEqual(await CamRelayJson.get('status.php'), null, JSON.stringify(body));
  }
});

test('get: an unreachable relay and a body that is not JSON are "not known", never thrown', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assertEqual(await CamRelayJson.get('status.php'), null);
  globalThis.fetch = answer(new SyntaxError('Unexpected token <'));
  assertEqual(await CamRelayJson.get('status.php'), null);
});

test('get: an empty object is an answer (no camera known yet), not a failure', async () => {
  globalThis.fetch = answer({});
  const got = await CamRelayJson.get('status.php');
  assertTrue(got !== null && Object.keys(got).length === 0);
});

runAll();
