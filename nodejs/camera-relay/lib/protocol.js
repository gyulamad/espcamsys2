'use strict';

// protocol.js — pure parsing for the camera push connection's wire
// protocol, extracted out of server.js's raw TCP `pushServer` socket
// handler:
//   1. one line:  "<cameraId>\t<apiKey>\n"          (auth, sent once)
//   2. repeated:  [4-byte big-endian length][that many bytes of payload]
//
// A payload is normally a JPEG frame, but the camera can also send small
// CONTROL MESSAGES down the same connection with the same framing (see
// classifyPayload()). Today the only ones are the alarm messages: the camera
// says "my alarm input fired" in-band, between two frames, instead of making
// a separate HTTP request. That matters because the HTTP request blocks the
// camera's loop for as long as it takes (seconds on weak Wi-Fi), during which
// it captures no frames; the in-band message is a 6-byte write that doesn't
// wait for anything, and because it travels in order with the frames, the
// relay knows exactly which frames came before the alarm.
//

// None of this touches an actual socket — every function takes a Buffer
// and returns a plain value, so the framing/parsing logic can be unit
// tested with hand-built buffers instead of a live TCP connection.

// Index of the '\n' (0x0a) terminating the one-time auth line, or -1 if
// the buffer doesn't contain a complete line yet.
function findAuthLineEnd(buf) {
  return buf.indexOf(0x0a);
}

// True once an un-terminated auth line has grown past any plausible real
// one — signals a malformed/oversized line the caller should drop the
// connection over instead of buffering it forever.
function isAuthLineTooLong(bufLength, maxLength = 256) {
  return bufLength > maxLength;
}

// Splits one raw auth line buffer (without the trailing newline) into
// { id, key }, trimming a trailing '\r' for CRLF-terminated lines. Returns
// null if it doesn't parse into both an id and a key.
function parseAuthLine(lineBuf) {
  const line = lineBuf.toString('utf8').replace(/\r$/, '');
  const [id, key] = line.split('\t');
  if (!id || key === undefined) return null;
  return { id, key };
}

// True if a frame's declared length is within the sanity cap (matches the
// 2MB HTTP /upload limit with headroom) rather than being 0 or absurdly
// large — the same guard that made the inline loop destroy() the socket.
function isFrameLengthValid(len, maxLen = 5 * 1024 * 1024) {
  return len > 0 && len <= maxLen;
}

// Drains as many complete [4-byte length][payload] messages as are fully
// buffered in `buf`. Returns the extracted payloads (named `frames` for
// historical reasons — most are JPEGs; run each through classifyPayload()
// to tell frames from control messages) in order, plus
// whatever's left over — a partial frame, a partial length prefix, or
// nothing. Throws if a length prefix fails isFrameLengthValid(); the
// caller should treat that the same as the inline check it replaces
// (destroy the connection).
function drainFrames(buf, maxFrameLen = 5 * 1024 * 1024) {
  const frames = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 4) break;
    const len = rest.readUInt32BE(0);
    if (!isFrameLengthValid(len, maxFrameLen)) {
      const err = new Error(`invalid frame length: ${len}`);
      err.code = 'INVALID_FRAME_LENGTH';
      throw err;
    }
    if (rest.length < 4 + len) break; // frame not fully arrived yet
    frames.push(rest.slice(4, 4 + len));
    rest = rest.slice(4 + len);
  }
  return { frames, rest };
}

// ── In-band control messages ─────────────────────────────────────────
// A payload is a control message iff its first byte is CONTROL_MARKER (0x00).
// A JPEG always starts 0xFF 0xD8, so the two can never be confused, and
// frames from existing firmware (which never starts with 0x00) are unaffected.
//   control payload layout: [0x00][type][... reserved for future use]
const CONTROL_MARKER = 0x00;
const MSG_ALARM = 0x01;     // "start/extend a recording on THIS camera"
const MSG_ALARM_ALL = 0x02; // "start/extend a recording on EVERY camera"

// What a drained payload is:
//   { kind: 'frame' }                  — a JPEG (or anything else not marked as control)
//   { kind: 'alarm', all: boolean }    — the camera's alarm input fired
//   { kind: 'unknown' }                — a control message of a type this relay doesn't
//                                        know; the caller should ignore it (so newer
//                                        firmware can add message types without
//                                        breaking an older relay's stream)
function classifyPayload(payload) {
  if (payload.length === 0 || payload[0] !== CONTROL_MARKER) return { kind: 'frame' };
  switch (payload[1]) {
    case MSG_ALARM: return { kind: 'alarm', all: false };
    case MSG_ALARM_ALL: return { kind: 'alarm', all: true };
    default: return { kind: 'unknown' };
  }
}

// The complete 6 bytes a camera writes for an alarm: 4-byte length prefix
// (always 2) + [CONTROL_MARKER][type]. The firmware builds the same bytes in
// logic.h's encodeAlarmMessage(); this copy exists so tests (and any other
// client) can produce them without the firmware.
function encodeAlarmMessage(all) {
  const msg = Buffer.alloc(6);
  msg.writeUInt32BE(2, 0);
  msg[4] = CONTROL_MARKER;
  msg[5] = all ? MSG_ALARM_ALL : MSG_ALARM;
  return msg;
}

// LEGACY: the single raw byte once written down the push socket to
// pause/resume a camera (0x00 = pause, 0x01 = resume). Pausing no longer
// exists — cameras stream continuously so the relay can keep a pre-roll
// buffer — and the relay now only ever sends 0x01, once per connect, so an
// old-firmware board that was paused at upgrade time gets un-stuck.
function encodeControlByte(enabled) {
  return Buffer.from([enabled ? 1 : 0]);
}

// ── Capability handshake (relay -> camera, right after authentication) ──
// A camera must NEVER send an in-band alarm to a relay that doesn't
// understand it: an old relay would take the 6 bytes for a video frame, show
// it as a corrupt frame on the stream (a black screen) and lose the alarm.
// So the relay announces what it supports, and the firmware only uses the
// in-band alarm once it has seen the announcement on the CURRENT connection
// (otherwise it falls back to the HTTP alarm, which every relay version has).
//
// Everything the relay writes to a camera is a single raw byte, which the
// firmware reads between frames. Values the firmware doesn't know are
// ignored, so this is safe in both directions: old firmware ignores the new
// capability byte, and an old relay simply never sends it.
//   0x00 / 0x01  legacy pause / resume (see encodeControlByte)
//   0x02         "I understand in-band alarm control messages"
const RELAY_CAP_INBAND_ALARM = 0x02;

// Sent once per authenticated connection: the legacy "resume" byte (so an
// old-firmware camera that was paused at upgrade time un-sticks), then the
// capability byte.
function encodeRelayGreeting() {
  return Buffer.concat([encodeControlByte(true), Buffer.from([RELAY_CAP_INBAND_ALARM])]);
}

module.exports = {
  findAuthLineEnd,
  isAuthLineTooLong,
  parseAuthLine,
  isFrameLengthValid,
  drainFrames,
  CONTROL_MARKER,
  MSG_ALARM,
  MSG_ALARM_ALL,
  classifyPayload,
  encodeAlarmMessage,
  encodeControlByte,
  RELAY_CAP_INBAND_ALARM,
  encodeRelayGreeting,
};
