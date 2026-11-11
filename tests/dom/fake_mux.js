'use strict';

// fake_mux.js — stands in for js/mux-pictures.js in the jsdom tests of the dashboard.
//
// The dashboard gets all its live data from ONE mux.php connection, through CamMuxPictures (js/mux-pictures.js). jsdom
// loads no external script unless the test names it (see pageScriptLoader in dom_helpers.js) and has no streaming
// fetch, so the tests give the page this fake instead, in beforeParse, and play the part of the connection themselves:
//
//   const mux = installFakeMux(window);   // before the page's scripts run
//   mux.pushCameraStatus({ cam1: { recording: false, ... } });   // what the relay pushes every 2 s: the cameras' state
//   mux.pushStatus({ 'cam1': { state: 'online', ... } });        // ... and the detectors' readings
//   mux.paint('cam', 'cam1');   // a picture arrives: it goes onto the <img> and fires its load event, like the real one
//   mux.down();                 // the connection ended (the real client reopens it by itself)
//   mux.calls                   // every call the page made on the pictures object, in order: 'show cam1', 'reconnect', ...
//   mux.shown('cam') / mux.shown('det')   // the ids whose picture the page wants now
//
// It keeps the contract of the real object (the same method names, `onDown` given the cameras being shown) and nothing
// else: it opens no connection and sends nothing.

function installFakeMux(window) {
  const wanted = { cam: new Set(), det: new Set() };
  const mux = {
    calls: [],
    options: null,
    created: 0,
    shown: (kind) => [...wanted[kind]].sort(),
    pushStatus: (data) => mux.options.onStatus(data),
    pushCameraStatus: (data) => mux.options.onCameraStatus(data),
    down: () => mux.options.onDown(mux.shown('cam')),
    paint(kind, id) {
      const img = mux.options.imgFor(kind, id);
      if (!img) return null;
      img.setAttribute('src', `blob:fake-mux/${kind}-${id}`);
      img.dispatchEvent(new window.Event('load'));
      return img;
    },
  };

  const record = (text) => mux.calls.push(text);
  const pictures = {
    show: (id) => { record(`show ${id}`); wanted.cam.add(id); },
    hide: (id) => { record(`hide ${id}`); wanted.cam.delete(id); },
    showDetector: (id) => { record(`showDetector ${id}`); wanted.det.add(id); },
    hideDetector: (id) => { record(`hideDetector ${id}`); wanted.det.delete(id); },
    watchStatus: (on) => record(`watchStatus ${on}`),
    watchCameraStatus: (on) => record(`watchCameraStatus ${on}`),
    reconnect: () => record('reconnect'),
    close: () => record('close'),
  };

  window.CamMuxPictures = {
    create(options) {
      mux.created += 1;
      mux.options = options;
      return pictures;
    },
  };
  return mux;
}

module.exports = { installFakeMux };
