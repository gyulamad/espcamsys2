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
  const NAV_HEIGHT_FALLBACK = 44;   // the navigation bar (CamLayout::navBarStyle --nav-h)
  const BAR_HEIGHT_FALLBACK = 48;   // the line with the camera count

  // What the thumbnails must leave room for above them: the navigation bar and the camera count line.
  function heightAbove() {
    const nav = document.querySelector('.site-nav');
    const bar = document.querySelector('.bar');
    return (nav ? nav.offsetHeight : NAV_HEIGHT_FALLBACK) + (bar ? bar.offsetHeight : BAR_HEIGHT_FALLBACK);
  }

  function layout() {
    const room = {
      width: document.documentElement.clientWidth - 24,   // the grid's own side padding
      height: window.innerHeight - heightAbove() - 12,
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

  // A camera that is not connected keeps its last picture in the stream: cover it with the loading indicator.
  function markOffline(status) {
    for (const thumb of Array.from(grid.children)) {
      const loading = thumb.querySelector('.cam-loading');
      if (loading) loading.hidden = !window.CamSimple.isOffline(status, thumb.dataset.cam);
    }
  }

  async function poll() {
    const status = await window.CamRelayJson.get('status.php');
    markRecording(status);
    markOffline(status);
  }

  layout();
  window.addEventListener('resize', layout);
  if (!window.CamRelayJson) return;   // the frames are the only thing that needs the relay
  poll();
  setInterval(poll, POLL_MS);
})();
