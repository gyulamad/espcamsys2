'use strict';
// mux-codec.js — reads the stream of mux.php in the browser. The format is written by the relay
// (nodejs/camera-relay/lib/muxcodec.js, which documents it); tests/node/test_muxcodec.js checks that the two
// agree. Pure: bytes in, messages out; no page, no network.
//
//   const parser = CamMuxCodec.createParser();
//   for (const message of parser.push(chunk)) ...   // { type, source, payload }, payload is a Uint8Array
//
// push() accepts chunks of any size (a picture usually arrives in several) and throws a CamMuxCodec.ProtocolError
// on bytes that are not this format. A message of a type this file does not know is still returned, so the
// caller skips it by its type: new kinds of message never break an older page.

(function (root) {
  const VERSION = 1;
  const TYPE_FRAME = 1;
  const TYPE_HEARTBEAT = 2;
  const CONTENT_TYPE = 'application/x-espcam-mux';

  const LENGTH_BYTES = 4;
  const FIXED_BODY_BYTES = 3;                  // version + type + source length
  const MAX_BODY_BYTES = FIXED_BODY_BYTES + 80 + 5 * 1024 * 1024;   // fixed part + longest source + largest picture

  class ProtocolError extends Error {}

  function concat(a, b) {
    if (a.length === 0) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // The message that starts `buffer` (a Uint8Array holding at least its length field and more).
  function readMessage(buffer, bodyLength) {
    const body = buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + bodyLength);
    if (body[0] !== VERSION) throw new ProtocolError('unknown version ' + body[0]);
    const sourceLength = body[2];
    if (FIXED_BODY_BYTES + sourceLength > bodyLength) throw new ProtocolError('source is longer than its message');
    return {
      type: body[1],
      source: new TextDecoder().decode(body.subarray(FIXED_BODY_BYTES, FIXED_BODY_BYTES + sourceLength)),
      payload: body.subarray(FIXED_BODY_BYTES + sourceLength),
    };
  }

  function createParser() {
    let pending = new Uint8Array(0);   // the start of a message that has not fully arrived yet

    return {
      push(chunk) {
        let buffer = concat(pending, chunk);
        const messages = [];
        while (buffer.length >= LENGTH_BYTES) {
          const bodyLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
          if (bodyLength < FIXED_BODY_BYTES || bodyLength > MAX_BODY_BYTES) throw new ProtocolError('bad message length ' + bodyLength);
          if (buffer.length < LENGTH_BYTES + bodyLength) break;
          messages.push(readMessage(buffer, bodyLength));
          buffer = buffer.subarray(LENGTH_BYTES + bodyLength);
        }
        pending = buffer.slice();      // a copy: it must not keep the whole last chunk alive
        return messages;
      },
    };
  }

  // The "kind:id" source of a picture message -> the camera's id, or null when it is not a camera's.
  function cameraIdOf(source) {
    return source.startsWith('cam:') ? source.slice('cam:'.length) : null;
  }

  const api = { VERSION, TYPE_FRAME, TYPE_HEARTBEAT, CONTENT_TYPE, ProtocolError, createParser, cameraIdOf };
  root.CamMuxCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
