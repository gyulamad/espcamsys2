'use strict';
// simple-list.js — simple-list.php: sizes the thumbnails to the screen, and puts a blinking red frame
// around the ones whose camera is recording. The rules are CamSimple.fitThumbnails / isRecording
// (js/simple-logic.js); this only reads the window and sets two CSS variables. Every thumbnail's picture and the
// recording state of the cameras arrive on ONE mux.php connection (js/mux-pictures.js), however many cameras
// there are; nothing is polled. While the connection is down the pictures are blank and no frame is shown.
// Without this script the CSS still shows a grid of minimum-size thumbnails (without pictures).

(function () {
  const grid = document.getElementById('thumbs');
  if (!grid || !window.CamSimple || !window.CamOffline) return;

  const count = Number(grid.dataset.count) || grid.children.length;
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

  // A camera that is not connected keeps its last picture in the stream: cover it with the "offline" message.
  function markOffline(status) {
    for (const thumb of Array.from(grid.children)) {
      window.CamOffline.render(thumb.querySelector('.cam-offline'), status, thumb.dataset.cam);
    }
  }

  layout();
  window.addEventListener('resize', layout);
  if (!window.CamMuxPictures) return;   // the pictures and the recording state are the only things that need the relay

  const thumbs = new Map(Array.from(grid.children).map((thumb) => [thumb.dataset.cam, thumb]));
  const imgOf = (id) => (thumbs.has(id) ? thumbs.get(id).querySelector('img') : null);
  const asMap = (data) => (data && typeof data === 'object' && !Array.isArray(data) ? data : null);
  const pictures = window.CamMuxPictures.create({
    url: 'mux.php',
    imgFor: (kind, id) => (kind === 'cam' ? imgOf(id) : null),
    onCameraStatus: (data) => { const status = asMap(data); markRecording(status); markOffline(status); },
    // Down: no state is known (no frame, no cover) and the last pictures are blanked rather than left standing as if live.
    onDown: (ids) => {
      markRecording(null);
      markOffline(null);
      for (const id of ids) {
        const img = imgOf(id);
        if (img) img.removeAttribute('src');
      }
    },
  });
  // All the thumbnails go in one go: they become ONE (re)connection, not one per camera.
  for (const id of thumbs.keys()) pictures.show(id);
  pictures.watchCameraStatus(true);
})();
