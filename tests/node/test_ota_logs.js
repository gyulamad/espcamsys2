'use strict';

// test_ota_logs.js — php/cameras/js/ota-logs.js: the dashboard's OTA & LOGS page. A fake page (tests/node/fake_dom.js), a
// fake clock and a fake request stand in for the browser, so what is checked is what the script decides: what it asks
// for and when, what it draws, and that what a server sent is only ever text.

const path = require('path');
const { asyncTest: test, assertEqual, assertTrue, runAsyncTests } = require('./framework');
const { createFakeDocument } = require('./fake_dom');

const Ota = require(path.join(__dirname, '../../php/cameras/js/ota-logs.js'));

// A clock whose timers only run when the test says so.
function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    // runs the oldest timer; resolves when what it started is done
    async fire() { const [id, t] = [...timers.entries()][0]; timers.delete(id); await t.fn(); },
    delays: () => [...timers.values()].map((t) => t.ms),
  };
}

// ── the numbers and the levels ──────────────────────────────────────────

test('clampInt: the number typed, cut to the range; the fallback when it is not a plain number', () => {
  const R = [1, 3600];
  assertEqual([Ota.clampInt('10', R, 7), Ota.clampInt(' 25 ', R, 7), Ota.clampInt('0', R, 7), Ota.clampInt('99999', R, 7), Ota.clampInt('-4', R, 7)], [10, 25, 1, 3600, 1]);
  assertEqual([Ota.clampInt('2.9', R, 7), Ota.clampInt('+8', R, 7)], [2, 8]);
  assertEqual([Ota.clampInt('', R, 7), Ota.clampInt('abc', R, 7), Ota.clampInt('1e3', R, 7), Ota.clampInt('12abc', R, 7), Ota.clampInt(undefined, R, 7), Ota.clampInt(null, R, 7)], [7, 7, 7, 7, 7, 7]);
});

test('nextLevelState: choosing a level clears ALL; ALL clears the levels; clearing ALL leaves nothing chosen', () => {
  const warnError = { WARN: true, ERROR: true, DEBUG: false, INFO: false, ALL: false };
  assertEqual(Ota.nextLevelState(warnError, 'INFO', true), { WARN: true, ERROR: true, DEBUG: false, INFO: true, ALL: false });
  assertEqual(Ota.nextLevelState(warnError, 'WARN', false), { WARN: false, ERROR: true, DEBUG: false, INFO: false, ALL: false });
  assertEqual(Ota.nextLevelState(warnError, 'ALL', true), { WARN: false, ERROR: false, DEBUG: false, INFO: false, ALL: true });
  const all = { WARN: false, ERROR: false, DEBUG: false, INFO: false, ALL: true };
  assertEqual(Ota.nextLevelState(all, 'ALL', false), { WARN: false, ERROR: false, DEBUG: false, INFO: false, ALL: false });
  assertEqual(Ota.nextLevelState(all, 'DEBUG', true), { WARN: false, ERROR: false, DEBUG: true, INFO: false, ALL: false });
  assertEqual(warnError.ALL, false, 'the old state is not changed');
});

test('selectedLevels and logsUrl: what is asked of the dashboard', () => {
  const state = (o) => ({ WARN: false, ERROR: false, DEBUG: false, INFO: false, ALL: false, ...o });
  assertEqual(Ota.selectedLevels(state({ WARN: true, ERROR: true })), ['WARN', 'ERROR']);
  assertEqual(Ota.selectedLevels(state({ ALL: true })), null);
  assertEqual(Ota.selectedLevels(state({})), []);
  assertEqual(Ota.logsUrl(1000, state({ WARN: true, ERROR: true })), 'logs-tail.php?lines=1000&levels=WARN,ERROR');
  assertEqual(Ota.logsUrl(50, state({ INFO: true, DEBUG: true })), 'logs-tail.php?lines=50&levels=DEBUG,INFO');
  assertEqual(Ota.logsUrl(1000, state({ ALL: true })), 'logs-tail.php?lines=1000');
  assertEqual(Ota.logsUrl(1000, state({})), null, 'nothing chosen: nothing to ask');
});

test('clockOf: the time of day of the server\'s own timestamp, nothing else', () => {
  assertEqual(Ota.clockOf('2026-11-17T10:00:05+01:00'), '10:00:05');
  assertEqual(Ota.clockOf('2026-11-17T23:59:59Z'), '23:59:59');
  assertEqual([Ota.clockOf(''), Ota.clockOf('yesterday'), Ota.clockOf(undefined), Ota.clockOf('<b>10:00:05</b>')], ['', '', '', '']);
});

// ── the timer ───────────────────────────────────────────────────────────

function pollerWith(run, { seconds = 10, hidden = () => false } = {}) {
  const clock = fakeClock();
  let secs = seconds;
  const poller = Ota.makePoller({ run, getSeconds: () => secs, isHidden: hidden, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, poller, setSeconds: (n) => { secs = n; } };
}

test('makePoller: runs at once, and again N seconds after each run finished', async () => {
  let runs = 0;
  const { clock, poller } = pollerWith(async () => { runs += 1; });
  await poller.start();
  assertEqual([runs, clock.delays()], [1, [10000]]);
  await clock.fire();
  assertEqual([runs, clock.delays()], [2, [10000]]);
});

test('makePoller: never two runs at once; the wait starts when the run is over', async () => {
  let release;
  let runs = 0;
  const { clock, poller } = pollerWith(() => { runs += 1; return new Promise((r) => { release = r; }); });
  const started = poller.start();
  assertEqual(clock.delays(), [], 'no next run is planned while one is going');
  release();
  await started;
  assertEqual([runs, clock.delays()], [1, [10000]]);
});

test('makePoller: a run that throws does not end the polling', async () => {
  let runs = 0;
  const { clock, poller } = pollerWith(async () => { runs += 1; throw new Error('boom'); });
  await poller.start();
  assertEqual([runs, clock.delays()], [1, [10000]]);
});

test('makePoller: a hidden tab is skipped, and asked again at the next turn', async () => {
  let runs = 0;
  let hidden = true;
  const { clock, poller } = pollerWith(async () => { runs += 1; }, { hidden: () => hidden });
  await poller.start();
  assertEqual([runs, clock.delays()], [0, [10000]]);
  hidden = false;
  await clock.fire();
  assertEqual(runs, 1);
});

test('makePoller: now() runs at once and replaces the planned run', async () => {
  let runs = 0;
  const { clock, poller } = pollerWith(async () => { runs += 1; });
  await poller.start();
  await poller.now();
  assertEqual([runs, clock.delays()], [2, [10000]], 'one planned run, not two');
});

test('makePoller: now() while a run is going runs again right after it (its answer may be for the old question)', async () => {
  const releases = [];
  let runs = 0;
  const { poller } = pollerWith(() => { runs += 1; return new Promise((r) => releases.push(r)); });
  const first = poller.start();
  await poller.now();
  assertEqual(runs, 1);
  releases[0]();
  await new Promise((r) => setImmediate(r));
  assertEqual(runs, 2);
  releases[1]();
  await first;
});

test('makePoller: restart() applies a changed interval; during a run it waits for the run', async () => {
  const { clock, poller, setSeconds } = pollerWith(async () => {});
  await poller.start();
  setSeconds(3);
  poller.restart();
  assertEqual(clock.delays(), [3000], 'the planned run moved, none added');
  let release;
  const slow = pollerWith(() => new Promise((r) => { release = r; }));
  const started = slow.poller.start();
  slow.setSeconds(5);
  slow.poller.restart();
  assertEqual(slow.clock.delays(), []);
  release();
  await started;
  assertEqual(slow.clock.delays(), [5000]);
});

// ── drawing ─────────────────────────────────────────────────────────────

const ROWS = [
  { id: 'cam1', type: 'recorder', target: 'v2', running: 'v2', state: 'updated', seen: '4s', error: '-' },
  { id: 'det1', type: 'detector', target: 'v2', running: 'v1', state: 'pending', seen: '12s', error: 'download failed: timeout' },
];

test('renderOta: a header and a row per board, with the columns of `curl /ota/status`', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  Ota.renderOta(doc, box, ROWS);
  const table = box.children[0];
  assertEqual(table.tagName, 'TABLE');
  const rows = table.descendants().filter((e) => e.tagName === 'TR');
  assertEqual(rows.length, 3);
  assertEqual(rows[0].children.map((c) => c.textContent), ['ID', 'TYPE', 'PUBLISHED', 'RUNNING', 'STATE', 'LAST SEEN', 'LAST ERROR']);
  assertEqual(rows[1].children.map((c) => c.textContent), ['cam1', 'recorder', 'v2', 'v2', 'updated', '4s', '-']);
  assertEqual(rows[2].children.map((c) => c.textContent), ['det1', 'detector', 'v2', 'v1', 'pending', '12s', 'download failed: timeout']);
});

test('renderOta: the state is coloured by a class only when it is one of the four known states', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  Ota.renderOta(doc, box, [
    { ...ROWS[0], state: 'updated' }, { ...ROWS[0], state: 'pending' }, { ...ROWS[0], state: 'offline' },
    { ...ROWS[0], state: 'nothing-published' }, { ...ROWS[0], state: 'x" onclick="evil' },
  ]);
  const tds = box.descendants().filter((e) => e.tagName === 'TD' && e.className.includes('ota-state'));
  assertEqual(tds.map((e) => e.className), ['ota-state ota-state-updated', 'ota-state ota-state-pending', 'ota-state ota-state-offline', 'ota-state ota-state-nothing-published']);
});

test('renderOta: what a server sent stays text — markup in a cell is shown, not run', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  const hostile = '<img src=x onerror=alert(1)>';
  Ota.renderOta(doc, box, [{ ...ROWS[0], id: hostile, error: hostile }]);
  const tds = box.descendants().filter((e) => e.tagName === 'TD');
  assertEqual(tds[0].textContent, hostile);
  assertEqual(tds[0].children.length, 0, 'no element was made from it');
  assertEqual(box.descendants().some((e) => e.tagName === 'IMG'), false);
});

test('renderOta: no boards is said in words; a second draw replaces the first', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  Ota.renderOta(doc, box, []);
  assertTrue(box.text().includes('No board has asked for firmware yet.'));
  Ota.renderOta(doc, box, ROWS);
  Ota.renderOta(doc, box, ROWS);
  assertEqual(box.children.length, 1);
  assertEqual(box.descendants().filter((e) => e.tagName === 'TR').length, 3);
});

test('renderLogs: a `==> path <==` heading per file, then its lines as one block of text', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  Ota.renderLogs(doc, box, [
    { kind: 'relay', path: '/r/camera.log', ok: true, lines: ['one ERROR', 'two <b>WARN</b>'] },
    { kind: 'apache', path: '/var/log/apache2/error.log', ok: true, lines: [] },
    { kind: 'apache', path: '/x/denied.log', ok: false, error: 'the relay is not allowed to read it (permission denied) — add its user to the log\'s group: sudo usermod -aG adm <relay user>, then restart the relay' },
  ]);
  const titles = box.descendants().filter((e) => e.className === 'log-source-title').map((e) => e.textContent);
  assertEqual(titles, ['==> /r/camera.log <==', '==> /var/log/apache2/error.log <==', '==> /x/denied.log <==']);
  const pres = box.descendants().filter((e) => e.tagName === 'PRE');
  assertEqual(pres.map((e) => e.textContent), ['one ERROR\ntwo <b>WARN</b>', '(no matching lines)']);
  assertEqual(pres[0].children.length, 0, 'the markup in a line is text');
  assertTrue(box.text().includes('(cannot be read: the relay is not allowed to read it (permission denied) — add its user to the log\'s group: sudo usermod -aG adm <relay user>, then restart the relay)'));
});

test('renderLogs: follows the tail when it was at the bottom, stays put when the person scrolled up', () => {
  const doc = createFakeDocument();
  const box = doc.createElement('div');
  const src = [{ kind: 'relay', path: '/r/c.log', ok: true, lines: ['a'] }];
  Object.assign(box, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });    // at the bottom
  Ota.renderLogs(doc, box, src);
  assertEqual(box.scrollTop, 1000);
  Object.assign(box, { scrollHeight: 1000, clientHeight: 300, scrollTop: 100 });    // scrolled up to read
  Ota.renderLogs(doc, box, src);
  assertEqual(box.scrollTop, 100);
  Object.assign(box, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });           // nothing drawn yet
  Ota.renderLogs(doc, box, src);
  assertEqual(box.scrollTop, 0);
});

// ── the page ────────────────────────────────────────────────────────────

function pageWith({ seconds = '10', lines = '1000', hidden = false, answers = {} } = {}) {
  const doc = createFakeDocument();
  const make = (tag, id, props = {}) => { const e = doc.createElement(tag); e.id = id; Object.assign(e, props); doc.body.append(e); return e; };
  const els = {
    otaRefresh: make('input', 'ota-refresh', { value: seconds }), otaTable: make('div', 'ota-table'), otaUpdated: make('span', 'ota-updated'), otaError: make('div', 'ota-error'),
    logLines: make('input', 'log-lines', { value: lines }), logRefresh: make('input', 'log-refresh', { value: seconds }), logOut: make('div', 'log-out'),
    logUpdated: make('span', 'log-updated'), logError: make('div', 'log-error'),
    WARN: make('input', 'lvl-warn', { type: 'checkbox', checked: true }), ERROR: make('input', 'lvl-error', { type: 'checkbox', checked: true }),
    DEBUG: make('input', 'lvl-debug', { type: 'checkbox', checked: false }), INFO: make('input', 'lvl-info', { type: 'checkbox', checked: false }),
    ALL: make('input', 'lvl-all', { type: 'checkbox', checked: false }),
  };
  const clock = fakeClock();
  const asked = [];
  const state = { hidden, onVisible: null, down: null };   // down: the words of the error the page answers with
  const request = async (url) => {
    asked.push(url);
    if (state.down) return { error: state.down };
    if (url === 'ota-status.php') return { data: answers.ota || { at: '2026-11-17T10:00:05+01:00', rows: ROWS } };
    return { data: answers.logs || { at: '2026-11-17T10:00:06+01:00', sources: [{ kind: 'relay', path: '/r/camera.log', ok: true, lines: ['x ERROR y'] }] } };
  };
  const app = Ota.mount({
    doc, request, setTimer: clock.setTimer, clearTimer: clock.clearTimer, isHidden: () => state.hidden,
    onVisibilityChange: (fn) => { state.onVisible = fn; },
  });
  return { doc, els, clock, asked, state, app };
}
const settle = () => new Promise((r) => setImmediate(r));

test('mount: both parts load at once — the status, and the log with WARN and ERROR chosen — and say when', async () => {
  const p = pageWith();
  await settle();
  assertEqual(p.asked, ['ota-status.php', 'logs-tail.php?lines=1000&levels=WARN,ERROR']);
  assertTrue(p.els.otaTable.text().includes('cam1') && p.els.otaTable.text().includes('download failed: timeout'));
  assertTrue(p.els.logOut.text().includes('x ERROR y'));
  assertEqual([p.els.otaUpdated.textContent, p.els.logUpdated.textContent], ['Updated 10:00:05', 'Updated 10:00:06']);
  assertEqual([p.els.otaError.textContent, p.els.logError.textContent], ['', '']);
  assertEqual(p.clock.delays(), [10000, 10000], 'each part has its own timer, 10 s by default');
});

test('mount: the two refresh times and the tail length are the page\'s own', async () => {
  const p = pageWith({ seconds: '30', lines: '250' });
  await settle();
  assertEqual(p.asked[1], 'logs-tail.php?lines=250&levels=WARN,ERROR');
  assertEqual(p.clock.delays(), [30000, 30000]);
});

test('mount: an answer that does not load is said in the page\'s own words and the last good draw stays', async () => {
  const p = pageWith();
  await settle();
  p.state.down = 'missing or wrong control key';
  await p.clock.fire();
  await p.clock.fire();
  assertEqual(p.els.otaError.textContent, 'Could not load the OTA status: missing or wrong control key');
  assertEqual(p.els.logError.textContent, 'Could not load the log: missing or wrong control key');
  assertTrue(p.els.otaTable.text().includes('cam1'), 'the table is still there');
  p.state.down = null;
  await p.clock.fire();
  await p.clock.fire();
  assertEqual([p.els.otaError.textContent, p.els.logError.textContent], ['', ''], 'and the words go when it loads again');
});

test('mount: an answer of the wrong shape is not drawn', async () => {
  const p = pageWith({ answers: { ota: { rows: 'nope' }, logs: { sources: { a: 1 } } } });
  await settle();
  assertEqual(p.els.otaError.textContent, 'Could not load the OTA status: the answer was not what was expected');
  assertEqual(p.els.logError.textContent, 'Could not load the log: the answer was not what was expected');
  assertEqual(p.els.otaTable.children.length + p.els.logOut.children.length, 0);
});

test('mount: ticking the ALL box asks without a level filter and clears the other boxes', async () => {
  const p = pageWith();
  await settle();
  p.els.ALL.click();
  await settle();
  assertEqual(p.asked[p.asked.length - 1], 'logs-tail.php?lines=1000');
  assertEqual([p.els.WARN.checked, p.els.ERROR.checked, p.els.DEBUG.checked, p.els.INFO.checked, p.els.ALL.checked], [false, false, false, false, true]);
});

test('mount: choosing a level again clears ALL and asks for exactly the chosen levels', async () => {
  const p = pageWith();
  await settle();
  p.els.ALL.click();
  await settle();
  p.els.INFO.click();
  await settle();
  assertEqual(p.asked[p.asked.length - 1], 'logs-tail.php?lines=1000&levels=INFO');
  assertEqual(p.els.ALL.checked, false);
  p.els.DEBUG.click();
  await settle();
  assertEqual(p.asked[p.asked.length - 1], 'logs-tail.php?lines=1000&levels=DEBUG,INFO');
});

test('mount: with no level chosen nothing is asked; the page says so and shows no stale lines', async () => {
  const p = pageWith();
  await settle();
  p.els.WARN.click();
  await settle();
  p.els.ERROR.click();
  await settle();
  assertEqual(p.asked.filter((u) => u.startsWith('logs-tail.php')), ['logs-tail.php?lines=1000&levels=WARN,ERROR', 'logs-tail.php?lines=1000&levels=ERROR'], 'the first load and the change that still left a level; the last change asks nothing');
  assertTrue(p.els.logError.textContent.includes('Choose at least one level'));
  assertEqual(p.els.logOut.children.length, 0);
});

test('mount: the number boxes are put right when left, and a changed refresh time moves the timer', async () => {
  const p = pageWith();
  await settle();
  p.els.otaRefresh.value = '0';
  p.els.otaRefresh.dispatch('change');
  assertEqual(p.els.otaRefresh.value, '1');
  p.els.logRefresh.value = '99999';
  p.els.logRefresh.dispatch('change');
  assertEqual(p.els.logRefresh.value, '3600');
  p.els.logRefresh.value = 'soon';
  p.els.logRefresh.dispatch('change');
  assertEqual(p.els.logRefresh.value, '10');
  p.els.logLines.value = '0';
  p.els.logLines.dispatch('change');
  assertEqual(p.els.logLines.value, '1');
  await settle();   // the new tail length asked again at once; its run is over and the next one planned
  assertEqual([...p.clock.delays()].sort((a, b) => a - b), [1000, 10000]);
});

test('mount: a new tail length asks again at once, with that length', async () => {
  const p = pageWith();
  await settle();
  p.els.logLines.value = '40';
  p.els.logLines.dispatch('change');
  await settle();
  assertEqual(p.asked[p.asked.length - 1], 'logs-tail.php?lines=40&levels=WARN,ERROR');
});

test('mount: a hidden tab asks nothing; showing it again asks at once', async () => {
  const p = pageWith({ hidden: true });
  await settle();
  assertEqual(p.asked, []);
  p.state.hidden = false;
  p.state.onVisible();
  await settle();
  assertEqual(p.asked.sort(), ['logs-tail.php?lines=1000&levels=WARN,ERROR', 'ota-status.php']);
  p.state.hidden = true;
  p.state.onVisible();
  await settle();
  assertEqual(p.asked.length, 2, 'going hidden asks nothing');
});

runAsyncTests();
