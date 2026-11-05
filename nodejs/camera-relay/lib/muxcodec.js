'use strict';

// muxcodec.js — the wire format of GET /mux, the ONE long-lived response that carries the pictures of
// every camera a dashboard tab shows (instead of one HTTP connection per camera: a browser allows only
// about 6 connections per address over HTTP/1.1, so a page with a few cameras starved every other request).
//
// One message (all numbers big-endian):
//
//   [length u32][version u8][type u8][source length u8][source (UTF-8)][payload]
//
//   length   the number of bytes that follow it (version .. payload), so a reader that does not know a
//            type can skip it and an unknown type never breaks the stream
//   version  VERSION; a reader refuses any other
//   type     TYPE_FRAME (payload = one JPEG), TYPE_STATE (payload = JSON: the newest value of something, e.g. the
//            detectors' readings) or TYPE_HEARTBEAT (nothing; proves the connection is alive)
//   source   who the message is about, namespaced by kind: "cam:cam1" (a camera's picture), "det:det1" (a detector's
//            picture), "state:detectors" (the readings of every detector). Empty for a heartbeat.
//
// Pure functions only (no sockets): the relay writes what these return, and the browser reads it with
// php/cameras/js/mux-codec.js, which has to agree with this file (tests/node/test_muxcodec.js checks that).

const VERSION = 1;
const TYPE_FRAME = 1;       // a "stream" message: when the viewer is too slow it may be dropped, newer ones follow
const TYPE_HEARTBEAT = 2;
const TYPE_STATE = 3;       // like a picture, only the newest matters: a viewer that is behind gets the latest, never the missed ones
const CONTENT_TYPE = 'application/x-espcam-mux';

const LENGTH_BYTES = 4;
const FIXED_BODY_BYTES = 3;                 // version + type + source length
const MAX_SOURCE_BYTES = 80;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;  // what the camera push connection accepts as one frame (protocol.isFrameLengthValid)

const CAMERA_KIND = 'cam';
const DETECTOR_KIND = 'det';
const STATE_DETECTORS = 'state:detectors';

function cameraSource(id) {
  return `${CAMERA_KIND}:${id}`;
}

function detectorSource(id) {
  return `${DETECTOR_KIND}:${id}`;
}

function encode(type, source, payload) {
  const name = Buffer.from(source, 'utf8');
  if (name.length > MAX_SOURCE_BYTES) throw new RangeError(`mux source is ${name.length} bytes (at most ${MAX_SOURCE_BYTES})`);
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RangeError(`mux payload is ${payload.length} bytes (at most ${MAX_PAYLOAD_BYTES})`);
  const head = Buffer.alloc(LENGTH_BYTES + FIXED_BODY_BYTES);
  head.writeUInt32BE(FIXED_BODY_BYTES + name.length + payload.length, 0);
  head.writeUInt8(VERSION, LENGTH_BYTES);
  head.writeUInt8(type, LENGTH_BYTES + 1);
  head.writeUInt8(name.length, LENGTH_BYTES + 2);
  return Buffer.concat([head, name, payload]);
}

function encodeFrame(source, jpeg) {
  return encode(TYPE_FRAME, source, jpeg);
}

function encodeState(source, json) {
  return encode(TYPE_STATE, source, json);
}

function encodeHeartbeat() {
  return encode(TYPE_HEARTBEAT, '', Buffer.alloc(0));
}

module.exports = {
  VERSION, TYPE_FRAME, TYPE_HEARTBEAT, TYPE_STATE, CONTENT_TYPE, STATE_DETECTORS,
  LENGTH_BYTES, FIXED_BODY_BYTES, MAX_SOURCE_BYTES, MAX_PAYLOAD_BYTES,
  cameraSource, detectorSource, encodeFrame, encodeState, encodeHeartbeat,
};
