'use strict';
// simple-list.js — simple-list.php: sizes the thumbnails to the screen, and puts a blinking red frame
// around the ones whose camera is recording. The rules are CamSimple.fitThumbnails / isRecording
// (js/simple-logic.js); this only reads the window, sets two CSS variables and asks status.php.
// Without this script the CSS still shows a grid of minimum-size thumbnails.

(function () {
  const grid = document.getElementById('thumbs');
  if (!grid || !window.CamSimple) return;

  const count = Number(grid.dataset.count) || grid.children.length;
  const POLL_MS = 2000;    // how often the relay is asked which cameras record (the simple view asks as often)
  const MIN_WIDTH = 160;   // below this a picture is no longer recognisable: the page scrolls instead
  const GAP = 8;
  const BAR_HEIGHT_FALLBACK = 48;

  function layout() {
    const bar = document.querySelector('.bar');
    const room = {
      width: document.documentElement.clientWidth - 24,   // the grid's own side padding
      height: window.innerHeight - (bar ? bar.offsetHeight : BAR_HEIGHT_FALLBACK) - 12,
    };
    const fit = window.CamSimple.fitThumbnails({ width: room.width, height: room.height, count, aspect: 4 / 3, gap: GAP, minWidth: MIN_WIDTH });
    grid.style.setProperty('--thumb-w', fit.width + 'px');
    grid.style.setProperty('--cols', String(fit.cols));
    grid.classList.add('fitted');
  }

  // The frame (CSS: .rec-frame.recording) of every thumbnail follows its camera; no answer = no frame.
  function markRecording(status) {
    for (const thumb of Array.from(grid.children)) {
      thumb.classList.toggle('recording', window.CamSimple.isRecording(status, thumb.dataset.cam));
    }
  }

  async function poll() {
    markRecording(await window.CamRelayJson.get('status.php'));
  }

  layout();
  window.addEventListener('resize', layout);
  if (!window.CamRelayJson) return;   // the frames are the only thing that needs the relay
  poll();
  setInterval(poll, POLL_MS);
})();
