'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { DEFAULT_SETTINGS, parseStoredSettings, applySettingsUpdate } = require('../../nodejs/camera-relay/lib/settings');

test('default alarm recording length is 60s, and there is no power setting any more', () => {
  assertEqual(DEFAULT_SETTINGS.alarmRecordSeconds, 60);
  assertEqual(Object.keys(DEFAULT_SETTINGS), ['alarmRecordSeconds']);
});

test('parseStoredSettings reads a valid stored value', () => {
  assertEqual(parseStoredSettings('{"alarmRecordSeconds":10}').alarmRecordSeconds, 10);
});

test('parseStoredSettings ignores the retired alarmPowerSeconds from an older settings.json', () => {
  const s = parseStoredSettings('{"alarmRecordSeconds":10,"alarmPowerSeconds":20}');
  assertEqual(s, { alarmRecordSeconds: 10 });
});

test('parseStoredSettings falls back to defaults on corrupt JSON', () => {
  assertEqual(parseStoredSettings('{not json').alarmRecordSeconds, 60);
});

test('parseStoredSettings falls back when the value is invalid or missing', () => {
  assertEqual(parseStoredSettings('{"alarmRecordSeconds":0}').alarmRecordSeconds, 60);
  assertEqual(parseStoredSettings('{"alarmRecordSeconds":99999}').alarmRecordSeconds, 60);
  assertEqual(parseStoredSettings('{}').alarmRecordSeconds, 60);
});

test('parseStoredSettings tolerates non-object JSON', () => {
  assertEqual(parseStoredSettings('null').alarmRecordSeconds, 60);
  assertEqual(parseStoredSettings('42').alarmRecordSeconds, 60);
});

test('applySettingsUpdate changes the provided field', () => {
  const r = applySettingsUpdate({ alarmRecordSeconds: 60 }, { alarmRecordSeconds: '10' });
  assertEqual(r.settings.alarmRecordSeconds, 10);
});

test('applySettingsUpdate rejects out-of-range or non-numeric values and changes nothing', () => {
  const cur = { alarmRecordSeconds: 60 };
  assertTrue(applySettingsUpdate(cur, { alarmRecordSeconds: '0' }).error);
  assertTrue(applySettingsUpdate(cur, { alarmRecordSeconds: '3601' }).error);
  const r = applySettingsUpdate(cur, { alarmRecordSeconds: 'abc' });
  assertTrue(r.error);
  assertEqual(r.settings, undefined);
  assertEqual(cur.alarmRecordSeconds, 60);
});

test('applySettingsUpdate requires the known field (an unknown or retired one is not enough)', () => {
  assertTrue(applySettingsUpdate({ alarmRecordSeconds: 60 }, {}).error);
  assertTrue(applySettingsUpdate({ alarmRecordSeconds: 60 }, { foo: '1' }).error);
  assertTrue(applySettingsUpdate({ alarmRecordSeconds: 60 }, { alarmPowerSeconds: '20' }).error);
});

test('applySettingsUpdate accepts boundary values', () => {
  assertEqual(applySettingsUpdate({ alarmRecordSeconds: 60 }, { alarmRecordSeconds: '1' }).settings.alarmRecordSeconds, 1);
  assertEqual(applySettingsUpdate({ alarmRecordSeconds: 60 }, { alarmRecordSeconds: '3600' }).settings.alarmRecordSeconds, 3600);
});

summarize();
