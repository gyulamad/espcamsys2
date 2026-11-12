'use strict';

// detectorstate.js — what the relay keeps about a person detector
// (ESP32_CAM_TFLite_Person) so the dashboard can show, under a camera's picture,
// what the detector sees (its 96x96 grayscale frame) and the numbers behind its
// alarm line: brightness, motion, person score, their thresholds and the level of
// the alarm GPIO. That is what you need to AIM a detector and choose its thresholds
// per camera with visual confirmation.
//
// A detector is NOT a recording camera: it is kept apart from the `cameras` map in
// server.js, so it never appears in /status, is never recorded and is not hit by
// "alarm all". It pushes its frames and readings up one long-lived connection (see
// detectorlink.js for the wire protocol); this file validates the readings it sends
// and shapes what the dashboard reads back — including, when the detector is NOT
// showing, WHY not, in words, because "offline" with no reason is what makes a
// missing detector so hard to track down.

const detectorview = require('./detectorview');
const wifiinfo = require('./wifiinfo');

const MAX_TEXT = 64;
const STATES = ['dark', 'still', 'active', 'off'];
// The detector's picture is FRAME_SIZE x FRAME_SIZE pixels (the person model's input).
const FRAME_SIZE = 96;

function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function text(v) {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

// The motion area a detector reports in scene.area: the part of its picture it watches for motion,
// { x0, y0, x1, y1 } whole pixels, left/top inside and right/bottom outside, so 0,0 - 96,96 is the whole
// picture. Firmware older than the motion area does not send it: that is `null` (the dashboard then
// shows no area). Anything else that is not a sane rectangle inside the picture is refused: the
// dashboard draws it as given. (How small an area may be is the firmware's and the settings page's
// business, not a reason to distrust a reading.)
//   -> { ok: true, area: {x0,y0,x1,y1} | null } | { ok: false }
function parseArea(a) {
  if (a === undefined || a === null) return { ok: true, area: null };
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false };
  const edge = (v) => (Number.isInteger(v) && v >= 0 && v <= FRAME_SIZE ? v : null);
  const x0 = edge(a.x0);
  const y0 = edge(a.y0);
  const x1 = edge(a.x1);
  const y1 = edge(a.y1);
  if ([x0, y0, x1, y1].some((v) => v === null) || x0 >= x1 || y0 >= y1) return { ok: false };
  return { ok: true, area: { x0, y0, x1, y1 } };
}

// Checks the readings one message carries. Returns { ok: true, report } or { ok: false, error }.
// Shape (all numbers; thresholds are the detector's own settings):
//   { ip, fw, uptimeMs, rssi, ssid (optional: the Wi-Fi network it is on), viewLeftS (optional),
//     gpio:   { pin, high },
//     scene:  { state, brightness, motion, darkBelow, motionAtLeast, motionLimit (optional), holdS,
//               area: { x0, y0, x1, y1 }                       <- optional: the part of the picture watched for motion },
//     person: { score|null, detectAt, clearAt, detected },
//     link:   { frames, jpegFails, reconnects, heap }          <- optional, diagnostics only }
function parseStatus(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'status must be a JSON object' };
  const g = body.gpio || {};
  const s = body.scene || {};
  const p = body.person || {};

  const pin = num(g.pin, 0, 48);
  const brightness = num(s.brightness, 0, 255);
  const motion = num(s.motion, 0, 1000000);
  const darkBelow = num(s.darkBelow, 0, 255);
  const motionAtLeast = num(s.motionAtLeast, 0, 1000000);
  // The threshold the readings are really judged against (MOTION_THRESH, or more with the auto-calibration on). Older
  // firmware does not send it: its MOTION_THRESH is then the limit. A value that is not a number in range is left out too.
  const sentLimit = s.motionLimit === undefined || s.motionLimit === null ? null : num(s.motionLimit, 0, 1000000);
  const motionLimit = sentLimit === null ? motionAtLeast : sentLimit;
  const holdS = num(s.holdS, 0, 3600);
  const detectAt = num(p.detectAt, 0, 1);
  const clearAt = num(p.clearAt, 0, 1);
  if ([pin, brightness, motion, darkBelow, motionAtLeast, holdS, detectAt, clearAt].some((v) => v === null)) {
    return { ok: false, error: 'gpio.pin, scene.* and person.detectAt/clearAt must be numbers in range' };
  }
  const area = parseArea(s.area);
  if (!area.ok) return { ok: false, error: `scene.area must be whole numbers x0 < x1 and y0 < y1, all from 0 to ${FRAME_SIZE}` };
  if (typeof g.high !== 'boolean' || typeof p.detected !== 'boolean') return { ok: false, error: 'gpio.high and person.detected must be booleans' };
  if (!STATES.includes(s.state)) return { ok: false, error: `scene.state must be one of ${STATES.join(', ')}` };
  const score = p.score === null || p.score === undefined ? null : num(p.score, 0, 1);
  if (p.score !== null && p.score !== undefined && score === null) return { ok: false, error: 'person.score must be 0..1 or null' };

  // Diagnostics only: a value that is missing or odd is left out (null), never a reason to refuse the readings.
  const l = body.link && typeof body.link === 'object' && !Array.isArray(body.link) ? body.link : {};

  return {
    ok: true,
    report: {
      ip: text(body.ip),
      fw: text(body.fw),
      uptimeMs: num(body.uptimeMs, 0, 4294967295 * 1000),
      rssi: num(body.rssi, -200, 0),
      ssid: wifiinfo.cleanSsid(body.ssid),            // optional: older firmware does not send it (null)
      viewLeftS: num(body.viewLeftS, 0, 86400),     // optional: seconds of live view left on the board's own timer
      gpio: { pin, high: g.high },
      scene: { state: s.state, brightness, motion, darkBelow, motionAtLeast, motionLimit, holdS, area: area.area },
      person: { score, detectAt, clearAt, detected: p.detected },
      link: { frames: num(l.frames, 0, 4294967295), jpegFails: num(l.jpegFails, 0, 4294967295), reconnects: num(l.reconnects, 0, 4294967295), heap: num(l.heap, 0, 16777216) },
    },
  };
}

// Nothing at all (no message) for this long = offline. A detector sends at least once a second.
const STALE_MS = 5000;
// Numbers arrive but no picture for this long = "no picture" (the board's JPEG encoder is failing, say).
const PICTURE_STALE_MS = 5000;

// "42 s", "3 min 5 s", "2 h 10 min" — for the messages below.
function describeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// What GET /detectors returns / what the dashboard reads, for one detector. `det` is the relay's
// record, or undefined for one it has never heard from:
//   { report, receivedAt, frameAt, connected, ip, connectedAt, lastDisconnectAt, lastDisconnectWhy }
// -> { state: 'online' | 'no-picture' | 'idle' | 'offline' | 'never',
//      online, hasPicture, connected, ageMs, pictureAgeMs, connectedForMs, ip,
//      lastDisconnect: { agoMs, why } | null, message, report, view, wifi }
// `wifi` is { ssid, rssi, ageMs } (lib/wifiinfo.js) or null; it is kept while the detector is idle (its report is not).
// 'idle' = the board is there but its live view is OFF (it rests and asks the relay every ~30 s whether
// somebody wants to look); `view` is detectorview.describe().
// `message` is empty while everything is fine, otherwise says why the detector is not (fully) showing.
function buildView(det, now) {
  if (!det) {
    return {
      state: 'never', online: false, hasPicture: false, connected: false, ageMs: null, pictureAgeMs: null,
      connectedForMs: null, ip: null, lastDisconnect: null,
      message: 'the relay has not heard from this detector since it started', report: null,
      view: detectorview.describe(null, now), wifi: null,
    };
  }
  const ageMs = det.receivedAt ? Math.max(0, now - det.receivedAt) : null;
  const pictureAgeMs = det.frameAt ? Math.max(0, now - det.frameAt) : null;
  const online = ageMs !== null && ageMs <= STALE_MS;
  const hasPicture = pictureAgeMs !== null && pictureAgeMs <= PICTURE_STALE_MS;
  const connected = !!det.connected;
  const lastDisconnect = det.lastDisconnectAt ? { agoMs: Math.max(0, now - det.lastDisconnectAt), why: det.lastDisconnectWhy || '' } : null;

  const view = detectorview.describe(det, now);
  let state = 'online';
  let message = '';
  if (!online && !connected && view.idleFresh) {
    // Resting on purpose: the live view is off. The last numbers are old, so they are not offered.
    state = 'idle';
    message = 'the live view is off: the detector rests and asks the relay every ~30 s whether you want to watch';
  } else if (!online) {
    state = 'offline';
    if (connected) {
      message = ageMs === null
        ? 'the detector connected but has not sent anything yet'
        : `the connection is open but nothing has arrived for ${describeAge(ageMs)}`;
    } else {
      message = ageMs === null ? 'never heard from' : `last heard ${describeAge(ageMs)} ago`;
      if (lastDisconnect) message += `; its connection ended${lastDisconnect.why ? ` (${lastDisconnect.why})` : ''}`;
      else message += '; it is not connected';
    }
  } else if (!hasPicture) {
    state = 'no-picture';
    const fails = det.report && det.report.link ? det.report.link.jpegFails : null;
    if (fails) message = `the numbers arrive but there is no picture: the board reports ${fails} failed JPEG encodings (out of memory?)`;
    else if (pictureAgeMs === null) message = 'the numbers arrive but the board has not sent a picture yet';
    else message = `the numbers arrive but the last picture is ${describeAge(pictureAgeMs)} old`;
  }

  return {
    state, online, hasPicture, connected, ageMs, pictureAgeMs,
    connectedForMs: connected && det.connectedAt ? Math.max(0, now - det.connectedAt) : null,
    ip: det.ip || null, lastDisconnect, message, report: state === 'idle' ? null : (det.report || null), view,
    wifi: wifiinfo.describe(det.wifi, now),
  };
}

// The relay-log line for "the dashboard asked for the picture of detector `id` but there is none": view is
// buildView()'s answer for it (any state but 'online'), knownIds the detectors the relay has heard from. It is the
// only trace of the problem, because the mux connection just stays open without that picture: a detector that
// "does not show up" must be explainable from the log alone. The usual cause of 'never' is a DETECTOR_ID on the
// board that differs from the one paired with the camera in the dashboard's config.php, hence the hint.
function missingPictureNotice(id, view, knownIds) {
  if (view.state !== 'never') return `the dashboard asked for the picture of detector '${id}' but there is none: detector '${id}' has no picture to show: ${view.message}`;
  const seen = knownIds.length ? ` (detectors seen: ${[...knownIds].sort().join(', ')})` : ' (no detector has connected at all)';
  return `the dashboard asked for the picture of detector '${id}' but there is none: no detector called '${id}' has connected to the relay since it started${seen}`
    + ' — check that DETECTOR_ID on the board equals the detector paired with the camera in the dashboard\'s config.php';
}

module.exports = { parseStatus, parseArea, buildView, describeAge, missingPictureNotice, STATES, FRAME_SIZE, STALE_MS, PICTURE_STALE_MS };
