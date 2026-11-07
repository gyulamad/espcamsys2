'use strict';
// simple-view.js — simple-view.php: shows one camera, the pager, the status line and the slideshow. The
// decisions (next camera, what is shown at once, priorities) are in js/simple-logic.js; this only wires
// them to the page, status.php (recording: the status line and the red frame around the picture) and
// detector-status.php (motion). A camera that is not connected is skipped by the slideshow and, when picked
// by hand, shows a loading indicator instead of its stale last picture. A click on the picture toggles full
// screen (js/fullscreen.js). While the slideshow runs (it is on when the page opens), "NEXT IN n s" and a bar
// under the picture show the time left before the next camera.

(function () {
  const S = window.CamSimple;
  const root = document.getElementById('view');
  if (!S || !window.CamRelayJson || !root) return;

  const POLL_MS = 2000;     // how often the relay is asked what the cameras do
  const TICK_MS = 1000;     // clock, and how often the slideshow looks at the situation
  const RETRY_MS = 3000;    // a broken picture stream is opened again after this long
  const VIEW_KEEP_MS = 20000;   // the live view of a detector is renewed this often while the slideshow runs
  const DEFAULT_SLIDESHOW_SECONDS = 10;

  function readCameras() {
    try {
      const list = JSON.parse(root.dataset.cameras);
      return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string') : [];
    } catch (e) {
      return [];
    }
  }

  const cameras = readCameras();
  const ids = cameras.map((c) => c.id);
  const nameOf = (id) => (cameras.find((c) => c.id === id) || { name: id }).name;
  const iconOf = (id) => (cameras.find((c) => c.id === id) || {}).icon || '';
  const slideshowMs = (Number(root.dataset.slideshowSeconds) || DEFAULT_SLIDESHOW_SECONDS) * 1000;

  const el = (id) => document.getElementById(id);
  const picture = el('picture');
  const pictureBox = el('picture-box');   // what goes full screen: everything laid over the picture goes with it
  let current = ids.includes(root.dataset.current) ? root.dataset.current : ids[0];
  let slideshow = null;            // the running slideshow, or null
  let status = null;               // the last answers of the relay (null: not known)
  let detectors = null;
  let retryTimer = null;
  const viewAsked = {};            // detector id -> when its live view was last requested

  // The status line and the red frame around the picture follow the recording state of the current camera.
  function renderRecording() {
    const rec = el('rec');
    const on = S.isRecording(status, current);
    rec.textContent = 'RECORDING: ' + (status === null ? '–' : on ? 'ON' : 'off');
    rec.className = on ? 'rec-on' : 'rec-off';
    if (pictureBox) pictureBox.classList.toggle('recording', on);
  }

  // A camera that is not connected sends nothing, and the picture would stay on its last frame: cover it with the
  // loading indicator until the camera is back. (Also the status line says so.)
  function renderLoading() {
    const loading = el('loading');
    if (loading) loading.hidden = !S.isOffline(status, current);
  }

  // The stream is a never-ending picture: switching the camera replaces it, which closes the old connection.
  function show(id) {
    current = id;
    picture.src = 'stream.php?cam=' + encodeURIComponent(id);
    picture.alt = nameOf(id);
    el('cam-name').textContent = nameOf(id);
    el('cam-icon').textContent = iconOf(id);
    document.title = nameOf(id) + ' — ESP32-CAM Dashboard';
    try { history.replaceState(null, '', 'simple-view.php?cam=' + encodeURIComponent(id)); } catch (e) { /* not allowed here: the address just stays */ }
    renderRecording();
    renderLoading();
  }

  function step(direction) {
    const id = S.neighbor(ids, current, direction);
    if (id === null) return;
    if (slideshow) slideshow.show(id, Date.now());   // the viewer's choice gets a full time
    show(id);
    renderCountdown(Date.now(), S.priorities(ids, status, detectors));
  }

  function setSlideshow(on) {
    if (!on) for (const id of ids) delete viewAsked[id];   // the views lapse by themselves: the detectors rest again
    slideshow = on ? S.createSlideshow(ids, current, slideshowMs, Date.now()) : null;
    const button = el('slideshow');
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) keepViews();
    button.textContent = on ? '⏸ SLIDESHOW ON' : '▶ SLIDESHOW';
    lastFraction = 0;
    renderCountdown(Date.now(), on ? S.priorities(ids, status, detectors) : null);
  }

  // The slideshow's "time left" indicator: seconds in the status line and a bar under the picture that runs
  // out. Both are hidden when no slideshow runs or it has nowhere to go (nothing to count down to).
  let lastFraction = 0;
  function renderCountdown(now, prio) {
    const left = slideshow ? S.countdown(slideshow.remainingMs(now, prio), slideshowMs) : null;
    el('countdown').hidden = left === null;
    el('countdown-bar').hidden = left === null;
    if (left === null) return;
    el('countdown').textContent = 'NEXT IN ' + left.seconds + ' s';
    // Back to full after a switch must not slide up slowly: only the running-out is animated.
    el('countdown-fill').style.transition = left.fraction > lastFraction ? 'none' : '';
    el('countdown-fill').style.width = (left.fraction * 100) + '%';
    lastFraction = left.fraction;
  }

  function tick() {
    el('clock').textContent = S.formatClock(new Date());
    if (!slideshow) { renderCountdown(Date.now(), null); return; }
    const now = Date.now();
    const prio = S.priorities(ids, status, detectors);
    const next = slideshow.tick(now, prio);
    if (next !== null) show(next);
    renderCountdown(now, prio);
  }

  // A resting detector sends no sensor values. The slideshow needs them (motion, person) of all cameras, so
  // while it runs the live view of every detector is switched on and renewed; it is never turned off here
  // (another viewer may be watching) but lapses by itself when nobody renews it.
  function keepViews() {
    if (!slideshow) return;
    const now = Date.now();
    for (const { id, action } of S.viewRequests(ids, detectors, viewAsked, now, VIEW_KEEP_MS)) {
      viewAsked[id] = now;
      fetch('detector-view.php?cam=' + encodeURIComponent(id) + '&action=' + action, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'camdash' },
      }).catch(() => { delete viewAsked[id]; });   // out of reach: ask again at the next poll
    }
  }

  async function poll() {
    [status, detectors] = await Promise.all([window.CamRelayJson.get('status.php'), window.CamRelayJson.get('detector-status.php')]);
    renderRecording();
    renderLoading();
    keepViews();
    tick();   // a camera that has just started recording is shown now, not at the next second
  }

  picture.addEventListener('error', () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => show(current), RETRY_MS);
  });
  // A click on the picture shows it full screen, another one leaves (the page works without the helper).
  if (window.CamFullscreen && pictureBox) picture.addEventListener('click', () => window.CamFullscreen.toggle(pictureBox));
  el('prev').addEventListener('click', () => step(-1));
  el('next').addEventListener('click', () => step(1));
  el('slideshow').addEventListener('click', () => setSlideshow(slideshow === null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  setSlideshow(true);   // the slideshow runs from the moment the page opens; the button stops it
  tick();
  setInterval(tick, TICK_MS);
  poll();
  setInterval(poll, POLL_MS);
})();
