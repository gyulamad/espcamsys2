'use strict';
// fake_detector.js — what the e2e tests use to play a person detector against a real relay:
// the uplink handshake (HTTP Upgrade), the length-prefixed messages and the heartbeat.
// Not a test itself (run_tests.sh runs the test_*.js files); core modules only.

const net = require('net');
const dl = require('../../nodejs/camera-relay/lib/detectorlink');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x11, 0x22, 0xff, 0xd9]);

// The readings a detector reports: the same shape the firmware builds (report_logic.h buildStatusJson()).
const status = (over = {}) => Object.assign({
  ip: '192.168.4.37', fw: 'e2e', uptimeMs: 5000, rssi: -55,
  gpio: { pin: 13, high: true },
  scene: { state: 'active', brightness: 130, motion: 900, darkBelow: 40, motionAtLeast: 300, holdS: 10 },
  person: { score: 0.81, detectAt: 0.6, clearAt: 0.5, detected: true },
  link: { frames: 1, jpegFails: 0, reconnects: 0, heap: 90000 },
}, over);

// One message as it travels on the wire: [length][type][status length][status JSON][JPEG].
const wire = (st, jpeg) => dl.frameMessage(dl.encodeMessage(st, jpeg));

// What a board does first: ask the relay's HTTP port for the uplink. Resolves
//   { status, headText, body?, socket }  once the answer's head is in: a 101 leaves the socket open for
// the stream, anything else the relay closes. `key: null` sends no key; `upgrade: null` no Upgrade headers.
function uplink(port, id, { key = 'k', upgrade = dl.PROTOCOL, path: urlPath } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let answered = false;
    s.on('connect', () => {
      const h = [`GET ${urlPath || `/detector/${id}/uplink`} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
      if (upgrade) h.push('Connection: Upgrade', `Upgrade: ${upgrade}`);
      if (key !== null) h.push(`X-Api-Key: ${key}`);
      s.write(`${h.join('\r\n')}\r\n\r\n`);
    });
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (answered || end < 0) return;
      answered = true;
      const headText = buf.slice(0, end).toString('latin1');
      const st = Number(/^HTTP\/1\.1 (\d+)/.exec(headText)[1]);
      if (st === 101) { resolve({ status: st, headText, socket: s }); return; }
      const wait = () => { // a refusal: the body follows (Content-Length), then the relay closes
        const m = /Content-Length: (\d+)/i.exec(headText);
        const have = buf.slice(end + 4);
        if (m && have.length >= Number(m[1])) resolve({ status: st, headText, body: have.toString('utf8'), socket: s });
        else setTimeout(wait, 20);
      };
      wait();
    });
    s.on('error', (e) => { if (!answered) reject(e); });
    s.on('close', () => { if (!answered) resolve({ status: 0, closedWithoutAnswer: true, socket: s }); });
  });
}

// A real detector sends something at least once a second (a status-only message when there is no new
// frame), which keeps the relay's idle timeout from dropping it. Returns a function that stops it.
function heartbeat(sock, make, everyMs = 400) {
  const t = setInterval(() => { if (!sock.destroyed) sock.write(wire(make(), null)); }, everyMs);
  return () => clearInterval(t);
}

module.exports = { JPEG, JPEG2, status, wire, uplink, heartbeat, net };
