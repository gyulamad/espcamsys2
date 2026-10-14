'use strict';
// Firmware the relay hands to the cameras (server-driven OTA update).
//
// The central machine uploads one image per sketch type (PUT /ota/<type>); every
// board polls GET /ota/<type>/version, and when the version it runs differs from
// the published one it downloads /ota/<type>/firmware.bin, flashes it and reboots.
// "Different", not "newer": checking out an older commit and deploying it
// downgrades the fleet the same way.
//
// This file is only decisions and text formats — no Express, no files read or
// written here (the caller passes the bytes in) — so everything is unit-tested in
// tests/node/test_firmware.js. The HTTP side is in tests/e2e/test_ota_e2e.js.

const crypto = require('crypto');
const path = require('path');

const TYPES = ['recorder', 'detector'];

// Same rule as camera ids elsewhere in the relay.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A version is `git describe --always --dirty` (+ ".t<epoch>" for a dirty tree).
// No '+': it would need URL-encoding in the query string the boards send.
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// An ESP32 app image starts with this byte; anything else (an HTML error page, a
// truncated upload that lost its head, a .elf) must never be handed to a board.
const IMAGE_MAGIC = 0xE9;
const MIN_IMAGE_BYTES = 100 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // a min_spiffs slot is 1,966,080; nothing bigger can be flashed anyway

// A device not heard from for this long is "offline" in the status.
const OFFLINE_MS = 10 * 60 * 1000;

function isType(t) {
  return typeof t === 'string' && TYPES.includes(t);
}

function isId(s) {
  return typeof s === 'string' && ID_PATTERN.test(s);
}

function isVersion(s) {
  return typeof s === 'string' && VERSION_PATTERN.test(s);
}

// The version a board says it runs (?fw=) or an error token (?err=) is only used for
// the log and the status table: a malformed one is cleaned up, never an error — a
// board must not be refused its update check over a hint. -> '' if nothing is left.
function cleanToken(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, maxLen);
}

// Is `buf` something we may publish as a firmware image?  -> { ok: true } or { ok: false, error }
function checkImage(buf) {
  if (!Buffer.isBuffer(buf)) return { ok: false, error: 'the body must be the raw .bin file (send it with --data-binary)' };
  if (buf.length < MIN_IMAGE_BYTES) return { ok: false, error: `the image is too small (${buf.length} bytes, at least ${MIN_IMAGE_BYTES}) - truncated upload?` };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: `the image is too large (${buf.length} bytes, at most ${MAX_IMAGE_BYTES})` };
  if (buf[0] !== IMAGE_MAGIC) return { ok: false, error: 'this is not an ESP32 app image (it does not start with 0xE9) - upload the sketch .ino.bin, not the merged/bootloader file' };
  return { ok: true };
}

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// What is stored next to the image (<type>.json).
function makeMeta(version, buf, now) {
  return { version, md5: md5Hex(buf), size: buf.length, uploadedAt: new Date(now).toISOString() };
}

// Reads <type>.json back; null if it is missing or not what makeMeta wrote
// (a half-written or hand-edited file must read as "nothing published", not crash).
function parseMeta(text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return null; }
  if (!m || typeof m !== 'object') return null;
  if (!isVersion(m.version) || typeof m.md5 !== 'string' || !/^[0-9a-f]{32}$/.test(m.md5)) return null;
  if (!Number.isInteger(m.size) || m.size <= 0) return null;
  return { version: m.version, md5: m.md5, size: m.size, uploadedAt: typeof m.uploadedAt === 'string' ? m.uploadedAt : '' };
}

// The body of GET /ota/<type>/version: two lines the board splits on '\n'.
function versionReply(meta) {
  return `${meta.version}\n${meta.md5}\n`;
}

function binFile(dir, type) {
  return path.join(dir, `${type}.bin`);
}

function metaFile(dir, type) {
  return path.join(dir, `${type}.json`);
}

// Remembers (in memory) every device that polled and what it reported, and decides
// what is worth a log line. Quiet when nothing changed: a fleet polling every
// minute must not fill the log.
class DeviceTable {
  constructor() {
    this.devices = new Map(); // `${type}:${id}` -> { id, type, running, lastSeen, lastError }
  }

  // A poll: GET /ota/<type>/version?id=&fw=&err=
  //   -> [{ level, message }]   lines to log (usually none)
  report(type, id, running, err, nowMs) {
    const key = `${type}:${id}`;
    const prev = this.devices.get(key);
    const dev = prev || { id, type, running: '', lastSeen: 0, lastError: '' };
    const events = [];
    if (!prev) {
      events.push({ level: 'INFO', message: `${id} (${type}) is checking for firmware, it runs ${running || 'an unknown version'}` });
    } else if (running && prev.running !== running) {
      events.push({ level: 'INFO', message: `${id} now runs ${running} (was ${prev.running || 'unknown'})` });
    }
    if (err) {
      events.push({ level: 'WARN', message: `${id} firmware update failed: ${err}` });
      dev.lastError = err;
    }
    if (running) dev.running = running;
    dev.lastSeen = nowMs;
    this.devices.set(key, dev);
    // Bounded: ids are validated, but a misbehaving client must not grow this without limit.
    if (this.devices.size > 1000) this.devices.delete(this.devices.keys().next().value);
    return events;
  }

  // The text of GET /ota/status. `targets` is { recorder: meta|null, detector: meta|null }.
  // One tab-separated line per device:  id type target running state lastSeenAgo lastError
  // state: updated (runs the published version) | pending | offline (not heard from for 10 min)
  //        | nothing-published
  statusText(targets, nowMs) {
    const rows = [...this.devices.values()].sort((a, b) => (a.id + '\t' + a.type).localeCompare(b.id + '\t' + b.type));
    let text = '';
    for (const d of rows) {
      const t = targets[d.type];
      const target = t ? t.version : '-';
      const ago = Math.max(0, Math.round((nowMs - d.lastSeen) / 1000));
      let state;
      if (!t) state = 'nothing-published';
      else if (d.running === t.version) state = 'updated';
      else if (nowMs - d.lastSeen > OFFLINE_MS) state = 'offline';
      else state = 'pending';
      // A successful update clears the old error: the line must say what is true now.
      const lastError = state === 'updated' ? '' : d.lastError;
      text += [d.id, d.type, target, d.running || '-', state, `${ago}s`, lastError || '-'].join('\t') + '\n';
    }
    return text;
  }
}

module.exports = {
  TYPES, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES, OFFLINE_MS,
  isType, isId, isVersion, cleanToken, checkImage, md5Hex, makeMeta, parseMeta, versionReply,
  binFile, metaFile, DeviceTable,
};
