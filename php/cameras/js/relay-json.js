'use strict';
// relay-json.js — asks one of the dashboard's own JSON pages (status.php, detector-status.php, ota-status.php, ...) for
// its answer. Shared by the simple pages and the OTA & LOGS page (window.CamRelayJson) and by tests/node/test_relay_json.js
// (require()); fetch is looked up at call time, so a test can put its own in place.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamRelayJson = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The answer as { data } — a plain object — or { error } with the words to show: the page's own { "error": ... } when
  // it sent one (the relay's refusal, "Could not reach relay"), otherwise what went wrong. Not an answer: the page is out
  // of reach, it answered with an error status, or the body is not a { ... } object (a list, an { error }).
  async function request(url) {
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      return { error: 'the dashboard could not be reached' };
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* not JSON */
    }
    const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
    if (res.ok && isObject && !body.error) return { data: body };
    if (isObject && typeof body.error === 'string' && body.error !== '') return { error: body.error };
    return { error: res.ok ? 'the answer was not what was expected' : `the dashboard answered HTTP ${res.status}` };
  }

  // The answer as a plain object, or null whenever request() has none. The caller treats null as "not known this round"
  // and asks again at its next poll.
  async function get(url) {
    const answer = await request(url);
    return answer.data || null;
  }

  return { get, request };
});
