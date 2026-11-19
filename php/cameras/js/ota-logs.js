'use strict';
// ota-logs.js — the dashboard's OTA & LOGS page (ota-logs.php): the firmware status of the boards and the tail of
// the relay's and Apache's logs, each refreshed on its own timer. Loaded by the page (window.CamOtaLogs.mount)
// and by tests/node/test_ota_logs.js (require(), with a fake page and a fake clock).
//
// Everything a server sent is put on the page with textContent only — never as markup — and PHP has already cut
// it down to the shape drawn here (CamLogic::sanitizeOtaStatus / sanitizeLogTail).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamOtaLogs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LEVEL_KEYS = ['WARN', 'ERROR', 'DEBUG', 'INFO'];   // the checkboxes, in the order they are shown (then ALL)
  const DEFAULT_SECONDS = 10;
  const DEFAULT_LINES = 1000;
  const SECONDS_RANGE = [1, 3600];
  const LINES_RANGE = [1, 5000];
  const OTA_STATES = ['updated', 'pending', 'offline', 'nothing-published'];
  const OTA_COLUMNS = [['id', 'ID'], ['type', 'TYPE'], ['target', 'PUBLISHED'], ['running', 'RUNNING'], ['state', 'STATE'], ['seen', 'LAST SEEN'], ['error', 'LAST ERROR']];

  // ── the numbers and the levels ─────────────────────────────────────────

  // A whole number inside [min, max]: what was typed (a decimal loses its fraction), cut to the range; the fallback
  // when it is not a plain number (empty, text, 1e3).
  function clampInt(raw, [min, max], fallback) {
    const text = String(raw).trim();
    if (!/^[+-]?[0-9]+(\.[0-9]+)?$/.test(text)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(Number(text))));
  }

  // The checkboxes after one of them changed. ALL means "no filter" and excludes the four levels; choosing a level
  // clears ALL; clearing ALL leaves nothing chosen (the page then asks for a level).
  function nextLevelState(state, changed, checked) {
    const next = { ...state };
    if (changed === 'ALL') {
      for (const k of LEVEL_KEYS) next[k] = false;
      next.ALL = checked;
      return next;
    }
    next[changed] = checked;
    if (checked) next.ALL = false;
    return next;
  }

  // The levels asked for, or null for no filter; an empty list means nothing is chosen.
  function selectedLevels(state) {
    if (state.ALL) return null;
    return LEVEL_KEYS.filter((k) => state[k]);
  }

  // The address that asks the dashboard for the log tail, or null while no level is chosen.
  function logsUrl(lines, state) {
    const levels = selectedLevels(state);
    if (levels !== null && levels.length === 0) return null;
    return `logs-tail.php?lines=${lines}` + (levels === null ? '' : `&levels=${levels.join(',')}`);
  }

  // "2026-11-17T10:00:05+01:00" -> "10:00:05" (the server's own clock, as it wrote it); '' when it is not that.
  function clockOf(iso) {
    const m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(String(iso));
    return m ? m[1] : '';
  }

  // ── a timer that waits for its run to finish ───────────────────────────

  // Runs `run` now and then every getSeconds() after the last run FINISHED (so a slow relay is never asked twice
  // at once). A hidden tab is skipped. now() runs it at once (or right after the run in progress, whose answer
  // may be for what was asked before); restart() applies a changed interval.
  function makePoller({ run, getSeconds, isHidden, setTimer, clearTimer }) {
    let timer = null;
    let running = false;
    let again = false;
    const schedule = () => { timer = setTimer(tick, getSeconds() * 1000); };
    async function tick() {
      timer = null;
      if (isHidden()) { schedule(); return; }
      running = true;
      try { await run(); } catch (e) { /* run shows its own trouble */ }
      running = false;
      if (again) { again = false; await tick(); return; }
      schedule();
    }
    return {
      start: () => tick(),
      now() {
        if (running) { again = true; return Promise.resolve(); }
        if (timer !== null) { clearTimer(timer); timer = null; }
        return tick();
      },
      restart() {
        if (running) return;
        if (timer !== null) clearTimer(timer);
        schedule();
      },
    };
  }

  // ── drawing ────────────────────────────────────────────────────────────

  function cell(doc, tag, text, className) {
    const el = doc.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  // The firmware status: one row per board, as `curl /ota/status` prints it (id type published running state seen error).
  function renderOta(doc, container, rows) {
    if (rows.length === 0) {
      container.replaceChildren(cell(doc, 'p', 'No board has asked for firmware yet.', 'muted'));
      return;
    }
    const table = doc.createElement('table');
    table.className = 'ota-table';
    const head = doc.createElement('tr');
    for (const [, title] of OTA_COLUMNS) head.append(cell(doc, 'th', title));
    const thead = doc.createElement('thead');
    thead.append(head);
    const tbody = doc.createElement('tbody');
    for (const row of rows) {
      const tr = doc.createElement('tr');
      for (const [key] of OTA_COLUMNS) {
        const known = key === 'state' && OTA_STATES.includes(row.state);
        tr.append(cell(doc, 'td', String(row[key] === undefined ? '' : row[key]), known ? `ota-state ota-state-${row.state}` : ''));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    container.replaceChildren(table);
  }

  // The log tail: for each file a `==> path <==` heading as `tail` prints it, then its lines (or why it cannot be read).
  // Stays at the bottom when it was there, so the newest lines follow along; a person who scrolled up is left alone.
  function renderLogs(doc, container, sources) {
    const numeric = typeof container.scrollHeight === 'number';
    const atBottom = !numeric || container.scrollHeight <= 0 || container.scrollHeight - container.scrollTop - container.clientHeight < 24;
    const blocks = [];
    for (const source of sources) {
      const block = doc.createElement('div');
      block.className = 'log-source';
      block.append(cell(doc, 'div', `==> ${source.path} <==`, 'log-source-title'));
      if (!source.ok) block.append(cell(doc, 'div', `(cannot be read: ${source.error})`, 'log-source-error'));
      else block.append(cell(doc, 'pre', source.lines.length ? source.lines.join('\n') : '(no matching lines)', source.lines.length ? 'log-lines' : 'log-lines muted'));
      blocks.push(block);
    }
    container.replaceChildren(...blocks);
    if (numeric && atBottom) container.scrollTop = container.scrollHeight;
  }

  // ── the page ───────────────────────────────────────────────────────────

  // Wires the page up. `env`: doc, request(url) ({ data } or { error }: CamRelayJson.request), setTimer/clearTimer,
  // isHidden(), onVisibilityChange(fn). Returns the two pollers and the two refreshes, for the tests.
  function mount(env) {
    const { doc, request, setTimer, clearTimer, isHidden } = env;
    const $ = (id) => doc.getElementById(id);
    const els = {
      otaRefresh: $('ota-refresh'), otaTable: $('ota-table'), otaUpdated: $('ota-updated'), otaError: $('ota-error'),
      logLines: $('log-lines'), logRefresh: $('log-refresh'), logOut: $('log-out'), logUpdated: $('log-updated'), logError: $('log-error'),
      boxes: { WARN: $('lvl-warn'), ERROR: $('lvl-error'), DEBUG: $('lvl-debug'), INFO: $('lvl-info'), ALL: $('lvl-all') },
    };
    let levels = {};
    for (const k of [...LEVEL_KEYS, 'ALL']) levels[k] = !!els.boxes[k].checked;

    const seconds = (input) => clampInt(input.value, SECONDS_RANGE, DEFAULT_SECONDS);
    const lines = () => clampInt(els.logLines.value, LINES_RANGE, DEFAULT_LINES);
    const syncBoxes = () => { for (const k of Object.keys(els.boxes)) els.boxes[k].checked = !!levels[k]; };

    // The words under a part that could not be loaded: what it was, and why (the page's own words when it has some).
    const couldNot = (what, answer) => `Could not load ${what}: ${answer.error || 'the answer was not what was expected'}`;

    async function refreshOta() {
      const answer = await request('ota-status.php');
      const data = answer.data;
      if (!data || !Array.isArray(data.rows)) {
        els.otaError.textContent = couldNot('the OTA status', answer);
        return;
      }
      els.otaError.textContent = '';
      renderOta(doc, els.otaTable, data.rows);
      els.otaUpdated.textContent = `Updated ${clockOf(data.at)}`;
    }

    async function refreshLogs() {
      const url = logsUrl(lines(), levels);
      if (url === null) {
        els.logError.textContent = 'Choose at least one level, or All.';
        els.logOut.replaceChildren();
        return;
      }
      const answer = await request(url);
      const data = answer.data;
      if (!data || !Array.isArray(data.sources)) {
        els.logError.textContent = couldNot('the log', answer);
        return;
      }
      els.logError.textContent = '';
      renderLogs(doc, els.logOut, data.sources);
      els.logUpdated.textContent = `Updated ${clockOf(data.at)}`;
    }

    const otaPoller = makePoller({ run: refreshOta, getSeconds: () => seconds(els.otaRefresh), isHidden, setTimer, clearTimer });
    const logPoller = makePoller({ run: refreshLogs, getSeconds: () => seconds(els.logRefresh), isHidden, setTimer, clearTimer });

    // A number box is put right (cut to its range, the default when it is not a number) as it is left.
    els.otaRefresh.addEventListener('change', () => { els.otaRefresh.value = String(seconds(els.otaRefresh)); otaPoller.restart(); });
    els.logRefresh.addEventListener('change', () => { els.logRefresh.value = String(seconds(els.logRefresh)); logPoller.restart(); });
    els.logLines.addEventListener('change', () => { els.logLines.value = String(lines()); logPoller.now(); });
    for (const k of Object.keys(els.boxes)) {
      els.boxes[k].addEventListener('change', () => {
        levels = nextLevelState(levels, k, !!els.boxes[k].checked);
        syncBoxes();
        logPoller.now();
      });
    }
    if (env.onVisibilityChange) env.onVisibilityChange(() => { if (!isHidden()) { otaPoller.now(); logPoller.now(); } });

    otaPoller.start();
    logPoller.start();
    return { otaPoller, logPoller, refreshOta, refreshLogs };
  }

  return { clampInt, nextLevelState, selectedLevels, logsUrl, clockOf, makePoller, renderOta, renderLogs, mount, LEVEL_KEYS, DEFAULT_SECONDS, DEFAULT_LINES };
});
