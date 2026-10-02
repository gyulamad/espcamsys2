'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { DEFAULT_SETTINGS, parseStoredSettings, applySettingsUpdate } = require('../../nodejs/camera-relay/lib/settings');

test('defaults are 60s record / 60s power', () => {
  assertEqual(DEFAULT_SETTINGS.alarmRecordSeconds, 60);
  assertEqual(DEFAULT_SETTINGS.alarmPowerSeconds, 60);
});

test('parseStoredSettings reads valid stored values', () => {
  const s = parseStoredSettings('{"alarmRecordSeconds":10,"alarmPowerSeconds":20}');
  assertEqual(s.alarmRecordSeconds, 10);
  assertEqual(s.alarmPowerSeconds, 20);
});

test('parseStoredSettings falls back to defaults on corrupt JSON', () => {
  const s = parseStoredSettings('{not json');
  assertEqual(s.alarmRecordSeconds, 60);
  assertEqual(s.alarmPowerSeconds, 60);
});

test('parseStoredSettings falls back per field when one is invalid or missing', () => {
  const s = parseStoredSettings('{"alarmRecordSeconds":0}');
  assertEqual(s.alarmRecordSeconds, 60);
  assertEqual(s.alarmPowerSeconds, 60);
  const t = parseStoredSettings('{"alarmRecordSeconds":15,"alarmPowerSeconds":99999}');
  assertEqual(t.alarmRecordSeconds, 15);
  assertEqual(t.alarmPowerSeconds, 60);
});

test('parseStoredSettings tolerates non-object JSON', () => {
  assertEqual(parseStoredSettings('null').alarmRecordSeconds, 60);
  assertEqual(parseStoredSettings('42').alarmPowerSeconds, 60);
});

test('applySettingsUpdate changes only the provided field', () => {
  const r = applySettingsUpdate({ alarmRecordSeconds: 60, alarmPowerSeconds: 60 }, { alarmRecordSeconds: '10' });
  assertEqual(r.settings.alarmRecordSeconds, 10);
  assertEqual(r.settings.alarmPowerSeconds, 60);
});

test('applySettingsUpdate can change both fields at once', () => {
  const r = applySettingsUpdate({ alarmRecordSeconds: 60, alarmPowerSeconds: 60 }, { alarmRecordSeconds: '10', alarmPowerSeconds: '20' });
  assertEqual(r.settings.alarmRecordSeconds, 10);
  assertEqual(r.settings.alarmPowerSeconds, 20);
});

test('applySettingsUpdate rejects out-of-range or non-numeric values and changes nothing', () => {
  const cur = { alarmRecordSeconds: 60, alarmPowerSeconds: 60 };
  assertTrue(applySettingsUpdate(cur, { alarmRecordSeconds: '0' }).error);
  assertTrue(applySettingsUpdate(cur, { alarmRecordSeconds: '3601' }).error);
  assertTrue(applySettingsUpdate(cur, { alarmPowerSeconds: 'abc' }).error);
  // one bad field poisons the whole update, even if the other is fine
  const r = applySettingsUpdate(cur, { alarmRecordSeconds: '10', alarmPowerSeconds: '-5' });
  assertTrue(r.error);
  assertEqual(r.settings, undefined);
  assertEqual(cur.alarmRecordSeconds, 60);
});

test('applySettingsUpdate requires at least one known field', () => {
  assertTrue(applySettingsUpdate({ alarmRecordSeconds: 60, alarmPowerSeconds: 60 }, {}).error);
  assertTrue(applySettingsUpdate({ alarmRecordSeconds: 60, alarmPowerSeconds: 60 }, { foo: '1' }).error);
});

test('applySettingsUpdate accepts boundary values', () => {
  const r = applySettingsUpdate({ alarmRecordSeconds: 60, alarmPowerSeconds: 60 }, { alarmRecordSeconds: '1', alarmPowerSeconds: '3600' });
  assertEqual(r.settings.alarmRecordSeconds, 1);
  assertEqual(r.settings.alarmPowerSeconds, 3600);
});

summarize();
