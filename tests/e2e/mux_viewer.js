'use strict';
// mux_viewer.js — a GET /mux viewer for the end-to-end tests of the relay. Everything live now rides on that one
// connection, so every test that wants a picture or the detectors' readings reads it here. The bytes are decoded
// with the browser's OWN parser (php/cameras/js/mux-codec.js), so a test also proves that what the relay writes is
// what the page reads.
//
//   const v = await muxViewer.view(port, '?cams=cam-a&dets=det-a&status=1', { 'X-Control-Key': key });
//   v.status, v.headers          the answer's head
//   v.text                       the body of an answer that is NOT a mux stream (a 400 / 503 / 401 says why in JSON)
//   v.messages, v.times          the decoded messages and when each arrived (ms since the epoch)
//   v.pause() / v.resume()       stop / go on reading (a stalled link); v.close() ends the connection
//   muxViewer.framesOf(v, id) ...  the messages of one source, see the helpers below
// view() resolves as soon as the head has arrived, so a request the relay answers at once is seen at once.

const nodeHttp = require('http');
const decoder = require('../../php/cameras/js/mux-codec');

const CONTENT_TYPE = decoder.CONTENT_TYPE;

function view(port, query, headers = {}) {
  return new Promise((resolve, reject) => {
    const v = { status: 0, headers: {}, text: '', messages: [], times: [], pause: () => {}, resume: () => {}, close: () => {} };
    const parser = decoder.createParser();
    const req = nodeHttp.get({ host: '127.0.0.1', port, path: `/mux${query}`, headers }, (res) => {
      v.status = res.statusCode; v.headers = res.headers;
      const isMux = res.headers['content-type'] === CONTENT_TYPE;
      res.on('data', (c) => {
        if (!isMux) { v.text += c.toString('utf8'); return; }
        for (const m of parser.push(new Uint8Array(c))) { v.messages.push(m); v.times.push(Date.now()); }
      });
      v.pause = () => res.pause(); v.resume = () => res.resume(); v.close = () => req.destroy();
      resolve(v);
    });
    req.on('error', (e) => { if (!v.status) reject(e); });
  });
}

const framesFrom = (v, source) => v.messages.filter((m) => m.type === decoder.TYPE_FRAME && m.source === source);
const framesOf = (v, id) => framesFrom(v, `cam:${id}`);        // a camera's pictures
const detFrames = (v, id) => framesFrom(v, `det:${id}`);       // a detector's pictures
const statesOf = (v, source) => v.messages.filter((m) => m.type === decoder.TYPE_STATE && m.source === source);
const states = (v) => statesOf(v, decoder.STATE_DETECTORS);    // the readings of every detector
const cameraStates = (v) => statesOf(v, decoder.STATE_CAMERAS);   // the recording state of every camera
const readings = (m) => JSON.parse(Buffer.from(m.payload).toString('utf8'));
const sameBytes = (m, bytes) => Buffer.from(m.payload).equals(bytes);   // is this message's payload exactly `bytes` (the JPEG that was sent)?

module.exports = { view, framesOf, detFrames, states, cameraStates, readings, sameBytes, codec: decoder, CONTENT_TYPE };
