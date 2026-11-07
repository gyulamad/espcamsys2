'use strict';

// httpspost.js — the one place the notification channels touch the network: a single POST that always ends
// as a result, with a timeout and a cap on how much of the answer is read (a hostile or broken server cannot
// hold the relay or fill its memory). The scheme module is injected (https by default) so the tests talk to a
// plain local http server.
//
//   postRequest({ hostname, port?, path, headers, body, timeoutMs, maxResponseBytes? }, lib?)
//     -> Promise<{ status, body }>   rejects with an Error (never with the request details: they hold secrets)

const https = require('https');

const DEFAULT_MAX_RESPONSE = 64 * 1024;

function postRequest({ hostname, port, path, headers = {}, body, timeoutMs, maxResponseBytes = DEFAULT_MAX_RESPONSE }, lib = https) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = lib.request({
      method: 'POST', hostname, port, path, timeout: timeoutMs,
      headers: { ...headers, 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          reject(new Error('the answer was larger than expected'));
          req.destroy();   // without an error: the promise is settled already, and an error here would go unhandled
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => {});   // a destroyed answer: the promise is settled by whoever destroyed it
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', (err) => reject(new Error(`could not reach ${hostname}: ${err.message}`)));
    req.end(payload);
  });
}

module.exports = { postRequest, DEFAULT_MAX_RESPONSE };
