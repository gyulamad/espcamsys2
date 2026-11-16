'use strict';
// switch-status.js — what the dashboard's recording switch says while it is OFF, as pure rules with no DOM,
// no network and no clock of their own (the page passes `now` in), so tests/node/test_switch_status.js can run
// every one of them. Loaded by index.php as a plain script (window.CamSwitchStatus) and by the tests with require().
//
//   formatRemaining(ms)     "59 s", "2 min", "1 h 05 min" — how long recording stays OFF
//   label(st, nowMs)        the switch pill's text and colour for a camera's OFF state (`st` of index.php's
//                           switchState: { forever, untilAt }), or REC ON when there is none
//   labelCandidates(ms, until)  EVERY text the pill can show while a timed OFF counts down from `ms` (with the
//                           "(until HH:MM)" part of exactly `until`): the list the status line reserves its
//                           width for (F-35), so a tick of the countdown can never move the layout
//   NO_DATA                 what a pill says while the relay answers nothing
//
// These rules used to live in index.php; one place (like js/alarm-chain.js) so the page and the tests cannot
// drift apart.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamSwitchStatus = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const NO_DATA = 'NO DATA';

  function formatRemaining(ms) {
    const mins = Math.ceil(ms / 60000);
    if (ms < 60000) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
  }

  // `st`: { forever, untilAt } while OFF (index.php's switchState), absent/null while ON. `nowMs`: this look's
  // own time, so the rules stay pure. -> { text, off }.
  function label(st, nowMs) {
    if (!st) return { text: 'REC ON', off: false };
    if (st.forever) return { text: 'REC OFF · until switched ON', off: true };
    const left = Math.max(0, st.untilAt - nowMs);
    const until = new Date(st.untilAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { text: `REC OFF · ${formatRemaining(left)} left (until ${until})`, off: true };
  }

  // The texts a timed OFF that runs out after `windowMs` can show, with the page's own "(until ...)" wording —
  // the widest of every SHAPE the countdown passes through (F-35: the page reserves the pill's width for the
  // list, so a tick of the countdown can never move the layout). The shapes are "N s" and "N min" (their N
  // never has more digits than 59), "H h" (the window's own hour has the most digits) and "H h MM min" (its
  // minutes are always two digits, so its widest is the one at the most digits the hour ever shows: the
  // window's own remaining time — or, when the window is a whole number of hours, one minute under it, 59 min
  // at the hour below). 'REC ON' and the forever variant are in the list too: the pill shows them at any time.
  function labelCandidates(windowMs, until) {
    const suffix = until === undefined ? '' : ` (until ${until})`;
    const texts = new Set(['REC ON', 'REC OFF · until switched ON']);
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) return [...texts];
    texts.add(`REC OFF · 59 s left${suffix}`);
    texts.add(`REC OFF · 59 min left${suffix}`);
    const minutes = Math.ceil(windowMs / 60000);
    if (minutes >= 60) {
      texts.add(`REC OFF · ${Math.floor(minutes / 60)} h left${suffix}`);
      const probe = minutes % 60 === 0 ? (minutes - 1) * 60000 : windowMs;
      texts.add(`REC OFF · ${formatRemaining(probe)} left${suffix}`);
    }
    return [...texts];
  }

  return { NO_DATA, formatRemaining, label, labelCandidates };
});
