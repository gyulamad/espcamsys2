'use strict';

// statusView.js — builds the per-camera JSON shape returned by GET
// /status, extracted out of server.js so the shape can be pinned down
// with a test independent of Express or the in-memory `cameras` store.
// `preRoll` is the camera's rolling-buffer fill (see lib/preroll.js) —
// bufferedSeconds close to windowSeconds means a recording started right
// now would get a full lead-in. `recordingCount` is how many saved
// recordings the camera has (null if the folder couldn't be read) — the
// dashboard shows it on the FILES button so you can see it without opening the list.
// `recordingOff` says whether the camera is switched OFF (see lib/recswitch.js): null when it may record.

// `online`: the camera sent a frame within the last ONLINE_WINDOW_MS (a camera that is switched off, out of Wi-Fi range or
// not yet connected stops sending; its last frame stays in the relay, which is why a viewer must not trust the picture
// alone). Worked out here, with the relay's clock, so a viewer's own clock can not make a camera look online or offline.
const ONLINE_WINDOW_MS = 5000;

function isOnline(lastSeen, now) {
  if (!lastSeen) return false;
  const age = now - new Date(lastSeen).getTime();
  return Number.isFinite(age) && age <= ONLINE_WINDOW_MS;
}

// `wifi` is the Wi-Fi network the camera reported and its signal ({ ssid, rssi, ageMs }, see lib/wifiinfo.js), null when
// the camera has not reported one lately (an older firmware never does).
const wifiinfo = require('./wifiinfo');
// `device` is what the relay knows about the camera's board besides its Wi-Fi ({ ip, connectedForMs, fw, uptimeMs,
// heapBytes }, see lib/deviceinfo.js); null when nothing is known. The dashboard shows it like a detector's report.
const deviceinfo = require('./deviceinfo');

function buildCameraStatusView(cam, recordingCount = null, recordingOff = null, now = Date.now()) {
  const online = isOnline(cam.lastSeen, now);
  return {
    lastSeen: cam.lastSeen,
    online,
    recording: !!cam.recording,
    recordingStartedAt: cam.recording ? cam.recording.startedAt : null,
    recordingEndAt: cam.recording ? cam.recording.endAt : null,
    preRoll: cam.preRoll ? cam.preRoll.stats : { frames: 0, bytes: 0, bufferedSeconds: 0, windowSeconds: 0 },
    recordingCount,
    wifi: wifiinfo.describe(cam.wifi, now),
    device: deviceinfo.describe(cam, online, now),
    recordingOff, // null = this camera may record; otherwise { forever, until, remainingMs } — it is switched OFF
  };
}

module.exports = { buildCameraStatusView, isOnline, ONLINE_WINDOW_MS };
