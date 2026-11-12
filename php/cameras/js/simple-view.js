'use strict';
// simple-view.js — simple-view.php: shows one camera, the pager, the status line and the slideshow. The
// decisions (next camera, what is shown at once, priorities) are in js/simple-logic.js; this only wires
// them to the page. Everything live arrives on ONE mux.php connection (js/mux-pictures.js): the picture of the
// camera being shown (one at a time: switching hides the old one and shows the new one), the recording state
// (the status line and the red frame around the picture) and the detectors' readings (motion). Nothing is
// polled. While the connection is down the picture is blank (its alt text shows) and nothing is known: the
// status line says so. A camera that is not connected is skipped by the slideshow and, when picked
// by hand, has its stale last picture covered with an "offline" message (js/camera-offline.js). A click on the picture
// toggles full screen of the picture alone, the FULL SCREEN button toggles it for the whole page with the status line
// (js/fullscreen.js). While the slideshow runs (it is on when the page opens), "NEXT IN n s" and a bar
// under the picture show the time left before the next camera.

(function () {
  const S = window.CamSimple;
  const root = document.getElementById('view');
  if (!S || !window.CamOffline || !window.CamMuxPictures || !root) return;

  const TICK_MS = 1000;     // clock, and how often the slideshow looks at the situation
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
  let status = null;               // the newest recording state of the cameras the relay pushed (null: not known)
  let detectors = null;            // the newest readings of the detectors (null: not known)
  const viewAsked = {};            // detector id -> when its live view was last requested
  const humans = S.createHumanHold();   // a camera that had a human keeps it for a moment when a look is lost or fails

  // How interesting each camera is at `now`, the way the slideshow (and its countdown) must see it: from the last
  // answers of the relay, with a human held through a gap in them. One place, so they can never disagree.
  const situation = (now) => humans.apply(now, S.priorities(ids, status, detectors));

  // The status line and the red frame around the picture follow the recording state of the current camera.
  function renderRecording() {
    const rec = el('rec');
    const on = S.isRecording(status, current);
    rec.textContent = 'RECORDING: ' + (status === null ? '–' : on ? 'ON' : 'off');
    rec.className = on ? 'rec-on' : 'rec-off';
    if (pictureBox) pictureBox.classList.toggle('recording', on);
  }

  // A camera that is not connected sends nothing, and the picture would stay on its last frame: cover it with the
  // "offline" message until the camera is back.
  function renderOffline() {
    window.CamOffline.render(el('offline'), status, current);
  }

  // Only the camera on screen is asked for: the old one is hidden first (its picture is dropped from the one
  // connection, which is renewed once for both calls) and frames of any other camera are never painted.
  function show(id) {
    if (id !== current && current !== undefined) pictures.hide(current);
    current = id;
    pictures.show(id);
    picture.alt = nameOf(id);
    el('cam-name').textContent = nameOf(id);
    el('cam-icon').textContent = iconOf(id);
    document.title = nameOf(id) + ' — ESP32-CAM Dashboard';
    try { history.replaceState(null, '', 'simple-view.php?cam=' + encodeURIComponent(id)); } catch (e) { /* not allowed here: the address just stays */ }
    renderRecording();
    renderOffline();
  }

  function step(direction) {
    const id = S.neighbor(ids, current, direction);
    if (id === null) return;
    if (slideshow) slideshow.show(id, Date.now());   // the viewer's choice gets a full time
    show(id);
    renderCountdown(Date.now(), situation(Date.now()));
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
    renderCountdown(Date.now(), on ? situation(Date.now()) : null);
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
    const prio = situation(now);
    keepViews();   // no poll to ride on any more: the tick renews the views (viewRequests lets one through per VIEW_KEEP_MS)
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
      }).catch(() => { delete viewAsked[id]; });   // out of reach: ask again at the next tick
    }
  }

  // What the relay pushed is all there is to know: the pages' state follows it, and the slideshow and the
  // status line are brought up to date at once (a camera that has just started recording is shown now, not
  // at the next second).
  function refresh() {
    renderRecording();
    renderOffline();
    tick();
  }

  const asMap = (data) => (data && typeof data === 'object' && !Array.isArray(data) ? data : null);

  const pictures = window.CamMuxPictures.create({
    url: 'mux.php',
    // Only the camera on screen has an image; a frame of any other is dropped by the caller.
    imgFor: (kind, id) => (kind === 'cam' && id === current ? picture : null),
    onStatus: (data) => { detectors = asMap(data); refresh(); },
    onCameraStatus: (data) => { status = asMap(data); refresh(); },
    // The connection ended (it opens again by itself): nothing is known until it is back, and the picture
    // that stands is the last one — blank it rather than show a frozen image as if it were live.
    onDown: () => {
      status = null;
      detectors = null;
      picture.removeAttribute('src');
      refresh();
    },
  });

  // Two ways into full screen, both toggles (the page works without the helper: no listener, the button stays hidden):
  // a click on the picture shows the picture alone (its box: no status line), the FULL SCREEN button shows the whole
  // page, status line (camera name, clock, recording, countdown) included.
  function wireFullscreen() {
    const fullscreen = window.CamFullscreen;
    if (!fullscreen) return;
    const toggleOnClick = (trigger, target) => trigger.addEventListener('click', () => fullscreen.toggle(target));
    if (pictureBox) toggleOnClick(picture, pictureBox);
    const button = el('fullscreen');
    const page = document.documentElement;
    if (!button || !fullscreen.supported(page)) return;   // nothing the button could do here: it stays hidden
    toggleOnClick(button, page);
    // Pressed while the whole page is full screen. (While the picture alone is, its box covers the button.)
    const renderPressed = () => {
      const on = fullscreen.current(document) === page;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    fullscreen.watch(renderPressed);   // also when the browser ends it (Esc)
    renderPressed();
    button.hidden = false;
  }

  wireFullscreen();
  el('prev').addEventListener('click', () => step(-1));
  el('next').addEventListener('click', () => step(1));
  el('slideshow').addEventListener('click', () => setSlideshow(slideshow === null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // A phone or tablet must not switch its screen off while the pictures run (the page works without the helper).
  if (window.CamScreenKeeper) {
    const keeper = window.CamScreenKeeper.create();
    keeper.keepAwake();
    const state = el('screen-state');
    // Says what holds the screen, so a device that still goes dark can be told apart from one that is not held.
    setInterval(() => {
      if (!state) return;
      const how = keeper.method();
      state.hidden = false;
      state.textContent = how === 'wake-lock' ? 'SCREEN: KEPT ON' : how === 'video' ? 'SCREEN: KEPT ON (VIDEO)' : 'SCREEN: NOT HELD – TOUCH THE PAGE';
    }, 2000);
  }

  if (current !== undefined) pictures.show(current);   // (no usable camera list: nothing to show)
  pictures.watchCameraStatus(true);
  pictures.watchStatus(true);
  setSlideshow(true);   // the slideshow runs from the moment the page opens; the button stops it
  tick();
  setInterval(tick, TICK_MS);
})();
