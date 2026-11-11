'use strict';
// device-info.js — the line of facts about a board that the dashboard shows on the card of a camera and of a detector:
// where it is (its address), how long it has been connected and running, how much memory it has free, which firmware it
// runs, and the trouble it counted. One place builds that line for both, so they read alike.
// Loaded by index.php as a plain script (window.CamDeviceInfo) and by the tests with require().
//
//   fmtUptime(ms)        "42 s", "5 min", "3 h 7 min"
//   summarize(info)      the parts of `info` that are known, joined with " · " ('' when none is)
//   render(el, info)     puts summarize(info) in the element `el` (hides it when there is nothing to show)
//
// `info` may have any of: ip, connectedForMs, uptimeMs, heapBytes, reconnects, jpegFails, fw — all optional; one that
// is missing, null or not of the right type is left out. The values come from a board over the network: they are only
// ever put on the page as TEXT (textContent), never as markup.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamDeviceInfo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SEPARATOR = ' · ';

  const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const isText = (v) => typeof v === 'string' && v !== '';

  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // One entry per fact: how to tell it is there, and how it reads. Their order is the order of the line.
  const FACTS = Object.freeze([
    { key: 'ip', has: isText, text: (v) => v },
    { key: 'connectedForMs', has: isCount, text: (v) => 'connected ' + fmtUptime(v) },
    { key: 'uptimeMs', has: isCount, text: (v) => 'up ' + fmtUptime(v) },
    { key: 'heapBytes', has: isCount, text: (v) => Math.round(v / 1024) + ' KB free' },
    { key: 'reconnects', has: (v) => isCount(v) && v > 0, text: (v) => v + ' reconnects' },
    { key: 'jpegFails', has: (v) => isCount(v) && v > 0, text: (v) => v + ' JPEG failures' },
    { key: 'fw', has: isText, text: (v) => 'fw ' + v },
  ]);

  // -> the known facts of `info`, as the pieces of the line
  function pieces(info) {
    if (!info || typeof info !== 'object') return [];
    return FACTS.filter((f) => f.has(info[f.key])).map((f) => f.text(info[f.key]));
  }

  function summarize(info) {
    return pieces(info).join(SEPARATOR);
  }

  // Shows `info` in the element `el`, or hides it. Nothing is left of an earlier reading when it hides.
  // `el` may be missing (a card without that line): nothing to do then.
  function render(el, info) {
    if (!el) return;
    const text = summarize(info);
    el.textContent = text;
    el.hidden = text === '';
  }

  return { SEPARATOR, fmtUptime, summarize, render };
});
