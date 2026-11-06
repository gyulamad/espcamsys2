'use strict';

// detectionnotice.js — "the person check found somebody in a new recording": decides whether to tell the
// user, builds the message (text, the thumbnail the detector saved, and a link to the footage on the relay's
// own dashboard) and hands it to the Notifier interface (lib/notify/). Which channels deliver it is not its
// business.
//
// Only a recording the relay has JUST saved is announced (the job carries notify: true — see queueScan in
// server.js); a person found while re-checking old footage by hand stays quiet. A cooldown per camera keeps a
// person who walks around the yard from sending a message per clip: what was held back is counted in the next
// message.
//
// The disk, the clock and the notifier are injected, so this is unit tested without any of them
// (tests/node/test_detectionnotice.js). onScanFinished never throws and never rejects: reporting must not
// disturb the scan queue.

const { isJpeg, MAX_IMAGE_BYTES } = require('./notify/notifier');

const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 86400;

// config.js's `notifications` block -> { footageBaseUrl: string | null, cooldownMs, warnings }.
//   footageBaseUrl  where the dashboard is, as the phone will reach it: http://raspberrypi.local/camdash
//   cooldownSeconds 0 = announce every detection
// A base URL that is not plain http(s) — or carries a password, a query or a fragment — is refused (a link in
// a message is something the user taps without reading it twice); the message then simply has no link.
function resolveNoticeConfig(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  let footageBaseUrl = null;
  if (given.footageBaseUrl !== undefined && given.footageBaseUrl !== '') {
    footageBaseUrl = cleanBaseUrl(given.footageBaseUrl);
    if (footageBaseUrl === null) warnings.push('notifications.footageBaseUrl must be a plain http:// or https:// address of the dashboard, like http://raspberrypi.local/camdash — messages carry no link');
  }
  let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
  if (given.cooldownSeconds !== undefined) {
    const n = given.cooldownSeconds;
    if (Number.isInteger(n) && n >= 0 && n <= MAX_COOLDOWN_SECONDS) cooldownSeconds = n;
    else warnings.push(`notifications.cooldownSeconds must be a whole number from 0 to ${MAX_COOLDOWN_SECONDS} — ${DEFAULT_COOLDOWN_SECONDS} is used`);
  }
  return { footageBaseUrl, cooldownMs: cooldownSeconds * 1000, warnings };
}

function cleanBaseUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value.trim()); } catch (e) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// The dashboard's own player for one clip (recordings.php streams it after the dashboard's login).
function footageUrl(baseUrl, camId, filename) {
  return `${baseUrl}/recordings.php?cam=${encodeURIComponent(camId)}&play=${encodeURIComponent(filename)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms) {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

// The text of the message. Lines for what is not known (no confidence, no size, no link) are left out.
function buildPersonText({ camId, filename, confidence, detectedAtMs, sizeBytes, footageBaseUrl, suppressed }) {
  const size = formatBytes(sizeBytes);
  return [
    `Person detected on ${camId}`,
    `Time: ${formatTime(detectedAtMs)}`,
    typeof confidence === 'number' ? `Confidence: ${Math.round(confidence * 100)}%` : null,
    `Clip: ${filename}${size ? ` (${size})` : ''}`,
    footageBaseUrl ? `Watch: ${footageUrl(footageBaseUrl, camId, filename)}` : null,
    suppressed > 0 ? `(${suppressed} more detection${suppressed === 1 ? '' : 's'} on this camera were not announced)` : null,
  ].filter(Boolean).join('\n');
}

// deps: notifier (MultiNotifier-like: isEmpty(), send()), config (resolveNoticeConfig's answer),
//   throttle (lib/throttle.js, window = config.cooldownMs), now() -> ms,
//   files { readThumbnail(clipPath) -> Buffer, sizeOf(clipPath) -> bytes } (may throw), log(level, message, { sender })
function createDetectionNotifier({ notifier, config, throttle, now, files, log }) {
  const tolerate = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  // A message without its picture is better than none: a missing or unusable thumbnail is simply left out.
  function thumbnailOf(clipPath) {
    const image = tolerate(() => files.readThumbnail(clipPath), null);
    return isJpeg(image) && image.length <= MAX_IMAGE_BYTES ? image : null;
  }

  async function announce(job, outcome) {
    const { camId, clipPath } = job.payload;
    const t = config.cooldownMs > 0 ? throttle.check(`person:${camId}`, now()) : { allow: true, suppressed: 0 };
    if (!t.allow) return;
    const image = thumbnailOf(clipPath);
    const text = buildPersonText({
      camId,
      filename: clipPath.split(/[\\/]/).pop(),
      confidence: outcome.confidence,
      detectedAtMs: now(),
      sizeBytes: tolerate(() => files.sizeOf(clipPath), null),
      footageBaseUrl: config.footageBaseUrl,
      suppressed: t.suppressed,
    });
    const results = await notifier.send(image ? { text, image } : { text });
    for (const r of results.filter((x) => !x.ok)) log('WARN', `the person notification through ${r.name} failed: ${r.error}`, { sender: camId });
  }

  async function onScanFinished(job, outcome) {
    if (outcome.state !== 'person') return;
    if (!job.payload.notify) return;
    if (notifier.isEmpty()) return;
    try {
      await announce(job, outcome);
    } catch (e) {
      log('WARN', `the person notification could not be sent: ${e && e.message ? e.message : e}`, { sender: job.payload.camId });
    }
  }

  return { onScanFinished };
}

module.exports = {
  resolveNoticeConfig, footageUrl, formatBytes, formatTime, buildPersonText, createDetectionNotifier,
  DEFAULT_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS,
};
