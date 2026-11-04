'use strict';
// mux-pictures.js — shows the cameras' live pictures from ONE mux.php connection on the page's existing
// <img> elements. The page says which cameras it wants shown (show / hide); this keeps the connection open for
// exactly that list and paints each arriving picture onto its image. The image is an ordinary <img> whose
// source is replaced for every picture, so the page's load / error handling, fullscreen and styling work
// as they did with one MJPEG stream per camera.
//
//   const pictures = CamMuxPictures.create({ url: 'mux.php', imgFor, onDown, onFallback });
//   pictures.show('cam1');   pictures.hide('cam1');   pictures.reconnect();   pictures.close();
//
//   imgFor(id)      the <img> of that camera (or null)
//   onDown(ids)     the connection ended (it is reopened by itself): the cameras that were being shown
//   onFallback()    mux.php is unusable from here (see js/mux-client.js): the page must show the pictures another way
//
// Calls that arrive together (the page restarts every camera in a loop) become ONE (re)connection, and the
// connection is reopened only when the list of cameras changes.

(function (root) {
  function create({ url, imgFor, onDown, onFallback, env = {} }) {
    const io = Object.assign({
      createClient: (options) => root.CamMuxClient.create(options),
      codec: root.CamMuxCodec,
      defer: (fn) => root.queueMicrotask(fn),
      Blob: root.Blob,
      createObjectURL: (blob) => root.URL.createObjectURL(blob),
      revokeObjectURL: (objectUrl) => root.URL.revokeObjectURL(objectUrl),
    }, env);

    const wanted = new Set();     // camera ids the page wants shown
    const objectUrls = new Map(); // camera id -> the object URL of the picture now on its image
    let subscribed = '';          // the list the open connection was made for
    let syncScheduled = false;

    const cameraList = () => [...wanted].sort();

    function paint(id, bytes) {
      const img = imgFor(id);
      if (!img) return;
      const objectUrl = io.createObjectURL(new io.Blob([bytes], { type: 'image/jpeg' }));
      const previous = objectUrls.get(id);
      objectUrls.set(id, objectUrl);
      img.src = objectUrl;
      if (previous) io.revokeObjectURL(previous);
    }

    function onMessage(message) {
      if (message.type !== io.codec.TYPE_FRAME) return;
      const id = io.codec.cameraIdOf(message.source);
      if (id === null || !wanted.has(id)) return;   // not shown any more (hidden since this connection was opened)
      paint(id, message.payload);
    }

    const client = io.createClient({
      buildUrl: () => url + '?cams=' + encodeURIComponent(cameraList().join(',')),
      onMessage,
      onDown: () => onDown(cameraList()),
      onGiveUp: () => onFallback(),
    });

    function sync() {
      syncScheduled = false;
      if (wanted.size === 0) {
        client.stop();
        subscribed = '';
        return;
      }
      const list = cameraList().join(',');
      if (list !== subscribed) {
        subscribed = list;
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

    function forget(id) {
      const objectUrl = objectUrls.get(id);
      if (objectUrl) io.revokeObjectURL(objectUrl);
      objectUrls.delete(id);
    }

    return {
      show(id) {
        wanted.add(id);
        scheduleSync();
      },
      hide(id) {
        wanted.delete(id);
        forget(id);
        const img = imgFor(id);
        if (img) img.removeAttribute('src');
        scheduleSync();
      },
      // Opens the connection again even if it looks open (a locked phone drops it without a sound).
      reconnect() {
        if (wanted.size === 0) return;
        subscribed = cameraList().join(',');
        client.restart();
      },
      close() {
        client.stop();
        wanted.clear();
        [...objectUrls.keys()].forEach(forget);
      },
    };
  }

  const api = { create };
  root.CamMuxPictures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
