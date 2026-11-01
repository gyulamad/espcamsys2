'use strict';

// Tests the "make room for footage" rule of the dashboard page (php/cameras/index.php) by running exactly
// the block between its <stream-pause> markers. The live pictures are connections that never end, and a
// browser allows about 6 per address; while the user waits for the file list, a clip, a download or a
// delete, every picture is closed, and they must come back exactly when nothing needs the room any more —
// never earlier (the request would starve again) and never never (the dashboard would stay blind).

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');
const m = /\/\/ <stream-pause>\n([\s\S]*?)\/\/ <\/stream-pause>/.exec(page);
assertTrue(!!m, 'the page has a <stream-pause> block');
const { createStreamPauser } = new Function(`${m[1]}\nreturn { createStreamPauser };`)();

function fixture() {
  const events = [];
  const pauser = createStreamPauser(() => events.push('pause'), () => events.push('resume'));
  return { events, pauser };
}

test('nothing happens until someone asks for room', () => {
  assertEqual(fixture().events, []);
});

test('the first request closes the pictures, releasing it opens them again', () => {
  const { events, pauser } = fixture();
  const release = pauser.acquire();
  assertEqual(events, ['pause']);
  release();
  assertEqual(events, ['pause', 'resume']);
});

test('overlapping requests (a list load while a clip plays) pause once and resume only after the last', () => {
  const { events, pauser } = fixture();
  const clip = pauser.acquire();
  const list = pauser.acquire();
  assertEqual(events, ['pause']);
  list();
  assertEqual(events, ['pause'], 'the clip still needs the room');
  clip();
  assertEqual(events, ['pause', 'resume']);
});

test('the order of releasing does not matter', () => {
  const { events, pauser } = fixture();
  const a = pauser.acquire();
  const b = pauser.acquire();
  a();
  assertEqual(events, ['pause']);
  b();
  assertEqual(events, ['pause', 'resume']);
});

test('releasing twice gives back only once (a double release must not steal another request\'s room)', () => {
  const { events, pauser } = fixture();
  const first = pauser.acquire();
  const second = pauser.acquire();
  first();
  first();
  assertEqual(events, ['pause'], 'the second request is still holding');
  second();
  assertEqual(events, ['pause', 'resume']);
});

test('after everything was given back, the next request pauses again', () => {
  const { events, pauser } = fixture();
  pauser.acquire()();
  pauser.acquire();
  assertEqual(events, ['pause', 'resume', 'pause']);
});

test('the page wires every footage request through the pauser', () => {
  const names = ['withLiveViewPaused(() => refreshRecordingsList(id))', 'holdLiveViewPausedWhileDownloadStarts();', 'updatePlayerHold();'];
  for (const snippet of names) assertTrue(page.includes(snippet), `missing: ${snippet}`);
  // the early-event replay runs at the top of the script: the flag it reads must be declared before it
  assertTrue(page.indexOf('let streamsPaused') < page.indexOf('function replayEarlyStreamEvents'), 'streamsPaused is declared after its first use');
});

summarize();
