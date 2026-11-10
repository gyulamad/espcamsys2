'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const sc = require('../../nodejs/camera-relay/lib/sysconfig');
const ps = require('../../nodejs/camera-relay/lib/personscan');

const BASE = { port: 8080, pushPort: 8081, camKey: 'cam-secret-1', controlKey: 'control-secret-1', preRollSeconds: 5 };
const state = (extra = {}) => Object.assign({ base: BASE, overrides: {}, alarmRecordSeconds: 60, env: {} }, extra);

test('every field has a unique key, a group, a label and a help text', () => {
  const keys = sc.FIELDS.map((f) => f.key);
  assertEqual(new Set(keys).size, keys.length);
  for (const f of sc.FIELDS) { assertTrue(f.group && f.label && f.help, f.key); assertTrue(['int', 'float', 'bool', 'string', 'secret'].includes(f.type), f.key); }
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

// ── minFreeStorageMB: the low-storage warning threshold ──

test('minFreeStorageMB is a Recording setting that applies at once (no restart) and 0 switches it off', () => {
  const f = sc.FIELDS.find((x) => x.key === 'minFreeStorageMB');
  assertTrue(f, 'field exists');
  assertEqual([f.type, f.group, f.restart, f.min, f.default], ['int', 'Recording', false, 0, 1024]);
  assertEqual(sc.checkValue(f, '0'), { value: 0 });
  for (const bad of ['-1', '1.5', 'abc', '', null, String(1024 * 1024 + 1)]) assertTrue(sc.checkValue(f, bad).error, String(bad));
});

test('minFreeStorageMB: a save is stored, needs no restart, and is shown by buildView', () => {
  const r = sc.applyUpdate(state(), { minFreeStorageMB: '2048' });
  assertEqual([r.changed, r.restartRequired, r.overrides.minFreeStorageMB], [['minFreeStorageMB'], false, 2048]);
  const view = sc.buildView(state({ overrides: r.overrides })).fields.find((x) => x.key === 'minFreeStorageMB');
  assertEqual([view.value, view.source], [2048, 'settings']);
});

test('minFreeStorageMB: an invalid value is refused and changes nothing', () => {
  const r = sc.applyUpdate(state(), { minFreeStorageMB: '-5', preRollSeconds: 9 });
  assertTrue(r.error && !r.overrides, JSON.stringify(r));
});

test('currentValue: environment, then saved settings, then config.js, then the default', () => {
  assertEqual(sc.currentValue('minFreeStorageMB', state()), 1024);
  assertEqual(sc.currentValue('minFreeStorageMB', state({ base: { minFreeStorageMB: 300 } })), 300);
  assertEqual(sc.currentValue('minFreeStorageMB', state({ base: { minFreeStorageMB: 300 }, overrides: { minFreeStorageMB: 500 } })), 500);
  assertEqual(sc.currentValue('minFreeStorageMB', state({ overrides: { minFreeStorageMB: 500 }, env: { MIN_FREE_STORAGE_MB: '700' } })), 700);
});

test('currentValue: a value that is not valid (hand-edited config.js, bad environment) falls back to the default, and 0 stays 0', () => {
  for (const bad of ['lots', -3, 1.5, 99999999999, {}]) {
    assertEqual(sc.currentValue('minFreeStorageMB', state({ base: { minFreeStorageMB: bad } })), 1024, JSON.stringify(bad));
  }
  assertEqual(sc.currentValue('minFreeStorageMB', state({ env: { MIN_FREE_STORAGE_MB: 'x' } })), 1024);
  assertEqual(sc.currentValue('minFreeStorageMB', state({ base: { minFreeStorageMB: 0 } })), 0);
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

// ── camKey vs controlKey (review NODE-013) ──

test('applyUpdate: setting camKey equal to controlKey is refused (a board with camKey must not gain dashboard power)', () => {
  const r = sc.applyUpdate(state(), { camKey: 'control-secret-1' });
  assertTrue(r.error, 'should error');
  assertTrue(/must be different/.test(r.error), `message: ${r.error}`);
  assertEqual(r.overrides, undefined);
});

test('applyUpdate: setting controlKey equal to camKey is also refused', () => {
  const r = sc.applyUpdate(state(), { controlKey: 'cam-secret-1' });
  assertTrue(r.error);
  assertTrue(/must be different/.test(r.error));
});

test('applyUpdate: two distinct valid keys are accepted', () => {
  const r = sc.applyUpdate(state(), { camKey: 'newcamkey1234567', controlKey: 'newcontrolkey123' });
  assertEqual(r.error, undefined);
  assertEqual(r.overrides.camKey, 'newcamkey1234567');
  assertEqual(r.overrides.controlKey, 'newcontrolkey123');
});

test('applyUpdate: equal keys in config.js are also caught when only one is being changed', () => {
  // config.js has both set to the same value; the page only sends one
  const sameBase = Object.assign({}, BASE, { camKey: 'same-key-1234567', controlKey: 'same-key-1234567' });
  const r = sc.applyUpdate(state({ base: sameBase }), { camKey: 'different-key-123' });
  assertEqual(r.error, undefined);
  assertEqual(r.overrides.camKey, 'different-key-123');
});

// ── personScanConfidence: how sure the person detector must be before a clip counts as "has a person" ──

test('personScanConfidence: a Person check setting that applies at once, with the person scan\'s own default and limits', () => {
  const f = field('personScanConfidence');
  assertTrue(f, 'field exists');
  assertEqual([f.type, f.group, f.restart, f.env, f.default, f.min, f.max, f.minExclusive], ['float', 'Person check', false, null, ps.CONFIDENCE.default, ps.CONFIDENCE.min, ps.CONFIDENCE.max, true]);
  assertTrue(f.label && f.help, 'label and help');
});

test('checkValue (float): a decimal, as text or number, inside (0, 1] is accepted — anything else is refused', () => {
  const f = field('personScanConfidence');
  for (const [raw, v] of [[0.4, 0.4], ['0.4', 0.4], [' 0.55 ', 0.55], ['.5', 0.5], ['1', 1], [1, 1], ['1.0', 1], ['0.01', 0.01], ['0.000001', 0.000001]]) assertEqual(sc.checkValue(f, raw), { value: v }, String(raw));
  for (const bad of [0, '0', '0.0', -0.1, '-0.5', 1.01, '1.0001', 2, '5.', 'abc', '0.4abc', '1e-1', '0x1', '0,5', '.', '--1', 'NaN', 'Infinity', NaN, Infinity, '', ' ', null, undefined, true, [0.4], {}]) {
    const r = sc.checkValue(f, bad);
    assertTrue(r.error && r.value === undefined, `${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
  }
  assertEqual(sc.checkValue(f, '2').error, 'personScanConfidence must be a number above 0 and at most 1');
});

test('personScanConfidence: the settings page and the person scan agree on what is valid (one definition, ps.CONFIDENCE)', () => {
  const f = field('personScanConfidence');
  for (const n of [-1, 0, 0.0001, 0.4, 0.9999, 1, 1.0001, 2]) assertEqual(sc.checkValue(f, n).error === undefined, ps.isValidConfidence(n), String(n));
});

test('personScanConfidence: config.js\'s personScan.confidence is the starting value, a saved one wins, else the default', () => {
  const view = (extra) => sc.buildView(state(extra)).fields.find((x) => x.key === 'personScanConfidence');
  assertEqual([view().value, view().source, view().envOverride], [0.4, 'default', false]);
  const fromConfig = { base: { ...BASE, personScan: { enabled: true, confidence: 0.55 } } };
  assertEqual([view(fromConfig).value, view(fromConfig).source], [0.55, 'config.js']);
  const saved = { ...fromConfig, overrides: { personScanConfidence: 0.7 } };
  assertEqual([view(saved).value, view(saved).source], [0.7, 'settings']);
  assertEqual([view(saved).min, view(saved).max, typeof view(saved).value], [0, 1, 'number']);
});

test('currentValue: the person scan\'s confidence — nested config.js value, saved value, default, and a bad value falls back', () => {
  const cur = (extra) => sc.currentValue('personScanConfidence', state(extra));
  assertEqual(cur(), 0.4);
  assertEqual(cur({ base: { personScan: { confidence: 0.55 } } }), 0.55);
  assertEqual(cur({ base: { personScan: { confidence: 0.55 } }, overrides: { personScanConfidence: 0.7 } }), 0.7);
  for (const bad of [0, 2, 'x', -1]) assertEqual(cur({ base: { personScan: { confidence: bad } } }), 0.4, JSON.stringify(bad));
  assertEqual(cur({ base: { personScan: 'nonsense' } }), 0.4);
  assertEqual(cur({ base: { personScan: null } }), 0.4);
});

test('applyUpdate: a new confidence is stored, needs no restart, and an unchanged value is not a change', () => {
  const r = sc.applyUpdate(state(), { personScanConfidence: '0.7' });
  assertEqual([r.error, r.changed, r.restartRequired, r.overrides.personScanConfidence], [undefined, ['personScanConfidence'], false, 0.7]);
  for (const same of ['0.4', '0.40', 0.4, ' .4 ']) assertEqual(sc.applyUpdate(state(), { personScanConfidence: same }).changed, [], String(same));
  const fromConfig = state({ base: { ...BASE, personScan: { confidence: 0.55 } } });
  assertEqual(sc.applyUpdate(fromConfig, { personScanConfidence: '0.55' }).changed, [], 'the value config.js already has is not a change');
  assertEqual(sc.applyUpdate(fromConfig, { personScanConfidence: '0.6' }).changed, ['personScanConfidence']);
});

test('applyUpdate: an invalid confidence changes nothing, even next to valid settings (all or nothing)', () => {
  for (const bad of ['0', '1.5', 'abc', '', null]) {
    const r = sc.applyUpdate(state(), { minFreeStorageMB: '10', personScanConfidence: bad });
    assertTrue(r.error && /personScanConfidence/.test(r.error) && r.overrides === undefined && r.changed === undefined, `${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
  }
});

test('mergeConfig: a saved confidence lands in personScan.confidence, the rest of the block stays and config.js\'s object is not touched', () => {
  const base = { port: 8080, personScan: { enabled: true, model: 'm.onnx' } };
  const merged = sc.mergeConfig(base, { personScanConfidence: 0.7, port: 9090 });
  assertEqual(merged.personScan, { enabled: true, model: 'm.onnx', confidence: 0.7 });
  assertEqual([merged.port, merged.personScanConfidence], [9090, undefined]);
  assertEqual(base, { port: 8080, personScan: { enabled: true, model: 'm.onnx' } }, 'base unchanged');
  assertEqual(sc.mergeConfig({ port: 1 }, { personScanConfidence: 0.7 }).personScan, { confidence: 0.7 }, 'no personScan block yet');
  assertEqual(sc.mergeConfig({ personScan: 'nonsense' }, { personScanConfidence: 0.7 }).personScan, { confidence: 0.7 });
});

test('parseOverrides: a saved confidence is kept when valid, skipped with a warning when not', () => {
  assertEqual(sc.parseOverrides('{"personScanConfidence":0.7}'), { overrides: { personScanConfidence: 0.7 }, warnings: [] });
  const bad = sc.parseOverrides('{"personScanConfidence":5}');
  assertEqual(bad.overrides, {});
  assertTrue(bad.warnings.length === 1 && /personScanConfidence/.test(bad.warnings[0]), JSON.stringify(bad.warnings));
});

test('a saved confidence reaches the person scan: mergeConfig, then resolveScanConfig', () => {
  const merged = sc.mergeConfig({ personScan: { enabled: true } }, { personScanConfidence: 0.7 });
  const scanCfg = ps.resolveScanConfig(merged.personScan, '/relay');
  assertEqual([scanCfg.confidence, scanCfg.enabled, scanCfg.warnings], [0.7, true, []]);
});

// ── personScanEnabled: the switch of the person check ────────────────

test('personScanEnabled: the first setting of the Person check group, off by default, applies at once', () => {
  const f = field('personScanEnabled');
  assertTrue(f, 'field exists');
  assertEqual([f.type, f.group, f.restart, f.env, f.default, f.config], ['bool', 'Person check', false, null, ps.DEFAULTS.enabled, ['personScan', 'enabled']]);
  assertTrue(f.label && f.help, 'label and help');
  const inGroup = sc.FIELDS.filter((x) => x.group === 'Person check').map((x) => x.key);
  assertEqual(inGroup, ['personScanEnabled', 'personScanConfidence']);
});

test('checkValue (bool): true or false, as a boolean or as the text true / false — nothing else (no 1, yes, on)', () => {
  const f = field('personScanEnabled');
  for (const [raw, v] of [[true, true], [false, false], ['true', true], ['false', false], [' TRUE ', true], ['False', false]]) assertEqual(sc.checkValue(f, raw), { value: v }, String(raw));
  for (const bad of [1, 0, '1', '0', 'yes', 'no', 'on', 'off', '', ' ', 'truefalse', 'true\n', null, undefined, NaN, [true], { v: true }]) {
    const r = sc.checkValue(f, bad);
    assertTrue(r.error && r.value === undefined, `${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
  }
  assertEqual(sc.checkValue(f, 'yes').error, 'personScanEnabled must be true or false');
});

test('personScanEnabled: config.js\'s personScan.enabled is the starting value, a saved one wins, else it is off', () => {
  const view = (extra) => sc.buildView(state(extra)).fields.find((x) => x.key === 'personScanEnabled');
  assertEqual([view().value, view().source, view().envOverride], [false, 'default', false]);
  const fromConfig = { base: { ...BASE, personScan: { enabled: true } } };
  assertEqual([view(fromConfig).value, view(fromConfig).source], [true, 'config.js']);
  const saved = { ...fromConfig, overrides: { personScanEnabled: false } };
  assertEqual([view(saved).value, view(saved).source, typeof view(saved).value], [false, 'settings', 'boolean']);
});

test('currentValue: the switch — saved value, config.js, default; anything not true/false falls back to OFF', () => {
  const cur = (extra) => sc.currentValue('personScanEnabled', state(extra));
  assertEqual(cur(), false);
  assertEqual(cur({ base: { personScan: { enabled: true } } }), true);
  assertEqual(cur({ base: { personScan: { enabled: true } }, overrides: { personScanEnabled: false } }), false);
  for (const bad of ['yes', 1, 'x', []]) assertEqual(cur({ base: { personScan: { enabled: bad } } }), false, JSON.stringify(bad));
});

test('applyUpdate: switching the check on/off is stored as a boolean, needs no restart, and the same state is not a change', () => {
  const on = sc.applyUpdate(state(), { personScanEnabled: 'true' });
  assertEqual([on.error, on.changed, on.restartRequired, on.overrides.personScanEnabled], [undefined, ['personScanEnabled'], false, true]);
  assertEqual(sc.applyUpdate(state(), { personScanEnabled: 'false' }).changed, [], 'already off');
  assertEqual(sc.applyUpdate(state(), { personScanEnabled: false }).changed, []);
  const fromConfig = state({ base: { ...BASE, personScan: { enabled: true } } });
  assertEqual(sc.applyUpdate(fromConfig, { personScanEnabled: true }).changed, [], 'already on through config.js');
  assertEqual(sc.applyUpdate(fromConfig, { personScanEnabled: 'false' }).changed, ['personScanEnabled']);
});

test('applyUpdate: a bad switch value changes nothing, even next to valid settings', () => {
  for (const bad of ['yes', '1', 1, '', null]) {
    const r = sc.applyUpdate(state(), { personScanConfidence: '0.5', personScanEnabled: bad });
    assertTrue(r.error && /personScanEnabled/.test(r.error) && r.overrides === undefined && r.changed === undefined, `${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
  }
});

test('mergeConfig + parseOverrides: a saved switch lands in personScan.enabled next to the confidence; a bad saved one is skipped with a warning', () => {
  const merged = sc.mergeConfig({ personScan: { model: 'm.onnx' } }, { personScanEnabled: true, personScanConfidence: 0.7 });
  assertEqual(merged.personScan, { model: 'm.onnx', enabled: true, confidence: 0.7 });
  assertEqual(merged.personScanEnabled, undefined);
  assertEqual(sc.parseOverrides('{"personScanEnabled":true}'), { overrides: { personScanEnabled: true }, warnings: [] });
  const bad = sc.parseOverrides('{"personScanEnabled":"yes"}');
  assertTrue(Object.keys(bad.overrides).length === 0 && bad.warnings.length === 1 && /personScanEnabled/.test(bad.warnings[0]), JSON.stringify(bad));
  const scanCfg = ps.resolveScanConfig(sc.mergeConfig({}, { personScanEnabled: true }).personScan, '/relay');
  assertEqual([scanCfg.enabled, scanCfg.warnings], [true, []]);
});

summarize();
