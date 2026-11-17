'use strict';

// soundplayer.js — plays a sound on the machine the relay runs on (the Pi's speaker), by running an audio player
// program over the sound's file. One sound at a time: while one is playing, a request for another is not queued
// (an alarm that goes off for every camera at once must be ONE sound, not a pile that plays on for a minute).
//
// The player is what config.js's `alarmSounds.player` says — a command and its arguments as a list, the file's
// path is added as the LAST argument. The default is ffplay (comes with ffmpeg, which the relay needs anyway, and
// plays WAV, MP3 and OGG). It is run directly, never through a shell, and only the machine's owner can change it
// (it is NOT a setting of the dashboard): nothing a browser sends ends up in a command line except the file's path,
// which comes from lib/soundstore.js and so always names a file inside the sounds folder.
//
// Running the program is injected (`run`, normally lib/runprocess.js), so this is unit tested without a player or a
// speaker — tests/node/test_soundplayer.js.

const { Throttle } = require('./throttle');

const DEFAULT_COMMAND = Object.freeze(['ffplay', '-nodisp', '-autoexit', '-loglevel', 'error']);
const DEFAULT_TIMEOUT_SECONDS = 30;       // a sound that has not ended by then is stopped: no player may hang for ever
const MAX_TIMEOUT_SECONDS = 300;
const MAX_ARGUMENTS = 16;
const MAX_ARGUMENT_LENGTH = 300;
const FAILURE_LOG_WINDOW_MS = 60 * 1000;  // a speaker that does not work must leave a line now and then, not one per alarm
const STDERR_LINE_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_G = /[\u0000-\u001f\u007f]+/g;

// config.js's `alarmSounds` block -> { command: [program, ...arguments], timeoutMs, warnings }. A value that is not
// usable is left out with a warning and the default is used, so a typo can never stop the relay from starting.
function resolvePlayerConfig(raw) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const warnings = [];
  let command = DEFAULT_COMMAND.slice();
  if (given.player !== undefined) {
    const p = given.player;
    const usable = Array.isArray(p) && p.length >= 1 && p.length <= MAX_ARGUMENTS
      && p.every((a) => typeof a === 'string' && a !== '' && a.length <= MAX_ARGUMENT_LENGTH && !CONTROL_CHARS.test(a));
    if (usable) command = p.slice();
    else warnings.push(`alarmSounds.player must be a list of 1-${MAX_ARGUMENTS} texts — the program, then its arguments, like ['aplay', '-q'] (the file is added last) — ${DEFAULT_COMMAND[0]} is used`);
  }
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (given.timeoutSeconds !== undefined) {
    const n = given.timeoutSeconds;
    if (Number.isInteger(n) && n >= 1 && n <= MAX_TIMEOUT_SECONDS) timeoutSeconds = n;
    else warnings.push(`alarmSounds.timeoutSeconds must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS} — ${DEFAULT_TIMEOUT_SECONDS} is used`);
  }
  return { command, timeoutMs: timeoutSeconds * 1000, warnings };
}

// The outcome of one run of the player in words, or null when it went fine.
function failureOf(result, program, timeoutMs) {
  if (result.spawnError) return `could not start ${program} (${result.spawnError}) — install it, or set alarmSounds.player in config.js`;
  if (result.timedOut) return `${program} was stopped after ${Math.round(timeoutMs / 1000)} s without finishing`;
  if (result.code === 0) return null;
  const line = String(result.stderr || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || '';
  const why = line.replace(CONTROL_CHARS_G, ' ').slice(0, STDERR_LINE_LENGTH);
  return `${program} ${result.signal ? `was ended by ${result.signal}` : `exited with code ${result.code}`}${why ? `: ${why}` : ''}`;
}

// A promise for what `fn` returns — also when it throws at once, so the caller handles one kind of failure.
function attempt(fn) {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

// deps: config (resolvePlayerConfig's answer), pathOf(name) -> the file (throws for a name that is not a sound's),
//   run(program, args, { timeoutMs }) -> Promise<result of lib/runprocess.js>, log(level, text), now() -> ms
//   play(name) -> { status: 'started', done: Promise<{ ok, error? }> } | { status: 'busy' } | { status: 'invalid' }
// `done` never rejects.
function createSoundPlayer({ config, pathOf, run, log, now = Date.now }) {
  const [program, ...baseArgs] = config.command;
  const failures = new Throttle(FAILURE_LOG_WINDOW_MS);
  let playing = false;

  function logFailure(error) {
    const t = failures.check('player', now());
    if (!t.allow) return;
    const more = t.suppressed > 0 ? ` (${t.suppressed} more failure${t.suppressed === 1 ? '' : 's'} since the last line)` : '';
    log('WARN', `the alarm sound could not be played on this machine: ${error}${more}`);
  }

  function play(name) {
    if (playing) return { status: 'busy' };
    let file;
    try {
      file = pathOf(name);
    } catch (err) {
      return { status: 'invalid' };
    }
    playing = true;
    const done = attempt(() => run(program, [...baseArgs, file], { timeoutMs: config.timeoutMs }))   // started now, not a tick later
      .then((result) => failureOf(result, program, config.timeoutMs))
      .catch((err) => `${program} could not be run: ${err && err.message ? err.message : err}`)
      .then((error) => {
        playing = false;
        if (error === null) return { ok: true };
        logFailure(error);
        return { ok: false, error };
      });
    return { status: 'started', done };
  }

  return { play, isPlaying: () => playing };
}

module.exports = { resolvePlayerConfig, createSoundPlayer, failureOf, DEFAULT_COMMAND, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
