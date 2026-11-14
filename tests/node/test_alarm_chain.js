'use strict';

// test_alarm_chain.js — the ALARM CHAIN line of the dashboard's detector panel (F-31): whether the
// detector's alarm pin can start a recording on the camera it is paired with, and when it cannot,
// why not. The rule is php/cameras/js/alarm-chain.js (the page requires it as a plain script); the
// wiring is asserted against index.php itself, so the line cannot silently fall off the page.

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const CamAlarmChain = require('../../php/cameras/js/alarm-chain');

// The recorder side as camera-settings.php passes it on: the settings the board reported it holds.
const REPORTED = { alarmGpioPin: 13, alarmActive: 'HIGH' };

// ── describe: the silent ways the chain fails, in words ──────────────

test('chain ok: the pin goes to a camera whose alarm input is on, active HIGH, recording ON', () => {
  const v = CamAlarmChain.describe({ name: 'Cam A', recorder: REPORTED, offLabel: null });
  assertEqual(v.level, 'ok');
  assertTrue(v.text.includes("Cam A's alarm input (ALARM_GPIO_PIN 13, active HIGH)"), v.text);
  assertTrue(v.text.includes('recording is ON'), v.text);
});

test('chain broken: the alarm input is OFF (ALARM_GPIO_PIN=-1, the firmware default) — the F-31 case', () => {
  const v = CamAlarmChain.describe({ name: 'Cam A', recorder: { alarmGpioPin: -1, alarmActive: 'LOW' }, offLabel: null });
  assertEqual(v.level, 'broken');
  assertTrue(v.text.includes("goes nowhere"), v.text);
  assertTrue(v.text.includes('ALARM_GPIO_PIN=-1'), v.text);
  assertTrue(v.text.includes('NOT start a recording'), v.text);
});

test('chain broken: the input is armed for LOW while the detector drives its pin HIGH on a person', () => {
  const v = CamAlarmChain.describe({ name: 'Cam B', recorder: { alarmGpioPin: 13, alarmActive: 'LOW' }, offLabel: null });
  assertEqual(v.level, 'broken');
  assertTrue(v.text.includes('ALARM_ACTIVE=LOW'), v.text);
  assertTrue(v.text.includes('when the person clears, not when they arrive'), v.text);
  assertTrue(v.text.includes('ALARM_ACTIVE=HIGH'), v.text);
});

test('chain off: the wiring is fine but recording is switched OFF — every alarm is ignored', () => {
  const v = CamAlarmChain.describe({ name: 'Cam C', recorder: REPORTED, offLabel: 'REC OFF · 5 min left (until 14:32)' });
  assertEqual(v.level, 'off');
  assertTrue(v.text.includes('recording is switched OFF for Cam C'), v.text);
  assertTrue(v.text.includes('every alarm is ignored'), v.text);
  assertTrue(v.text.includes('REC OFF · 5 min left (until 14:32)'), v.text);
});

test('chain unknown: the board has not reported its settings yet', () => {
  const v = CamAlarmChain.describe({ name: 'Cam A', recorder: null, recorderError: null, offLabel: null });
  assertEqual(v.level, 'unknown');
  assertTrue(v.text.includes('has not reported its settings yet'), v.text);
});

test('chain unknown: the settings could not be read at all (relay down, no control key)', () => {
  const v = CamAlarmChain.describe({ name: 'Cam A', recorder: null, recorderError: 'HTTP 503' });
  assertEqual(v.level, 'unknown');
  assertTrue(v.text.includes('could not be read (HTTP 503)'), v.text);
});

test('chain unknown: the board reported, but without the alarm keys (older firmware)', () => {
  const v = CamAlarmChain.describe({ name: 'Cam A', recorder: {}, offLabel: null });
  assertEqual(v.level, 'unknown');
  assertTrue(v.text.includes('did not report ALARM_GPIO_PIN'), v.text);
  const v2 = CamAlarmChain.describe({ name: 'Cam A', recorder: { alarmGpioPin: 13 }, offLabel: null });
  assertEqual(v2.level, 'unknown');
  assertTrue(v2.text.includes('did not report ALARM_ACTIVE'), v2.text);
});

test('describe: the first problem wins — a broken chain is reported even while the switch is OFF, a broken chain before an unreadable switch', () => {
  const wiring = CamAlarmChain.describe({ name: 'Cam A', recorder: { alarmGpioPin: -1, alarmActive: 'LOW' }, offLabel: 'REC OFF · forever' });
  assertEqual(wiring.level, 'broken');
  assertTrue(!wiring.text.includes('switched OFF'), 'the wiring is the part that stays wrong: ' + wiring.text);
  const unreadable = CamAlarmChain.describe({ name: 'Cam A', recorder: null, recorderError: 'relay down', offLabel: 'REC OFF · forever' });
  assertEqual(unreadable.level, 'unknown');
});

test('describe: a missing name falls back to "the camera"; garbage input does not throw', () => {
  assertEqual(CamAlarmChain.describe({ recorder: REPORTED }).level, 'ok');
  assertEqual(CamAlarmChain.describe(null).level, 'unknown');
  assertEqual(CamAlarmChain.describe(undefined).level, 'unknown');
});

// ── the wiring on the page ───────────────────────────────────────────

const page = fs.readFileSync(path.join(__dirname, '../../php/cameras/index.php'), 'utf8');

test('the dashboard loads js/alarm-chain.js as a plain script, right after camera-offline.js', () => {
  assertTrue(page.includes('<script src="js/alarm-chain.js"></script>'), 'the script tag');
  assertTrue(page.indexOf('src="js/alarm-chain.js"') > page.indexOf('src="js/camera-offline.js"')
    && page.indexOf('src="js/alarm-chain.js"') < page.indexOf('src="js/device-info.js"'), 'its place in the order');
});

test('every detector panel has its ALARM CHAIN line under the ALARM PIN chip', () => {
  assertTrue(page.includes('id="detchainsub-<?= $camId ?>"'), 'the element');
  assertTrue(page.indexOf('id="detpin-<?= $camId ?>">') < page.indexOf('id="detchainsub-<?= $camId ?>"'), 'after the ALARM PIN chip');
  assertTrue(page.includes('.det-sub.alarmchain.broken'), 'the level styles');
});

test("renderDetector keeps the line with the pin, applySwitchState keeps it with the switch, the page fetches it once per detector row", () => {
  assertTrue(/pin\.className = 'det-chip ' \+ \(r\.gpio\.high \? 'high' : 'low'\);\s*\n\s*renderAlarmChain\(id\);/.test(page), 'renderDetector re-renders it');
  assertTrue(/renderSwitchAll\(\);\s*\n\s*renderAlarmChain\(id\);/.test(page), 'applySwitchState re-renders it');
  assertTrue(page.includes(".forEach((row) => fetchAlarmChain(row.dataset.cam))"), 'the one fetch per detector row');
  assertTrue(/fetch\('camera-settings\.php\?cam=' \+ encodeURIComponent\(id\), \{\s*\n\s*headers: \{ 'X-Requested-With': 'camdash' \}/.test(page), 'the fetch goes through camera-settings.php with the dashboard header');
  assertTrue(/alarmChainRecorder\[id\] = s \? \{ alarmGpioPin: s\.ALARM_GPIO_PIN, alarmActive: s\.ALARM_ACTIVE \} : null;/.test(page), 'the reported settings are what feeds the verdict');
  assertTrue(/alarmChainRecorder\[id\] === undefined && !alarmChainError\[id\]/.test(page), 'the fetch window says checking…, never a premature verdict');
});

summarize();
