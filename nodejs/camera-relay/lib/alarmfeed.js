'use strict';

// alarmfeed.js — what the browsers are told when an alarm sound is due: a short list of the latest alarm events,
// each with a number that only goes up. It is what GET /mux carries as the "state:alarms" source (lib/muxfeed.js).
//
// Why a list and not "the last event": the mux stream delivers the NEWEST state of a source to a viewer that is
// behind, never the ones it missed (so a slow link cannot make the relay queue up). If two events came while a
// viewer was busy, "only the last" would lose one. With the latest few and a number on each, the viewer plays what
// it has not played yet — and a viewer that has been away longer than the list holds simply missed those, which is
// right for a live alarm.
//
//   epoch   when this relay run started: after a restart the numbers begin again, and the viewer must not think the
//           first new event is an old one
//   now     the relay's clock at the moment the list is sent: with each event's `at` it says how old an event is,
//           without the viewer's own (possibly wrong) clock coming into it
//
// Pure apart from the clock and the bus, both given — tests/node/test_alarmfeed.js.

const { EventEmitter } = require('events');

const KEEP_EVENTS = 8;

// deps: now() -> ms, keep (how many events are held), maxListeners (one listener per viewer of /mux)
//   publish({ kind, camId, sound })   adds an event and tells the bus ('change')
//   snapshot() -> { epoch, now, events: [{ seq, at, kind, camId, sound }] }   oldest first
function createAlarmFeed({ now = Date.now, keep = KEEP_EVENTS, maxListeners = 20 } = {}) {
  const bus = new EventEmitter();
  bus.setMaxListeners(maxListeners);
  const epoch = now();
  let seq = 0;
  let events = [];

  return {
    bus,
    publish({ kind, camId, sound }) {
      seq += 1;
      events = [...events, { seq, at: now(), kind, camId, sound }].slice(-keep);
      bus.emit('change');
    },
    snapshot: () => ({ epoch, now: now(), events: events.map((e) => ({ ...e })) }),
  };
}

module.exports = { createAlarmFeed, KEEP_EVENTS };
