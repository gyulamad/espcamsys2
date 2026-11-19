#!/usr/bin/env node
'use strict';
// test_dashboard_ota_logs_e2e.js — the dashboard's OTA & LOGS page (ota-logs.php) and the two JSON pages behind it
// (ota-status.php, logs-tail.php), on a REAL PHP server in front of a fake relay (core modules only: runs without the
// relay's npm packages).
//   * both JSON pages need the dashboard login, add the control key on the way to the relay and never send it to the browser
//   * ota-status.php turns the relay's text into rows; a line that is not seven columns is dropped
//   * logs-tail.php passes on only a lines/levels it has checked (nothing else from the browser, no path), and a bad
//     query never reaches the relay
//   * what the relay says is cut down to plain text of bounded size: control characters replaced, an unknown kind of
//     file dropped, a long line cut
//   * a relay that is down, that refuses the key or that sends nonsense is a clear error, not a blank page
//   * the page itself has the controls (OTA refresh, level boxes, tail length, log refresh) with their defaults, loads its
//     script, and is marked in the navigation bar, which every page has
// Own ports, throwaway dashboard copy. Needs `php` (skips if missing).
//   node tests/e2e/test_dashboard_ota_logs_e2e.js

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { createReporter, httpRequest, phpInstalled, makeDashboardCopy, startPhpServer, stopProcess } = require('./harness');

const DASH_SRC = path.join(__dirname, '../../php/cameras');
const BASE = Number(process.env.E2E_DOTALOGS_PORT || 19510);
const PHP_PORT = BASE;
const RELAY_PORT = BASE + 1;
const AUTH = { user: 'owner', pass: 'a-good-long-password' };
const KEY = 'a-long-secret-control-key-0123456789';

const t = createReporter();
const { check } = t;

// ── the fake relay ──
const OTA_TEXT = [
  'cam1\trecorder\tv2\tv2\tupdated\t4s\t-',
  'det1\tdetector\tv2\tv1\tpending\t12s\tdownload failed',
  'not\ta status line',
  'cam2\trecorder\t<b>v2</b>\tv\u001b[0m\tupdated\t1s\t-',
].join('\n') + '\n';
const LOGS_GOOD = { at: 'ignored', lines: 1000, levels: null, sources: [
  { kind: 'relay', path: '/home/pi/espcamsys2/nodejs/camera-relay/logs/camera.log', ok: true, lines: ['2026-11-17T10:00:01.000Z ERROR cam2: Frame capture failed'] },
  { kind: 'apache', path: '/var/log/apache2/error.log', ok: false, error: 'the relay is not allowed to read it (permission denied)' },
] };
const LOGS_HOSTILE = { sources: [
  { kind: 'relay', path: '/r/camera.log', ok: true, lines: ['ok line', 'esc \u001b[31mred', 'y'.repeat(2500), 7, null] },
  { kind: 'shadow', path: '/etc/shadow', ok: true, lines: ['root:x:0:0'] },
  { kind: 'apache', path: '/var/log/apache2/error.log', ok: false, error: 'denied\u001b[0m' },
] };
const relayState = { mode: 'good', seen: [] };
function relayHandler(req, res) {
  const key = req.headers['x-control-key'];
  relayState.seen.push({ url: req.url, key });
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (relayState.mode === 'refuse' || key !== KEY) return json(401, { error: 'missing or wrong control key' });
  if (req.url === '/ota/status') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(relayState.mode === 'garbage' ? '<html>not a status</html>' : OTA_TEXT); }
  if (req.url.startsWith('/logs/tail')) {
    if (relayState.mode === 'garbage') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('<html>nonsense</html>'); }
    return json(200, relayState.mode === 'hostile' ? LOGS_HOSTILE : LOGS_GOOD);
  }
  return json(404, { error: 'not found' });
}

// ── the dashboard ──
const CONFIG_PHP = `<?php return ['auth_user' => '${AUTH.user}', 'auth_pass' => '${AUTH.pass}', 'relay_url' => 'http://127.0.0.1:${RELAY_PORT}', 'relay_control_key' => '${KEY}', 'cameras' => [` +
  "['id' => 'camA', 'name' => 'A', 'icon' => 'x']]];\n";
let docroot, phpTmp;

// A request to the dashboard as its own page's script makes it (the same-origin marker), with or without the login.
function call(method, p, { auth = true, own = true } = {}) {
  const headers = { Host: `127.0.0.1:${PHP_PORT}` };
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
  if (own) Object.assign(headers, { 'X-Requested-With': 'camdash', Origin: `http://127.0.0.1:${PHP_PORT}`, 'Sec-Fetch-Site': 'same-origin' });
  return httpRequest({ port: PHP_PORT, method, path: '/' + p, headers, timeoutMs: 10000 });
}

async function main() {
  if (!phpInstalled()) { t.skip('php is not installed.'); return; }
  let php;
  let relay = nodeHttp.createServer(relayHandler);
  const askedRelay = () => relayState.seen.length;
  try {
    await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
    phpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dotalogs-tmp-'));
    docroot = makeDashboardCopy(DASH_SRC, CONFIG_PHP);
    php = await startPhpServer({ port: PHP_PORT, docroot, tmpDir: phpTmp });

    // ── the login ─────────────────────────────────────────────────
    let r = await call('GET', 'ota-status.php', { auth: false });
    check('ota-status.php needs the dashboard login', r.status !== 200 && !r.text.includes('cam1') && askedRelay() === 0, String(r.status));
    r = await call('GET', 'logs-tail.php', { auth: false });
    check('logs-tail.php needs the dashboard login', r.status !== 200 && !r.text.includes('camera.log') && askedRelay() === 0, String(r.status));

    // ── ota-status.php ────────────────────────────────────────────
    r = await call('GET', 'ota-status.php');
    check('ota-status.php: 200, JSON, never cached', r.status === 200 && /application\/json/.test(r.headers['content-type'] || '') && /no-store/.test(r.headers['cache-control'] || '') && r.json, r.text.slice(0, 200));
    check('... the relay was asked for /ota/status with the control key', relayState.seen.length === 1 && relayState.seen[0].url === '/ota/status' && relayState.seen[0].key === KEY, JSON.stringify(relayState.seen));
    check('... the control key is not in what the browser gets', !r.text.includes(KEY) && !JSON.stringify(r.headers).includes(KEY));
    check('... one row per board, the line that is not seven columns dropped',
      r.json.rows.length === 3 && r.json.rows[0].id === 'cam1' && r.json.rows[1].state === 'pending' && r.json.rows[1].error === 'download failed', JSON.stringify(r.json.rows));
    check('... markup stays text and a control character is replaced', r.json.rows[2].target === '<b>v2</b>' && r.json.rows[2].running === 'v?[0m', JSON.stringify(r.json.rows[2]));
    check('... and it says when', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(r.json.at), String(r.json.at));

    // ── logs-tail.php ─────────────────────────────────────────────
    relayState.seen = [];
    r = await call('GET', 'logs-tail.php');
    check('logs-tail.php: 200, the two files as the relay sent them, the relay asked for lines=1000 with the control key',
      r.status === 200 && r.json && r.json.sources.length === 2 && r.json.sources[0].ok === true && r.json.sources[1].ok === false
      && relayState.seen.length === 1 && relayState.seen[0].url === '/logs/tail?lines=1000' && relayState.seen[0].key === KEY, JSON.stringify({ r: r.text.slice(0, 200), seen: relayState.seen }));
    check('... the control key is not in what the browser gets', !r.text.includes(KEY));
    r = await call('GET', 'logs-tail.php?lines=50&levels=WARN,ERROR');
    check('logs-tail.php?lines=50&levels=WARN,ERROR: asked of the relay exactly so', relayState.seen[1].url === '/logs/tail?lines=50&levels=WARN,ERROR' && r.status === 200, relayState.seen[1].url);
    r = await call('GET', 'logs-tail.php?lines=5&file=/etc/passwd&path=/x');
    check('anything else in the query is not passed on', relayState.seen[2].url === '/logs/tail?lines=5', relayState.seen[2].url);

    relayState.seen = [];
    for (const q of ['lines=0', 'lines=5001', 'lines=abc', 'levels=FATAL', 'levels=warn', 'levels[]=WARN', 'lines[]=5', 'levels=WARN,']) {
      r = await call('GET', `logs-tail.php?${q}`);
      check(`logs-tail.php?${q}: a 400 that says why, as JSON`, r.status === 400 && /application\/json/.test(r.headers['content-type'] || '') && r.json && typeof r.json.error === 'string', `${r.status} ${r.text.slice(0, 120)}`);
    }
    check('... and none of those queries reached the relay', askedRelay() === 0, JSON.stringify(relayState.seen));

    // ── what the relay says is cut down ───────────────────────────
    relayState.mode = 'hostile';
    r = await call('GET', 'logs-tail.php');
    const lines = r.json && r.json.sources[0] ? r.json.sources[0].lines : [];
    check('a file of a kind that is not known is dropped', r.status === 200 && r.json.sources.map((x) => x.kind).join() === 'relay,apache' && !r.text.includes('root:x'), r.text.slice(0, 300));
    check('lines are plain text: a control character replaced, a long line cut, what is not text dropped',
      lines.length === 3 && lines[1] === 'esc ?[31mred' && lines[2] === 'y'.repeat(2000) + '…', JSON.stringify(lines).slice(0, 200));
    check('an error text is cleaned too', r.json.sources[1].error === 'denied?[0m', JSON.stringify(r.json.sources[1]));

    // ── a relay that does not answer well ─────────────────────────
    relayState.mode = 'refuse';
    r = await call('GET', 'logs-tail.php');
    check('a relay that refuses the key: its own status and words are passed on, so the page can say what to fix', r.status === 401 && r.json && r.json.error === 'missing or wrong control key', r.text.slice(0, 200));
    r = await call('GET', 'ota-status.php');
    check('... the same for ota-status.php', r.status === 401 && r.json && r.json.error === 'missing or wrong control key', r.text.slice(0, 200));
    relayState.mode = 'garbage';
    r = await call('GET', 'logs-tail.php');
    check('a log answer that is not JSON: 502, not a blank page', r.status === 502 && r.json && /does not understand/.test(r.json.error), r.text.slice(0, 200));
    r = await call('GET', 'ota-status.php');
    check('a status text that is not rows: no rows, no error', r.status === 200 && r.json && r.json.rows.length === 0, r.text.slice(0, 200));
    relayState.mode = 'good';

    // ── the page ──────────────────────────────────────────────────
    r = await call('GET', 'ota-logs.php');
    const html = r.text;
    check('ota-logs.php: 200 with the OTA STATUS and LOGS parts', r.status === 200 && /OTA STATUS/.test(html) && />LOGS</.test(html), String(r.status));
    check('... the refresh times default to 10 s, the tail length to 1000',
      /id="ota-refresh" value="10"/.test(html) && /id="log-refresh" value="10"/.test(html) && /id="log-lines" value="1000"/.test(html));
    check('... WARN and ERROR are ticked, DEBUG, INFO and All are not',
      /id="lvl-warn" checked/.test(html) && /id="lvl-error" checked/.test(html) && /id="lvl-debug">/.test(html) && /id="lvl-info">/.test(html) && /id="lvl-all">/.test(html));
    check('... it has the places the script fills and loads the script', ['ota-table', 'ota-updated', 'ota-error', 'log-out', 'log-updated', 'log-error'].every((id) => html.includes(`id="${id}"`)) && /src="js\/ota-logs\.js"/.test(html) && /src="js\/relay-json\.js"/.test(html));
    check('... it is marked in the navigation bar', html.includes('data-nav="ota-logs" data-page-load aria-current="page"') && /OTA &amp; LOGS<\/a>/.test(html));
    check('... the control key is nowhere in it', !html.includes(KEY));
    r = await call('GET', 'js/ota-logs.js');
    check('the script is served', r.status === 200 && /CamOtaLogs/.test(r.text), String(r.status));
    r = await call('GET', 'index.php');
    check('the dashboard\'s navigation bar has the OTA & LOGS button', r.status === 200 && r.text.includes('data-nav="ota-logs"') && r.text.includes('href="ota-logs.php"'), String(r.status));

    // ── the relay is down ─────────────────────────────────────────
    await new Promise((resolve) => relay.close(resolve));
    relay = null;
    r = await call('GET', 'ota-status.php');
    check('a relay that is down: ota-status.php says so (502)', r.status === 502 && r.json && /Could not reach relay/.test(r.json.error), r.text.slice(0, 200));
    r = await call('GET', 'logs-tail.php');
    check('... and logs-tail.php too', r.status === 502 && r.json && /Could not reach relay/.test(r.json.error), r.text.slice(0, 200));
  } catch (err) {
    t.crash(err);
  } finally {
    await stopProcess(php);
    if (relay) await new Promise((resolve) => relay.close(resolve));
    if (docroot) fs.rmSync(docroot, { recursive: true, force: true });
    if (phpTmp) fs.rmSync(phpTmp, { recursive: true, force: true });
  }
}

main().then(() => t.finish()).catch((err) => { t.crash(err); t.finish(); });
