'use strict';

// controlkey.js — the check in front of every relay route that a person or a tool (the dashboard, ota-deploy.sh)
// uses: the request must carry `X-Control-Key: <controlKey>`. One place for what each of those routes used to repeat:
//   - no controlKey in the relay's config: the route is refused (503), because a relay without a key must not let
//     anyone in — unless the route says failOpen (the reads, when the operator opted in with READ_KEY_REQUIRED=0)
//   - the key is checked by checkKey (which answers 429 itself while an address is locked out after wrong keys)
//   - a wrong or missing key is a 401 and a WARN line in the log, at most once a minute per throttle key
// The pieces that belong to server.js (the key check, the log, the throttles) are handed in, so this file has no
// dependencies and is tested on its own (tests/node/test_controlkey.js).

// createGuardFactory({ hasKey, checkKey, normalizeIp, log, suppressedNote }) -> guard(options) -> Express middleware.
//   hasKey()        whether a controlKey is configured (asked on every request)
//   checkKey(req, res, presentedKey) -> 'ok' | 'locked' | anything else (wrong); on 'locked' it has already answered
//   normalizeIp(remoteAddress), log(level, text), suppressedNote(count) -> text, as in server.js
// guard options:
//   disabled        the 503 message when it is not
//   failOpen        let the request through when it is not (default false: refuse)
//   throttle        a Throttle (lib/throttle.js): at most one log line a minute per throttleKey
//   throttleKey(ip) what the throttle counts by (default: the address)
//   subject(req, from)  who is refused, for the log: "REJECTED <subject>: missing or wrong control key"
//                       (default: "a GET /path from 192.168.4.9")
function createGuardFactory({ hasKey, checkKey, normalizeIp, log, suppressedNote }) {
  return function guard({
    disabled,
    failOpen = false,
    throttle,
    throttleKey = (ip) => ip || 'unknown',
    subject = (req, from) => `a ${req.method} ${req.path} from ${from}`,
  }) {
    return (req, res, next) => {
      if (!hasKey()) {
        if (failOpen) return next();
        return res.status(503).json({ error: disabled });
      }
      const keyState = checkKey(req, res, req.headers['x-control-key']);
      if (keyState === 'ok') return next();
      if (keyState === 'locked') return undefined;
      const ip = normalizeIp(req.socket.remoteAddress);
      const t = throttle.check(throttleKey(ip), Date.now());
      if (t.allow) log('WARN', `REJECTED ${subject(req, ip || 'unknown address')}: missing or wrong control key${suppressedNote(t.suppressed)}`);
      return res.status(401).json({ error: 'missing or wrong control key' });
    };
  };
}

module.exports = { createGuardFactory };
