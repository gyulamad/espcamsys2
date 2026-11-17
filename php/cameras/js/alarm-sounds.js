'use strict';
// alarm-sounds.js — plays the alarm sounds in the browser. The relay says WHEN (the alarm events of GET /mux?alarms=1,
// php/cameras/lib/Sounds.php shapes them, nodejs/camera-relay/lib/alarmfeed.js makes them); this decides which of
// them are NEW to this page and plays the sound.
//
//   const alarms = CamAlarmSounds.create({ onBlocked });
//   pictures = CamMuxPictures.create({ ..., onAlarms: alarms.handle });      pictures.watchAlarms(true);
//
// The list the relay sends holds its latest few events, each with a number that only goes up (`seq`) and the time it
// happened (`at`, the relay's clock, as is `now`: the age of an event never depends on this device's clock):
//   - the FIRST list this page gets is only remembered, never played: opening (or reloading) a page must not sound an
//     alarm that went off before it, and moving between two pages must not play it twice
//   - after that every event with a number above the last one seen is new — played if it is not older than
//     MAX_AGE_MS (a connection that came back after a long break must not play a stale alarm)
//   - a different `epoch` means the relay restarted and numbers begin again: remembered like a first list
// One sound at a time: while one is playing (a recording starting on several cameras at once is several events with
// the same sound) the others are skipped, and the first new event of a list is the one played.
//
// Browsers only let a page play sound once the person has clicked, tapped or pressed a key on it. When they refuse,
// onBlocked(event) is called, so the page can say so (by default: one toast, js/toast.js, for the whole life of the
// page); the next click makes the following alarm play.

(function (root) {
  const MAX_AGE_MS = 15000;      // an event older than this when it reaches the page is not played
  const MAX_PLAY_MS = 30000;     // a sound that has not ended by then is no longer considered playing (so nothing sticks)
  const SOUND_URL = 'sounds.php?name=';

  const isInt = (n) => Number.isInteger(n);

  // What a page does by default when the browser refuses a sound: says so ONCE, if there is a toast to say it with.
  function blockedToastOnce() {
    let said = false;
    return () => {
      if (said || !root.CamToast) return;
      said = true;
      root.CamToast.show('The browser blocked an alarm sound. Click or tap anywhere on this page once, and the next alarm will sound.', 'info');
    };
  }

  // memory: { epoch, seq } (epoch null = nothing seen yet). payload: one list from the relay.
  // -> { memory, events }: the memory after this list, and the events of it that are new and fresh, oldest first.
  function selectNew(memory, payload, maxAgeMs = MAX_AGE_MS) {
    if (!payload || !isInt(payload.epoch) || !isInt(payload.now) || !Array.isArray(payload.events)) return { memory, events: [] };
    const events = payload.events.filter((e) => e && isInt(e.seq) && isInt(e.at) && typeof e.sound === 'string');
    const newest = events.reduce((max, e) => Math.max(max, e.seq), 0);
    if (memory.epoch !== payload.epoch) return { memory: { epoch: payload.epoch, seq: newest }, events: [] };
    const fresh = events
      .filter((e) => e.seq > memory.seq && payload.now - e.at <= maxAgeMs)
      .sort((a, b) => a.seq - b.seq);
    return { memory: { epoch: memory.epoch, seq: Math.max(memory.seq, newest) }, events: fresh };
  }

  function create({
    urlFor = (name) => SOUND_URL + encodeURIComponent(name),
    createAudio = (url) => new root.Audio(url),
    onBlocked = blockedToastOnce(),
    now = Date.now,
    maxAgeMs = MAX_AGE_MS,
  } = {}) {
    let memory = { epoch: null, seq: 0 };
    let playing = null;   // { audio, since } of the sound that is playing

    const isPlaying = () => playing !== null && now() - playing.since < MAX_PLAY_MS;

    function play(event) {
      const audio = createAudio(urlFor(event.sound));
      const mine = { audio, since: now() };
      playing = mine;
      const release = () => { if (playing === mine) playing = null; };
      audio.addEventListener('ended', release);
      audio.addEventListener('error', release);
      let started;
      try {
        started = audio.play();
      } catch (err) {
        release();
        return;
      }
      if (started && typeof started.catch === 'function') {
        started.catch((err) => {
          release();
          if (err && err.name === 'NotAllowedError') onBlocked(event);
        });
      }
    }

    // One list of events from the relay (the mux stream's onAlarms).
    function handle(payload) {
      const picked = selectNew(memory, payload, maxAgeMs);
      memory = picked.memory;
      if (picked.events.length === 0 || isPlaying()) return;
      play(picked.events[0]);
    }

    return { handle };
  }

  const api = { create, selectNew, MAX_AGE_MS, MAX_PLAY_MS };
  root.CamAlarmSounds = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
