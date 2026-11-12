'use strict';
// mux-client.js — keeps ONE long-lived connection to mux.php open and hands what arrives to the page.
// Only the connection lives here: what the messages mean is the caller's business (js/mux-pictures.js), what
// they look like is js/mux-codec.js.
//
//   const client = CamMuxClient.create({ buildUrl, onMessage, onDown });
//   client.start();     // opens it (does nothing while it is open or waiting to retry)
//   client.restart();   // closes it and opens it again at once (the URL is asked for again: the camera list may have changed)
//   client.stop();      // closes it
//
// When the connection ends, for whatever reason (refused, not a mux stream, garbage, a dead link), onDown() is
// called and it is opened again after a pause that grows to 15 s. The client NEVER gives up and has no other way
// to show the pictures to fall back on: it retries until stop() is called. A connection that stays silent for
// 15 s (the relay sends a heartbeat every 5 s) is closed and counted as ended: over Tor a stalled link would
// otherwise stay "open" for ever.

(function (root) {
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 15000;
  const SILENCE_MS = 15000;

  function backoffMs(retries) {
    return Math.min(BACKOFF_BASE_MS * 2 ** retries, BACKOFF_MAX_MS);
  }

  // env: what the browser provides, replaceable by tests ({ fetch, setTimeout, clearTimeout, AbortController, codec }).
  function create({ buildUrl, onMessage, onDown, env = {} }) {
    const io = Object.assign({
      fetch: (...args) => root.fetch(...args),
      setTimeout: (...args) => root.setTimeout(...args),
      clearTimeout: (...args) => root.clearTimeout(...args),
      AbortController: root.AbortController,
      codec: root.CamMuxCodec,
    }, env);

    let state = 'idle';        // idle | connecting | live | waiting (to retry)
    let generation = 0;        // changes whenever the connection is closed on purpose: a late result of the old one is ignored
    let retries = 0;           // attempts in a row that ended before any message arrived: the pause grows with it
    let controller = null;
    let silenceTimer = null;
    let retryTimer = null;

    const isMuxType = (contentType) => String(contentType || '').split(';')[0].trim().toLowerCase() === io.codec.CONTENT_TYPE;

    function release() {
      io.clearTimeout(silenceTimer);
      io.clearTimeout(retryTimer);
      silenceTimer = null;
      retryTimer = null;
      if (controller) controller.abort();
      controller = null;
    }

    function armSilence(mine) {
      io.clearTimeout(silenceTimer);
      silenceTimer = io.setTimeout(() => {
        if (mine === generation && controller) controller.abort();   // read() fails and run() counts the end
      }, SILENCE_MS);
    }

    function ended(mine) {
      release();
      state = 'waiting';
      onDown();
      const delay = backoffMs(retries);
      retries += 1;
      retryTimer = io.setTimeout(() => {
        retryTimer = null;
        if (mine === generation) connect();
      }, delay);
    }

    async function run(mine) {
      let live = false;
      try {
        const response = await io.fetch(buildUrl(), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (!isMuxType(response.headers.get('Content-Type'))) throw new Error('not a mux stream');
        const reader = response.body.getReader();
        const parser = io.codec.createParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (mine !== generation) return;
          if (done) throw new Error('the connection was closed');
          armSilence(mine);
          for (const message of parser.push(value)) {
            if (!live) {
              live = true;
              state = 'live';
              retries = 0;
            }
            onMessage(message);
          }
        }
      } catch (err) {
        if (mine === generation) ended(mine);
      }
    }

    function connect() {
      state = 'connecting';
      controller = new io.AbortController();
      armSilence(generation);
      run(generation);
    }

    function stop() {
      generation += 1;
      release();
      state = 'idle';
      retries = 0;
    }

    return {
      start() { if (state === 'idle') connect(); },
      restart() { stop(); connect(); },
      stop,
      state: () => state,
    };
  }

  const api = { create, backoffMs, SILENCE_MS };
  root.CamMuxClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
