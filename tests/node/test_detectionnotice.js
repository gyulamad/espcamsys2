'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { Throttle } = require('../../nodejs/camera-relay/lib/throttle');
const { MultiNotifier, Notifier } = require('../../nodejs/camera-relay/lib/notify/notifier');
const n = require('../../nodejs/camera-relay/lib/detectionnotice');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const T0 = Date.UTC(2026, 10, 6, 14, 5, 9);

test('config: defaults — no link, one message a minute per camera', () => {
  assertEqual(n.resolveNoticeConfig(undefined), { footageBaseUrl: null, cooldownMs: 60000, warnings: [] });
  assertEqual(n.resolveNoticeConfig({ footageBaseUrl: '' }).footageBaseUrl, null);
});

test('config: the base URL is normalised (no trailing slash) and plain http(s) only', () => {
  const url = (v) => n.resolveNoticeConfig({ footageBaseUrl: v });
  assertEqual(url('http://raspberrypi.local/camdash/').footageBaseUrl, 'http://raspberrypi.local/camdash');
  assertEqual(url(' https://192.168.1.20:8443 ').footageBaseUrl, 'https://192.168.1.20:8443');
  for (const bad of ['javascript:alert(1)', 'ftp://x/y', 'http://user:pw@host/camdash', 'http://host/camdash?x=1', 'http://host/#frag', 'not a url', 42, 'http://']) {
    const r = url(bad);
    assertEqual([r.footageBaseUrl, r.warnings.length], [null, 1], String(bad));
  }
});

test('config: cooldown is a whole number of seconds, 0 allowed, anything else falls back with a warning', () => {
  const c = (v) => n.resolveNoticeConfig({ cooldownSeconds: v });
  assertEqual([c(0).cooldownMs, c(5).cooldownMs, c(86400).cooldownMs], [0, 5000, 86400000]);
  for (const bad of [-1, 1.5, '30', 86401, null]) assertEqual([c(bad).cooldownMs, c(bad).warnings.length], [60000, 1], String(bad));
});

test('footageUrl: points at the dashboard player and encodes every part', () => {
  assertEqual(n.footageUrl('http://pi/camdash', 'cam1', 'cam1_2026-11-06T14-05-09-000Z.mp4'), 'http://pi/camdash/recordings.php?cam=cam1&play=cam1_2026-11-06T14-05-09-000Z.mp4');
  const u = n.footageUrl('http://pi', 'a&b=c', 'x y#z.mp4');
  assertEqual(u, 'http://pi/recordings.php?cam=a%26b%3Dc&play=x%20y%23z.mp4');
});

test('formatBytes / formatTime', () => {
  assertEqual([n.formatBytes(0), n.formatBytes(1023), n.formatBytes(1536), n.formatBytes(3.25 * 1024 * 1024)], ['0 B', '1023 B', '1.5 KB', '3.3 MB']);
  assertEqual([n.formatBytes(-1), n.formatBytes(NaN), n.formatBytes(null)], [null, null, null]);
  assertEqual(n.formatTime(T0), '2026-11-06 14:05:09 UTC');
});

test('buildPersonText: all the known facts, one per line', () => {
  const text = n.buildPersonText({ camId: 'cam1', filename: 'a.mp4', confidence: 0.874, detectedAtMs: T0, sizeBytes: 2 * 1024 * 1024, footageBaseUrl: 'http://pi/camdash', suppressed: 0 });
  assertEqual(text.split('\n'), [
    'Person detected on cam1',
    'Time: 2026-11-06 14:05:09 UTC',
    'Confidence: 87%',
    'Clip: a.mp4 (2.0 MB)',
    'Watch: http://pi/camdash/recordings.php?cam=cam1&play=a.mp4',
  ]);
});

test('buildPersonText: lines for unknown facts are left out; held-back detections are counted', () => {
  const text = n.buildPersonText({ camId: 'c', filename: 'a.mp4', confidence: null, detectedAtMs: T0, sizeBytes: null, footageBaseUrl: null, suppressed: 1 });
  assertEqual(text.split('\n'), ['Person detected on c', 'Time: 2026-11-06 14:05:09 UTC', 'Clip: a.mp4', '(1 more detection on this camera were not announced)']);
  assertTrue(n.buildPersonText({ camId: 'c', filename: 'a.mp4', detectedAtMs: T0, suppressed: 4 }).endsWith('(4 more detections on this camera were not announced)'));
});

// ── onScanFinished ──
class Spy extends Notifier {
  constructor(fail) { super('spy'); this.sent = []; this.fail = fail; }
  async deliver(m) { if (this.fail) throw new Error(this.fail); this.sent.push(m); }
}
function setup({ channels = [new Spy()], clock = { t: T0 }, cooldownSeconds = 60, files = {}, footageBaseUrl = 'http://pi/camdash' } = {}) {
  const logs = [];
  const notifier = new MultiNotifier(channels);
  const config = { ...n.resolveNoticeConfig({ cooldownSeconds }), footageBaseUrl };
  const d = n.createDetectionNotifier({
    notifier, config, throttle: new Throttle(config.cooldownMs), now: () => clock.t,
    files: { readThumbnail: () => jpeg, sizeOf: () => 4096, ...files },
    log: (level, message, opts) => logs.push([level, message, opts && opts.sender]),
  });
  return { d, logs, channels, clock };
}
const job = (extra = {}) => ({ key: 'cam1/a.mp4', payload: { camId: 'cam1', clipPath: '/rec/cam1/a.mp4', notify: true, ...extra } });
const person = { state: 'person', confidence: 0.9 };

(async () => {
  const a = setup();
  await a.d.onScanFinished(job(), person);
  test('a person in a fresh recording: one message with the thumbnail and every fact', () => {
    assertEqual(a.channels[0].sent.length, 1);
    const m = a.channels[0].sent[0];
    assertTrue(m.image === jpeg);
    assertEqual(m.text.split('\n'), ['Person detected on cam1', 'Time: 2026-11-06 14:05:09 UTC', 'Confidence: 90%', 'Clip: a.mp4 (4.0 KB)', 'Watch: http://pi/camdash/recordings.php?cam=cam1&play=a.mp4']);
    assertEqual(a.logs, []);
  });

  const quiet = setup();
  await quiet.d.onScanFinished(job(), { state: 'moved' });
  await quiet.d.onScanFinished(job(), { state: 'error', reason: 'x' });
  await quiet.d.onScanFinished(job({ notify: false }), person);
  await quiet.d.onScanFinished({ key: 'k', payload: { camId: 'cam1', clipPath: '/rec/cam1/a.mp4' } }, person);
  const none = setup({ channels: [] });
  await none.d.onScanFinished(job(), person);
  test('quiet cases: nobody found, a failed check, a manual re-check, no channel — nothing is sent', () => {
    assertEqual(quiet.channels[0].sent.length, 0);
    assertEqual([quiet.logs, none.logs], [[], []]);
  });

  const cd = setup();
  await cd.d.onScanFinished(job(), person);
  cd.clock.t += 10000;
  await cd.d.onScanFinished(job(), person);
  cd.clock.t += 10000;
  await cd.d.onScanFinished(job(), person);
  await cd.d.onScanFinished(job({ camId: 'cam2', clipPath: '/rec/cam2/b.mp4' }), person);
  cd.clock.t += 60000;
  await cd.d.onScanFinished(job(), person);
  test('the cooldown is per camera, and what was held back is counted in the next message', () => {
    const sent = cd.channels[0].sent;
    assertEqual(sent.length, 3);
    assertTrue(sent[1].text.startsWith('Person detected on cam2'));
    assertTrue(sent[2].text.endsWith('(2 more detections on this camera were not announced)'));
  });

  const zero = setup({ cooldownSeconds: 0 });
  await zero.d.onScanFinished(job(), person);
  await zero.d.onScanFinished(job(), person);
  test('cooldown 0 announces every detection', () => assertEqual(zero.channels[0].sent.length, 2));

  const bad = [
    setup({ files: { readThumbnail: () => { throw new Error('ENOENT'); } } }),
    setup({ files: { readThumbnail: () => Buffer.from('GIF89a......') } }),
    setup({ files: { readThumbnail: () => null } }),
    setup({ files: { readThumbnail: () => Buffer.concat([jpeg, Buffer.alloc(11 * 1024 * 1024)]) } }),
  ];
  for (const s of bad) await s.d.onScanFinished(job(), person);
  const noSize = setup({ files: { sizeOf: () => { throw new Error('gone'); } }, footageBaseUrl: null });
  await noSize.d.onScanFinished(job(), person);
  test('a missing, broken or oversized thumbnail still sends the text; a missing size or link leaves its line out', () => {
    for (const s of bad) {
      assertEqual(s.channels[0].sent.length, 1);
      assertTrue(!('image' in s.channels[0].sent[0]));
      assertEqual(s.logs, []);
    }
    assertEqual(noSize.channels[0].sent[0].text.split('\n').slice(3), ['Clip: a.mp4']);
  });

  const mixed = setup({ channels: [new Spy('quota exceeded'), new Spy()] });
  await mixed.d.onScanFinished(job(), person);
  test('a channel that fails is logged (with the camera as sender) and the others still deliver', () => {
    assertEqual(mixed.channels[1].sent.length, 1);
    assertEqual(mixed.logs, [['WARN', 'the person notification through spy failed: quota exceeded', 'cam1']]);
  });

  const exploding = setup({ files: { sizeOf: () => 1 } });
  exploding.d = n.createDetectionNotifier({
    notifier: { isEmpty: () => false, send: async () => { throw new Error('kaput'); } },
    config: { cooldownMs: 0, footageBaseUrl: null }, throttle: null, now: () => T0,
    files: { readThumbnail: () => jpeg, sizeOf: () => 1 }, log: (l, m, o) => exploding.logs.push([l, m, o.sender]),
  });
  let escaped = null;
  try { await exploding.d.onScanFinished(job(), person); } catch (e) { escaped = e; }
  test('an unexpected failure is logged and never escapes into the scan queue', () => {
    assertEqual(escaped, null);
    assertEqual(exploding.logs, [['WARN', 'the person notification could not be sent: kaput', 'cam1']]);
  });

  summarize();
})();
