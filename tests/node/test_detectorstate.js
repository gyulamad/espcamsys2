'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const ds = require('../../nodejs/camera-relay/lib/detectorstate');

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]).toString('base64');

function good() {
  return {
    ip: '192.168.4.37', fw: 'abc', uptimeMs: 1234, rssi: -60,
    gpio: { pin: 13, high: false },
    scene: { state: 'active', brightness: 120, motion: 812, darkBelow: 40, motionAtLeast: 300, holdS: 10 },
    person: { score: 0.74, detectAt: 0.6, clearAt: 0.5, detected: true },
    jpeg: JPEG_B64,
  };
}

test('parseReport: a complete report is accepted and the picture decoded', () => {
  const r = ds.parseReport(good());
  assertTrue(r.ok, r.error);
  assertEqual(r.report.scene.brightness, 120);
  assertEqual(r.report.gpio, { pin: 13, high: false });
  assertEqual(r.report.person.score, 0.74);
  assertEqual(r.jpeg[0], 0xff);
  assertEqual(r.jpeg.length, 8);
});

test('parseReport: no picture and no score are fine (model paused)', () => {
  const b = good(); delete b.jpeg; b.person.score = null;
  const r = ds.parseReport(b);
  assertTrue(r.ok, r.error);
  assertEqual(r.jpeg, null);
  assertEqual(r.report.person.score, null);
});

test('parseReport: rejects what is not a report', () => {
  for (const bad of [null, 'x', [], 5]) assertEqual(ds.parseReport(bad).ok, false);
});

test('parseReport: rejects out-of-range or missing numbers, bad state, bad booleans', () => {
  const mutate = (fn) => { const b = good(); fn(b); return ds.parseReport(b).ok; };
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
});

test('parseReport: rejects a picture that is not a base64 JPEG', () => {
  const mutate = (v) => { const b = good(); b.jpeg = v; return ds.parseReport(b).ok; };
  assertEqual(mutate('not base64!!'), false);
  assertEqual(mutate(5), false);
  assertEqual(mutate(Buffer.from('hello world').toString('base64')), false);   // not a JPEG
  assertEqual(mutate('A'.repeat(ds.MAX_JPEG_BYTES * 2 + 4)), false);          // too big
  assertEqual(mutate(Buffer.alloc(ds.MAX_JPEG_BYTES + 10, 0xff).toString('base64')), false);
});

test('parseReport: long text is cut, odd text fields become empty', () => {
  const b = good(); b.ip = 'x'.repeat(500); b.fw = 7;
  const r = ds.parseReport(b);
  assertEqual(r.report.ip.length, 64);
  assertEqual(r.report.fw, '');
});

test('buildView: never heard from, fresh, and stale', () => {
  assertEqual(ds.buildView(undefined, 1000), { online: false, ageMs: null, report: null });
  assertEqual(ds.buildView({ report: null, receivedAt: 0 }, 1000).online, false);
  const rep = ds.parseReport(good()).report;
  const fresh = ds.buildView({ report: rep, receivedAt: 900 }, 1000);
  assertEqual(fresh.online, true);
  assertEqual(fresh.ageMs, 100);
  assertEqual(ds.buildView({ report: rep, receivedAt: 1000 - ds.STALE_MS - 1 }, 1000).online, false);
  assertEqual(ds.buildView({ report: rep, receivedAt: 2000 }, 1000).ageMs, 0); // clock step backwards
});

summarize();
