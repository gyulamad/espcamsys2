'use strict';

// test_relay_json.js — php/cameras/js/relay-json.js: the answer of one of the dashboard's JSON pages as a plain
// object, or null whenever it cannot be trusted. fetch is replaced by a stand-in for each case.

const path = require('path');
const { asyncTest: test, assertEqual, assertTrue, runAsyncTests } = require('./framework');

const CamRelayJson = require(path.join(__dirname, '../../php/cameras/js/relay-json.js'));

const realFetch = globalThis.fetch;   // put back after every test

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

test('request: an object answer is { data }', async () => {
  globalThis.fetch = answer({ rows: [] });
  assertEqual(await CamRelayJson.request('ota-status.php'), { data: { rows: [] } });
});

test('request: the page\'s own { error } words are the error, whatever the status', async () => {
  globalThis.fetch = answer({ error: 'missing or wrong control key' }, { ok: false });
  assertEqual(await CamRelayJson.request('ota-status.php'), { error: 'missing or wrong control key' });
  globalThis.fetch = answer({ error: 'Could not reach relay' }, { ok: true });
  assertEqual(await CamRelayJson.request('ota-status.php'), { error: 'Could not reach relay' });
});

test('request: an error status without words says the status; an answer that is not an object says so', async () => {
  globalThis.fetch = answer({}, { ok: false });
  assertEqual(await CamRelayJson.request('x.php'), { error: 'the dashboard answered HTTP undefined' });
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('<html>'); } });
  assertEqual(await CamRelayJson.request('x.php'), { error: 'the dashboard answered HTTP 502' });
  globalThis.fetch = answer([1, 2]);
  assertEqual(await CamRelayJson.request('x.php'), { error: 'the answer was not what was expected' });
  globalThis.fetch = answer(null);
  assertEqual(await CamRelayJson.request('x.php'), { error: 'the answer was not what was expected' });
});

test('request: a page that cannot be reached at all', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assertEqual(await CamRelayJson.request('ota-status.php'), { error: 'the dashboard could not be reached' });
});

runAsyncTests({ afterEach: () => { globalThis.fetch = realFetch; } });
