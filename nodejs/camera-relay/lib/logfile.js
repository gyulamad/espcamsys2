'use strict';

// logfile.js — how a log entry is written into the plain-text log file, and
// how the log settings from config.js are interpreted.
//
// The format is meant to be read by a person with `less` / `grep` / `tail -f`:
//
//   2026-10-03T12:00:01.234Z ERROR cam2@192.168.4.20 up=3621.4s heap=84312 rssi=-71 seq=42 late=300.2s fw="Oct  3 2026": Frame capture failed
//       at ESP32_CAM_Recorder.ino:405 loop()
//       recent events (oldest first):
//         -12.3s INFO push connection established
//
// - ONE header line per entry, always starting with the timestamp, so
//   `grep ' ERROR '` and `grep cam2` find whole entries.
// - Everything else belonging to the entry (extra message lines, the trace)
//   is on continuation lines that ALWAYS start with four spaces. Whatever a
//   message contains — even a newline followed by something that looks like a
//   header — it can never produce a line that starts like a new entry.
// - `late=` appears only when the entry reached the relay well after it
//   happened (it sat in the camera's memory while the relay was unreachable);
//   the timestamp is then when it HAPPENED, not when it arrived.
//
// Pure (no fs, no clock): the caller supplies the time.

const path = require('path');

const DEFAULTS = {
  maxBytes: 5 * 1024 * 1024, // per file
  keep: 2,                   // rotated files kept besides the current one
  minBytes: 64 * 1024,
  maxKeep: 20,
};
const LATE_THRESHOLD_MS = 2000;

// Identity parts end up in the header line, so keep them to harmless characters.
function safeToken(value) {
  return String(value).replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 80);
}

function formatEntry(e) {
  const level = String(e.level || 'INFO').toUpperCase().padEnd(5);
  let who = safeToken(e.sender || 'unknown');
  if (e.ip) who += '@' + safeToken(e.ip);
  if (e.via) who += ` [${safeToken(e.via)}]`;

  const x = e.extras || {};
  const parts = [];
  if (Number.isInteger(x.uptimeMs)) parts.push(`up=${(x.uptimeMs / 1000).toFixed(1)}s`);
  if (Number.isInteger(x.heap)) parts.push(`heap=${x.heap}`);
  if (Number.isInteger(x.rssi)) parts.push(`rssi=${x.rssi}`);
  if (Number.isInteger(x.seq)) parts.push(`seq=${x.seq}`);
  if (Number.isInteger(x.attempt) && x.attempt > 0) parts.push(`attempt=${x.attempt + 1}`);
  if (Number.isInteger(x.lateMs) && x.lateMs >= LATE_THRESHOLD_MS) parts.push(`late=${(x.lateMs / 1000).toFixed(1)}s`);
  if (x.fw) parts.push(`fw=${JSON.stringify(String(x.fw))}`);

  const messageLines = String(e.message == null ? '' : e.message).replace(/\r\n?/g, '\n').split('\n');
  const header = `${e.time.toISOString()} ${level} ${who}${parts.length ? ' ' + parts.join(' ') : ''}: ${messageLines[0]}`;

  const lines = [header];
  for (const l of messageLines.slice(1)) lines.push(`    | ${l}`);
  if (e.trace) {
    for (const l of String(e.trace).replace(/\r\n?/g, '\n').split('\n')) {
      if (l.trim() !== '') lines.push(`    ${l}`);
    }
  }
  return lines.join('\n') + '\n';
}

// When an entry reached the relay at `receivedAtMs` but happened `ageMs`
// earlier on the camera, this is when it happened.
function eventTime(receivedAtMs, ageMs) {
  return new Date(receivedAtMs - (Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0));
}

// Reads the log settings (from config.js, or the LOG_* env overrides — which
// arrive as strings) into { file, maxBytes, keep, warnings }. Missing values
// use the defaults silently; present-but-unusable ones fall back WITH a
// warning, so a typo can't quietly disable logging or let it fill the SD card.
// A relative `file` is relative to `baseDir` (the relay's folder).
function resolveLogConfig({ file, maxBytes, keep } = {}, baseDir = '.') {
  const warnings = [];
  const given = (v) => v !== undefined && v !== null && v !== '';

  let outFile = path.join(baseDir, 'logs', 'camera.log');
  if (given(file)) {
    if (typeof file === 'string' && file.trim() !== '') outFile = path.resolve(baseDir, file.trim());
    else warnings.push(`logFile=${JSON.stringify(file)} is not a path; using ${outFile}`);
  }

  let outMax = DEFAULTS.maxBytes;
  if (given(maxBytes)) {
    const n = Number(maxBytes);
    if (Number.isFinite(n) && n >= DEFAULTS.minBytes) outMax = Math.floor(n);
    else warnings.push(`logMaxBytes=${JSON.stringify(maxBytes)} is not a number >= ${DEFAULTS.minBytes}; using ${DEFAULTS.maxBytes}`);
  }

  let outKeep = DEFAULTS.keep;
  if (given(keep)) {
    const n = Number(keep);
    if (Number.isInteger(n) && n >= 1 && n <= DEFAULTS.maxKeep) outKeep = n;
    else warnings.push(`logKeepFiles=${JSON.stringify(keep)} is not a whole number between 1 and ${DEFAULTS.maxKeep}; using ${DEFAULTS.keep}`);
  }

  return { file: outFile, maxBytes: outMax, keep: outKeep, warnings };
}

// The address of the other end of a connection as people write it: Node
// reports an IPv4 peer on a dual-stack socket as "::ffff:192.168.4.20".
function normalizeIp(addr) {
  if (typeof addr !== 'string' || addr === '') return null;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

module.exports = { DEFAULTS, LATE_THRESHOLD_MS, safeToken, formatEntry, eventTime, normalizeIp, resolveLogConfig };
