'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { buildCameraStatusView, isOnline, ONLINE_WINDOW_MS } = require('../../nodejs/camera-relay/lib/statusView');
const { PreRollBuffer } = require('../../nodejs/camera-relay/lib/preroll');

const EMPTY_PREROLL = { frames: 0, bytes: 0, bufferedSeconds: 0, windowSeconds: 0 };

test('buildCameraStatusView: idle camera that has never recorded', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam), {
    lastSeen: null,
    online: false,        // never seen: not online
    recording: false,
    recordingStartedAt: null,
    recordingEndAt: null,
    preRoll: EMPTY_PREROLL,
    recordingCount: null, // not known unless the caller says
    wifi: null,           // the camera has not reported its Wi-Fi network
    recordingOff: null,   // may record, unless the caller says it is switched OFF
  });
});

test('isOnline: a frame within the window counts, an older one or none does not', () => {
  const now = 1000000;
  assertEqual(isOnline(new Date(now), now), true);
  assertEqual(isOnline(new Date(now - ONLINE_WINDOW_MS), now), true, 'exactly at the edge is still online');
  assertEqual(isOnline(new Date(now - ONLINE_WINDOW_MS - 1), now), false);
  assertEqual(isOnline(null, now), false);
  assertEqual(isOnline(undefined, now), false);
  assertEqual(isOnline('not a date', now), false);
});

test('buildCameraStatusView: online follows the age of the last frame (with the clock it is given)', () => {
  const cam = { lastSeen: new Date(10000), recording: null };
  assertEqual(buildCameraStatusView(cam, null, null, 12000).online, true);
  assertEqual(buildCameraStatusView(cam, null, null, 10000 + ONLINE_WINDOW_MS + 1).online, false);
});

test('buildCameraStatusView: currently recording', () => {
  const startedAt = new Date(1000);
  const endAt = new Date(2000);
  const cam = { lastSeen: new Date(500), recording: { startedAt, endAt } };
  const view = buildCameraStatusView(cam);
  assertEqual(view.recording, true);
  assertEqual(view.recordingStartedAt, startedAt);
  assertEqual(view.recordingEndAt, endAt);
});

test('buildCameraStatusView: no longer reports any power state (cameras always stream)', () => {
  const view = buildCameraStatusView({ lastSeen: null, recording: null });
  assertTrue(!('enabled' in view) && !('enabledUntil' in view), 'power fields must be gone');
});

test('buildCameraStatusView: reports the pre-roll buffer fill', () => {
  const preRoll = new PreRollBuffer({ seconds: 5 });
  preRoll.push(Buffer.alloc(10), 1000);
  preRoll.push(Buffer.alloc(10), 3000);
  const view = buildCameraStatusView({ lastSeen: new Date(3000), recording: null, preRoll });
  assertEqual(view.preRoll, { frames: 2, bytes: 20, bufferedSeconds: 2, windowSeconds: 5 });
});

test('buildCameraStatusView: reports how many recordings the camera has (for the dashboard FILES button)', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam, 7).recordingCount, 7);
  assertEqual(buildCameraStatusView(cam, 0).recordingCount, 0, '0 is a real count, not "unknown"');
  assertEqual(buildCameraStatusView(cam, null).recordingCount, null, 'null = the folder could not be read');
});

test('buildCameraStatusView: a camera that only exists as a folder of footage (never seen) still builds', () => {
  const view = buildCameraStatusView({ lastSeen: null, recording: null, preRoll: null }, 3);
  assertEqual(view.recording, false);
  assertEqual(view.preRoll, EMPTY_PREROLL);
  assertEqual(view.recordingCount, 3);
});

test('buildCameraStatusView: reports whether the camera is switched OFF (for the dashboard)', () => {
  const cam = { lastSeen: null, recording: null };
  assertEqual(buildCameraStatusView(cam, 0, null).recordingOff, null);
  const off = { forever: false, until: '2026-10-03T13:00:00.000Z', remainingMs: 1800000 };
  assertEqual(buildCameraStatusView(cam, 0, off).recordingOff, off);
  assertEqual(buildCameraStatusView(cam, 0, { forever: true, until: null, remainingMs: null }).recordingOff.forever, true);
});

test('buildCameraStatusView: the Wi-Fi network and signal the camera reported, with the reading\'s age', () => {
  const cam = { lastSeen: null, recording: null, wifi: { ssid: 'HomeNet', rssi: -61, at: 1000 } };
  assertEqual(buildCameraStatusView(cam, null, null, 4000).wifi, { ssid: 'HomeNet', rssi: -61, ageMs: 3000 });
});

test('buildCameraStatusView: a stale Wi-Fi reading (camera gone quiet) is not shown as current', () => {
  const cam = { lastSeen: null, recording: null, wifi: { ssid: 'HomeNet', rssi: -61, at: 0 } };
  assertEqual(buildCameraStatusView(cam, null, null, 10 * 60 * 1000).wifi, null);
});

summarize();
