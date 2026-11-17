'use strict';

// alarmsound.js — "something happened that has an alarm sound": decides whether a sound is due, and where it goes.
//
// Two events have a sound (EVENTS): a recording STARTED, and a person FOUND in a fresh recording (the person check,
// the same moment lib/detectionnotice.js sends its message). Each has three settings on the dashboard's settings
// page: which sound (none = silent), whether it plays on the machine the relay runs on, and whether it plays in
// the browsers that have the dashboard open. This module reads those settings at the moment of the event (so a
// saved change counts at once), and sends the sound to the relay's player (lib/soundplayer.js) and/or to the
// browsers (lib/alarmfeed.js).
//
// An alarm sound is a nicety on top of a recording: it must never get in the way of one. trigger() and
// onScanFinished() never throw, and nothing here waits for a speaker.
//
// Everything outside is injected, so this is unit tested without a disk, a speaker or a browser
// (tests/node/test_alarmsound.js):
//   setting(key) -> the saved value of a system setting (a sound's name or '', true/false)
//   soundExists(name) -> boolean         player.play(name)      feed.publish({ kind, camId, sound })
//   log(level, text, { sender })         now() -> ms

const { Throttle } = require('./throttle');

// kind -> its label (for messages) and the system settings that say what to do (lib/sysconfig.js)
const EVENTS = Object.freeze({
  recordStart: Object.freeze({
    label: 'a recording starts',
    sound: 'alarmSoundRecordStart', relay: 'alarmSoundRecordStartRelay', browser: 'alarmSoundRecordStartBrowser',
  }),
  personDetected: Object.freeze({
    label: 'a person is found in a recording',
    sound: 'alarmSoundPersonDetected', relay: 'alarmSoundPersonDetectedRelay', browser: 'alarmSoundPersonDetectedBrowser',
  }),
});

const MISSING_LOG_WINDOW_MS = 60 * 1000;   // a chosen sound whose file is gone: one line a minute, not one per alarm

function createAlarmSounds({ setting, soundExists, player, feed, log, now = Date.now }) {
  const missing = new Throttle(MISSING_LOG_WINDOW_MS);

  // -> { browser: boolean, relay: 'started' | 'busy' | 'invalid' | null }   what was done (null = not asked for)
  function dispatch(kind, camId) {
    const event = EVENTS[kind];
    if (!event) throw new TypeError(`unknown alarm event: ${kind}`);
    const none = { browser: false, relay: null };
    const sound = setting(event.sound);
    if (!sound) return none;
    const toRelay = setting(event.relay) === true;
    const toBrowser = setting(event.browser) === true;
    if (!toRelay && !toBrowser) return none;
    if (!soundExists(sound)) {
      const t = missing.check(`${kind}:${sound}`, now());
      if (t.allow) log('WARN', `the sound "${sound}" chosen for when ${event.label} is not in the sounds folder any more — no alarm sound (choose another on the settings page)`, { sender: camId });
      return none;
    }
    if (toBrowser) feed.publish({ kind, camId, sound });
    return { browser: toBrowser, relay: toRelay ? player.play(sound).status : null };
  }

  function trigger(kind, camId) {
    try {
      return dispatch(kind, camId);
    } catch (err) {
      log('ERROR', `the alarm sound could not be started: ${err && err.message ? err.message : err}`, { sender: camId });
      return { browser: false, relay: null };
    }
  }

  // The person check finished a clip (the scan queue's onFinished). Only a person in a clip the relay has JUST saved
  // sounds the alarm: one found while a clip is re-checked by hand stays quiet (job.payload.notify, see queueScan).
  function onScanFinished(job, outcome) {
    if (!outcome || outcome.state !== 'person') return;
    if (!job || !job.payload || !job.payload.notify) return;
    trigger('personDetected', job.payload.camId);
  }

  // The labels of the events whose sound is `name`: what stops a sound being deleted while an alarm relies on it.
  function eventsUsing(name) {
    return Object.values(EVENTS).filter((e) => setting(e.sound) === name).map((e) => e.label);
  }

  return { trigger, onScanFinished, eventsUsing };
}

module.exports = { createAlarmSounds, EVENTS };
