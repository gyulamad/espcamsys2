'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const sc = require('../../nodejs/camera-relay/lib/sysconfig');

const BASE = { port: 8080, pushPort: 8081, camKey: 'cam-secret-1', controlKey: 'control-secret-1', preRollSeconds: 5 };
const state = (extra = {}) => Object.assign({ base: BASE, overrides: {}, alarmRecordSeconds: 60, env: {} }, extra);

test('every field has a unique key, a group, a label and a help text', () => {
  const keys = sc.FIELDS.map((f) => f.key);
  assertEqual(new Set(keys).size, keys.length);
  for (const f of sc.FIELDS) { assertTrue(f.group && f.label && f.help, f.key); assertTrue(['int', 'string', 'secret'].includes(f.type), f.key); }
});

test('checkValue: integers are range checked and parsed from text or numbers', () => {
  const f = sc.FIELDS.find((x) => x.key === 'preRollSeconds');
  assertEqual(sc.checkValue(f, '10'), { value: 10 });
  assertEqual(sc.checkValue(f, 0), { value: 0 });
  for (const bad of ['61', '-1', '1.5', 'abc', '', null, undefined, {}, '1e2']) assertTrue(sc.checkValue(f, bad).error, String(bad));
});

test('checkValue: secrets need 8+ characters and no spaces or control characters', () => {
  const f = sc.FIELDS.find((x) => x.key === 'camKey');
  assertEqual(sc.checkValue(f, 'abcdefgh'), { value: 'abcdefgh' });
  for (const bad of ['short', 'has space 123', 'line\nbreak12', 'x'.repeat(201), 5]) assertTrue(sc.checkValue(f, bad).error, String(bad));
});

test('checkValue: text is trimmed, must not be empty and must not hold control characters', () => {
  const f = sc.FIELDS.find((x) => x.key === 'logFile');
  assertEqual(sc.checkValue(f, '  logs/x.log '), { value: 'logs/x.log' });
  for (const bad of ['', '   ', 'a\nb', 'a\u0000b', 7]) assertTrue(sc.checkValue(f, bad).error, JSON.stringify(bad));
});

test('parseOverrides: keeps valid values and warns about (and skips) invalid ones', () => {
  const r = sc.parseOverrides('{"preRollSeconds":9,"logKeepFiles":99,"camKey":"x","bogus":1,"logFile":"a.log"}');
  assertEqual(r.overrides, { preRollSeconds: 9, logFile: 'a.log' });
  assertEqual(r.warnings.length, 2);
});

test('parseOverrides: a missing, empty, corrupt or non-object file means no overrides', () => {
  for (const t of [undefined, '', '  ', '{nope', 'null', '[1]', '42']) assertEqual(sc.parseOverrides(t).overrides, {}, String(t));
  assertTrue(sc.parseOverrides('{nope').warnings.length === 1);
  assertEqual(sc.parseOverrides('').warnings, []);
});

test('parseOverrides: the live alarm value is not an override (it lives in settings.json)', () => {
  assertEqual(sc.parseOverrides('{"alarmRecordSeconds":5}').overrides, {});
});

test('parseOverrides: equal ports are dropped together so the relay can still start', () => {
  const r = sc.parseOverrides('{"port":9000,"pushPort":9000}');
  assertEqual(r.overrides, {});
  assertEqual(r.warnings.length, 1);
});

test('mergeConfig lays overrides over config.js without changing either', () => {
  const o = { preRollSeconds: 9 };
  const m = sc.mergeConfig(BASE, o);
  assertEqual(m.preRollSeconds, 9);
  assertEqual(m.port, 8080);
  assertEqual(BASE.preRollSeconds, 5);
});

test('buildView: shows value and source, falling back to config.js then the default', () => {
  const v = sc.buildView(state({ overrides: { preRollSeconds: 9 } }));
  const by = Object.fromEntries(v.fields.map((f) => [f.key, f]));
  assertEqual([by.preRollSeconds.value, by.preRollSeconds.source], [9, 'settings']);
  assertEqual([by.port.value, by.port.source], [8080, 'config.js']);
  assertEqual([by.logKeepFiles.value, by.logKeepFiles.source], [2, 'default']);
  assertEqual([by.alarmRecordSeconds.value, by.alarmRecordSeconds.restart], [60, false]);
});

test('buildView NEVER includes a secret, only whether it is set', () => {
  const v = sc.buildView(state());
  const text = JSON.stringify(v);
  assertTrue(!text.includes('cam-secret-1') && !text.includes('control-secret-1'));
  const cam = v.fields.find((f) => f.key === 'camKey');
  assertEqual([cam.isSet, 'value' in cam], [true, false]);
  const unset = sc.buildView(state({ base: { port: 1, pushPort: 2 } })).fields.find((f) => f.key === 'controlKey');
  assertEqual(unset.isSet, false);
});

test('buildView marks environment-overridden fields and shows the environment value', () => {
  const v = sc.buildView(state({ env: { PORT: '9999' } }));
  const port = v.fields.find((f) => f.key === 'port');
  assertEqual([port.value, port.source, port.envOverride, port.envName], [9999, 'environment', true, 'PORT']);
});

test('applyUpdate: a restart-needing change is reported, saved as an override and leaves the input alone', () => {
  const cur = state();
  const r = sc.applyUpdate(cur, { preRollSeconds: '12' });
  assertEqual([r.changed, r.restartRequired, r.overrides.preRollSeconds], [['preRollSeconds'], true, 12]);
  assertEqual(cur.overrides, {});
});

test('applyUpdate: the alarm length applies without a restart', () => {
  const r = sc.applyUpdate(state(), { alarmRecordSeconds: 30 });
  assertEqual([r.changed, r.restartRequired, r.alarmRecordSeconds, r.overrides], [['alarmRecordSeconds'], false, 30, {}]);
});

test('applyUpdate: values equal to the current ones are not changes (no needless restart)', () => {
  const r = sc.applyUpdate(state(), { port: 8080, preRollSeconds: '5', alarmRecordSeconds: 60 });
  assertEqual([r.changed, r.restartRequired], [[], false]);
});

test('applyUpdate: an empty secret keeps the current one, a new one is stored', () => {
  assertEqual(sc.applyUpdate(state(), { camKey: '' }).changed, []);
  const r = sc.applyUpdate(state(), { camKey: 'brand-new-key' });
  assertEqual([r.changed, r.overrides.camKey, r.restartRequired], [['camKey'], 'brand-new-key', true]);
  assertEqual(sc.applyUpdate(state(), { camKey: 'cam-secret-1' }).changed, []);
});

test('applyUpdate is all-or-nothing: one bad value, or an unknown key, rejects the lot', () => {
  assertTrue(sc.applyUpdate(state(), { preRollSeconds: 9, port: 'x' }).error);
  assertTrue(sc.applyUpdate(state(), { preRollSeconds: 9, nope: 1 }).error);
  for (const bad of [null, [], 'text', 5]) assertTrue(sc.applyUpdate(state(), bad).error, String(bad));
});

test('applyUpdate: port and pushPort may not end up the same', () => {
  assertTrue(sc.applyUpdate(state(), { port: 8081 }).error);
  assertTrue(sc.applyUpdate(state(), { pushPort: 8080 }).error);
  assertTrue(!sc.applyUpdate(state(), { port: 9000, pushPort: 9001 }).error);
});

test('applyUpdate: an environment-overridden field cannot be changed, but being echoed back is fine', () => {
  const env = { PORT: '9999' };
  assertTrue(sc.applyUpdate(state({ env }), { port: 1234 }).error);
  assertEqual(sc.applyUpdate(state({ env }), { port: 9999 }).changed, []);
  assertTrue(sc.applyUpdate(state({ env: { CAM_KEY: 'x'.repeat(10) } }), { camKey: 'another-key-1' }).error);
});

test('isSupervised: systemd, pm2 or the explicit flag count; a hand-started relay does not', () => {
  assertEqual(sc.isSupervised({}), false);
  assertEqual(sc.isSupervised({ INVOCATION_ID: 'abc' }), true);
  assertEqual(sc.isSupervised({ INVOCATION_ID: '' }), false);
  assertEqual(sc.isSupervised({ pm_id: '0' }), true);
  assertEqual(sc.isSupervised({ RELAY_SUPERVISED: '1' }), true);
  assertEqual(sc.isSupervised({ RELAY_SUPERVISED: '0' }), false);
});

test('the restart exit code is non-zero, so systemd Restart=on-failure restarts the relay', () => {
  assertTrue(sc.RESTART_EXIT_CODE > 0);
});

// ── the four path settings must stay inside the relay's folder (security review R-04) ──
const field = (key) => sc.FIELDS.find((f) => f.key === key);

test('checkRelayPath: ordinary relative folders and files are accepted and normalised', () => {
  assertEqual(sc.checkRelayPath(field('firmwareDir'), 'firmware'), { value: 'firmware' });
  assertEqual(sc.checkRelayPath(field('firmwareDir'), 'data/firmware/'), { value: 'data/firmware' });
  assertEqual(sc.checkRelayPath(field('firmwareDir'), './fw//images'), { value: 'fw/images' });
  assertEqual(sc.checkRelayPath(field('deviceSettingsDir'), 'device-settings'), { value: 'device-settings' });
  assertEqual(sc.checkRelayPath(field('logFile'), 'logs/camera.log'), { value: 'logs/camera.log' });
  assertEqual(sc.checkRelayPath(field('switchFile'), 'recording-switch.json'), { value: 'recording-switch.json' });
});

test('checkRelayPath: absolute paths, ~ , drive letters and backslashes are refused', () => {
  for (const bad of ['/etc', '/var/lib/fw', '~/fw', '~', 'C:/fw', 'C:\\fw', 'fw\\x', '\\\\server\\share', 'file:///x']) {
    assertTrue(sc.checkRelayPath(field('firmwareDir'), bad).error, bad);
  }
});

test('checkRelayPath: ".." anywhere is refused, however it is hidden', () => {
  for (const bad of ['..', '../x', 'a/..', 'a/../b', 'a/b/../../..', './../x', 'a//../..']) {
    assertTrue(sc.checkRelayPath(field('firmwareDir'), bad).error, bad);
  }
});

test('checkRelayPath: nothing may start with a dot (.git, .ssh, hidden files)', () => {
  for (const bad of ['.git', '.ssh/keys', 'a/.hidden', '.env']) assertTrue(sc.checkRelayPath(field('deviceSettingsDir'), bad).error, bad);
});

test('checkRelayPath: empty, "." and "/" alone name no folder', () => {
  for (const bad of ['', '.', './', './.', '//']) assertTrue(sc.checkRelayPath(field('firmwareDir'), bad).error, JSON.stringify(bad));
});

test('checkRelayPath: the relay\'s own code and recordings are not valid places to write', () => {
  for (const bad of ['lib', 'lib/x', 'LIB/x', 'node_modules/x', 'recordings', 'recordings/cam1']) assertTrue(sc.checkRelayPath(field('firmwareDir'), bad).error, bad);
});

test('checkRelayPath: a file setting needs its own extension and may not be one of the relay\'s own files', () => {
  const log = field('logFile'); const sw = field('switchFile');
  for (const bad of ['server.js', 'config.js', 'package.json', 'package-lock.json', 'settings.json', 'system-settings.json', 'logs/config.js', 'camera.txt', 'camera', '.log', 'logs/.log']) {
    assertTrue(sc.checkRelayPath(log, bad).error, `log ${bad}`);
  }
  for (const bad of ['package.json', 'settings.json', 'system-settings.json', 'state.txt', 'server.js', 'x.json/y']) assertTrue(sc.checkRelayPath(sw, bad).error, `switch ${bad}`);
  assertEqual(sc.checkRelayPath(sw, 'state/switch.JSON'), { value: 'state/switch.JSON' });
});

test('checkRelayPath: the error says what is allowed', () => {
  assertTrue(/inside the relay's own folder/.test(sc.checkRelayPath(field('firmwareDir'), '/etc').error));
  assertTrue(/ending in \.log/.test(sc.checkRelayPath(field('logFile'), 'x.txt').error));
});

test('applyUpdate: a path setting changed to something outside the relay folder is refused, and nothing is changed', () => {
  for (const [key, bad] of [['firmwareDir', '/tmp/fw'], ['deviceSettingsDir', '../elsewhere'], ['switchFile', '/etc/cron.d/x.json'], ['logFile', '/var/log/x.log'], ['logFile', 'server.js']]) {
    const r = sc.applyUpdate(state(), { [key]: bad });
    assertTrue(r.error, `${key}=${bad}`);
    assertEqual(r.overrides, undefined);
  }
});

test('applyUpdate: one bad path refuses the whole request, even next to good values (all-or-nothing)', () => {
  const r = sc.applyUpdate(state(), { preRollSeconds: '9', firmwareDir: '/tmp/fw' });
  assertTrue(r.error);
  assertEqual(r.overrides, undefined);
});

test('applyUpdate: a good path is saved normalised, and needs a restart', () => {
  const r = sc.applyUpdate(state(), { firmwareDir: 'data/fw/' });
  assertEqual(r.error, undefined);
  assertEqual(r.overrides.firmwareDir, 'data/fw');
  assertEqual(r.changed, ['firmwareDir']);
  assertEqual(r.restartRequired, true);
});

test('applyUpdate: a path already in force from config.js is not touched when the page sends it back unchanged', () => {
  const base = Object.assign({}, BASE, { firmwareDir: '/mnt/usb/firmware', logFile: '/var/log/camera.log' });
  const r = sc.applyUpdate(state({ base }), { firmwareDir: '/mnt/usb/firmware', logFile: '/var/log/camera.log', preRollSeconds: '9' });
  assertEqual(r.error, undefined);
  assertEqual(r.changed, ['preRollSeconds']);
  assertEqual(r.overrides.firmwareDir, undefined);
});

test('applyUpdate: ...but changing such a path to another outside one is refused', () => {
  const base = Object.assign({}, BASE, { firmwareDir: '/mnt/usb/firmware' });
  assertTrue(sc.applyUpdate(state({ base }), { firmwareDir: '/mnt/usb/other' }).error);
});

test('applyUpdate: the same relative path written differently is no change', () => {
  const r = sc.applyUpdate(state({ overrides: { firmwareDir: 'data/fw' } }), { firmwareDir: './data/fw/' });
  assertEqual(r.error, undefined);
  assertEqual(r.changed, []);
});

test('parseOverrides: a saved path is still honoured as before (only changes made here are checked)', () => {
  const r = sc.parseOverrides('{"firmwareDir":"/mnt/usb/firmware"}');
  assertEqual(r.overrides, { firmwareDir: '/mnt/usb/firmware' });
});

test('every path setting is marked with what kind it is (so none is missed by the check)', () => {
  const paths = sc.FIELDS.filter((f) => f.path).map((f) => f.key).sort();
  assertEqual(paths, ['deviceSettingsDir', 'firmwareDir', 'logFile', 'switchFile']);
  for (const f of sc.FIELDS.filter((x) => x.type === 'string')) assertTrue(f.path, `${f.key} is a text setting that is not confined`);
});

summarize();
