'use strict';

// discovery.js — how a camera finds the relay when the address it has stored (SERVER_HOST) stops
// working, e.g. because the router gave the Pi a new address. Pure apart from `crypto`: no sockets
// (server.js owns the UDP socket), so every rule here is unit tested with plain `node`.
//
// The protocol is two tiny UDP datagrams (the firmware's side is Arduino/*/relay_find_logic.h; the two
// must agree byte for byte):
//
//   camera -> relay   "ESPCAM1?" + <nonce>                       nonce: 16 lowercase hex characters,
//                                                                made up fresh by the camera
//   relay  -> camera  "ESPCAM1!" + <nonce> + ":" + <mac>         mac: HMAC-SHA256(camKey,
//                                                                "ESPCAM1!" + <nonce>) as 64 hex characters
//
// Why a keyed answer instead of "send the camKey to whoever answers": the camera sends its probe to
// many addresses (a sweep of its subnet, a broadcast), and most of them are not the relay. The probe
// carries no secret, and only a machine that knows camKey can answer it correctly, so
//   - the key is never sent to a printer, a NAS or a stranger on the network, and
//   - a machine that merely answers "yes, I'm the relay" is ignored by the camera.
// The fresh nonce means an answer recorded earlier is worthless. (This does not defend against someone who
// can already sit in the middle of your LAN: the cameras' HTTP is plain, as before.)

const crypto = require('crypto');

const PROBE_TAG = 'ESPCAM1?';
const REPLY_TAG = 'ESPCAM1!';
const NONCE_RE = /^[0-9a-f]{16}$/;
const PROBE_LENGTH = PROBE_TAG.length + 16;

const DEFAULT_PORT = 8082; // the firmware's RELAY_FIND_PORT; change both together

// The nonce of a valid probe, or null for anything else (any other datagram is silently ignored:
// the relay must not answer a port scanner, and an answer must never be bigger than a request
// by much — see buildReply).
function parseProbe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== PROBE_LENGTH) return null;
  const text = buf.toString('latin1');
  if (!text.startsWith(PROBE_TAG)) return null;
  const nonce = text.slice(PROBE_TAG.length);
  return NONCE_RE.test(nonce) ? nonce : null;
}

function macFor(key, nonce) {
  return crypto.createHmac('sha256', key).update(REPLY_TAG + nonce).digest('hex');
}

// The answer to a valid probe. Needs a non-empty key: an unset camKey must not turn into an answer
// anyone could compute (same rule as auth.safeEqual).
function buildReply(nonce, key) {
  if (typeof key !== 'string' || key === '' || !NONCE_RE.test(nonce)) return null;
  return Buffer.from(`${REPLY_TAG}${nonce}:${macFor(key, nonce)}`, 'latin1');
}

// What the camera does with an answer (the firmware does the same in C++; this is here so the tests
// and tools can check a relay's answer independently of the firmware).
function verifyReply(buf, nonce, key) {
  if (typeof key !== 'string' || key === '' || !Buffer.isBuffer(buf)) return false;
  const expected = buildReply(nonce, key);
  if (!expected || buf.length !== expected.length) return false;
  return crypto.timingSafeEqual(buf, expected);
}

// discoveryPort from config.js / DISCOVERY_PORT: a whole number 1..65535, or 0 to switch discovery
// off. Anything else falls back to the default, with a warning the caller shows.
function resolveDiscoveryPort(value) {
  if (value === undefined || value === null || value === '') return { port: DEFAULT_PORT, warnings: [] };
  // Only a number or digits (an environment variable is text): Number(true) is 1, which would
  // quietly become port 1.
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return { port: n, warnings: [] };
  return { port: DEFAULT_PORT, warnings: [`discoveryPort ${JSON.stringify(value)} is not a port number (0-65535) — using ${DEFAULT_PORT}`] };
}

module.exports = { PROBE_TAG, REPLY_TAG, DEFAULT_PORT, parseProbe, buildReply, verifyReply, macFor, resolveDiscoveryPort };
