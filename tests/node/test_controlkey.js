'use strict';

// test_controlkey.js — nodejs/camera-relay/lib/controlkey.js: the control-key check in front of the relay's dashboard and tool
// routes. Fake requests, responses, throttle and log stand in for server.js's, so what is checked is what the guard
// decides: who gets through, what the refusal says, and what is written to the log.

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { createGuardFactory } = require('../../nodejs/camera-relay/lib/controlkey');

function harness({ checkResult = 'ok', allow = true, suppressed = 0, hasKey = true } = {}) {
  const state = { hasKey };
  const calls = { checkKey: [], throttle: [], log: [], next: 0, sent: [] };
  const guard = createGuardFactory({
    hasKey: () => state.hasKey,
    checkKey: (req, res, presented) => { calls.checkKey.push(presented); return checkResult; },
    normalizeIp: (addr) => (addr ? addr.replace(/^::ffff:/, '') : ''),
    log: (level, text) => calls.log.push([level, text]),
    suppressedNote: (n) => (n > 0 ? ` (${n} more suppressed)` : ''),
  });
  const throttle = { check: (key, now) => { calls.throttle.push(key); return { allow, suppressed }; } };
  const res = { status(code) { this.code = code; return this; }, json(body) { calls.sent.push([this.code, body]); return this; } };
  const req = (headers = {}, addr = '::ffff:192.168.4.9') => ({ method: 'POST', path: '/ota/recorder', headers, socket: { remoteAddress: addr } });
  const run = (mw, r) => mw(r, res, () => { calls.next += 1; });
  return { calls, guard, throttle, req, run, state };
}

test('a configured key that checks out lets the request through, and nothing else happens', () => {
  const h = harness({ checkResult: 'ok' });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({ 'x-control-key': 'k' }));
  assertEqual([h.calls.next, h.calls.sent, h.calls.log, h.calls.throttle], [1, [], [], []]);
  assertEqual(h.calls.checkKey, ['k'], 'the X-Control-Key header is what is checked');
});

test('no controlKey configured: refused with the route\'s own message (503), the key is not even checked', () => {
  const h = harness({ hasKey: false });
  const mw = h.guard({ disabled: 'switching is disabled: controlKey is not set in the relay config', throttle: h.throttle });
  h.run(mw, h.req());
  assertEqual(h.calls.sent, [[503, { error: 'switching is disabled: controlKey is not set in the relay config' }]]);
  assertEqual([h.calls.next, h.calls.checkKey, h.calls.log], [0, [], []]);
});

test('no controlKey configured, failOpen: the request goes through (the reads the operator opened up)', () => {
  const h = harness({ hasKey: false });
  const mw = h.guard({ failOpen: true, disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req());
  assertEqual([h.calls.next, h.calls.sent, h.calls.checkKey], [1, [], []]);
});

test('failOpen applies only when there is no key: with one configured, a wrong key is still refused', () => {
  const h = harness({ checkResult: 'bad' });
  const mw = h.guard({ failOpen: true, disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({ 'x-control-key': 'nope' }));
  assertEqual([h.calls.next, h.calls.sent.map((s) => s[0])], [0, [401]]);
});

test('a locked-out address: checkKey has answered (429), the guard says and logs nothing more', () => {
  const h = harness({ checkResult: 'locked' });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({ 'x-control-key': 'k' }));
  assertEqual([h.calls.next, h.calls.sent, h.calls.log, h.calls.throttle], [0, [], [], []]);
});

test('a wrong or missing key: 401 "missing or wrong control key" and one WARN line naming the request and the address', () => {
  const h = harness({ checkResult: 'bad' });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({}));
  assertEqual(h.calls.sent, [[401, { error: 'missing or wrong control key' }]]);
  assertEqual(h.calls.log, [['WARN', 'REJECTED a POST /ota/recorder from 192.168.4.9: missing or wrong control key']]);
  assertEqual([h.calls.next, h.calls.checkKey], [0, [undefined]]);
});

test('the refusal is logged at most once a minute: when the throttle says no, it is still a 401 but nothing is logged', () => {
  const h = harness({ checkResult: 'bad', allow: false });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({ 'x-control-key': 'x' }));
  assertEqual([h.calls.sent.map((s) => s[0]), h.calls.log], [[401], []]);
});

test('a logged refusal says how many were left out since the last line', () => {
  const h = harness({ checkResult: 'bad', suppressed: 7 });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({ 'x-control-key': 'x' }));
  assertTrue(h.calls.log[0][1].endsWith('missing or wrong control key (7 more suppressed)'), h.calls.log[0][1]);
});

test('an address that is not known is "unknown address" in the log and "unknown" for the throttle', () => {
  const h = harness({ checkResult: 'bad' });
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req({}, ''));
  assertEqual(h.calls.throttle, ['unknown']);
  assertTrue(h.calls.log[0][1].includes('from unknown address:'), h.calls.log[0][1]);
});

test('throttleKey and subject are the route\'s own: the throttle counts by what the route says, the log line names what the route says', () => {
  const h = harness({ checkResult: 'bad' });
  const mw = h.guard({
    disabled: 'off', throttle: h.throttle,
    throttleKey: (ip) => `put:${ip}`,
    subject: (req, from) => `a recording on/off request from ${from} (${req.method} ${req.path})`,
  });
  h.run(mw, h.req({}));
  assertEqual(h.calls.throttle, ['put:192.168.4.9']);
  assertEqual(h.calls.log, [['WARN', 'REJECTED a recording on/off request from 192.168.4.9 (POST /ota/recorder): missing or wrong control key']]);
});

test('hasKey is asked on every request, so a key that is set later counts at once', () => {
  const h = harness({ checkResult: 'ok' });
  h.state.hasKey = false;
  const mw = h.guard({ disabled: 'off', throttle: h.throttle });
  h.run(mw, h.req());
  h.state.hasKey = true;
  h.run(mw, h.req({ 'x-control-key': 'k' }));
  assertEqual([h.calls.sent.map((s) => s[0]), h.calls.next], [[503], 1]);
});

summarize();
