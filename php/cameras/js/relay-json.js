'use strict';
// relay-json.js — asks one of the dashboard's own JSON pages (status.php, detector-status.php) for its
// answer. Shared by the two simple pages (window.CamRelayJson) and by tests/node/test_relay_json.js
// (require()); fetch is looked up at call time, so a test can put its own in place.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamRelayJson = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The answer as a plain object, or null: the relay is out of reach, the page answered with an error
  // status, or the body is not a { ... } object (a list, an { error }). The caller treats null as
  // "not known this round" and asks again at its next poll.
  async function get(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === 'object' && !Array.isArray(data) && !data.error ? data : null;
    } catch (e) {
      return null;
    }
  }

  return { get };
});
