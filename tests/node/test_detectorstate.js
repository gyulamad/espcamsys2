'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ds = require('../../nodejs/camera-relay/lib/detectorstate');

function good() {
  return {
    ip: '192.168.4.37', fw: 'abc', uptimeMs: 1234, rssi: -60,
    gpio: { pin: 13, high: false },
    scene: { state: 'active', brightness: 120, motion: 812, darkBelow: 40, motionAtLeast: 300, holdS: 10, area: { x0: 10, y0: 20, x1: 60, y1: 90 } },
    person: { score: 0.74, detectAt: 0.6, clearAt: 0.5, detected: true },
    link: { frames: 42, jpegFails: 1, reconnects: 2, heap: 91000 },
  };
}

// ── parseStatus ─────────────────────────────────────────────────────────

test('parseStatus: complete readings are accepted', () => {
  const r = ds.parseStatus(good());
  assertTrue(r.ok, r.error);
  assertEqual(r.report.scene.brightness, 120);
  assertEqual(r.report.gpio, { pin: 13, high: false });
  assertEqual(r.report.person.score, 0.74);
  assertEqual(r.report.link, { frames: 42, jpegFails: 1, reconnects: 2, heap: 91000 });
});

test('parseStatus: the motion area is carried to the dashboard as reported', () => {
  const r = ds.parseStatus(good());
  assertTrue(r.ok, r.error);
  assertEqual(r.report.scene.area, { x0: 10, y0: 20, x1: 60, y1: 90 });
  const b = good(); b.scene.area = { x0: 0, y0: 0, x1: 96, y1: 96 };
  assertEqual(ds.parseStatus(b).report.scene.area, { x0: 0, y0: 0, x1: 96, y1: 96 }, 'the whole picture');
});

test('parseStatus: firmware from before the motion area sends none, which is not an error', () => {
  const b = good(); delete b.scene.area;
  const r = ds.parseStatus(b);
  assertTrue(r.ok, r.error);
  assertEqual(r.report.scene.area, null, 'null: the dashboard shows no area for it');
  b.scene.area = null;
  assertEqual(ds.parseStatus(b).report.scene.area, null);
});

test('parseStatus: a motion area that is not a rectangle inside the picture is refused', () => {
  const area = (a) => { const b = good(); b.scene.area = a; return ds.parseStatus(b); };
  const full = { x0: 0, y0: 0, x1: 96, y1: 96 };
  for (const bad of [
    { ...full, x0: -1 }, { ...full, y0: -1 }, { ...full, x1: 97 }, { ...full, y1: 97 },
    { ...full, x0: 50, x1: 50 }, { ...full, y0: 60, y1: 40 },
    { ...full, x0: 1.5 }, { ...full, x1: '96' }, { ...full, y1: NaN }, { ...full, x0: Infinity },
    { x0: 0, y0: 0, x1: 96 }, {}, [], 'all', 5, true,
  ]) {
    const r = area(bad);
    assertEqual(r.ok, false, JSON.stringify(bad));
    assertTrue(/scene\.area/.test(r.error), 'the error names the member: ' + r.error);
  }
  assertEqual(area({ x0: 95, y0: 95, x1: 96, y1: 96 }).ok, true, 'any rectangle inside the picture is a reading; the minimum size is the settings\' business');
});

test('parseArea: only the four edges are kept', () => {
  assertEqual(ds.parseArea({ x0: 1, y0: 2, x1: 30, y1: 40, junk: 'x' }), { ok: true, area: { x0: 1, y0: 2, x1: 30, y1: 40 } });
  assertEqual(ds.parseArea(undefined), { ok: true, area: null });
  assertEqual(ds.FRAME_SIZE, 96);
});

test('parseStatus: no score is fine (model paused)', () => {
  const b = good(); b.person.score = null;
  assertEqual(ds.parseStatus(b).report.person.score, null);
  delete b.person.score;
  assertEqual(ds.parseStatus(b).report.person.score, null);
});

test('parseStatus: the link statistics are optional and never a reason to refuse', () => {
  const b = good(); delete b.link;
  assertEqual(ds.parseStatus(b).report.link, { frames: null, jpegFails: null, reconnects: null, heap: null });
  b.link = { frames: -3, jpegFails: 'x', heap: 1e12 };
  const r = ds.parseStatus(b);
  assertTrue(r.ok, 'odd diagnostics do not spoil the readings');
  assertEqual(r.report.link, { frames: null, jpegFails: null, reconnects: null, heap: null });
  b.link = [1, 2];
  assertTrue(ds.parseStatus(b).ok);
});

test('parseStatus: rejects what is not a status object', () => {
  for (const bad of [null, undefined, 'x', [], 5]) assertEqual(ds.parseStatus(bad).ok, false);
});

test('parseStatus: rejects out-of-range or missing numbers, bad state, bad booleans', () => {
  const mutate = (fn) => { const b = good(); fn(b); return ds.parseStatus(b).ok; };
  assertEqual(mutate((b) => { b.scene.brightness = 256; }), false);
  assertEqual(mutate((b) => { b.scene.motion = -1; }), false);
  assertEqual(mutate((b) => { delete b.scene.darkBelow; }), false);
  assertEqual(mutate((b) => { b.person.detectAt = 1.5; }), false);
  assertEqual(mutate((b) => { b.gpio.pin = 'x'; }), false);
  assertEqual(mutate((b) => { b.scene.state = 'weird'; }), false);
  assertEqual(mutate((b) => { b.gpio.high = 1; }), false);
  assertEqual(mutate((b) => { b.person.detected = 'yes'; }), false);
  assertEqual(mutate((b) => { b.person.score = 2; }), false);
  assertEqual(mutate((b) => { delete b.gpio; }), false);
  assertEqual(mutate((b) => { b.scene.motion = Infinity; }), false);
  assertEqual(mutate((b) => { b.scene.motion = NaN; }), false);
});

test('parseStatus: long text is cut, odd text fields become empty, a picture member is not carried', () => {
  const b = good(); b.ip = 'x'.repeat(500); b.fw = 7; b.jpeg = 'AAAA';
  const r = ds.parseStatus(b);
  assertEqual(r.report.ip.length, 64);
  assertEqual(r.report.fw, '');
  assertEqual(r.report.jpeg, undefined, 'pictures travel as bytes, never inside the readings');
});

// ── buildView ───────────────────────────────────────────────────────────

const rec = (over = {}) => ({
  report: ds.parseStatus(good()).report, receivedAt: 900, frameAt: 900, connected: true, ip: '10.0.0.5', connectedAt: 100,
  lastDisconnectAt: 0, lastDisconnectWhy: '', ...over,
});

test('buildView: never heard from', () => {
  const v = ds.buildView(undefined, 1000);
  assertEqual(v.state, 'never');
  assertEqual(v.online, false);
  assertEqual(v.report, null);
  assertTrue(/has not heard from this detector/.test(v.message));
});

test('buildView: a healthy detector has no message and carries its readings', () => {
  const v = ds.buildView(rec(), 1000);
  assertEqual(v.state, 'online');
  assertEqual([v.online, v.hasPicture, v.connected], [true, true, true]);
  assertEqual(v.message, '');
  assertEqual(v.ageMs, 100);
  assertEqual(v.pictureAgeMs, 100);
  assertEqual(v.connectedForMs, 900);
  assertEqual(v.ip, '10.0.0.5');
  assertEqual(v.report.scene.brightness, 120);
});

test('buildView: quiet for longer than STALE_MS is offline, and says for how long', () => {
  const t = 900 + ds.STALE_MS;
  assertEqual(ds.buildView(rec(), t).online, true, 'exactly at the limit is still online');
  const v = ds.buildView(rec({ connected: false, lastDisconnectAt: 950, lastDisconnectWhy: 'the connection was reset' }), t + 1);
  assertEqual(v.state, 'offline');
  assertEqual(v.online, false);
  assertTrue(/last heard 5 s ago/.test(v.message), v.message);
  assertTrue(/connection ended \(the connection was reset\)/.test(v.message), v.message);
  assertEqual(v.lastDisconnect.why, 'the connection was reset');
  assertEqual(v.connectedForMs, null);
});

test('buildView: offline and never disconnected, and offline while still connected, read differently', () => {
  const gone = ds.buildView(rec({ connected: false }), 20900);
  assertTrue(/last heard 20 s ago; it is not connected/.test(gone.message), gone.message);
  const stuck = ds.buildView(rec({ connected: true }), 20900);
  assertTrue(/connection is open but nothing has arrived for 20 s/.test(stuck.message), stuck.message);
  const mute = ds.buildView(rec({ connected: true, receivedAt: 0, report: null }), 20000);
  assertTrue(/connected but has not sent anything yet/.test(mute.message), mute.message);
  const never = ds.buildView(rec({ connected: false, receivedAt: 0, report: null }), 20000);
  assertTrue(/^never heard from/.test(never.message), never.message);
});

test('buildView: numbers without a picture are "no-picture", with the board\'s own count of failures when it gave one', () => {
  const none = ds.buildView(rec({ frameAt: 0, report: { ...rec().report, link: { jpegFails: 0 } } }), 1000);
  assertEqual(none.state, 'no-picture');
  assertEqual([none.online, none.hasPicture], [true, false]);
  assertTrue(/has not sent a picture yet/.test(none.message), none.message);
  const failing = ds.buildView(rec({ frameAt: 0 }), 1000);   // good() reports jpegFails: 1
  assertTrue(/1 failed JPEG encodings/.test(failing.message), failing.message);
  // numbers arrived a second ago, the last picture eight seconds ago
  const old = ds.buildView(rec({ receivedAt: 7000, frameAt: 100, report: { ...rec().report, link: { jpegFails: 0 } } }), 8000);
  assertEqual(old.state, 'no-picture');
  assertTrue(/last picture is 8 s old/.test(old.message), old.message);
  // a picture that is only a couple of seconds old is still a picture
  assertEqual(ds.buildView(rec({ receivedAt: 7000, frameAt: 5000 }), 8000).state, 'online');
});

test('buildView: a clock step backwards never gives a negative age', () => {
  const v = ds.buildView(rec({ receivedAt: 2000, frameAt: 2000, connectedAt: 2000 }), 1000);
  assertEqual([v.ageMs, v.pictureAgeMs, v.connectedForMs], [0, 0, 0]);
});

test('describeAge: seconds, minutes, hours', () => {
  assertEqual(ds.describeAge(0), '0 s');
  assertEqual(ds.describeAge(42400), '42 s');
  assertEqual(ds.describeAge(59400), '59 s');
  assertEqual(ds.describeAge(59600), '1 min 0 s', 'rounds first, so 59.6 s is a minute, not "60 s"');
  assertEqual(ds.describeAge(60000), '1 min 0 s');
  assertEqual(ds.describeAge(185000), '3 min 5 s');
  assertEqual(ds.describeAge(3 * 3600 * 1000 + 12 * 60 * 1000), '3 h 12 min');
  assertEqual(ds.describeAge(-5), '0 s');
});

// ── the live view that is switched off (idle) ───────────────────────────

test('buildView: resting detector (live view off, it still asks every ~30 s) is idle, not offline', () => {
  const v = ds.buildView(rec({ connected: false, receivedAt: 1000, frameAt: 1000, lastDisconnectAt: 1200, lastDisconnectWhy: 'the board closed the connection', polledAt: 60000, polls: 3 }), 70000);
  assertEqual(v.state, 'idle');
  assertEqual(v.online, false);
  assertEqual(v.report, null, 'old numbers are not shown as if they were live');
  assertTrue(v.view.supported && v.view.idleFresh);
  assertTrue(/live view is off/.test(v.message));
});

test('buildView: a detector that stopped asking is offline again', () => {
  const v = ds.buildView(rec({ connected: false, receivedAt: 1000, frameAt: 1000, polledAt: 1000, polls: 3 }), 1000 + 80000);
  assertEqual(v.state, 'offline');
  assertTrue(/last heard/.test(v.message));
});

test('buildView: streaming wins over idle (numbers arriving are shown)', () => {
  const v = ds.buildView(rec({ polledAt: 950, polls: 1 }), 1000);
  assertEqual(v.state, 'online');
  assertTrue(v.report !== null);
});

test('buildView: an older firmware (never asks) has no switchable view', () => {
  const v = ds.buildView(rec(), 1000);
  assertEqual(v.view.supported, false);
});

test('parseStatus: viewLeftS is optional and checked', () => {
  assertEqual(ds.parseStatus(good()).report.viewLeftS, null);
  assertEqual(ds.parseStatus(Object.assign(good(), { viewLeftS: 540 })).report.viewLeftS, 540);
  assertEqual(ds.parseStatus(Object.assign(good(), { viewLeftS: -1 })).report.viewLeftS, null);
  assertEqual(ds.parseStatus(Object.assign(good(), { viewLeftS: 'x' })).report.viewLeftS, null);
});

summarize();
