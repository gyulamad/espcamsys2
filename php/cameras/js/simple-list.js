'use strict';
// simple-list.js — simple-list.php: sizes the thumbnails to the screen. The rule is
// CamSimple.fitThumbnails (js/simple-logic.js); this only reads the window and sets two CSS variables.
// Without this script the CSS still shows a grid of minimum-size thumbnails.

(function () {
  const grid = document.getElementById('thumbs');
  if (!grid || !window.CamSimple) return;

  const count = Number(grid.dataset.count) || grid.children.length;
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

  layout();
  window.addEventListener('resize', layout);
})();
