'use strict';
// screen-keeper.js — keeps a phone's or tablet's screen from going dark while a camera picture is on it (the
// slideshow, a live stream). Loaded by the pages as a plain script (window.CamScreenKeeper) and by
// tests/node/test_screen_keeper.js with require(); the browser's objects are parameters, so the test needs no browser.
//
// Two ways, the first one when the browser offers it:
//   1. The Screen Wake Lock API (navigator.wakeLock) — the proper way, but browsers allow it on HTTPS (and
//      localhost) only. The browser drops the lock whenever the page is hidden, so it is asked for again when the
//      page is shown again.
//   2. A tiny silent video, muted, looping, played inline and out of sight: a screen does not sleep while a video
//      plays. This works on plain http:// too (a Raspberry Pi on the home network usually is), which is why it is
//      the fallback. Browsers may refuse to START a video without a touch: then the first touch or click on the
//      page starts it.
// The keeper never throws and never needs a browser feature: where neither way exists, it does nothing.
//
//   const keeper = CamScreenKeeper.create();   // { nav, doc, makeVideo } can be given (tests)
//   keeper.keepAwake();   keeper.allowSleep();   keeper.isAwake();   keeper.method()  // 'wake-lock' | 'video' | 'none'

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamScreenKeeper = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // 16x16 black, 2 s, no sound: a few hundred bytes each. WebM for Chrome / Firefox / Android, MP4 (H.264
  // baseline) for Safari / iOS.
  const VIDEO_WEBM = 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAInEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggIR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECfQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYgphbM5w9hXtZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhB3NZQDgibCBELqBEJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYgphbM5w9hXtWfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnXt54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwNYAD+/6tQgKOVgQH0ALEBAAcQ7AAYABhYL/QACAAAo5WBA+gAsQEABxDsABgAGFgv9AAIAACjlYEF3ACxAQAHEOwAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAZ/wgQM=';
  const VIDEO_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAM1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAl90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABgm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUJzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAF2dCwAqmEXsBEAAAAwAQAAADAEDxImEYAQAGaMhCA5LIAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAACowAAAqMAAAAGHN0dHMAAAAAAAAAAQAAAAQAACAAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAQAAAABAAAAJHN0c3oAAAAAAAAAAAAAAAQAAAKFAAAACgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA2UAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAACq21kYXQAAAJyBgX//27cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MTYgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDEzMSBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD02MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTQwLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAALZYiCAp5MUAASB8AAAAAGQZocBT1AAAAABkGaKgFPUAAAAAZBmjsBL1A=';
  const GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'];   // a touch the browser accepts as "the user played it"

  // The hidden video, in the page. Not display:none (some browsers do not count a video they do not draw as
  // playing): one nearly invisible pixel that takes no clicks.
  function domVideo(doc) {
    const video = doc.createElement('video');
    video.setAttribute('playsinline', '');   // iOS: play in the page, never take over the screen
    video.setAttribute('muted', '');
    video.setAttribute('loop', '');
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('tabindex', '-1');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    for (const [src, type] of [[VIDEO_WEBM, 'video/webm'], [VIDEO_MP4, 'video/mp4']]) {
      const source = doc.createElement('source');
      source.src = src;
      source.type = type;
      video.appendChild(source);
    }
    doc.body.appendChild(video);
    return video;
  }

  function create({ nav, doc, makeVideo } = {}) {
    const navigatorObj = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);
    const docObj = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
    const buildVideo = makeVideo || (docObj && docObj.body ? () => domVideo(docObj) : null);

    let wanted = false;       // keepAwake() was asked for and allowSleep() has not been since
    let sentinel = null;      // the wake lock the browser gave us
    let requesting = false;   // a wake lock request is on its way
    let video = null;
    let armed = null;         // the handler waiting for a touch to start the video

    const canLock = () => !!(navigatorObj && navigatorObj.wakeLock && typeof navigatorObj.wakeLock.request === 'function');
    const hidden = () => !!(docObj && docObj.visibilityState === 'hidden');

    function disarm() {
      if (!armed) return;
      for (const g of GESTURES) docObj.removeEventListener(g, armed);
      armed = null;
    }

    // The browser would not start the video by itself: the first touch does (and every later one, until it plays).
    function arm() {
      if (armed || !docObj || !wanted) return;
      armed = () => { disarm(); startVideo(); };
      for (const g of GESTURES) docObj.addEventListener(g, armed);
    }

    function startVideo() {
      if (!wanted || !buildVideo) return;
      try {
        video = video || buildVideo();
        const played = video.play();
        if (played && typeof played.then === 'function') played.then(disarm, arm);
        else disarm();
      } catch (e) {
        arm();
      }
    }

    function stopVideo() {
      disarm();
      if (video && typeof video.pause === 'function') video.pause();
    }

    async function acquire() {
      if (!wanted || requesting) return;
      if (sentinel) return;                 // still held
      if (hidden()) return;                 // a hidden page cannot hold a lock: asked again when it is shown
      if (!canLock()) return startVideo();
      requesting = true;
      try {
        const lock = await navigatorObj.wakeLock.request('screen');
        if (!wanted) {                      // allowSleep() came while the browser was thinking
          lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });   // the browser took it back
        stopVideo();
      } catch (e) {
        startVideo();                       // refused (battery saver, policy): the video does the same job
      } finally {
        requesting = false;
      }
    }

    // The page was hidden and is shown again (or the lock was taken back): hold the screen again.
    function onVisibility() {
      if (!wanted || hidden()) return;
      acquire();
      if (!sentinel && !canLock()) startVideo();
    }
    if (docObj && typeof docObj.addEventListener === 'function') docObj.addEventListener('visibilitychange', onVisibility);

    return {
      keepAwake() {
        if (wanted) return;
        wanted = true;
        acquire();
      },
      allowSleep() {
        wanted = false;
        if (sentinel) { const lock = sentinel; sentinel = null; lock.release(); }
        stopVideo();
      },
      isAwake: () => sentinel !== null || !!(video && !video.paused),
      method: () => (sentinel ? 'wake-lock' : (video && !video.paused ? 'video' : 'none')),
    };
  }

  return { create, domVideo, VIDEO_WEBM, VIDEO_MP4 };
});
