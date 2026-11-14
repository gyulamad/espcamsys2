'use strict';
// alarm-chain.js — the detector panel's ALARM CHAIN line (F-31): whether the detector's alarm pin
// CAN start a recording on the camera it is paired with, and when it cannot, WHY not, in words.
//
// The chain is a physical wire: the detector drives its PERSON_GPIO (LOW while idle, HIGH while a
// person is detected) into the recorder camera's alarm input, and that camera's firmware turns an
// edge on the input into an alarm message to the relay, which starts the recording. The dashboard's
// detector panel shows the detector's side (the ALARM PIN chip: the level the board reports) — but
// that chip says nothing about the camera's side, and every way the chain fails IS silent: an alarm
// input left OFF, a polarity mismatch, or the recording switch OFF all produce no error anywhere
// (the relay logs a refused alarm at INFO and throttles it; the camera logs any HTTP answer at
// INFO). A red pin, no recording and a clean log is exactly what cannot be debugged from the log —
// so the panel states it in words instead.
//
// The camera's side is read where the camera reports it: its device settings (ALARM_GPIO_PIN,
// ALARM_ACTIVE), as served by camera-settings.php from the relay's device-settings state; the
// switch side is the page's own recording-switch state. Pure data in, one verdict out; loaded as a
// plain script (window.CamAlarmChain) and by the tests with require().
//
//   describe   the chain's verdict for one camera: { level, text }
//              level: 'ok' | 'off' | 'broken' | 'unknown'

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamAlarmChain = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // The verdict for one camera. All inputs come from the page:
  //   name          the camera's name as its card shows it (or its id)
  //   recorder      what camera-settings.php says the board REPORTED it holds:
  //                 { alarmGpioPin, alarmActive } | null (nothing reported yet)
  //   recorderError why the settings could not be read at all (relay down, no control key), or null
  //   offLabel      the recording switch's own text while OFF ("REC OFF · 5 min left (until 14:32)"),
  //                 or null / undefined while recording is ON
  // -> { level: 'ok' | 'off' | 'broken' | 'unknown', text }
  // The first problem wins (early returns): a chain that cannot carry the alarm is reported before
  // a switch that only silences it — with the input OFF or armed for the wrong level, switching
  // recording ON would not make one alarm work, so the wiring is what the line must say first.
  function describe(input) {
    const { name, recorder, recorderError, offLabel } = input || {};
    const who = name || 'the camera';

    if (recorderError) {
      return { level: 'unknown', text: `${who}'s alarm input is unknown: the camera's settings could not be read (${recorderError})` };
    }
    if (!recorder) {
      return { level: 'unknown', text: `${who} has not reported its settings yet, so its alarm input is unknown and the alarm chain cannot be checked. It reports after it starts with the firmware that supports remote settings.` };
    }
    const pin = Number(recorder.alarmGpioPin);
    if (!Number.isFinite(pin)) {
      return { level: 'unknown', text: `${who} did not report ALARM_GPIO_PIN, so its alarm input is unknown (firmware without the alarm feature?)` };
    }
    if (pin < 0) {
      return { level: 'broken', text: `the detector's alarm pin goes nowhere: ${who}'s alarm input is OFF (ALARM_GPIO_PIN=-1) — a red pin will NOT start a recording. Set ALARM_GPIO_PIN on the camera's SETTINGS page to the pin the wire meets.` };
    }
    if (recorder.alarmActive !== 'HIGH' && recorder.alarmActive !== 'LOW') {
      return { level: 'unknown', text: `${who}'s alarm input is wired to GPIO ${pin}, but it did not report ALARM_ACTIVE, so the polarity is unknown` };
    }
    if (recorder.alarmActive !== 'HIGH') {
      return { level: 'broken', text: `${who}'s alarm input is armed for LOW (ALARM_ACTIVE=LOW) but the detector drives its pin HIGH on a person: it would record when the person clears, not when they arrive. Set ALARM_ACTIVE=HIGH.` };
    }
    if (offLabel) {
      return { level: 'off', text: `recording is switched OFF for ${who} (“${offLabel}”): the alarm chain is fine but every alarm is ignored — press ON on the camera's card` };
    }
    return { level: 'ok', text: `the alarm chain is ready: the detector's pin goes to ${who}'s alarm input (ALARM_GPIO_PIN ${pin}, active HIGH) and recording is ON` };
  }

  return { describe };
});
