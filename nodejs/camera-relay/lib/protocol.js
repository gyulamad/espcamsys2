'use strict';

// protocol.js — pure parsing for the camera push connection's wire
// protocol, extracted out of server.js's raw TCP `pushServer` socket
// handler:
//   1. one line:  "<cameraId>\t<apiKey>\n"          (auth, sent once)
//   2. repeated:  [4-byte big-endian length][that many bytes of JPEG]
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

// Drains as many complete [4-byte length][payload] frames as are fully
// buffered in `buf`. Returns the extracted frames (in order) plus
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

// The single raw byte written down the push socket to pause/resume a
// camera: 0x00 = pause, 0x01 = resume.
function encodeControlByte(enabled) {
  return Buffer.from([enabled ? 1 : 0]);
}

module.exports = {
  findAuthLineEnd,
  isAuthLineTooLong,
  parseAuthLine,
  isFrameLengthValid,
  drainFrames,
  encodeControlByte,
};
