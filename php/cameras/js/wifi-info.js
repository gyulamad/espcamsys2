'use strict';
// wifi-info.js — the Wi-Fi network a camera or a detector is on and how strong the signal is, as the dashboard
// shows it (a small chip: signal bars, the network name, the strength in dBm).
// Loaded by index.php as a plain script (window.CamWifi) and by the tests with require().
//
//   quality(rssi)        the band of a signal strength: { level 0-4, label }
//   describe(wifi)       everything the chip shows for a { ssid, rssi, ageMs } answer of the server, or null
//   render(el, wifi)     fills the chip element `el` (hides it when there is nothing to show)
//
// The network name comes from a board over the network: it is only ever put on the page as TEXT (textContent),
// never as markup.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamWifi = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const BARS = 4;

  // The usual scale of phones and routers, in dBm. Below the last band the link is hardly usable.
  const BANDS = Object.freeze([
    { atLeast: -55, level: 4, label: 'excellent' },
    { atLeast: -65, level: 3, label: 'good' },
    { atLeast: -75, level: 2, label: 'fair' },
    { atLeast: -85, level: 1, label: 'weak' },
  ]);
  const LOWEST = Object.freeze({ level: 0, label: 'very weak' });

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // -> { level, label } or null when `rssi` is not a number
  function quality(rssi) {
    if (!isNum(rssi)) return null;
    const band = BANDS.find((b) => rssi >= b.atLeast);
    return band ? { level: band.level, label: band.label } : { level: LOWEST.level, label: LOWEST.label };
  }

  // "12 s ago", "3 min ago": how old a reading is, for the tooltip.
  function formatAge(ageMs) {
    if (!isNum(ageMs) || ageMs < 0) return '';
    const s = Math.round(ageMs / 1000);
    return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
  }

  // -> { ssid, rssi, level, label, text, title } or null when there is nothing true to show
  function describe(wifi) {
    if (!wifi || typeof wifi.ssid !== 'string' || wifi.ssid === '') return null;
    const q = quality(wifi.rssi);
    if (!q) return null;
    const age = formatAge(wifi.ageMs);
    const title = wifi.ssid + ': ' + wifi.rssi + ' dBm, ' + q.label + ' signal' + (age ? ', reported ' + age : '');
    return { ssid: wifi.ssid, rssi: wifi.rssi, level: q.level, label: q.label, text: wifi.ssid + ' · ' + wifi.rssi + ' dBm', title };
  }

  // Builds the inside of a chip once: the bars and the text.
  function build(el) {
    const doc = el.ownerDocument;
    const bars = doc.createElement('span');
    bars.className = 'wifi-bars';
    for (let i = 0; i < BARS; i++) bars.appendChild(doc.createElement('i'));
    const text = doc.createElement('span');
    text.className = 'wifi-text';
    el.appendChild(bars);
    el.appendChild(text);
  }

  // Shows `wifi` in the chip `el`, or hides the chip. Nothing is left of an earlier reading when it hides.
  // `el` may be missing (a card without that chip): nothing to do then.
  function render(el, wifi) {
    if (!el) return;
    const d = describe(wifi);
    if (!d) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      el.removeAttribute('aria-label');
      el.removeAttribute('data-level');
      return;
    }
    if (!el.querySelector('.wifi-bars')) {
      el.textContent = '';
      build(el);
    }
    el.querySelector('.wifi-text').textContent = d.text;
    el.dataset.level = String(d.level);
    el.title = d.title;
    el.setAttribute('aria-label', 'Wi-Fi ' + d.title);
    el.hidden = false;
  }

  return { BARS, BANDS, quality, formatAge, describe, render };
});
