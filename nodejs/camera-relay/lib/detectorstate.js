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

const MAX_TEXT = 64;
const STATES = ['dark', 'still', 'active', 'off'];

function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function text(v) {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

// Checks the readings one message carries. Returns { ok: true, report } or { ok: false, error }.
// Shape (all numbers; thresholds are the detector's own settings):
//   { ip, fw, uptimeMs, rssi,
//     gpio:   { pin, high },
//     scene:  { state, brightness, motion, darkBelow, motionAtLeast, holdS },
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
  const holdS = num(s.holdS, 0, 3600);
  const detectAt = num(p.detectAt, 0, 1);
  const clearAt = num(p.clearAt, 0, 1);
  if ([pin, brightness, motion, darkBelow, motionAtLeast, holdS, detectAt, clearAt].some((v) => v === null)) {
    return { ok: false, error: 'gpio.pin, scene.* and person.detectAt/clearAt must be numbers in range' };
  }
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
      gpio: { pin, high: g.high },
      scene: { state: s.state, brightness, motion, darkBelow, motionAtLeast, holdS },
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
// -> { state: 'online' | 'no-picture' | 'offline' | 'never',
//      online, hasPicture, connected, ageMs, pictureAgeMs, connectedForMs, ip,
//      lastDisconnect: { agoMs, why } | null, message, report }
// `message` is empty while everything is fine, otherwise says why the detector is not (fully) showing.
function buildView(det, now) {
  if (!det) {
    return {
      state: 'never', online: false, hasPicture: false, connected: false, ageMs: null, pictureAgeMs: null,
      connectedForMs: null, ip: null, lastDisconnect: null,
      message: 'the relay has not heard from this detector since it started', report: null,
    };
  }
  const ageMs = det.receivedAt ? Math.max(0, now - det.receivedAt) : null;
  const pictureAgeMs = det.frameAt ? Math.max(0, now - det.frameAt) : null;
  const online = ageMs !== null && ageMs <= STALE_MS;
  const hasPicture = pictureAgeMs !== null && pictureAgeMs <= PICTURE_STALE_MS;
  const connected = !!det.connected;
  const lastDisconnect = det.lastDisconnectAt ? { agoMs: Math.max(0, now - det.lastDisconnectAt), why: det.lastDisconnectWhy || '' } : null;

  let state = 'online';
  let message = '';
  if (!online) {
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
    ip: det.ip || null, lastDisconnect, message, report: det.report || null,
  };
}

module.exports = { parseStatus, buildView, describeAge, STATES, STALE_MS, PICTURE_STALE_MS };
