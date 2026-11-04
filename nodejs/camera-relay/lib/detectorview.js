'use strict';

// detectorview.js — "does anybody want to look at this detector right now?", as pure functions.
//
// A detector does not stream all day: the Wi-Fi radio and the board rest unless somebody wants to see its
// sensor values and its small picture (to aim it or calibrate it). The detection itself and the alarm
// pin run all the time either way. So:
//   * the dashboard ASKS for the live view (POST /detector/:id/view?action=on|keep|off) — "keep" is what an
//     open page sends every few seconds while somebody is watching;
//   * the detector ASKS the relay whether to stream (GET /detector/:id/view): about every 30 s while it
//     rests, every few seconds while it streams, and gets { view, stop } back.
// The relay never connects to a detector (it is often behind a NAT router), which is why the board does
// the asking. One ask from the dashboard counts for WANT_MS, so that a page which is simply closed
// stops being "wanted" by itself.
//
// HOW LONG a detector keeps streaming once it was asked (and again after every later ask) is the relay's
// setting detectorViewMinutes (config.js, or DETECTOR_VIEW_MINUTES); the answer carries it ("mins=10") and
// the board counts the time itself, so it stops by itself even if the relay or the dashboard goes away.
//
// A record is the part of the relay's detector record this file owns:
//   { viewWantedUntil, viewOnAt, viewOffAt, polledAt, polls }

const ACTIONS = ['on', 'keep', 'off'];
// One ask from the dashboard keeps the view "wanted" this long (the page asks again every ~20 s).
const WANT_MS = 90 * 1000;
// A stop (the OFF button) is passed on to a detector that asks within this time.
const STOP_MS = 120 * 1000;
// A detector that rests asks every ~30 s: heard within this long = it is there, just resting.
const IDLE_STALE_MS = 75 * 1000;
const DEFAULT_VIEW_MINUTES = 10;
const MAX_VIEW_MINUTES = 1440;

// The configured number of minutes (text or number) -> a whole number 1..MAX_VIEW_MINUTES, else the default.
function viewMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_VIEW_MINUTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VIEW_MINUTES) return DEFAULT_VIEW_MINUTES;
  return n;
}

// The fields a new record starts with.
function newRecord() {
  return { viewWantedUntil: 0, viewOnAt: 0, viewOffAt: 0, polledAt: 0, polls: 0 };
}

// The dashboard asks. Returns the new wanted-until time (0 = not wanted). `action` must be one of ACTIONS
// (the caller validates it with isAction()).
function ask(rec, action, now) {
  if (action === 'off') {
    rec.viewWantedUntil = 0;
    rec.viewOffAt = now;
    return 0;
  }
  rec.viewWantedUntil = now + WANT_MS;
  rec.viewOnAt = now;
  return rec.viewWantedUntil;
}

function isAction(v) {
  return typeof v === 'string' && ACTIONS.includes(v);
}

// The detector asks: notes that it did, and answers { view, stop }.
//   view: somebody wants to look — stream (and keep streaming for your configured time)
//   stop: the OFF button was pressed after the last ON — stop streaming now
function answerPoll(rec, now) {
  rec.polledAt = now;
  rec.polls += 1;
  return {
    view: rec.viewWantedUntil > now,
    stop: rec.viewOffAt > rec.viewOnAt && now - rec.viewOffAt < STOP_MS,
  };
}

// What the detector gets on the wire (plain text, like the settings lines: the firmware looks for
// "view=1", "stop=1" and "mins=<n>", in any order, and ignores what it does not know).
function encodeAnswer(a, minutes) {
  return `view=${a.view ? 1 : 0};stop=${a.stop ? 1 : 0};mins=${viewMinutes(minutes)}`;
}

// What the dashboard may know about the view of one detector (part of GET /detectors):
//   supported  the firmware asks (an older one streams all the time: there is nothing to switch)
//   wanted     somebody asked recently
//   idleFresh  it asked recently: it is there, resting
function describe(rec, now) {
  const polledAt = rec && rec.polledAt ? rec.polledAt : 0;
  return {
    supported: polledAt > 0,
    wanted: !!rec && rec.viewWantedUntil > now,
    wantedForMs: rec && rec.viewWantedUntil > now ? rec.viewWantedUntil - now : 0,
    idleFresh: polledAt > 0 && now - polledAt <= IDLE_STALE_MS,
    pollAgeMs: polledAt > 0 ? Math.max(0, now - polledAt) : null,
  };
}

module.exports = { ACTIONS, WANT_MS, STOP_MS, IDLE_STALE_MS, DEFAULT_VIEW_MINUTES, MAX_VIEW_MINUTES, viewMinutes, newRecord, ask, isAction, answerPoll, encodeAnswer, describe };
