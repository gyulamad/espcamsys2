'use strict';

// sharedsnapshot.js — one value that many viewers want to be told about, worked out ONCE for all of them.
//
// GET /status (every camera's recording state, FILES count and switch) reads the recordings' folders, so
// answering it for each open dashboard tab every few seconds costs more the more tabs there are. Instead, while
// at least one viewer is subscribed, one timer works the value out every `intervalMs` and hands the same text to
// every subscriber; with nobody subscribed nothing runs at all.
//
//   const status = createSharedSnapshot({ compute: async () => '{"cam1":{...}}', intervalMs: 2000 });
//   const stop = status.subscribe((text) => ...);   // the newest value at once (if there is one), then every tick
//   stop();
//
// compute() returns the value as text (JSON). A round that fails is skipped (the viewers keep what they had),
// and a round that is still running when the next tick comes is not started a second time.

function createSharedSnapshot({ compute, intervalMs, onError = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const listeners = new Set();
  let newest = null;      // the last value worked out, while somebody is subscribed
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      newest = await compute();
      [...listeners].forEach((listener) => listener(newest));
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  function start() {
    timer = setTimer(tick, intervalMs);
    tick();
  }

  function stop() {
    clearTimer(timer);
    timer = null;
    newest = null;   // by the next subscriber it would be old
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      else if (newest !== null) listener(newest);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
  };
}

module.exports = { createSharedSnapshot };
