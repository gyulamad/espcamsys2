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
//   preloaderFor which of a card's two preloaders shows while the camera is not live (F-25: never both at once)

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

  // Which of a camera card's two preloaders shows while the camera is not live: the page's own stream overlay (the
  // "CONNECTING…" / "STREAM ERROR" / "FEED PAUSED" layer of the dashboard) or this module's offline cover above
  // ("CAMERA OFFLINE / Reconnecting…"). Only one may show at a time (F-25: an offline camera never sends the picture
  // that would end the CONNECTING… spinner, so without this rule the two preloaders stack on top of each other). When
  // the relay says the camera is not connected the cover is the one that knows why, and the stream overlay yields to
  // it — unless the user has paused that camera's feed on purpose, which wins, or the cover would only hide the
  // overlay's RESTORE button. `offline` is isOffline()'s answer for the camera, `streamState` what the page's own
  // stream layer is doing: 'connecting' | 'live' | 'error' | 'paused' (anything else counts as 'connecting', the
  // state a page starts in). Returns 'cover', 'overlay' or 'none' (no preloader: the picture is live).
  function preloaderFor(offline, streamState) {
    if (offline) return streamState === 'paused' ? 'overlay' : 'cover';
    return streamState === 'live' ? 'none' : 'overlay';
  }

  return { isOffline, render, preloaderFor };
});
