'use strict';

// F-29 T6a — every value the relay uses is a row of the settings table (lib/sysfields.js): nothing is left in config.js
// only or in the environment only, the default of every row is what the relay used before, an empty store changes
// nothing, and every row can be changed through the settings API (lib/sysconfig.js applyUpdate).

const fs = require('fs');
const path = require('path');
const { test, assertEqual, assertTrue, summarize } = require('./framework');

const RELAY = path.join(__dirname, '../../nodejs/camera-relay');
const sc = require(`${RELAY}/lib/sysconfig`);
const { FIELDS, FIELD_TYPES, TIERS, BOOTSTRAP_ENV } = require(`${RELAY}/lib/sysfields`);
const { buildReference } = require(`${RELAY}/lib/sysconfigdoc`);
const personscan = require(`${RELAY}/lib/personscan`);
const soundplayer = require(`${RELAY}/lib/soundplayer`);
const detectionnotice = require(`${RELAY}/lib/detectionnotice`);
const storagenotice = require(`${RELAY}/lib/storagenotice`);
const discovery = require(`${RELAY}/lib/discovery`);
const detectorview = require(`${RELAY}/lib/detectorview`);
const { resolveTelegramConfig } = require(`${RELAY}/lib/notify/telegram`);

const field = (key) => FIELDS.find((f) => f.key === key);
const empty = (extra = {}) => ({ base: {}, overrides: {}, env: {}, ...extra });
const full = (extra = {}) => ({ base: {}, overrides: {}, alarmRecordSeconds: 60, env: {}, soundNames: [], ...extra });

// ── the table itself ──

test('every row has a key, a known type, a tier, a group, a label, a help text and a boolean restart flag', () => {
  for (const f of FIELDS) {
    assertTrue(f.key && f.label && f.help && f.group, `${f.key}: key, label, help, group`);
    assertTrue(FIELD_TYPES.includes(f.type), `${f.key}: type ${f.type}`);
    assertTrue(TIERS.includes(f.tier), `${f.key}: tier ${f.tier}`);
    assertEqual(typeof f.restart, 'boolean', `${f.key}: restart`);
  }
});

test('every row that is not a secret has a default, and a default is a value the row accepts', () => {
  for (const f of FIELDS.filter((x) => x.type !== 'secret' && x.type !== 'argv' && x.type !== 'sound' && !x.locked)) {
    assertTrue(f.default !== undefined, `${f.key} has no default`);
    const r = sc.checkValue(f, typeof f.default === 'number' || typeof f.default === 'boolean' ? f.default : String(f.default));
    assertTrue(!r.error, `${f.key}: its own default ${JSON.stringify(f.default)} is refused: ${r.error}`);
  }
  for (const f of FIELDS.filter((x) => x.type === 'secret')) assertEqual(f.default, undefined, `${f.key}: a secret has no default`);
});

test('the number of rows: 23 that were already settings, 31 that came from config.js only or the environment only, and 1 added later', () => {
  assertEqual(FIELDS.length, 55);
});

// ── nothing is left outside the table ──

// Every environment variable the code reads is a row's `env` or one of the documented bootstrap exceptions. A new
// variable read anywhere in the relay fails here until it is made a setting (or given a reason in BOOTSTRAP_ENV).
function relaySources() {
  const files = ['server.js'];
  for (const dir of ['lib', 'lib/notify']) for (const f of fs.readdirSync(path.join(RELAY, dir))) if (f.endsWith('.js')) files.push(`${dir}/${f}`);
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(RELAY, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n') }));
}

test('every environment variable the relay reads is a settings row or a documented bootstrap exception', () => {
  const known = new Set([...FIELDS.map((f) => f.env).filter(Boolean), ...Object.keys(BOOTSTRAP_ENV)]);
  const patterns = [/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g, /\benv\[['"]([^'"]+)['"]\]/g, /\b(?:fromEnv|envOr\([^,]+,)\s*\(?\s*'([A-Za-z_0-9]+)'/g];
  const seen = [];
  for (const { file, code } of relaySources()) {
    for (const re of patterns) {
      for (const m of code.matchAll(re)) {
        seen.push(m[1]);
        assertTrue(known.has(m[1]), `${file} reads the environment variable ${m[1]}: make it a row in lib/sysfields.js (or give it a reason in BOOTSTRAP_ENV)`);
      }
    }
  }
  assertTrue(seen.length >= 20, `the scan found only ${seen.length} reads — is it still looking at the right code?`);
  for (const name of Object.keys(BOOTSTRAP_ENV)) assertTrue(seen.includes(name), `BOOTSTRAP_ENV lists ${name}, which nothing reads any more`);
});

test('every key that example.config.js shows is a settings row (or the block that holds rows)', () => {
  const text = fs.readFileSync(path.join(RELAY, 'example.config.js'), 'utf8');
  const names = new Set([...text.matchAll(/^\s*(?:\/\/\s*)?([a-z][A-Za-z]*):/gm)].map((m) => m[1]));   // a key starts with a lower-case letter; comment prose does not
  const blocks = new Set(FIELDS.filter((f) => f.config).flatMap((f) => f.config.slice(0, -1)));
  const leaves = new Set(FIELDS.map((f) => (f.config ? f.config[f.config.length - 1] : f.key)));
  assertTrue(names.size >= 25, `only ${names.size} keys found in example.config.js`);
  for (const name of names) assertTrue(leaves.has(name) || blocks.has(name), `example.config.js shows "${name}", which is not a settings row`);
});

test('SETTINGS.md is the reference of the table as it is now (regenerate: node lib/sysconfigdoc.js > SETTINGS.md)', () => {
  assertEqual(fs.readFileSync(path.join(RELAY, 'SETTINGS.md'), 'utf8'), buildReference());
});

// ── apacheErrorLog (F-30): the Apache log the OTA & LOGS page shows ──

test('apacheErrorLog: the system Apache log by default; the environment and config.js name another; only the environment can leave it out', () => {
  assertEqual(sc.currentValue('apacheErrorLog', empty()), '/var/log/apache2/error.log');
  assertEqual(sc.currentValue('apacheErrorLog', empty({ base: { apacheErrorLog: '/var/log/httpd/error_log' } })), '/var/log/httpd/error_log');
  assertEqual(sc.currentValue('apacheErrorLog', empty({ env: { APACHE_ERROR_LOG: '/var/log/x/error.log' } })), '/var/log/x/error.log');
  assertEqual(sc.currentValue('apacheErrorLog', empty({ env: { APACHE_ERROR_LOG: '' } })), '', 'APACHE_ERROR_LOG= leaves it out');
  assertEqual(sc.currentValue('apacheErrorLog', empty({ base: { apacheErrorLog: '' } })), '/var/log/apache2/error.log', 'an empty config.js value is "not set", as for every row');
});

test('apacheErrorLog: a file the relay READS and shows to the dashboard — set from the page it must be a .log inside the relay\'s folder', () => {
  for (const bad of ['/etc/shadow', '/var/log/apache2/other.log', 'config.js', 'logs/../config.js', '../x.log', 'lib/x.log', 'node_modules/x.log', '.hidden/x.log', 'x.txt', '']) {
    assertTrue(sc.applyUpdate(full(), { apacheErrorLog: bad }).error, `refused: ${JSON.stringify(bad)}`);
  }
  const ok = sc.applyUpdate(full(), { apacheErrorLog: 'logs/apache.log' });
  assertEqual([ok.error, ok.changed, ok.restartRequired, ok.overrides.apacheErrorLog], [undefined, ['apacheErrorLog'], true, 'logs/apache.log']);
});

// ── an empty store changes nothing: every default is the value the code used before ──

// What the relay used before each of these became a setting, written out here (not read from the table).
const ALREADY_SETTINGS = ['alarmRecordSeconds', 'minFreeStorageMB', 'preRollSeconds', 'preRollMaxBytes', 'personScanEnabled', 'personScanConfidence',
  'alarmSoundRecordStart', 'alarmSoundRecordStartRelay', 'alarmSoundRecordStartBrowser', 'alarmSoundPersonDetected', 'alarmSoundPersonDetectedRelay',
  'alarmSoundPersonDetectedBrowser', 'port', 'pushPort', 'camKey', 'controlKey', 'logFile', 'logMaxBytes', 'logKeepFiles', 'deviceSettingsDir',
  'firmwareDir', 'soundsDir', 'switchFile'];
// Rows added after T6a: they did not exist before, so there is no "before" value to compare (tested on their own below).
const ADDED_LATER = ['apacheErrorLog'];
const BEFORE = {
  discoveryPort: 8082, detectorViewMinutes: 10, personScanAuto: true, personScanAction: 'move', personScanStride: 1,
  personScanTimeoutSeconds: 900, personScanPython: 'python3', personScanModel: 'models/person.onnx', personScanScript: 'tools/person_scan.py',
  alarmSoundTimeoutSeconds: 30, telegramEnabled: true, telegramChatId: '', footageBaseUrl: '', notifyCooldownSeconds: 60,
  storageReminderHours: 24, relayHsts: false, authMaxFailures: 10, authLockSeconds: 60, authLockMaxSeconds: 900, restartCooldownMs: 30000,
  readKeyRequired: true, allowKeylessAlarm: false, keylessAlarmGapMs: 60000, maxAlarmRecordings: 16, relayBind: '0.0.0.0',
  pushAuthTimeoutMs: 10000, pushIdleTimeoutMs: 60000, detectorNoPictureWarnMs: 10000, loopWatch: true,
};

test('with nothing stored, in config.js or in the environment, each moved value is what the relay used before', () => {
  for (const [key, before] of Object.entries(BEFORE)) {
    assertEqual(field(key).default, before, `${key}: default`);
    if (!field(key).locked) assertEqual(sc.currentValue(key, empty()), before, `${key}: currentValue`);
  }
  assertEqual(field('alarmSoundPlayer').default, ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'error']);
  // the rows that are new in T6a are exactly these (a secret has no default to compare)
  const moved = FIELDS.filter((f) => !ALREADY_SETTINGS.includes(f.key) && !ADDED_LATER.includes(f.key)).map((f) => f.key).sort();
  assertEqual(moved, [...Object.keys(BEFORE), 'alarmSoundPlayer', 'telegramBotToken'].sort());
});

test('writing a default into config.js changes nothing for the code that reads config.js (its own defaults are the table\'s)', () => {
  const merged = sc.mergeConfig({}, Object.fromEntries(FIELDS.filter((f) => f.config && !f.locked && f.default !== undefined && f.type !== 'secret').map((f) => [f.key, f.default])));
  const a = personscan.resolveScanConfig(merged.personScan, '/relay');
  const b = personscan.resolveScanConfig(undefined, '/relay');
  assertEqual(a, b);
  assertEqual(soundplayer.resolvePlayerConfig(merged.alarmSounds), soundplayer.resolvePlayerConfig(undefined));
  assertEqual(detectionnotice.resolveNoticeConfig(merged.notifications), detectionnotice.resolveNoticeConfig(undefined));
  assertEqual(storagenotice.resolveStorageNoticeConfig(merged.notifications), storagenotice.resolveStorageNoticeConfig(undefined));
  assertEqual(discovery.resolveDiscoveryPort(field('discoveryPort').default), discovery.resolveDiscoveryPort(undefined));
  assertEqual(detectorview.viewMinutes(field('detectorViewMinutes').default), detectorview.viewMinutes(undefined));
  assertEqual(resolveTelegramConfig(merged.notifications && merged.notifications.telegram, {}), resolveTelegramConfig(undefined, {}));
});

// ── the environment variables keep the meaning they had ──

test('legacy switches: RELAY_HSTS and ALLOW_KEYLESS_ALARM are on only for exactly "1"; READ_KEY_REQUIRED and LOOPWATCH off only for exactly "0"', () => {
  const on = (key, v) => sc.currentValue(key, empty({ env: { [field(key).env]: v } }));
  for (const key of ['relayHsts', 'allowKeylessAlarm']) {
    assertEqual(on(key, '1'), true, key);
    for (const v of ['0', 'true', 'yes', '', ' 1', '11']) assertEqual(on(key, v), false, `${key}=${JSON.stringify(v)}`);
  }
  for (const key of ['readKeyRequired', 'loopWatch']) {
    assertEqual(on(key, '0'), false, key);
    for (const v of ['1', 'true', 'false', '', ' 0', '00']) assertEqual(on(key, v), true, `${key}=${JSON.stringify(v)}`);
  }
});

test('legacy numbers: a positive whole number is used, anything else falls back to the default', () => {
  const cases = { authMaxFailures: 5, authLockSeconds: 30, authLockMaxSeconds: 120, restartCooldownMs: 5000, keylessAlarmGapMs: 2000, maxAlarmRecordings: 4, pushAuthTimeoutMs: 2500, pushIdleTimeoutMs: 9000, detectorNoPictureWarnMs: 3000 };
  for (const [key, n] of Object.entries(cases)) {
    const env = (v) => empty({ env: { [field(key).env]: v } });
    assertEqual(sc.currentValue(key, env(String(n))), n, key);
    for (const bad of ['0', '-3', 'abc', '', '1e3', '2.5']) assertEqual(sc.currentValue(key, env(bad)), BEFORE[key], `${key}=${JSON.stringify(bad)}`);
  }
});

test('legacy numbers: values the old code accepted stay accepted (the e2e tests set AUTH_MAX_FAILURES=100000 to switch the lock-out off)', () => {
  const env = (name, v) => empty({ env: { [name]: v } });
  assertEqual(sc.currentValue('authMaxFailures', env('AUTH_MAX_FAILURES', '100000')), 100000);
  assertEqual(sc.currentValue('authLockSeconds', env('AUTH_LOCK_SECONDS', '172800')), 172800);
  assertEqual(sc.currentValue('maxAlarmRecordings', env('MAX_ALARM_RECORDINGS', '5000')), 5000);
  assertEqual(sc.currentValue('pushIdleTimeoutMs', env('PUSH_IDLE_TIMEOUT_MS', '3600000')), 3600000);
});

test('RELAY_BIND: an address or a host name is used (the old code took any text); empty or odd text falls back to 0.0.0.0', () => {
  const env = (v) => empty({ env: { RELAY_BIND: v } });
  for (const ok of ['127.0.0.1', '0.0.0.0', '::', '::1', 'localhost', 'pi.local']) assertEqual(sc.currentValue('relayBind', env(ok)), ok, ok);
  for (const bad of ['', ' ', 'a b', 'x;y', 'a/b']) assertEqual(sc.currentValue('relayBind', env(bad)), '0.0.0.0', JSON.stringify(bad));
});

test('where a value comes from: environment > saved settings > config.js > default (here for a number, a nested switch and a nested secret)', () => {
  const key = 'maxAlarmRecordings';
  assertEqual(sc.currentValue(key, empty()), 16);
  assertEqual(sc.currentValue(key, empty({ overrides: { [key]: 8 } })), 8);
  assertEqual(sc.currentValue(key, empty({ env: { MAX_ALARM_RECORDINGS: '3' }, overrides: { [key]: 8 } })), 3);
  const nested = (over, base) => sc.currentValue('personScanAuto', empty({ base, overrides: over }));
  assertEqual(nested({}, { personScan: { auto: false } }), false);
  assertEqual(nested({ personScanAuto: true }, { personScan: { auto: false } }), true);
  const tok = (env, overrides) => sc.buildView(full({ env, overrides, base: { notifications: { telegram: { botToken: '123456789:abcdefghijklmnopqrstuvwxyz' } } } })).fields.find((f) => f.key === 'telegramBotToken');
  assertEqual([tok({}, {}).isSet, tok({}, {}).source], [true, 'config.js']);
  assertEqual(tok({ TELEGRAM_BOT_TOKEN: 'x' }, {}).source, 'environment');
  assertEqual(JSON.stringify(tok({}, {})).includes('abcdefghij'), false, 'the token is never in the view');
});

// ── every moved value can be changed through the settings API ──

// A valid value for a row that differs from its default.
// (a few rows have to agree with another row: two ports must differ, the two keys must differ, the longest lock-out is not the shortest)
const SAMPLE = { port: '9090', pushPort: '9091', camKey: 'camera-key-0001', controlKey: 'control-key-0001', authLockMaxSeconds: '3600' };
function sampleFor(f) {
  if (SAMPLE[f.key] !== undefined) return SAMPLE[f.key];
  switch (f.type) {
    case 'int': return String(f.default === f.min ? f.max : f.min);
    case 'bool': return String(!f.default);
    case 'choice': return f.options.find((o) => o !== f.default);
    case 'url': return 'http://pi.local/camdash';
    case 'chatids': return '123456,@mychannel';
    case 'host': return '127.0.0.1';
    case 'secret': return 'abcdefgh-1234';
    case 'string': return `other/${f.key}${f.ext || ''}`;
    default: throw new Error(`no sample for ${f.type}`);
  }
}
const EDITABLE = FIELDS.filter((f) => !f.locked && f.type !== 'sound' && f.type !== 'float' && f.key !== 'alarmRecordSeconds');

test('applyUpdate: every editable row accepts a valid value, reports it as changed, and flags a restart exactly when the row needs one', () => {
  assertTrue(EDITABLE.length >= 40, `only ${EDITABLE.length} rows were exercised`);
  for (const f of EDITABLE) {
    const value = sampleFor(f);
    const r = sc.applyUpdate(full(), { [f.key]: value });
    assertTrue(!r.error, `${f.key}: ${r.error}`);
    assertEqual([r.changed, r.restartRequired], [[f.key], f.restart], f.key);
    assertTrue(r.overrides[f.key] !== undefined, `${f.key} is saved in the store`);
  }
});

test('what is saved survives the file: parseOverrides gives back exactly what applyUpdate stored, with no warning', () => {
  const values = Object.fromEntries(EDITABLE.map((f) => [f.key, sampleFor(f)]));
  const r = sc.applyUpdate(full(), values);
  assertTrue(!r.error, r.error);
  const back = sc.parseOverrides(JSON.stringify(r.overrides));
  assertEqual(back.warnings, []);
  assertEqual(back.overrides, r.overrides);
});

test('applyUpdate: a bad value for any editable number is refused, and nothing is changed', () => {
  for (const f of EDITABLE.filter((x) => x.type === 'int')) {
    for (const bad of [String(f.min - 1), String(f.max + 1), 'abc', '1.5', '']) {
      const r = sc.applyUpdate(full(), { [f.key]: bad });
      assertTrue(r.error && !r.overrides, `${f.key}=${JSON.stringify(bad)}`);
    }
  }
});

test('applyUpdate: the new kinds of value are checked — a choice, an address, chat ids, a dashboard address, a path', () => {
  const bad = (key, value) => assertTrue(sc.applyUpdate(full(), { [key]: value }).error, `${key}=${JSON.stringify(value)}`);
  const good = (key, value, stored) => assertEqual(sc.applyUpdate(full(), { [key]: value }).overrides[key], stored, key);
  bad('personScanAction', 'erase'); good('personScanAction', ' delete ', 'delete');
  bad('relayBind', 'a b'); bad('relayBind', ''); good('relayBind', '::1', '::1');
  bad('telegramChatId', 'abc'); bad('telegramChatId', '12,x y'); good('telegramChatId', ' 123456 , -1001234567890 ,123456', '123456,-1001234567890');
  bad('footageBaseUrl', 'ftp://x'); bad('footageBaseUrl', 'http://u:p@x/'); bad('footageBaseUrl', 'http://x/?a=1'); good('footageBaseUrl', ' http://pi.local/camdash/ ', 'http://pi.local/camdash');
  // an empty value clears what config.js says (the same value as the default is "no change", so start from a config.js that has one)
  const withConfig = full({ base: { notifications: { footageBaseUrl: 'http://old/x', telegram: { chatId: '1' } } } });
  assertEqual(sc.applyUpdate(withConfig, { telegramChatId: '', footageBaseUrl: '' }).overrides, { telegramChatId: '', footageBaseUrl: '' });
  assertEqual(sc.applyUpdate(full(), { telegramChatId: '', footageBaseUrl: '' }).changed, []);
  for (const p of ['/etc/model.onnx', '../x.onnx', 'models/x.txt', 'lib/x.onnx', '.hidden/x.onnx', 'C:\\x.onnx']) bad('personScanModel', p);
  good('personScanModel', 'models/other.onnx', 'models/other.onnx');
  bad('telegramBotToken', 'short'); bad('telegramBotToken', 'has space in it');
});

test('applyUpdate: the longest lock-out may not be shorter than the first; a save of something else is not blocked by a bad pair already stored', () => {
  assertTrue(sc.applyUpdate(full(), { authLockSeconds: '1000' }).error, 'first 1000 s > the longest, 900 s');
  assertTrue(sc.applyUpdate(full(), { authLockMaxSeconds: '30' }).error, 'longest 30 s < the first, 60 s');
  assertTrue(sc.applyUpdate(full(), { authLockSeconds: '200', authLockMaxSeconds: '100' }).error);
  assertEqual(sc.applyUpdate(full(), { authLockSeconds: '10', authLockMaxSeconds: '100' }).changed, ['authLockSeconds', 'authLockMaxSeconds']);
  const damaged = full({ overrides: { authLockSeconds: 500, authLockMaxSeconds: 100 } });   // a hand-edited file
  assertEqual(sc.applyUpdate(damaged, { maxAlarmRecordings: '5' }).changed, ['maxAlarmRecordings']);
});

// ── locked rows ──

test('locked rows (the programs the relay runs) are never changed through the API, never stored, and never merged into config', () => {
  const locked = FIELDS.filter((f) => f.locked);
  assertEqual(locked.map((f) => f.key).sort(), ['alarmSoundPlayer', 'personScanPython', 'personScanScript']);
  for (const f of locked) {
    assertTrue(sc.applyUpdate(full(), { [f.key]: Array.isArray(f.default) ? ['rm', '-rf'] : 'evil' }).error, f.key);
    assertEqual(sc.OVERRIDE_KEYS.includes(f.key), false, `${f.key} is not a store key`);
    const parsed = sc.parseOverrides(JSON.stringify({ [f.key]: 'evil' }));
    assertEqual(parsed.overrides, {});
    assertEqual(parsed.warnings.length, 1, `${f.key}: a stored value is ignored with a warning`);
    const view = sc.buildView(full()).fields.find((x) => x.key === f.key);
    assertEqual([view.locked, view.restart], [true, true]);
  }
});

test('locked rows: sending back the value that is shown is not an error (a page may echo everything)', () => {
  const view = sc.buildView(full({ base: { personScan: { python: '/usr/bin/python3.11' } } }));
  const python = view.fields.find((f) => f.key === 'personScanPython');
  assertEqual(python.value, '/usr/bin/python3.11');
  const r = sc.applyUpdate(full({ base: { personScan: { python: '/usr/bin/python3.11' } } }), { personScanPython: python.value, alarmSoundPlayer: view.fields.find((f) => f.key === 'alarmSoundPlayer').value });
  assertEqual([r.error, r.changed], [undefined, []]);
});

// ── what the page is shown ──

test('buildView: every row shows its tier and, unless it is a secret, its default; a choice shows its words', () => {
  const view = sc.buildView(full());
  assertEqual(view.fields.length, 55);
  for (const f of view.fields) {
    assertTrue(TIERS.includes(f.tier), f.key);
    if (f.type === 'secret') assertTrue(!('default' in f) && !('value' in f), `${f.key}: a secret shows neither`);
    else assertTrue('default' in f || field(f.key).default === undefined, `${f.key}: default`);
  }
  const action = view.fields.find((f) => f.key === 'personScanAction');
  assertEqual([action.options, action.value, action.default], [['move', 'delete'], 'move', 'move']);
  assertEqual(view.fields.find((f) => f.key === 'telegramChatId').value, '', 'no chat id: empty text, not "undefined"');
});

test('buildView: a switch set by a legacy variable shows as true / false and as set by the environment', () => {
  const f = sc.buildView(full({ env: { RELAY_HSTS: '1', READ_KEY_REQUIRED: '0' } })).fields;
  const hsts = f.find((x) => x.key === 'relayHsts');
  assertEqual([hsts.value, hsts.source, hsts.envOverride, hsts.envName], [true, 'environment', true, 'RELAY_HSTS']);
  assertEqual(f.find((x) => x.key === 'readKeyRequired').value, false);
});

test('applyUpdate: a row set by the environment cannot be changed, but sending back what is shown is fine', () => {
  const env = { RELAY_HSTS: '1', MAX_ALARM_RECORDINGS: '7' };
  assertTrue(sc.applyUpdate(full({ env }), { relayHsts: 'false' }).error);
  assertTrue(sc.applyUpdate(full({ env }), { maxAlarmRecordings: '8' }).error);
  assertEqual(sc.applyUpdate(full({ env }), { relayHsts: 'true', maxAlarmRecordings: '7' }).changed, []);
  assertEqual(sc.applyUpdate(full({ env }), { relayHsts: '1' }).changed, []);
});

// ── mergeConfig reaches the code that reads config.js ──

test('mergeConfig: a saved nested value lands where config.js keeps it, next to what was already there, and the base is not changed', () => {
  const base = { notifications: { footageBaseUrl: 'http://old/x', telegram: { chatId: '1', botToken: '1:abc' } }, personScan: { enabled: true } };
  const snapshot = JSON.stringify(base);
  const merged = sc.mergeConfig(base, { telegramChatId: '2,3', notifyCooldownSeconds: 5, personScanStride: 4, relayBind: '127.0.0.1' });
  assertEqual(merged.notifications, { footageBaseUrl: 'http://old/x', telegram: { chatId: '2,3', botToken: '1:abc' }, cooldownSeconds: 5 });
  assertEqual(merged.personScan, { enabled: true, stride: 4 });
  assertEqual(merged.relayBind, '127.0.0.1');
  assertEqual(JSON.stringify(base), snapshot);
});

test('mergeConfig: a block that is missing, or is not an object, is replaced rather than crashing', () => {
  assertEqual(sc.mergeConfig({ notifications: 'oops' }, { telegramEnabled: false }).notifications, { telegram: { enabled: false } });
  assertEqual(sc.mergeConfig({}, { telegramBotToken: 'abc' }).notifications, { telegram: { botToken: 'abc' } });
});

test('a saved nested value reaches the module that reads it (person check, sound player, notices, Telegram)', () => {
  const m = sc.mergeConfig({}, { personScanAction: 'delete', personScanStride: 7, alarmSoundTimeoutSeconds: 12, notifyCooldownSeconds: 0, storageReminderHours: 3, footageBaseUrl: 'http://pi.local/cam', telegramEnabled: false });
  assertEqual([personscan.resolveScanConfig(m.personScan, '/r').action, personscan.resolveScanConfig(m.personScan, '/r').stride], ['delete', 7]);
  assertEqual(soundplayer.resolvePlayerConfig(m.alarmSounds).timeoutMs, 12000);
  assertEqual(detectionnotice.resolveNoticeConfig(m.notifications), { footageBaseUrl: 'http://pi.local/cam', cooldownMs: 0, warnings: [] });
  assertEqual(storagenotice.resolveStorageNoticeConfig(m.notifications).reminderMs, 3 * 3600 * 1000);
  assertEqual(resolveTelegramConfig(m.notifications.telegram, { TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz', TELEGRAM_CHAT_ID: '5' }).config, null, 'switched off even with a token and a chat');
});

summarize();
