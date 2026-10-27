#!/usr/bin/env node
'use strict';
// test_relay_redirect_e2e.js — F-08: the control key (and X-Actor) must only ever go to the relay.
// A REAL PHP dashboard in front of a hostile "relay" that answers EVERY request with a redirect to a
// second server (the "thief"). Checks that:
//   - no dashboard page follows the redirect: the thief never receives a single request, not even with
//     the control key — for the status, recordings, record, delete, switch, settings, live-stream and
//     detector-stream calls, and the video player
//   - the dashboard answers 502 instead of passing the redirect's body on
//   - the hostile relay DID get the key on the calls that carry it (so the test really sent it)
//   - the SETTINGS page refuses a new relay_url that is public, link-local (cloud metadata), a public name or a
//     disguised address, and does not save it
//   - a new relay_url must really answer like a relay: a web server that just answers 200 (a router
//     page), a closed port and a redirecting server are refused with the SAME message (no port-scan
//     oracle), and the probe itself carries no control key
//   - a genuine relay on the local network is accepted and saved
// Needs `php` on PATH (skips if missing). Own ports, throwaway dashboard copy, core modules only.
//
// Usage:  node tests/e2e/test_relay_redirect_e2e.js
// Exit code: 0 if every check passed (or php is missing), 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_REDIRECT_PORT || 19380);
const PHP_PORT = BASE;
const HOSTILE_PORT = BASE + 1;   // answers everything with a redirect
const THIEF_PORT = BASE + 2;     // where the redirect points
const HTML_PORT = BASE + 3;      // a web server that is not a relay (answers 200 HTML)
const REAL_PORT = BASE + 4;      // a genuine-looking relay
const DEAD_PORT = BASE + 5;      // nothing listens
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';
const FILE = 'cam-a-20260101-000000.mp4';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = { hostile: [], thief: [], html: [], real: [] };
function listen(port, name, handler) {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => { log[name].push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res); });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

let docroot;
let phpLog = '';
const cfgFile = () => path.join(docroot, 'config.php');
function makeDashboard() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-redirect-')));
  spawnSync('cp', ['-r', DASH_SRC + '/.', dir]);
  fs.rmSync(path.join(dir, 'config.php'), { force: true });
  fs.writeFileSync(path.join(dir, 'config.php'),
    `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${HOSTILE_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [['id' => 'cam-a', 'name' => 'A', 'icon' => '📷', 'detector' => 'det-a']]];\n`);
  return dir;
}
function startPhp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
    child.stdout.on('data', (d) => { phpLog += d; });
    child.stderr.on('data', (d) => { phpLog += d; });
    child.on('exit', (code) => reject(new Error(`php -S exited early (code ${code})`)));
    const started = Date.now();
    (async () => {
      while (Date.now() - started < 5000) {
        const ok = await new Promise((r) => { const q = nodeHttp.get(`http://127.0.0.1:${PHP_PORT}/`, () => r(true)); q.on('error', () => r(false)); });
        if (ok) return resolve(child);
        await sleep(100);
      }
      child.kill('SIGKILL');
      reject(new Error('php -S not ready in 5s'));
    })();
  });
}
function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 1500);
  });
}

// The dashboard's own page talking to PHP (header + same Origin), like a browser would.
function dash(method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64'),
      Host: `127.0.0.1:${PHP_PORT}`, 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin',
    };
    if (method !== 'GET') headers['Content-Length'] = payload ? Buffer.byteLength(payload) : 0;
    if (payload) headers['Content-Type'] = 'application/json';
    const req = nodeHttp.request(`http://127.0.0.1:${PHP_PORT}/${pathAndQuery}`, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, text: data, headers: res.headers }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}
const setRelay = (port) => dash('POST', 'system-settings.php', { values: { relay_url: `http://127.0.0.1:${port}` } });

async function main() {
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status !== 0) {
    console.log('SKIP: php is not installed — cannot run the dashboard.');
    finished = true;
    return;
  }
  const servers = [];
  let php;
  try {
    servers.push(await listen(HOSTILE_PORT, 'hostile', (req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${THIEF_PORT}/stolen${req.url}`, 'Content-Type': 'text/plain' }); res.end('moved'); }));
    servers.push(await listen(THIEF_PORT, 'thief', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"leaked":true}'); }));
    servers.push(await listen(HTML_PORT, 'html', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>router login page</html>'); }));
    servers.push(await listen(REAL_PORT, 'real', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }));
    docroot = makeDashboard();
    php = await startPhp(docroot);

    // ── a redirecting relay is never followed, by any call ──
    const calls = [
      ['status.php', 'GET', 'status.php'],
      ['detector-status.php', 'GET', 'detector-status.php'],
      ['recordings.php (the list)', 'GET', 'recordings.php?cam=cam-a'],
      ['recordings.php (the video player)', 'GET', `recordings.php?cam=cam-a&play=${FILE}`],
      ['recordings.php (download)', 'GET', `recordings.php?cam=cam-a&download=${FILE}`],
      ['record.php (status)', 'GET', 'record.php?cam=cam-a'],
      ['record.php (start recording)', 'POST', 'record.php?cam=cam-a&seconds=60'],
      ['record.php (stop recording)', 'POST', 'record.php?cam=cam-a&stop=1'],
      ['recordings.php (delete one)', 'POST', `recordings.php?cam=cam-a&delete=${FILE}`],
      ['recordings.php (delete ALL)', 'POST', 'recordings.php?cam=cam-a&deleteAll=1'],
      ['recordings.php (mark seen)', 'POST', `recordings.php?cam=cam-a&seen=${FILE}`],
      ['system-settings.php (read)', 'GET', 'system-settings.php'],
      ['settings.php', 'GET', 'settings.php'],
      ['stream.php (live view)', 'GET', 'stream.php?cam=cam-a'],
      ['detector-stream.php', 'GET', 'detector-stream.php?cam=cam-a'],
    ];
    for (const [name, method, q] of calls) {
      const r = await dash(method, q);
      check(`${name}: the redirect is not passed on (no 3xx, nothing from the thief)`, r.status >= 400 && !/leaked|moved/.test(r.text) && !r.headers.location, `status=${r.status} ${r.text.slice(0, 120)}`);
    }
    const sw = await dash('POST', 'recording-switch.php?scope=camera&cam=cam-a&action=off');   // (the real parameter names: a wrong one is refused before the relay is even asked)
    check('recording-switch.php: the redirect is not followed either', sw.status >= 400 && !/leaked|moved/.test(sw.text), `status=${sw.status} ${sw.text.slice(0, 120)}`);
    await sleep(300);
    check('(control) the switch call really reached the hostile relay, with the key', log.hostile.some((x) => x.url.startsWith('/recording/camera/cam-a/off') && x.headers['x-control-key'] === KEY), JSON.stringify(log.hostile.slice(-3).map((x) => x.url)));
    check('the thief received NOTHING (no request at all, so no control key, no actor)', log.thief.length === 0, JSON.stringify(log.thief.slice(0, 2)));
    const withKey = log.hostile.filter((x) => x.headers['x-control-key'] === KEY);
    check('(control) the hostile relay itself did get the key on the calls that carry it', withKey.length >= 5, `with key: ${withKey.length} of ${log.hostile.length}`);
    check('(control) ...and was asked many times, so every call above really reached it', log.hostile.length >= calls.length - 2, String(log.hostile.length));
    check('a redirect is written to the PHP error log for the owner', /relay answered GET with a redirect, which is never followed/.test(phpLog), phpLog.slice(-300));

    // ── the SETTINGS page and relay_url ──
    const before = fs.readFileSync(cfgFile(), 'utf8');
    for (const url of ['http://8.8.8.8:80', 'http://169.254.169.254', 'http://evil.example.com:8080', 'http://2130706433:80', 'http://[::ffff:8.8.8.8]:80', 'https://relay.example.org']) {
      const r = await dash('POST', 'system-settings.php', { values: { relay_url: url } });
      check(`a new relay_url of ${url} is refused (400, local network only)`, r.status === 400 && /local network/.test((r.json || {}).error || ''), `status=${r.status} ${r.text.slice(0, 160)}`);
    }
    check('...and nothing was saved', fs.readFileSync(cfgFile(), 'utf8') === before);
    const hostileBefore = log.hostile.length;

    const html = await setRelay(HTML_PORT);
    const dead = await setRelay(DEAD_PORT);
    const redir = await setRelay(HOSTILE_PORT);   // the current address, unchanged: no probe
    const redirNew = await dash('POST', 'system-settings.php', { values: { relay_url: `http://localhost:${HOSTILE_PORT}` } });   // same relay, written differently: a change
    const strip = (r) => ((r.json || {}).error || '').replace(/http:\/\/[^ ]+/, '<url>');
    check('a web server that is not a relay (answers 200 HTML) is refused', html.status === 400 && /No relay answered/.test(strip(html)), `status=${html.status} ${html.text.slice(0, 160)}`);
    check('a closed port is refused', dead.status === 400 && /No relay answered/.test(strip(dead)), `status=${dead.status} ${dead.text.slice(0, 160)}`);
    check('a redirecting server is refused', redirNew.status === 400 && /No relay answered/.test(strip(redirNew)), `status=${redirNew.status} ${redirNew.text.slice(0, 160)}`);
    check('all three failures read the SAME (the page cannot be used to scan the network)', strip(html) === strip(dead) && strip(dead) === strip(redirNew), [strip(html), strip(dead), strip(redirNew)].join(' | '));
    check('the unchanged address is not probed or rewritten (nothing to do)', redir.status === 200 && /Nothing changed/.test((redir.json || {}).message || ''), `status=${redir.status} ${redir.text.slice(0, 160)}`);
    check('the thief still has nothing', log.thief.length === 0);
    check('the probes carried no control key', [...log.html, ...log.hostile.slice(hostileBefore)].every((x) => !x.headers['x-control-key']), JSON.stringify(log.html.slice(0, 1)));
    check('config.php is untouched after all the refusals', fs.readFileSync(cfgFile(), 'utf8') === before);

    const ok = await setRelay(REAL_PORT);
    check('a genuine relay on the local network is accepted (200)', ok.status === 200 && /Saved/.test((ok.json || {}).message || ''), `status=${ok.status} ${ok.text.slice(0, 200)}`);
    check('...and its address is saved in config.php', fs.readFileSync(cfgFile(), 'utf8').includes(`http://127.0.0.1:${REAL_PORT}`));
    check('...with the probe asking /status and sending no key', log.real.some((x) => x.url === '/status' && !x.headers['x-control-key']), JSON.stringify(log.real.slice(0, 2)));
  } catch (err) {
    check('the test ran without an unexpected error', false, String(err && err.stack || err));
  } finally {
    await stopProc(php);
    for (const s of servers) s.close();
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
  }
  summarize();
}
main();
