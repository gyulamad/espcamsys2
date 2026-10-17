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
// "alarm all". The detector POSTs one report per update (POST /detector/:id, camera
// key); this file only validates it and shapes what the dashboard reads back.

const MAX_JPEG_BYTES = 16 * 1024; // a 96x96 grayscale JPEG is ~1-3 KB; anything near this is wrong
const MAX_TEXT = 64;
const STATES = ['dark', 'still', 'active', 'off'];

function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function text(v) {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

// Checks one report. Returns { ok: true, report, jpeg } (jpeg is a Buffer, or null when the
// report carries no picture) or { ok: false, error }.
// Report shape (all numbers; thresholds are the detector's own settings):
//   { ip, fw, uptimeMs, rssi,
//     gpio:   { pin, high },
//     scene:  { state, brightness, motion, darkBelow, motionAtLeast, holdS },
//     person: { score|null, detectAt, clearAt, detected },
//     jpeg:   "<base64>" }
function parseReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
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

  let jpeg = null;
  if (body.jpeg !== undefined && body.jpeg !== null && body.jpeg !== '') {
    if (typeof body.jpeg !== 'string' || body.jpeg.length > MAX_JPEG_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.jpeg)) {
      return { ok: false, error: 'jpeg must be a base64 string' };
    }
    jpeg = Buffer.from(body.jpeg, 'base64');
    if (jpeg.length < 4 || jpeg.length > MAX_JPEG_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return { ok: false, error: 'jpeg is not a JPEG picture' };
  }

  return {
    ok: true,
    jpeg,
    report: {
      ip: text(body.ip),
      fw: text(body.fw),
      uptimeMs: num(body.uptimeMs, 0, 4294967295 * 1000),
      rssi: num(body.rssi, -200, 0),
      gpio: { pin, high: g.high },
      scene: { state: s.state, brightness, motion, darkBelow, motionAtLeast, holdS },
      person: { score, detectAt, clearAt, detected: p.detected },
    },
  };
}

// Reports older than this are shown as "offline" by the dashboard.
const STALE_MS = 5000;

// What GET /detector/:id returns / what the dashboard reads. `det` is the relay's record
// ({ report, receivedAt }) or undefined for a detector never heard from.
function buildView(det, now) {
  if (!det || !det.report) return { online: false, ageMs: null, report: null };
  const ageMs = Math.max(0, now - det.receivedAt);
  return { online: ageMs <= STALE_MS, ageMs, report: det.report };
}

module.exports = { parseReport, buildView, STALE_MS, MAX_JPEG_BYTES };
