#!/usr/bin/env node
'use strict';
// test_logs_tail_e2e.js — end-to-end check of GET /logs/tail, the route behind the dashboard's OTA & LOGS page, against a REAL
// `server.js` process, real HTTP, and real log files on disk (the relay's own log, and a stand-in for Apache's error log).
//
//   - it needs the control key (none / wrong -> 401) and shows nothing then
//   - it returns the relay's own log and Apache's error log, the last N lines of each (?lines=), kept by level (?levels=),
//     where an Apache line counts at the level of its [module:level] tag
//   - a query it does not understand is a 400, never a guess; a path in the query is ignored (only the two configured
//     files are ever read)
//   - control characters in a line are replaced
//   - a file that is not there is reported for that file and the other one is still shown; APACHE_ERROR_LOG='' switches
//     Apache's log off
//   - reading is NOT logged (the page polls: each poll would add a line to the log it shows)
//
// Independent client (no require() of lib/ or server.js), own ports, throwaway files in a temp folder. Core modules only.
//
// Usage:  node tests/e2e/test_logs_tail_e2e.js
//         E2E_LOGSTAIL_PORT=19410 E2E_LOGSTAIL_PUSH_PORT=19411 node tests/e2e/test_logs_tail_e2e.js
// Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReporter, sleep, waitFor, httpRequest, startProcess, stopProcess } = require('./harness');

const RELAY_DIR = path.join(__dirname, '../../nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_LOGSTAIL_PORT || 19410);
const PUSH_PORT = Number(process.env.E2E_LOGSTAIL_PUSH_PORT || 19411);
const KEY = 'e2e-logstail-key';
const CONTROL_KEY = 'e2e-logstail-control-key';

const t = createReporter();
const { check } = t;

// A real relay on its own ports; `env` names the files (SETTINGS_FILE, LOG_FILE, APACHE_ERROR_LOG).
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
  }
  return startProcess({
    command: 'node',
    args: ['server.js'],
    cwd: RELAY_DIR,
    env: Object.assign({ PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, CONTROL_KEY, SWITCH_FILE: path.join(os.tmpdir(), `e2e-logstail-switch-${process.pid}.json`) }, env),
    ready: (out) => out.includes(`raw push) listening on :${PUSH_PORT}`),
  });
}

const get = (urlPath, { headers = {} } = {}) => httpRequest({ port: PORT, path: urlPath, headers: Object.assign({ 'X-Control-Key': CONTROL_KEY }, headers) });

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const headerLines = (text) => text.split('\n').filter((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(l));

// What Apache's error log looks like (module:level tags, no WARN / ERROR words), plus a line with an escape character.
const APACHE_LINES = [
  '[Tue Nov 17 10:00:01.000000 2026] [mpm_prefork:notice] [pid 1] AH00163: Apache configured -- resuming normal operations',
  '[Tue Nov 17 10:00:02.000000 2026] [core:warn] [pid 812] AH00045: child process still did not exit',
  '[Tue Nov 17 10:00:03.000000 2026] [php:error] [pid 812] [client 10.0.0.5:5000] PHP Fatal error:  Uncaught Error: boom',
  '[Tue Nov 17 10:00:04.000000 2026] [core:info] [pid 812] server is running',
  '[Tue Nov 17 10:00:05.000000 2026] [php:error] [pid 812] colour \u001b[31mred\u001b[0m escape',
];

async function main() {
  if (!fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'express'))) {
    check('relay dependencies are installed', false, `run "npm install" in ${RELAY_DIR} first`);
    t.finish();
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-logstail-'));
  const settingsFile = path.join(tmp, 'settings.json');
  const logFile = path.join(tmp, 'logs', 'camera.log');
  const apacheFile = path.join(tmp, 'apache-error.log');
  fs.writeFileSync(apacheFile, `${APACHE_LINES.join('\n')}\n`);
  let relay;
  try {
    // ── 1. both files, the key, the filters ─────────────────────────
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile, APACHE_ERROR_LOG: apacheFile });
    await waitFor(() => headerLines(readLog(logFile)).length > 0, 3000);

    let r = await get('/logs/tail', { headers: { 'X-Control-Key': '' } });
    check('no control key is refused (401)', r.status === 401, JSON.stringify(r.json));
    r = await get('/logs/tail', { headers: { 'X-Control-Key': 'wrong' } });
    check('a wrong control key is refused (401) and nothing of the logs is in the answer', r.status === 401 && !r.text.includes('PHP Fatal error'), r.text.slice(0, 200));

    r = await get('/logs/tail');
    check('with the key: 200, no-store, two sources — the relay\'s own log and Apache\'s',
      r.status === 200 && /no-store/.test(r.headers['cache-control'] || '') && r.json && r.json.sources.length === 2
      && r.json.sources[0].kind === 'relay' && r.json.sources[1].kind === 'apache', JSON.stringify(r.json).slice(0, 300));
    check('the answer says when and what was asked (1000 lines, no level filter)', r.json && typeof r.json.at === 'string' && r.json.lines === 1000 && r.json.levels === null);
    check('the relay source is the relay\'s log file, with its lines', r.json.sources[0].path === logFile && r.json.sources[0].ok === true && r.json.sources[0].lines.length > 0);
    check('the Apache source is the configured file, every line, oldest first', r.json.sources[1].path === apacheFile && r.json.sources[1].ok === true
      && r.json.sources[1].lines.length === 5 && r.json.sources[1].lines[0].includes('AH00163') && r.json.sources[1].lines[3].includes('server is running'));

    r = await get('/logs/tail?levels=WARN,ERROR');
    const apache = r.json.sources[1].lines;
    check('levels=WARN,ERROR: Apache\'s warn and error tags count, notice and info do not',
      apache.length === 3 && apache.some((l) => l.includes('[core:warn]')) && apache.filter((l) => l.includes('[php:error]')).length === 2
      && !apache.some((l) => l.includes('notice') || l.includes('[core:info]')), JSON.stringify(apache));
    r = await get('/logs/tail?levels=ERROR');
    check('levels=ERROR: only the errors', r.json.sources[1].lines.length === 2 && r.json.sources[1].lines.every((l) => l.includes('[php:error]')));
    r = await get('/logs/tail?levels=INFO');
    check('levels=INFO: notice and info lines', r.json.sources[1].lines.length === 2 && r.json.levels.join() === 'INFO');
    check('the relay\'s own INFO lines are found by their INFO word', r.json.sources[0].lines.length > 0 && r.json.sources[0].lines.every((l) => /\bINFO\b/.test(l)));
    r = await get('/logs/tail?levels=ALL');
    check('levels=ALL: no filter', r.json.levels === null && r.json.sources[1].lines.length === 5);
    r = await get('/logs/tail?levels=warn');
    check('levels are case-insensitive', r.status === 200 && r.json.levels.join() === 'WARN' && r.json.sources[1].lines.length === 1);

    // ── 2. the tail comes first, the filter second ──────────────────
    r = await get('/logs/tail?lines=2');
    check('lines=2: the last two lines of each file', r.json.lines === 2 && r.json.sources[1].lines.length === 2 && r.json.sources[1].lines[1].includes('colour') && r.json.sources[0].lines.length <= 2);
    r = await get('/logs/tail?lines=2&levels=WARN');
    check('lines=2&levels=WARN: the tail first, then the filter (the warning is not in the last two lines)', r.json.sources[1].lines.length === 0);

    // ── 3. what is not understood, what is cleaned ─────────────────
    for (const q of ['lines=0', 'lines=5001', 'lines=abc', 'lines=1&lines=2', 'levels=FATAL', 'levels=WARN;ERROR']) {
      r = await get(`/logs/tail?${q}`);
      check(`?${q}: a 400 that says why, nothing read`, r.status === 400 && r.json && typeof r.json.error === 'string' && !r.text.includes('PHP Fatal error'), `${r.status} ${r.text.slice(0, 120)}`);
    }
    r = await get(`/logs/tail?file=/etc/passwd&path=${encodeURIComponent(apacheFile)}x&source=/etc/shadow`);
    check('a path in the query is ignored: only the two configured files are read', r.status === 200 && r.json.sources.length === 2 && !r.text.includes('root:'));
    r = await get('/logs/tail');
    check('a control character in a line is replaced, not sent', !r.text.includes('\\u001b') && r.json.sources[1].lines[4].includes('colour ?[31mred?[0m escape'), r.json.sources[1].lines[4]);

    // ── 4. reading is not logged ────────────────────────────────────
    await sleep(500);
    const before = headerLines(readLog(logFile)).length;
    for (let i = 0; i < 5; i++) await get('/logs/tail?levels=WARN,ERROR');
    await sleep(500);
    check('five reads add no line to the relay\'s log', headerLines(readLog(logFile)).length === before, `${before} -> ${headerLines(readLog(logFile)).length}`);
    await stopProcess(relay);

    // ── 5. a file that is not there ─────────────────────────────────
    const missing = path.join(tmp, 'no-such-apache.log');
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile, APACHE_ERROR_LOG: missing });
    r = await get('/logs/tail');
    check('a missing Apache log is reported for that file; the relay\'s own log is still shown',
      r.status === 200 && r.json.sources[1].ok === false && r.json.sources[1].error === 'the file does not exist' && r.json.sources[1].path === missing
      && r.json.sources[0].ok === true, JSON.stringify(r.json).slice(0, 300));
    await stopProcess(relay);

    // ── 6. Apache's log switched off ────────────────────────────────
    relay = await startRelay({ SETTINGS_FILE: settingsFile, LOG_FILE: logFile, APACHE_ERROR_LOG: '' });
    r = await get('/logs/tail');
    check('APACHE_ERROR_LOG="" switches Apache\'s log off: only the relay\'s own log', r.status === 200 && r.json.sources.length === 1 && r.json.sources[0].kind === 'relay');
    await stopProcess(relay);
    relay = null;
  } catch (err) {
    t.crash(err);
  } finally {
    await stopProcess(relay);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  t.finish();
}

main();
