'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const sp = require('../../nodejs/camera-relay/lib/soundplayer');

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null };
const config = (extra = {}) => Object.assign({ command: ['aplay', '-q'], timeoutMs: 5000 }, extra);

// A player whose runs the test finishes by hand.
function harness({ cfg = config(), pathOf = (n) => `/snd/${n}` } = {}) {
  const calls = [];
  const logs = [];
  const pending = [];
  let clock = 1000;
  const player = sp.createSoundPlayer({
    config: cfg,
    pathOf,
    run: (program, args, opts) => { calls.push({ program, args, opts }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    log: (level, text) => logs.push({ level, text }),
    now: () => clock,
  });
  return { player, calls, logs, pending, tick: (ms) => { clock += ms; } };
}

// ── resolvePlayerConfig ──

test('resolvePlayerConfig: nothing configured -> ffplay, 30 s, no warnings', () => {
  for (const raw of [undefined, null, {}, 'x', 5, []]) {
    const r = sp.resolvePlayerConfig(raw);
    assertEqual(r, { command: sp.DEFAULT_COMMAND.slice(), timeoutMs: 30000, warnings: [] }, String(raw));
  }
  assertEqual(sp.DEFAULT_COMMAND[0], 'ffplay');
});

test('resolvePlayerConfig: a configured player and timeout are used', () => {
  const r = sp.resolvePlayerConfig({ player: ['mpg123', '-q'], timeoutSeconds: 10 });
  assertEqual(r, { command: ['mpg123', '-q'], timeoutMs: 10000, warnings: [] });
});

test('resolvePlayerConfig: the default list is never shared (changing the answer cannot change the default)', () => {
  const a = sp.resolvePlayerConfig({});
  a.command.push('--evil');
  assertEqual(sp.resolvePlayerConfig({}).command, sp.DEFAULT_COMMAND.slice());
  const given = ['aplay'];
  const b = sp.resolvePlayerConfig({ player: given });
  given.push('late');
  assertEqual(b.command, ['aplay']);
});

test('resolvePlayerConfig: an unusable player is refused with a warning, the default stays', () => {
  const bad = ['aplay -q', '', [], [''], ['aplay', 5], ['aplay', 'a\nb'], ['a'.repeat(301)], new Array(17).fill('x'), 5, {}, null];
  for (const player of bad) {
    const r = sp.resolvePlayerConfig({ player });
    assertEqual(r.command, sp.DEFAULT_COMMAND.slice(), JSON.stringify(player));
    assertEqual(r.warnings.length, 1, JSON.stringify(player));
    assertTrue(/alarmSounds\.player/.test(r.warnings[0]));
  }
});

test('resolvePlayerConfig: a timeout outside 1-300 whole seconds is refused with a warning', () => {
  for (const timeoutSeconds of [0, -1, 301, 1.5, '30', NaN, null]) {
    const r = sp.resolvePlayerConfig({ timeoutSeconds });
    assertEqual([r.timeoutMs, r.warnings.length], [30000, 1], String(timeoutSeconds));
  }
  assertEqual(sp.resolvePlayerConfig({ timeoutSeconds: 300 }).timeoutMs, 300000);
});

// ── failureOf ──

test('failureOf: success is null; every other outcome is told in words', () => {
  assertEqual(sp.failureOf(OK, 'aplay', 5000), null);
  assertTrue(/could not start aplay \(spawn aplay ENOENT\).*install it, or set alarmSounds\.player/.test(sp.failureOf({ ...OK, code: null, spawnError: 'spawn aplay ENOENT' }, 'aplay', 5000)));
  assertEqual(sp.failureOf({ ...OK, code: null, timedOut: true }, 'aplay', 5000), 'aplay was stopped after 5 s without finishing');
  assertEqual(sp.failureOf({ ...OK, code: 1, stderr: '\n  no soundcards found\nmore' }, 'aplay', 5000), 'aplay exited with code 1: no soundcards found');
  assertEqual(sp.failureOf({ ...OK, code: null, signal: 'SIGSEGV' }, 'aplay', 5000), 'aplay was ended by SIGSEGV');
  assertEqual(sp.failureOf({ ...OK, code: 2 }, 'aplay', 5000), 'aplay exited with code 2');
});

test('failureOf: the player\'s own words are cut short and have no control characters', () => {
  const text = sp.failureOf({ ...OK, code: 1, stderr: `bad\u001b[31m${'x'.repeat(500)}` }, 'aplay', 5000);
  assertTrue(text.length < 260 && !/[\u0000-\u001f]/.test(text), text);
});

// ── createSoundPlayer ──
// (the repo's convention for async code: do the awaiting first, then check what came out with plain tests)

(async () => {
  // runs the player once and finishes it with `result`; -> { h, r (the play() answer), outcome (what done said) }
  async function runOnce(result, harnessOptions) {
    const h = harness(harnessOptions);
    const r = h.player.play('siren.wav');
    h.pending[0].resolve(result);
    return { h, r, outcome: await r.done };
  }

  // a normal run
  const ok = harness();
  const okRun = ok.player.play('siren.wav');
  const argsSeenImmediately = ok.calls.slice();            // the player is started now, not a tick later
  ok.pending[0].resolve(OK);
  const okOutcome = await okRun.done;

  // busy while playing
  const busy = harness();
  const first = busy.player.play('a.wav');
  const playingDuring = busy.player.isPlaying();
  const second = busy.player.play('b.wav');
  const callsWhileBusy = busy.calls.length;
  busy.pending[0].resolve(OK);
  await first.done;
  const freeAfter = !busy.player.isPlaying();
  const third = busy.player.play('b.wav');

  // an invalid name
  const invalid = harness({ pathOf: (n) => { if (n !== 'ok.wav') throw new Error('no'); return '/snd/ok.wav'; } });
  const invalidAnswer = invalid.player.play('../x.wav');

  // a player that fails, a run that rejects, a run that throws at once
  const failed = await runOnce({ ...OK, code: 1, stderr: 'no soundcards found' });
  const rejecting = harness();
  const rejected = rejecting.player.play('a.wav');
  rejecting.pending[0].reject(new Error('boom'));
  const rejectedOutcome = await rejected.done;
  const throwing = sp.createSoundPlayer({ config: config(), pathOf: (n) => n, run: () => { throw new Error('sync boom'); }, log: () => {} });
  const thrownOutcome = await throwing.play('x.wav').done;

  // repeated failures
  const rep = harness();
  const fail = async () => { const r = rep.player.play('a.wav'); rep.pending[rep.pending.length - 1].resolve({ ...OK, code: 1 }); await r.done; };
  await fail(); await fail(); await fail();
  const logsAfterThree = rep.logs.length;
  rep.tick(61 * 1000);
  await fail();

  // a success is quiet
  const quiet = await runOnce(OK);

  test('play: runs the player with its arguments and the file LAST, with the configured time limit — started at once', () => {
    assertEqual(argsSeenImmediately, [{ program: 'aplay', args: ['-q', '/snd/siren.wav'], opts: { timeoutMs: 5000 } }]);
    assertEqual(okRun.status, 'started');
    assertEqual(okOutcome, { ok: true });
  });

  test('play: while one sound plays, another request is busy (not queued); afterwards the player is free again', () => {
    assertTrue(playingDuring);
    assertEqual(second, { status: 'busy' });
    assertEqual(callsWhileBusy, 1);
    assertTrue(freeAfter);
    assertEqual(third.status, 'started');
  });

  test('play: a name that is not a sound\'s is invalid, nothing is run, and the player stays free', () => {
    assertEqual(invalidAnswer, { status: 'invalid' });
    assertEqual(invalid.calls.length, 0);
    assertTrue(!invalid.player.isPlaying());
  });

  test('play: a player that fails is reported (ok: false) and logged, and the player is free again', () => {
    assertEqual(failed.outcome, { ok: false, error: 'aplay exited with code 1: no soundcards found' });
    assertTrue(!failed.h.player.isPlaying());
    assertEqual(failed.h.logs.length, 1);
    assertEqual(failed.h.logs[0].level, 'WARN');
    assertTrue(/could not be played on this machine: aplay exited with code 1/.test(failed.h.logs[0].text));
  });

  test('play: a run that rejects or throws (it should not) is still a result — no unhandled rejection, no stuck player', () => {
    assertEqual(rejectedOutcome, { ok: false, error: 'aplay could not be run: boom' });
    assertTrue(!rejecting.player.isPlaying());
    assertEqual(thrownOutcome, { ok: false, error: 'aplay could not be run: sync boom' });
    assertTrue(!throwing.isPlaying());
  });

  test('play: repeated failures leave one log line per minute, carrying how many were left out', () => {
    assertEqual(logsAfterThree, 1);
    assertEqual(rep.logs.length, 2);
    assertTrue(/2 more failures since the last line/.test(rep.logs[1].text), rep.logs[1].text);
  });

  test('play: a success logs nothing', () => {
    assertEqual(quiet.h.logs, []);
  });

  summarize();
})();
