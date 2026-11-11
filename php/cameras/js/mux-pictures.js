'use strict';
// mux-pictures.js — shows the live pictures of the cameras and of their person detectors, and delivers the
// detectors' readings and the cameras' recording state, from ONE mux.php connection. The pictures go onto the page's existing <img> elements: an
// image whose source is replaced for every picture, so the page's load / error handling, fullscreen and
// styling work as they did with one MJPEG stream per image. The page says what it wants to see; this keeps the
// connection open for exactly that and paints each arriving picture onto its image.
//
//   const pictures = CamMuxPictures.create({ url: 'mux.php', imgFor, onStatus, onCameraStatus, onDown });
//   pictures.show('cam1');           pictures.hide('cam1');            the camera's picture
//   pictures.showDetector('cam1');   pictures.hideDetector('cam1');    the picture of the detector paired with that camera
//   pictures.watchStatus(true);      the detectors' readings (onStatus gets { camId: status }, as detector-status.php)
//   pictures.watchCameraStatus(true) the cameras' recording state (onCameraStatus gets { camId: status }, as status.php)
//   pictures.reconnect();   pictures.close();
//
//   imgFor(kind, id)  the <img> of a camera ('cam') or of the detector paired with it ('det'), or null
//   onStatus(data)    the newest readings of the detectors
//   onCameraStatus(data)  the newest recording state of the cameras
//   onDown(ids)       the connection ended (it is reopened by itself, for ever, see js/mux-client.js): the cameras that were being shown
//
// The connection exists while at least one camera is shown (the recording's pre-roll needs every camera's
// stream all the time; only the page's ALL OFF hides them all); detector pictures and readings ride along on it. Calls
// that arrive together (the page restarts every camera in a loop) become ONE (re)connection, and the connection
// is reopened only when what is wanted changes.

(function (root) {
  const KINDS = ['cam', 'det'];

  function create({ url, imgFor, onStatus, onCameraStatus, onDown, env = {} }) {
    const io = Object.assign({
      createClient: (options) => root.CamMuxClient.create(options),
      codec: root.CamMuxCodec,
      defer: (fn) => root.queueMicrotask(fn),
      Blob: root.Blob,
      createObjectURL: (blob) => root.URL.createObjectURL(blob),
      revokeObjectURL: (objectUrl) => root.URL.revokeObjectURL(objectUrl),
    }, env);

    const wanted = { cam: new Set(), det: new Set() };   // camera ids whose picture / whose detector's picture is wanted
    const wantedStates = new Set();   // the sources of the readings the page wants: STATE_DETECTORS, STATE_CAMERAS
    const objectUrls = new Map();   // "kind:id" -> the object URL of the picture now on that image
    let subscribed = '';            // what the open connection was made for
    let syncScheduled = false;

    const idsOf = (kind) => [...wanted[kind]].sort();
    const requestKey = () => `${idsOf('cam').join(',')}|${idsOf('det').join(',')}|${[...wantedStates].sort().join(',')}`;

    // What each kind of readings is asked for with, and who gets them (the page's callbacks).
    const states = {
      [io.codec.STATE_DETECTORS]: { param: 'status=1', deliver: (data) => onStatus(data) },
      [io.codec.STATE_CAMERAS]: { param: 'rec=1', deliver: (data) => onCameraStatus(data) },
    };

    function buildUrl() {
      const parts = ['cams=' + encodeURIComponent(idsOf('cam').join(','))];
      if (wanted.det.size > 0) parts.push('dets=' + encodeURIComponent(idsOf('det').join(',')));
      for (const source of [...wantedStates].sort()) parts.push(states[source].param);
      return url + '?' + parts.join('&');
    }

    function paint(kind, id, bytes) {
      const img = imgFor(kind, id);
      if (!img) return;
      const objectUrl = io.createObjectURL(new io.Blob([bytes], { type: 'image/jpeg' }));
      const key = kind + ':' + id;
      const previous = objectUrls.get(key);
      objectUrls.set(key, objectUrl);
      img.src = objectUrl;
      if (previous) io.revokeObjectURL(previous);
    }

    function deliverState(message) {
      if (!wantedStates.has(message.source)) return;   // not asked for (or not any more)
      let data = null;
      try { data = JSON.parse(new TextDecoder().decode(message.payload)); } catch (err) { return; }   // not JSON: ignore this message
      states[message.source].deliver(data);
    }

    function onMessage(message) {
      if (message.type === io.codec.TYPE_STATE) {
        deliverState(message);
        return;
      }
      if (message.type !== io.codec.TYPE_FRAME) return;
      for (const kind of KINDS) {
        const id = io.codec.idOf(message.source, kind);
        // (not wanted any more: hidden since this connection was opened)
        if (id !== null && wanted[kind].has(id)) paint(kind, id, message.payload);
      }
    }

    const client = io.createClient({
      buildUrl,
      onMessage,
      onDown: () => onDown(idsOf('cam')),
    });

    function sync() {
      syncScheduled = false;
      if (wanted.cam.size === 0) {
        client.stop();
        subscribed = '';
        return;
      }
      if (requestKey() !== subscribed) {
        subscribed = requestKey();
        client.restart();
        return;
      }
      const state = client.state();
      if (state === 'idle') client.start();
      if (state === 'waiting') client.restart();   // "retry" pressed: do not wait for the pause to end
    }

    function scheduleSync() {
      if (syncScheduled) return;
      syncScheduled = true;
      io.defer(sync);
    }

    function forget(key) {
      const objectUrl = objectUrls.get(key);
      if (objectUrl) io.revokeObjectURL(objectUrl);
      objectUrls.delete(key);
    }

    const add = (kind, id) => { wanted[kind].add(id); scheduleSync(); };
    function remove(kind, id) {
      wanted[kind].delete(id);
      forget(kind + ':' + id);
      const img = imgFor(kind, id);
      if (img) img.removeAttribute('src');
      scheduleSync();
    }

    function watch(source, on) {
      if (wantedStates.has(source) === on) return;
      if (on) wantedStates.add(source); else wantedStates.delete(source);
      scheduleSync();
    }

    return {
      show: (id) => add('cam', id),
      hide: (id) => remove('cam', id),
      showDetector: (id) => add('det', id),
      hideDetector: (id) => remove('det', id),
      watchStatus: (on) => watch(io.codec.STATE_DETECTORS, on),
      watchCameraStatus: (on) => watch(io.codec.STATE_CAMERAS, on),
      // Opens the connection again even if it looks open (a locked phone drops it without a sound).
      reconnect() {
        if (wanted.cam.size === 0) return;
        subscribed = requestKey();
        client.restart();
      },
      close() {
        client.stop();
        KINDS.forEach((kind) => wanted[kind].clear());
        wantedStates.clear();
        [...objectUrls.keys()].forEach(forget);
      },
    };
  }

  const api = { create };
  root.CamMuxPictures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
