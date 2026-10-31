'use strict';

// detectorlink.js — how a person detector (ESP32_CAM_TFLite_Person) talks to the relay, as pure
// functions (no sockets, no clock) so the wire protocol can be unit tested with hand-built buffers.
//
// WHY THIS LINK EXISTS. The dashboard shows each detector's 96x96 grayscale picture and the numbers
// behind its alarm line (brightness, motion, person score, thresholds, the alarm GPIO level). A
// detector is often behind a NAT router, so the relay can never connect to IT: the detector connects
// OUT and keeps ONE connection open, pushing its frames up it — the way the recorder cameras push
// theirs to the raw push port. Unlike the cameras it needs no extra port and no extra setting: it asks
// the relay's ordinary HTTP port to switch the connection over (an HTTP Upgrade, the mechanism
// WebSockets use). A side benefit that matters when something is wrong: every refusal is an ordinary
// HTTP answer (401 wrong key, 400 bad id, ...) that the board can print and send to the log.
//
//   detector -> relay   GET /detector/<DETECTOR_ID>/uplink HTTP/1.1
//                       Connection: Upgrade
//                       Upgrade: espcam-detector/1
//                       X-Api-Key: <camKey>
//   relay -> detector   HTTP/1.1 101 Switching Protocols          accepted: the connection is now a raw byte stream
//                       HTTP/1.1 401 ... {"error":"..."}          refused (then closed): the JSON says why
//   then, detector -> relay only, repeated:   [4-byte big-endian length][message]
//     message = [type: 1][N: 2-byte big-endian][N bytes of JSON status][JPEG bytes — may be none]
//   The relay never writes anything after the 101, so the board has nothing to read or to wait for.
//
// A message with a type this relay does not know is ignored (newer firmware may add some); a message
// of the known type whose content is unusable is reported, never trusted.
//
// The length prefix is the same framing the cameras use (see protocol.js drainFrames()).

const PROTOCOL = 'espcam-detector/1';
const MSG_FRAME = 1;

// /detector/<id>/uplink — the id follows the same rule as a camera id (logentry.CAMERA_ID_RE).
const PATH_RE = /^\/detector\/([A-Za-z0-9_.-]{1,64})\/uplink$/;

// A message is a few hundred bytes of JSON and a 96x96 JPEG (1-3 KB): anything near these is wrong.
const MAX_STATUS_BYTES = 2048;
const MAX_JPEG_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 3 + MAX_STATUS_BYTES + MAX_JPEG_BYTES;

// The detector id in an uplink request's address, or null if the address is not one.
function matchPath(url) {
  if (typeof url !== 'string') return null;
  const m = PATH_RE.exec(url.split('?')[0]);
  return m ? m[1] : null;
}

// Judges an upgrade request. `req` needs { url, headers } (a Node IncomingMessage will do);
// `keyOk(presented)` says whether the camera key was right (the caller supplies the constant-time
// comparison, so this stays free of secrets). The order is deliberate: nothing is revealed to a client
// that has not shown the key, beyond "that is not an address I serve".
// -> { ok: true, id } | { ok: false, status, error }
function checkUpgrade(req, keyOk) {
  const id = matchPath(req && req.url);
  if (id === null) return { ok: false, status: 404, error: 'not a detector uplink address (expected /detector/<DETECTOR_ID>/uplink; the id is 1-64 characters of A-Z a-z 0-9 _ . -)' };
  const headers = (req && req.headers) || {};
  const key = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : '';
  if (!keyOk(key)) return { ok: false, status: 401, error: key === '' ? 'missing key: send the camera key in the X-Api-Key header' : 'wrong key: API_KEY on the board must equal camKey in the relay\'s config.js' };
  const upgrade = typeof headers.upgrade === 'string' ? headers.upgrade.trim().toLowerCase() : '';
  if (upgrade !== PROTOCOL) return { ok: false, status: 426, error: `Upgrade: ${PROTOCOL} is required` };
  return { ok: true, id };
}

const REASONS = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' };

// The whole refusal, ready to write to the socket before closing it.
function refusalResponse(status, message) {
  const body = JSON.stringify({ error: message });
  const lines = [
    `HTTP/1.1 ${status} ${REASONS[status] || 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'Connection: close',
  ];
  if (status === 426) lines.push(`Upgrade: ${PROTOCOL}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

// The answer that switches the connection over.
function acceptResponse() {
  return `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${PROTOCOL}\r\n\r\n`;
}

// Builds one message (without the 4-byte length prefix). Used by the tests and by anything that wants
// to act as a detector; the firmware builds the same bytes in report_logic.h (buildFrameMessage()).
function encodeMessage(status, jpeg) {
  const json = Buffer.from(typeof status === 'string' ? status : JSON.stringify(status), 'utf8');
  const head = Buffer.alloc(3);
  head[0] = MSG_FRAME;
  head.writeUInt16BE(json.length, 1);
  return Buffer.concat([head, json, jpeg && jpeg.length ? jpeg : Buffer.alloc(0)]);
}

// The same, with the length prefix, as it travels on the wire.
function frameMessage(message) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(message.length, 0);
  return Buffer.concat([prefix, message]);
}

// Takes one message apart. The JSON is only PARSED here; whether its numbers make sense is
// detectorstate.parseStatus()'s job.
// -> { ok: true, kind: 'frame', status: <parsed JSON>, jpeg: Buffer|null }
//  | { ok: true, kind: 'unknown', type }          (ignore it)
//  | { ok: false, error }
function decodeMessage(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) return { ok: false, error: 'empty message' };
  if (payload[0] !== MSG_FRAME) return { ok: true, kind: 'unknown', type: payload[0] };
  if (payload.length < 3) return { ok: false, error: 'message too short for its header' };
  const statusLength = payload.readUInt16BE(1);
  if (statusLength === 0 || statusLength > MAX_STATUS_BYTES) return { ok: false, error: `status length ${statusLength} is out of range (1-${MAX_STATUS_BYTES})` };
  if (3 + statusLength > payload.length) return { ok: false, error: `status says ${statusLength} bytes but the message has only ${payload.length - 3}` };
  let status;
  try {
    status = JSON.parse(payload.slice(3, 3 + statusLength).toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'status is not valid JSON' };
  }
  const rest = payload.slice(3 + statusLength);
  if (rest.length === 0) return { ok: true, kind: 'frame', status, jpeg: null };
  if (rest.length > MAX_JPEG_BYTES) return { ok: false, error: `picture is ${rest.length} bytes (at most ${MAX_JPEG_BYTES})` };
  if (rest.length < 4 || rest[0] !== 0xff || rest[1] !== 0xd8) return { ok: false, error: 'picture is not a JPEG (does not start with FF D8)' };
  return { ok: true, kind: 'frame', status, jpeg: rest };
}

module.exports = {
  PROTOCOL, MSG_FRAME, PATH_RE, MAX_STATUS_BYTES, MAX_JPEG_BYTES, MAX_MESSAGE_BYTES,
  matchPath, checkUpgrade, refusalResponse, acceptResponse, encodeMessage, frameMessage, decodeMessage,
};
