'use strict';
// simple-logic.js — the rules of the two simple camera pages (simple-list.php, simple-view.php), with no
// DOM, no network and no clock of their own, so tests/node/test_simple_logic.js can run every rule.
// Loaded by the pages as a plain script (window.CamSimple) and by the tests with require().
//
//   fitThumbnails   how big the thumbnails of the list page are, and in how many columns
//   neighbor        the previous / next camera of the pager (wraps around)
//   isRecording     is a camera recording, from status.php's answer (the red frame of both pages)
//   isOffline       is a camera known not to be connected (its picture is covered, the slideshow skips it)
//   countdown       what the slideshow's "time left" indicator shows (whole seconds and the part of the time left)
//   viewRequests    which detectors the slideshow must switch to live view (no values otherwise)
//   priorities      how "interesting" each camera is right now, from the two status answers
//   tier            the kinds of "interesting" that count as one: a person seen and a recording are both a human
//   createHumanHold keeps a camera's human for a short while when the data lets go of it (a lost or failed look)
//   nextByPriority  which camera follows after the slideshow time is up
//   jumpTarget      which camera the slideshow shows AT ONCE, without waiting for the time
//   createSlideshow the slideshow itself: the two rules above plus the timer
//
// The order of the slideshow: a HUMAN (a recording, or a person the detector sees) comes first and is never left for
// anything less — not for motion elsewhere, not when the time is up. Several humans take turns. Only with no human
// anywhere does motion get its turn; only with neither do all the cameras take theirs.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamSimple = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Higher wins. Recording beats a person, a person beats motion, motion beats everything else. A camera that is
  // not connected is below all of them: the slideshow only shows it when every camera is offline.
  const PRIORITY = Object.freeze({ OFFLINE: -1, IDLE: 0, MOTION: 1, PERSON: 2, RECORDING: 3 });

  // How long a camera keeps its human after the data stops showing one. The cameras are looked at every 2 s, and a look
  // can be lost (the relay is busy saving a recording, a request fails): that must not look like "the human left". Long
  // enough to bridge a couple of lost looks, shorter than a slideshow turn so a human who really left does not hold the view.
  const HUMAN_HOLD_MS = 6000;

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // A person seen and a recording are one tier: either way a human is on the screen. Used wherever cameras are
  // grouped, so that a person who is not (yet) recorded is not skipped while another camera records.
  const tier = (priority) => Math.min(priority, PRIORITY.PERSON);
  const isHuman = (priority) => priority >= PRIORITY.PERSON;

  // The thumbnails of the list page: as big as all of them fit on the screen without scrolling, but never
  // narrower than minWidth — below that they would no longer be recognisable, so the page scrolls instead.
  // width/height: the room on screen; aspect: picture width / height; gap: space between thumbnails.
  // -> { cols, width, height } (whole pixels)
  function fitThumbnails({ width, height, count, aspect = 4 / 3, gap = 8, minWidth = 160 }) {
    if (!(count >= 1) || !(width > 0) || !(height > 0) || !(aspect > 0)) return sized(1, minWidth, 4 / 3);   // nothing sensible to measure
    const byWidth = (cols) => (width - (cols - 1) * gap) / cols;
    // the widest thumbnail `cols` columns allow: limited by the width of the screen and by its height
    const biggest = (cols) => {
      const rows = Math.ceil(count / cols);
      return Math.min(byWidth(cols), ((height - (rows - 1) * gap) / rows) * aspect);
    };
    let best = { cols: 1, w: biggest(1) };
    for (let cols = 2; cols <= count; cols += 1) {   // a tie keeps the fewer columns
      const w = biggest(cols);
      if (w > best.w) best = { cols, w };
    }
    if (best.w >= minWidth) return sized(best.cols, best.w, aspect);
    // They cannot all be shown at a recognisable size: as many columns as keep the minimum, and scroll.
    const cols = Math.min(count, Math.max(1, Math.floor((width + gap) / (minWidth + gap))));
    return sized(cols, Math.max(minWidth, byWidth(cols)), aspect);
  }
  function sized(cols, w, aspect) {
    return { cols, width: Math.floor(w), height: Math.floor(w / aspect) };
  }

  // The camera one step before (-1) or after (+1) `currentId`, wrapping around. An id that is not in the
  // list starts at the first camera. null when there are no cameras.
  function neighbor(ids, currentId, step) {
    if (!ids.length) return null;
    const at = ids.indexOf(currentId);
    if (at < 0) return ids[0];
    return ids[(at + step + ids.length) % ids.length];
  }

  // Is the camera `id` recording, going by status.php's answer (`status`: id -> { recording, ... }, or null
  // when the relay could not be asked)? Anything but a plain true — an unknown camera, no answer — is "not".
  function isRecording(status, id) {
    return !!(status && status[id] && status[id].recording === true);
  }

  // Is the camera `id` known NOT to be connected, going by status.php's answer (`online` is the relay's word)?
  // Only a plain false counts: no answer, an unknown camera or an older relay without the field is "not known
  // to be offline", so nothing is hidden or skipped on a guess.
  function isOffline(status, id) {
    return !!(status && status[id] && status[id].online === false);
  }

  // Is the person detector of a camera reporting motion at or above its threshold? The threshold is the one in
  // force (`motionLimit`: MOTION_THRESH, or more while the auto-calibration follows a noisy scene), else the
  // set one (older relay or firmware). A threshold of 0 means the motion check is off; an offline detector's
  // last numbers are old news.
  function inMotion(detector) {
    if (!detector || detector.online !== true || !detector.report || !detector.report.scene) return false;
    const scene = detector.report.scene;
    const limit = isNum(scene.motionLimit) ? scene.motionLimit : scene.motionAtLeast;
    return isNum(scene.motion) && isNum(limit) && limit > 0 && scene.motion >= limit;
  }

  // Does the person detector of a camera see a person right now? (Offline: old news.)
  function personSeen(detector) {
    if (!detector || detector.online !== true || !detector.report || !detector.report.person) return false;
    return detector.report.person.detected === true;
  }

  // Which of the cameras' person detectors have to be switched to live view (they rest otherwise and send no
  // sensor values) — and with which action. Only detectors that support the switch (view.supported) are
  // asked: 'on' while the relay does not yet want the view, 'keep' to renew it, at most every keepMs per
  // camera (`asked`: id -> time of the last request, updated by the caller). -> [{ id, action }]
  function viewRequests(ids, detectors, asked, nowMs, keepMs) {
    const out = [];
    for (const id of ids) {
      const d = detectors && detectors[id];
      if (!d || !d.view || d.view.supported !== true) continue;   // no detector, or it streams always
      const last = asked && asked[id];
      if (isNum(last) && nowMs - last < keepMs) continue;
      out.push({ id, action: d.view.wanted === true ? 'keep' : 'on' });
    }
    return out;
  }

  // { id: PRIORITY } for every camera, from status.php's answer (`status`: id -> { recording, ... }) and
  // detector-status.php's (`detectors`: id -> detector view). Either may be null (the request failed).
  function priorities(ids, status, detectors) {
    const out = {};
    for (const id of ids) {
      if (isOffline(status, id)) out[id] = PRIORITY.OFFLINE;
      else if (isRecording(status, id)) out[id] = PRIORITY.RECORDING;
      else if (detectors && personSeen(detectors[id])) out[id] = PRIORITY.PERSON;
      else if (detectors && inMotion(detectors[id])) out[id] = PRIORITY.MOTION;
      else out[id] = PRIORITY.IDLE;
    }
    return out;
  }

  // The same priorities, but a camera that had a human a moment ago keeps it for `holdMs` after the data stops
  // showing one (see HUMAN_HOLD_MS). The page's looks at the relay are all the slideshow knows: a look that is lost
  // or fails makes every camera look idle, and a person flag can flicker off while the camera still records —
  // without this the view would leave a human for whatever else moves. A camera known to be offline is not held.
  // Each call is a look at time `at` (ms, not going back); asking again for the same moment gives the same answer.
  function createHumanHold(holdMs = HUMAN_HOLD_MS) {
    const lastHuman = {};   // id -> { at, level } of the last look that showed a human there
    const held = (id, level, at) => {
      if (level === PRIORITY.OFFLINE) { delete lastHuman[id]; return level; }
      if (isHuman(level)) { lastHuman[id] = { at, level }; return level; }
      const seen = lastHuman[id];
      if (!seen || at - seen.at >= holdMs) return level;
      return seen.level;
    };
    return {
      apply(at, prio) {
        const out = {};
        for (const id of Object.keys(prio)) out[id] = held(id, prio[id], at);
        return out;
      },
    };
  }

  // The camera after the current one once the slideshow time is up: only the cameras of the highest tier take
  // part (all humans, else all moving ones, else all of them), so the others are skipped. The current camera
  // alone in that group stays: a human is never left for something less.
  function nextByPriority(ids, currentId, prio) {
    if (!ids.length) return null;
    const level = (id) => tier(prio[id] || PRIORITY.IDLE);
    const top = Math.max(...ids.map(level));
    const group = ids.filter((id) => level(id) === top);
    const at = ids.indexOf(currentId);
    for (let i = 1; i <= ids.length; i += 1) {   // walk on from the current camera, in list order
      const id = ids[(Math.max(at, -1) + i) % ids.length];
      if (group.includes(id)) return id;
    }
    return group[0];
  }

  // The camera to show IMMEDIATELY: one that has just become more interesting (started recording, or
  // started moving) than it was at the previous look, and is at least as interesting as the current one
  // (a camera that starts moving does not pull the view away from one that is recording). The most
  // interesting such camera wins; of equals the first in list order. null when nothing calls for a jump.
  function jumpTarget(ids, currentId, before, now) {
    const level = (map, id) => (map && map[id]) || PRIORITY.IDLE;
    const bar = level(now, currentId);
    let best = null;
    for (const id of ids) {
      const p = level(now, id);
      if (id === currentId || p === PRIORITY.IDLE || p <= level(before, id) || p < bar) continue;
      if (best === null || p > level(now, best)) best = id;
    }
    return best;
  }

  // The slideshow. `ids`: the cameras in order; `intervalMs`: how long one camera stays when nothing
  // calls for a change. All time is passed in (`nowMs`), so it is testable without waiting.
  function createSlideshow(ids, currentId, intervalMs, nowMs) {
    let current = ids.includes(currentId) ? currentId : (ids[0] === undefined ? null : ids[0]);
    let shownAt = nowMs;
    let before = null;   // the priorities at the previous look; none yet, so everything counts as new
    return {
      current: () => current,
      // The viewer picked a camera (pager button): show it for a full interval.
      show(id, at) { current = id; shownAt = at; },
      // How long (ms) until the slideshow moves on if nothing else happens, or null when it will not move:
      // there is no other camera to go to (one camera, or the others are skipped for a recording one).
      remainingMs(at, prio) {
        const next = nextByPriority(ids, current, prio);
        if (next === null || next === current) return null;
        return Math.max(0, intervalMs - (at - shownAt));
      },
      // Look at the situation. Returns the id to switch to, or null to stay on the current camera.
      tick(at, prio) {
        const jump = jumpTarget(ids, current, before, prio);
        before = prio;
        if (jump !== null) { current = jump; shownAt = at; return current; }
        if (at - shownAt < intervalMs) return null;
        shownAt = at;
        const next = nextByPriority(ids, current, prio);
        if (next === null || next === current) return null;
        current = next;
        return current;
      },
    };
  }

  // The "time left before the next camera" indicator: `remainingMs` of createSlideshow().remainingMs and the
  // time one camera stays. -> { seconds, fraction } (seconds rounded UP, so it never says 0 while there is
  // time left; fraction 1 = just switched, 0 = switching now), or null when there is nothing to show.
  function countdown(remainingMs, intervalMs) {
    if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || !(intervalMs > 0)) return null;
    const left = Math.min(Math.max(remainingMs, 0), intervalMs);
    return { seconds: Math.ceil(left / 1000), fraction: left / intervalMs };
  }

  // 14:05:09 — the clock of the status line (local time, like the dashboard's).
  function formatClock(date) {
    const two = (n) => String(n).padStart(2, '0');
    return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
  }

  return { PRIORITY, HUMAN_HOLD_MS, fitThumbnails, neighbor, isRecording, isOffline, inMotion, personSeen, viewRequests, priorities, tier, createHumanHold, nextByPriority, jumpTarget, createSlideshow, countdown, formatClock };
});
