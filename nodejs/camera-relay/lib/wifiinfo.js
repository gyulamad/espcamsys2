'use strict';

// wifiinfo.js — the Wi-Fi network a device is connected to and how strong the signal is, as the dashboard
// shows it next to each camera and detector.
//
// A device REPORTS it (a recorder as an in-band control message, a detector inside its status and on its
// live-view poll), so everything here is untrusted text from the network: it is checked before it is kept
// and shaped before it is handed on. Pure functions, no clock and no sockets, so they are unit tested
// (tests/node/test_wifiinfo.js).
//
//   reading  { ssid, rssi }        what a device sent, checked
//   wifi     { ssid, rssi, ageMs } what the dashboard reads (ageMs = how old the reading is)

// A Wi-Fi network name is at most 32 BYTES (IEEE 802.11).
const MAX_SSID_BYTES = 32;
// RSSI is in dBm and always negative; 0 is what a board reports when it is not connected, so it is no reading.
const MIN_RSSI = -127;
const MAX_RSSI = -1;
// A reading older than this is no longer "what the device is connected to" (a device reports every few seconds).
const STALE_MS = 2 * 60 * 1000;

// A network name that is safe to keep and to show: a non-empty string of at most 32 bytes without control
// characters (they would break log lines and could be used to forge them). Anything else -> null.
function cleanSsid(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_SSID_BYTES) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

// A signal strength in dBm: a whole number from MIN_RSSI to MAX_RSSI, else null.
function cleanRssi(value) {
  return Number.isInteger(value) && value >= MIN_RSSI && value <= MAX_RSSI ? value : null;
}

// The reading a device sent, or null when either half is unusable (a name without a signal, or the other way
// round, says nothing the dashboard can show truthfully).
function parseReading(ssid, rssi) {
  const cleanName = cleanSsid(ssid);
  const cleanStrength = cleanRssi(rssi);
  if (cleanName === null || cleanStrength === null) return null;
  return { ssid: cleanName, rssi: cleanStrength };
}

// Same, from a query string value (the detector's live-view poll sends ?ssid=...&rssi=-61): the rssi arrives
// as text and must be a plain integer, nothing else that Number() would accept ("0x10", "1e1", " 5").
function parseQueryReading(ssid, rssi) {
  if (typeof rssi !== 'string' || !/^-?\d{1,4}$/.test(rssi)) return null;
  return parseReading(ssid, Number(rssi));
}

// What the dashboard reads for a stored reading { ssid, rssi, at } (null when there is none, or it is stale).
function describe(stored, now) {
  if (!stored) return null;
  const ageMs = Math.max(0, now - stored.at);
  if (ageMs > STALE_MS) return null;
  return { ssid: stored.ssid, rssi: stored.rssi, ageMs };
}

// The reading to keep: `reading` stamped with the time it arrived, or what was kept before when there is none.
function remember(previous, reading, now) {
  return reading ? { ssid: reading.ssid, rssi: reading.rssi, at: now } : previous || null;
}

module.exports = { MAX_SSID_BYTES, MIN_RSSI, MAX_RSSI, STALE_MS, cleanSsid, cleanRssi, parseReading, parseQueryReading, describe, remember };
