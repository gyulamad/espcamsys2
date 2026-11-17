'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { createAlarmSounds, EVENTS } = require('../../nodejs/camera-relay/lib/alarmsound');
const sysconfig = require('../../nodejs/camera-relay/lib/sysconfig');

// settings: what the dashboard has saved. Unmentioned ones are "no sound, both places ON" (the schema's defaults).
function make(settings = {}, { present = ['siren.wav', 'beep.mp3'], playStatus = 'started', playThrows = false } = {}) {
  const published = [];
  const played = [];
  const logs = [];
  const clock = { t: 1000 };
  const values = { alarmSoundRecordStart: '', alarmSoundRecordStartRelay: true, alarmSoundRecordStartBrowser: true,
    alarmSoundPersonDetected: '', alarmSoundPersonDetectedRelay: true, alarmSoundPersonDetectedBrowser: true, ...settings };
  const sounds = createAlarmSounds({
    setting: (key) => values[key],
    soundExists: (name) => present.includes(name),
    player: { play: (name) => { if (playThrows) throw new Error('player exploded'); played.push(name); return { status: playStatus }; } },
    feed: { publish: (e) => published.push(e) },
    log: (level, text, extra) => logs.push({ level, text, sender: extra && extra.sender }),
    now: () => clock.t,
  });
  return { sounds, published, played, logs, clock, values };
}

test('EVENTS: each event names three distinct settings, and every one exists in the settings schema', () => {
  const keys = new Set(sysconfig.FIELDS.map((f) => f.key));
  const seen = [];
  for (const [kind, e] of Object.entries(EVENTS)) {
    for (const key of [e.sound, e.relay, e.browser]) { assertTrue(keys.has(key), `${kind}: ${key}`); seen.push(key); }
    assertEqual(sysconfig.FIELDS.find((f) => f.key === e.sound).type, 'sound');
    assertEqual([sysconfig.FIELDS.find((f) => f.key === e.relay).type, sysconfig.FIELDS.find((f) => f.key === e.browser).type], ['bool', 'bool']);
  }
  assertEqual(new Set(seen).size, seen.length);
  assertEqual(Object.keys(EVENTS), ['recordStart', 'personDetected']);
});

test('no sound chosen: nothing plays anywhere', () => {
  const t = make();
  assertEqual(t.sounds.trigger('recordStart', 'cam1'), { browser: false, relay: null });
  assertEqual([t.published, t.played, t.logs], [[], [], []]);
});

test('a sound chosen for both places: it goes to the browsers (with the camera and the kind) and to the relay\'s speaker', () => {
  const t = make({ alarmSoundRecordStart: 'siren.wav' });
  assertEqual(t.sounds.trigger('recordStart', 'cam1'), { browser: true, relay: 'started' });
  assertEqual(t.published, [{ kind: 'recordStart', camId: 'cam1', sound: 'siren.wav' }]);
  assertEqual(t.played, ['siren.wav']);
});

test('only the relay machine, or only the browsers, when only that one is ON', () => {
  const relayOnly = make({ alarmSoundRecordStart: 'siren.wav', alarmSoundRecordStartBrowser: false });
  assertEqual(relayOnly.sounds.trigger('recordStart', 'cam1'), { browser: false, relay: 'started' });
  assertEqual([relayOnly.published, relayOnly.played], [[], ['siren.wav']]);
  const browserOnly = make({ alarmSoundRecordStart: 'siren.wav', alarmSoundRecordStartRelay: false });
  assertEqual(browserOnly.sounds.trigger('recordStart', 'cam1'), { browser: true, relay: null });
  assertEqual([browserOnly.published.length, browserOnly.played], [1, []]);
});

test('a sound chosen but neither place ON: silent', () => {
  const t = make({ alarmSoundRecordStart: 'siren.wav', alarmSoundRecordStartRelay: false, alarmSoundRecordStartBrowser: false });
  assertEqual(t.sounds.trigger('recordStart', 'cam1'), { browser: false, relay: null });
  assertEqual([t.published, t.played, t.logs], [[], [], []]);
});

test('the two events have their own sound and places: one does not use the other\'s settings', () => {
  const t = make({ alarmSoundRecordStart: 'siren.wav', alarmSoundPersonDetected: 'beep.mp3', alarmSoundPersonDetectedRelay: false });
  t.sounds.trigger('personDetected', 'cam2');
  assertEqual(t.published, [{ kind: 'personDetected', camId: 'cam2', sound: 'beep.mp3' }]);
  assertEqual(t.played, []);
  t.sounds.trigger('recordStart', 'cam1');
  assertEqual(t.played, ['siren.wav']);
});

test('the relay\'s speaker busy is reported, not an error, and the browsers still get the sound', () => {
  const t = make({ alarmSoundRecordStart: 'siren.wav' }, { playStatus: 'busy' });
  assertEqual(t.sounds.trigger('recordStart', 'cam1'), { browser: true, relay: 'busy' });
  assertEqual(t.published.length, 1);
  assertEqual(t.logs, []);
});

test('a chosen sound whose file is gone: no alarm, one warning a minute (with the event and camera), and nothing is played or published', () => {
  const t = make({ alarmSoundRecordStart: 'gone.wav' });
  assertEqual(t.sounds.trigger('recordStart', 'cam1'), { browser: false, relay: null });
  t.sounds.trigger('recordStart', 'cam1');
  t.sounds.trigger('recordStart', 'cam2');
  assertEqual([t.published, t.played], [[], []]);
  assertEqual(t.logs.length, 1);
  assertEqual(t.logs[0].level, 'WARN');
  assertTrue(/"gone\.wav".*a recording starts.*no alarm sound/.test(t.logs[0].text), t.logs[0].text);
  assertEqual(t.logs[0].sender, 'cam1');
  t.clock.t += 61 * 1000;
  t.sounds.trigger('recordStart', 'cam1');
  assertEqual(t.logs.length, 2);
});

test('trigger never throws: a player or an unknown event is logged as an ERROR and nothing is lost for the caller', () => {
  const boom = make({ alarmSoundRecordStart: 'siren.wav' }, { playThrows: true });
  assertEqual(boom.sounds.trigger('recordStart', 'cam1'), { browser: false, relay: null });
  assertEqual(boom.logs.length, 1);
  assertEqual(boom.logs[0].level, 'ERROR');
  assertTrue(/player exploded/.test(boom.logs[0].text));
  const unknown = make();
  unknown.sounds.trigger('nonsense', 'cam1');
  assertTrue(/unknown alarm event: nonsense/.test(unknown.logs[0].text));
  const notError = createAlarmSounds({ setting: () => { throw 'plain text'; }, soundExists: () => true, player: {}, feed: {}, log: (l, t) => notError.seen.push(t) });
  notError.seen = [];
  notError.trigger('recordStart', 'c');
  assertTrue(/plain text/.test(notError.seen[0]));
});

test('onScanFinished: a person in a fresh clip sounds the alarm for that camera', () => {
  const t = make({ alarmSoundPersonDetected: 'beep.mp3' });
  t.sounds.onScanFinished({ payload: { camId: 'cam3', clipPath: '/r/cam3/a.mp4', notify: true } }, { state: 'person' });
  assertEqual(t.published, [{ kind: 'personDetected', camId: 'cam3', sound: 'beep.mp3' }]);
  assertEqual(t.played, ['beep.mp3']);
});

test('onScanFinished: nothing for a clip nobody is in, a failed check, a re-check by hand, or a malformed job', () => {
  const t = make({ alarmSoundPersonDetected: 'beep.mp3' });
  const job = (notify) => ({ payload: { camId: 'cam3', clipPath: '/r/cam3/a.mp4', notify } });
  t.sounds.onScanFinished(job(true), { state: 'moved' });
  t.sounds.onScanFinished(job(true), { state: 'deleted' });
  t.sounds.onScanFinished(job(true), { state: 'error', reason: 'x' });
  t.sounds.onScanFinished(job(false), { state: 'person' });
  t.sounds.onScanFinished({ payload: { camId: 'cam3' } }, { state: 'person' });
  t.sounds.onScanFinished({}, { state: 'person' });
  t.sounds.onScanFinished(null, { state: 'person' });
  t.sounds.onScanFinished(job(true), null);
  t.sounds.onScanFinished(job(true), undefined);
  assertEqual([t.published, t.played, t.logs], [[], [], []]);
});

test('onScanFinished: a person alarm needs no notification channel (it is independent of the messages)', () => {
  const t = make({ alarmSoundPersonDetected: 'beep.mp3', alarmSoundPersonDetectedRelay: false });
  t.sounds.onScanFinished({ payload: { camId: 'cam1', clipPath: '/r/cam1/a.mp4', notify: true } }, { state: 'person' });
  assertEqual(t.published.length, 1);
});

test('eventsUsing: which alarms rely on a sound (whatever places they use), so it is not deleted from under them', () => {
  const t = make({ alarmSoundRecordStart: 'siren.wav', alarmSoundPersonDetected: 'siren.wav', alarmSoundRecordStartRelay: false, alarmSoundRecordStartBrowser: false });
  assertEqual(t.sounds.eventsUsing('siren.wav'), ['a recording starts', 'a person is found in a recording']);
  assertEqual(t.sounds.eventsUsing('beep.mp3'), []);
  assertEqual(make().sounds.eventsUsing('siren.wav'), []);
});

summarize();
