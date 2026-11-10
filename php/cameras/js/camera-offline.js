'use strict';
// camera-offline.js — what every page that shows a camera's picture (the dashboard, simple-list.php, simple-view.php)
// does about a camera that is not connected. Such a camera sends nothing, but the relay keeps its last picture and keeps
// serving it, so without a sign the page shows a clear, still picture of a quiet scene: nothing moves, everything looks
// fine, and no information is coming in. The page covers that picture instead (CamLayout::offlineCover, a dark but
// transparent cover that says "CAMERA OFFLINE").
// Loaded by the pages as a plain script (window.CamOffline) and by the tests with require().
//
//   isOffline   is a camera known not to be connected, from status.php's answer (the relay's `online`)
//   render      shows the cover of a camera while it is offline and hides it again when it is back

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamOffline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Is the camera `id` known NOT to be connected, going by { camId: status } (status.php's answer; `online` is the relay's
  // word, worked out with its own clock)? Only a plain `online: false` counts. No answer, no entry for the camera or an
  // older relay that sends no `online` is "not known to be offline", so nothing is covered on a guess.
  function isOffline(status, id) {
    return !!(status && status[id] && status[id].online === false);
  }

  // Shows `cover` (the element laid over the camera's picture) while the camera `id` is offline, hides it otherwise. A
  // page without that element is left alone. Returns whether the camera is offline, for a caller that does more with it.
  function render(cover, status, id) {
    const offline = isOffline(status, id);
    if (!cover) return offline;
    cover.hidden = !offline;
    return offline;
  }

  return { isOffline, render };
});
