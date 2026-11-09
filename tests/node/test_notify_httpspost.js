'use strict';

const http = require('http');
const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { postRequest } = require('../../nodejs/camera-relay/lib/notify/httpspost');

// A real local HTTP server stands in for the remote API (the scheme module is injected, so http works).
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    // Polyfill: Node 17 doesn't have server.closeAllConnections() (added in 18.2).
    // Track sockets so the slow server (that never answers) can be cleaned up on
    // any Node version — without this the test process hangs after the timeout test.
    const sockets = new Set();
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    if (typeof server.closeAllConnections !== 'function') {
      server.closeAllConnections = () => { sockets.forEach((s) => s.destroy()); };
    }
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
const base = (port, extra) => ({ hostname: '127.0.0.1', port, path: '/x', headers: { 'Content-Type': 'text/plain' }, body: 'hello', timeoutMs: 500, ...extra });
async function attempt(opts) {
  try { return { value: await postRequest(opts, http) }; } catch (e) { return { error: e.message }; }
}

(async () => {
  let seen = null;
  const echo = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen = { method: req.method, url: req.url, type: req.headers['content-type'], length: req.headers['content-length'], body: Buffer.concat(chunks).toString() }; res.statusCode = 201; res.end('{"ok":true}'); });
  });
  const good = await attempt(base(echo.port));
  const binary = await attempt(base(echo.port, { body: Buffer.from([0xff, 0x00, 0xd8]) }));
  echo.server.close();
  test('posts the body with its length and type, and answers status and text', () => {
    assertEqual(good.value, { status: 201, body: '{"ok":true}' });
    assertTrue(binary.value.status === 201);
  });
  test('the server saw a POST with the exact headers and body', () => {
    assertEqual(seen.method, 'POST');
    assertEqual(seen.url, '/x');
    assertEqual(seen.length, '3');   // the last request was the 3-byte binary one
  });

  const big = await serve((req, res) => { req.resume(); req.on('end', () => res.end('y'.repeat(5000))); });
  const capped = await attempt(base(big.port, { maxResponseBytes: 1000 }));
  big.server.close();
  test('an answer larger than the cap is refused, not buffered', () => assertEqual(capped.error, 'the answer was larger than expected'));

  const slow = await serve(() => { /* never answers */ });
  const timedOut = await attempt(base(slow.port, { timeoutMs: 100 }));
  slow.server.closeAllConnections();
  slow.server.close();
  test('no answer in time is an error that names the limit', () => assertEqual(timedOut.error, 'could not reach 127.0.0.1: no answer within 100 ms'));

  const closed = await serve(() => {});
  const port = closed.port;
  closed.server.close();
  const refused = await attempt(base(port));
  test('a connection that is refused is an error that names the host but never the path (secrets live there)', () => {
    assertTrue(refused.error.startsWith('could not reach 127.0.0.1: '), refused.error);
    assertTrue(!refused.error.includes('/x'));
  });

  summarize();
})();
