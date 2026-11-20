'use strict';

// logtail.js — the last lines of the relay's own log and of Apache's error log, for the dashboard's
// OTA & LOGS page (GET /logs/tail). It is the browser's version of
//
//   tail -n N camera.log /var/log/apache2/error.log | grep -E '\b(WARN|ERROR)\b'
//
// - the LAST N lines of each file are taken first, THEN filtered (as `tail | grep` does), so a
//   quiet log shows less than N lines, never lines from further back;
// - a line is kept if it holds a chosen level as a whole word (WARN, ERROR, ...), as the grep does. For
//   Apache's error log a line also counts at the level of its own [module:level] tag, because Apache
//   does not write the words WARN/ERROR: without that the grep would never find an Apache error;
// - only the two files named in the relay's configuration are ever read, never a path from a request;
// - what is returned is plain text lines, cleaned of control characters and cut to a sane length: the page
//   shows them as text and never as markup, and this makes it safe for a terminal too.
//
// Reads asynchronously (the relay serves cameras and must not wait for a disk) and only the end of a
// file (a window of at most MAX_WINDOW_BYTES), however big the file is.

const fs = require('fs');
const path = require('path');

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const DEFAULT_LINES = 1000;
const MAX_LINES = 5000;
const MAX_WINDOW_BYTES = 4 * 1024 * 1024; // how far back from the end of a file a read goes
const MAX_LINE_CHARS = 2000;              // longer lines are cut (an Apache line can hold a whole stack trace)
const MAX_SOURCE_CHARS = 1000000;         // what one file adds to an answer, newest lines kept
const DEFAULT_APACHE_LOG = '/var/log/apache2/error.log';

// ── the request ─────────────────────────────────────────────────────────

// parseLineCount(raw) — ?lines=: a whole number from 1 to MAX_LINES; absent or empty is DEFAULT_LINES.
function parseLineCount(raw) {
  if (raw === undefined || raw === '') return { ok: true, value: DEFAULT_LINES };
  if (typeof raw !== 'string' || !/^[0-9]{1,5}$/.test(raw)) return { ok: false, error: `lines must be a whole number from 1 to ${MAX_LINES}` };
  const value = Number(raw);
  if (value < 1 || value > MAX_LINES) return { ok: false, error: `lines must be a whole number from 1 to ${MAX_LINES}` };
  return { ok: true, value };
}

// parseLevels(raw) — ?levels=WARN,ERROR: the levels to keep, in the order DEBUG INFO WARN ERROR.
// Absent, empty or containing ALL means no filter (null).
function parseLevels(raw) {
  if (raw === undefined || raw === '') return { ok: true, levels: null };
  const bad = { ok: false, error: `levels must be a comma-separated list of ${LEVELS.join(', ')} or ALL` };
  if (typeof raw !== 'string') return bad;
  const names = raw.split(',').map((s) => s.trim().toUpperCase());
  if (names.some((n) => n !== 'ALL' && !LEVELS.includes(n))) return bad;
  if (names.includes('ALL')) return { ok: true, levels: null };
  return { ok: true, levels: LEVELS.filter((l) => names.includes(l)) };
}

// ── one line ────────────────────────────────────────────────────────────

const WORD = /\b(DEBUG|INFO|WARN|ERROR)\b/g;
const APACHE_TAG = /\[[A-Za-z_][A-Za-z0-9_]*:(emerg|alert|crit|error|warn|notice|info|debug|trace[1-8])\]/;
const APACHE_LEVEL = { emerg: 'ERROR', alert: 'ERROR', crit: 'ERROR', error: 'ERROR', warn: 'WARN', notice: 'INFO', info: 'INFO', debug: 'DEBUG' };

// levelsOfLine(line, kind) — the levels a line counts as: every level word it contains, and for an
// Apache line ('apache') the level of its [module:level] tag.
function levelsOfLine(line, kind) {
  const found = new Set();
  for (const m of line.matchAll(WORD)) found.add(m[1]);
  if (kind === 'apache') {
    const tag = APACHE_TAG.exec(line);
    if (tag) found.add(APACHE_LEVEL[tag[1]] || 'DEBUG'); // traceN has no entry: it is DEBUG
  }
  return found;
}

// matchesLevels(line, levels, kind) — levels null keeps every line.
function matchesLevels(line, levels, kind) {
  if (levels === null) return true;
  const have = levelsOfLine(line, kind);
  return levels.some((l) => have.has(l));
}

// cleanLine(line) — what is sent to the browser: control characters (an ESC that starts a colour code, a
// stray NUL) become '?', a tab stays, and a very long line is cut.
function cleanLine(line) {
  const clean = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?');
  return clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean;
}

// ── one file ────────────────────────────────────────────────────────────

function failure(err) {
  if (err && err.code === 'ENOENT') return { ok: false, error: 'the file does not exist' };
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    // The usual case: Apache's error log on Raspberry Pi OS / Debian is 0640 root:adm in a 0750
    // root:adm folder, so the relay's user cannot read it until it joins the adm group. Say the fix,
    // not just the refusal (F-40) — the answer is all the person sees on the OTA & LOGS page.
    return { ok: false, error: 'the relay is not allowed to read it (permission denied) — add its user to the log\'s group: sudo usermod -aG adm <relay user>, then restart the relay' };
  }
  return { ok: false, error: 'the file could not be read' };
}

// tailFile(file, count, maxWindow) — the last `count` lines of a file as { ok: true, lines } or
// { ok: false, error }. Only a regular file is opened (opening a pipe would wait for ever).
async function tailFile(file, count, maxWindow = MAX_WINDOW_BYTES) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (err) {
    return failure(err);
  }
  if (!st.isFile()) return { ok: false, error: 'it is not a regular file' };
  if (st.size === 0) return { ok: true, lines: [] };

  const want = Math.min(st.size, maxWindow);
  const start = st.size - want;
  let text;
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, start);
    text = buffer.toString('utf8', 0, bytesRead);
  } catch (err) {
    return failure(err);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();   // the newline that ends the last line
  if (start > 0) lines.shift();                      // the window began inside a line
  return { ok: true, lines: lines.slice(-count).map((l) => l.replace(/\r$/, '')) };
}

// capChars(lines, max) — the newest lines whose total length fits in max characters.
function capChars(lines, max) {
  let total = 0;
  let from = lines.length;
  while (from > 0 && total + lines[from - 1].length + 1 <= max) {
    from -= 1;
    total += lines[from].length + 1;
  }
  return lines.slice(from);
}

// ── the answer ──────────────────────────────────────────────────────────

// readSources(sources, count, levels) — each source { kind: 'relay' | 'apache', path } read, filtered and cleaned:
// [ { kind, path, ok: true, lines } | { kind, path, ok: false, error } ].
async function readSources(sources, count, levels, maxWindow = MAX_WINDOW_BYTES) {
  return Promise.all(sources.map(async (source) => {
    const head = { kind: source.kind, path: source.path };
    const tail = await tailFile(source.path, count, maxWindow);
    if (!tail.ok) return { ...head, ok: false, error: tail.error };
    const kept = tail.lines.filter((l) => matchesLevels(l, levels, source.kind)).map(cleanLine);
    return { ...head, ok: true, lines: capChars(kept, MAX_SOURCE_CHARS) };
  }));
}

// answer(query, sources, now) — everything GET /logs/tail does: { status, body } for a request's query
// (anything not understood is a 400 saying so, never a guess).
async function answer(query, sources, now = new Date()) {
  const count = parseLineCount(query.lines);
  if (!count.ok) return { status: 400, body: { error: count.error } };
  const levels = parseLevels(query.levels);
  if (!levels.ok) return { status: 400, body: { error: levels.error } };
  const read = await readSources(sources, count.value, levels.levels);
  return { status: 200, body: { at: now.toISOString(), lines: count.value, levels: levels.levels, sources: read } };
}

// ── the configuration ───────────────────────────────────────────────────

// resolveSources({ relayLog, apacheErrorLog }, baseDir) — the files to tail: the relay's own log (always) and Apache's error
// log (the apacheErrorLog setting, already checked by lib/sysconfig.js: a path, relative to baseDir when it is relative,
// or empty to leave it out of the page).
function resolveSources({ relayLog, apacheErrorLog }, baseDir = '.') {
  const sources = [{ kind: 'relay', path: relayLog }];
  if (apacheErrorLog) sources.push({ kind: 'apache', path: path.resolve(baseDir, apacheErrorLog) });
  return sources;
}

module.exports = {
  LEVELS, DEFAULT_LINES, MAX_LINES, MAX_WINDOW_BYTES, MAX_LINE_CHARS, MAX_SOURCE_CHARS, DEFAULT_APACHE_LOG,
  parseLineCount, parseLevels, levelsOfLine, matchesLevels, cleanLine, tailFile, capChars, readSources, answer, resolveSources,
};
