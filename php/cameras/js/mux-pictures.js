'use strict';
// mux-pictures.js — shows the live pictures of the cameras and of their person detectors, and delivers the
// detectors' readings, from ONE mux.php connection. The pictures go onto the page's existing <img> elements: an
// image whose source is replaced for every picture, so the page's load / error handling, fullscreen and
// styling work as they did with one MJPEG stream per image. The page says what it wants to see; this keeps the
// connection open for exactly that and paints each arriving picture onto its image.
//
//   const pictures = CamMuxPictures.create({ url: 'mux.php', imgFor, onStatus, onDown, onFallback });
//   pictures.show('cam1');           pictures.hide('cam1');            the camera's picture
//   pictures.showDetector('cam1');   pictures.hideDetector('cam1');    the picture of the detector paired with that camera
//   pictures.watchStatus(true);      the detectors' readings (onStatus gets { camId: status }, as detector-status.php)
//   pictures.reconnect();   pictures.close();
//
//   imgFor(kind, id)  the <img> of a camera ('cam') or of the detector paired with it ('det'), or null
//   onStatus(data)    the newest readings of the detectors
//   onDown(ids)       the connection ended (it is reopened by itself): the cameras that were being shown
//   onFallback()      mux.php is unusable from here (see js/mux-client.js): the page must show the pictures another way
//
// The connection exists while at least one camera is shown; detector pictures and readings ride along on it. Calls
// that arrive together (the page restarts every camera in a loop) become ONE (re)connection, and the connection
// is reopened only when what is wanted changes.

(function (root) {
  const KINDS = ['cam', 'det'];

  function create({ url, imgFor, onStatus, onDown, onFallback, env = {} }) {
    const io = Object.assign({
      createClient: (options) => root.CamMuxClient.create(options),
      codec: root.CamMuxCodec,
      defer: (fn) => root.queueMicrotask(fn),
      Blob: root.Blob,
      createObjectURL: (blob) => root.URL.createObjectURL(blob),
      revokeObjectURL: (objectUrl) => root.URL.revokeObjectURL(objectUrl),
    }, env);

    const wanted = { cam: new Set(), det: new Set() };   // camera ids whose picture / whose detector's picture is wanted
    let statusWanted = false;
    const objectUrls = new Map();   // "kind:id" -> the object URL of the picture now on that image
    let subscribed = '';            // what the open connection was made for
    let syncScheduled = false;

    const idsOf = (kind) => [...wanted[kind]].sort();
    const requestKey = () => `${idsOf('cam').join(',')}|${idsOf('det').join(',')}|${statusWanted ? 1 : 0}`;

    function buildUrl() {
      const parts = ['cams=' + encodeURIComponent(idsOf('cam').join(','))];
      if (wanted.det.size > 0) parts.push('dets=' + encodeURIComponent(idsOf('det').join(',')));
      if (statusWanted) parts.push('status=1');
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

    function deliverStatus(payload) {
      let data = null;
      try { data = JSON.parse(new TextDecoder().decode(payload)); } catch (err) { return; }   // not JSON: ignore this message
      onStatus(data);
    }

    function onMessage(message) {
      if (message.type === io.codec.TYPE_STATE) {
        if (statusWanted && message.source === io.codec.STATE_DETECTORS) deliverStatus(message.payload);
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
      onGiveUp: () => onFallback(),
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

    return {
      show: (id) => add('cam', id),
      hide: (id) => remove('cam', id),
      showDetector: (id) => add('det', id),
      hideDetector: (id) => remove('det', id),
      watchStatus(on) {
        if (statusWanted === on) return;
        statusWanted = on;
        scheduleSync();
      },
      // Opens the connection again even if it looks open (a locked phone drops it without a sound).
      reconnect() {
        if (wanted.cam.size === 0) return;
        subscribed = requestKey();
        client.restart();
      },
      close() {
        client.stop();
        KINDS.forEach((kind) => wanted[kind].clear());
        statusWanted = false;
        [...objectUrls.keys()].forEach(forget);
      },
    };
  }

  const api = { create };
  root.CamMuxPictures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
