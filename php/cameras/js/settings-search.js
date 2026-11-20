'use strict';
// settings-search.js — the "Jump to any setting" search (F-29 T7b, designs/Search-v2.png), embedded in
// the settings page (settings-page.php, F-38: the old search page settings-search.php is gone). One
// index of EVERY setting — each camera's keys, each detector's keys (via the camera it is paired with)
// and the relay's and dashboard's own fields — loaded once from settings-search-index.php. A query
// matches a hit's NAME, its plain-language LABEL and its HELP text (every word typed must appear
// somewhere in them); the scope pills narrow it to Cameras, Detectors or Relay. A hit opens the page
// the setting is edited on with ?find=KEY, which shows the category (or, on the settings page, just
// the row) with the setting framed and focused.
//
// Loaded by the page as a plain script (window.CamSettingsSearch) and by tests with require(); the
// matching and ranking are pure (search(), below) so they are checked without a page.
//
// Everything shown is built with createElement and textContent, never as markup, so nothing from the
// index (a label, a help text, a device name) can become HTML. The rows are real links, so a hit can
// also be opened in a new tab; Enter opens the selected one.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamSettingsSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // A list this long stops being a jump: the query is narrowed instead. The note under the list says
  // how much did not fit.
  const MAX_HITS = 50;

  // Where a query matched, best first: the setting's own name says most, then its label, the help
  // text least. An entry matches when EVERY word typed appears in any of the three; its rank is the
  // best field any of its words matched, and ties keep the index's order (the schema's own).
  function rank(entry, terms) {
    const name = String(entry.key || '').toLowerCase();
    const label = String(entry.label || '').toLowerCase();
    const help = String(entry.help || '').toLowerCase();
    let best = -1;
    for (const t of terms) {
      let r = -1;
      if (name.indexOf(t) !== -1) r = 0;
      else if (label.indexOf(t) !== -1) r = 1;
      else if (help.indexOf(t) !== -1) r = 2;
      if (r === -1) return -1;          // one word not found: no match at all
      if (r > best) best = r;
    }
    return best;
  }

  // The hits for a query and a scope ('all' or one of the index's scopes), best first.
  function search(entries, query, scope) {
    const terms = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits = [];
    for (const e of entries) {
      if (scope !== 'all' && e.scope !== scope) continue;
      const r = rank(e, terms);
      if (r !== -1) hits.push([r, hits.length, e]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.map((h) => h[2]);
  }

  // ── the page ────────────────────────────────────────────────────────────────────────
  // mount({ input, scopeBar, results, note, indexUrl }) — the elements the page holds. Returns a
  // small controller for the tests. The index fetch carries the X-Requested-With header, the one
  // the dashboard's endpoints require.
  function mount(parts) {
    const input = parts.input, scopeBar = parts.scopeBar, results = parts.results, note = parts.note;
    let entries = [];
    let scope = 'all';
    let hits = [];
    let selected = 0;
    let relayError = '';
    let open = openDefault;

    function openDefault(url) {
      if (window.CamBusy && window.CamBusy.navigate) window.CamBusy.navigate(url);
      else window.location.href = url;
    }

    function el(tag, props, ...kids) {
      const e = document.createElement(tag);
      Object.assign(e, props || {});
      for (const k of kids) e.append(k);
      return e;
    }

    // The scope pills: All scopes + one per scope the index names, in its order. The counts come
    // from the index, so a dashboard without detectors simply finds nothing under Detectors.
    function renderScopes() {
      scopeBar.textContent = '';
      const pills = [['all', 'All scopes']].concat((parts.scopes || []).map((s) => [s, SCOPE_LABELS[s] || s]));
      for (const [key, label] of pills) {
        const b = el('button', { className: 'scope-pill' + (key === scope ? ' on' : ''), type: 'button', textContent: label });
        b.dataset.scope = key;
        b.addEventListener('click', () => { scope = key; renderScopes(); render(); input.focus(); });
        scopeBar.append(b);
      }
    }

    // A device chip only when a scope holds more than one device: with one camera "Cameras /
    // Picture & link" already says everything, with several the camera's name is what tells the
    // equal-looking hits apart. Decided per answer below, from the hits the query touched.

    function render() {
      const query = input.value;
      hits = search(entries, query, scope);
      selected = Math.min(selected, Math.max(0, hits.length - 1));
      results.textContent = '';
      note.textContent = relayError;   // what the index could not hold (an unreachable relay), kept across renders
      if (!String(query).trim()) {
        results.append(el('div', { className: 'search-hint', textContent: 'Type part of a setting\u2019s name (jpeg), its label (debounce) or its help text (slow-loris). Every word typed must match.' }));
        markRows();
        return;
      }
      const shown = hits.slice(0, MAX_HITS);
      // the device counts of the scopes the query touches decide whether a hit names its device
      const multi = {};
      {
        const perScope = {};
        for (const h of hits) {
          perScope[h.scope] = perScope[h.scope] || new Set();
          perScope[h.scope].add(h.deviceId || '');
        }
        for (const s of Object.keys(perScope)) multi[s] = perScope[s].size > 1;
      }
      for (const h of shown) results.append(hitRow(h, multi[h.scope]));
      if (hits.length > shown.length) {
        note.textContent += (relayError ? ' ' : '') + (hits.length - shown.length) + ' more match'
          + (hits.length - shown.length === 1 ? 'es' : '') + ' \u2014 narrow the search, or pick a scope.';
      } else if (!hits.length) {
        results.append(el('div', { className: 'search-hint', textContent: 'No setting matches \u201c' + query + '\u201d.' }));
      }
      markRows();
    }

    function hitRow(h, withDevice) {
      const left = el('div', { className: 'hit-what' },
        el('span', { className: 'hit-key', textContent: h.key }),
        h.label ? el('span', { className: 'hit-label', textContent: h.label }) : '');
      const chips = el('span', { className: 'hit-chips' });
      if (withDevice) {
        chips.append(el('span', { className: 'chip device', textContent: (h.deviceIcon ? h.deviceIcon + ' ' : '') + h.deviceName, title: h.deviceName }));
      }
      chips.append(el('span', { className: 'chip', textContent: (SCOPE_LABELS[h.scope] || h.scope) + (h.category ? ' / ' + h.category : ''), title: (SCOPE_LABELS[h.scope] || h.scope) + (h.category ? ' / ' + h.category : '') }));
      if (h.apply === 'reboot') chips.append(el('span', { className: 'chip reboot', textContent: 'reboot', title: 'takes effect only after the device restarts' }));
      const a = el('a', { className: 'hit', href: h.url }, left, chips, el('span', { className: 'hit-value', textContent: h.value === null || h.value === undefined || h.value === '' ? '\u2014' : String(h.value) }));
      a.setAttribute('role', 'option');
      a.setAttribute('data-page-load', '');   // js/busy.js covers the page this opens
      a.addEventListener('focus', () => { selected = hits.indexOf(h); markRows(); });
      a.addEventListener('mousemove', () => { selected = hits.indexOf(h); markRows(); });
      return a;
    }

    function markRows() {
      const rows = results.querySelectorAll('.hit');
      rows.forEach((r, i) => {
        r.classList.toggle('sel', i === selected);
        r.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      });
    }

    function move(delta) {
      if (!hits.length) return;
      selected = Math.min(hits.length - 1, Math.max(0, selected + delta));
      const row = results.querySelectorAll('.hit')[selected];
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      markRows();
    }

    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        const h = hits[selected];
        if (h) open(h.url);
      } else if (ev.key === 'Escape') {
        if (input.value !== '') {
          input.value = ''; selected = 0; render();
          // the same event a hand-clearing carries, so an embedding page can follow the emptying
          // (the settings page swaps its result list back for the settings, F-38)
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else window.history.back();
      }
    });

    renderScopes();
    render();

    fetch(parts.indexUrl, { headers: { 'X-Requested-With': 'camdash' } })
      .then((r) => { if (!r.ok) throw new Error('Error ' + r.status); return r.json(); })
      .then((data) => {
        entries = Array.isArray(data.entries) ? data.entries : [];
        parts.scopes = Array.isArray(data.scopes) ? data.scopes : [];
        relayError = typeof data.relayError === 'string' ? data.relayError : '';
        renderScopes();
        render();
        // autoFocus: false leaves the focus alone — a search box embedded in a page that is
        // something first (the settings page, F-38) must not pull the caret (and the scroll) to
        // itself on every page load, a ?find= jump included.
        if (parts.autoFocus !== false) input.focus();
      })
      .catch((e) => {
        results.textContent = '';
        results.append(el('div', { className: 'search-hint err', textContent: 'The settings index could not be loaded (' + (e && e.message ? e.message : 'network error') + '). The settings pages still work from their own links.' }));
      });

    return {
      search, reload: render,
      get hits() { return hits; },
      get selected() { return selected; },
      set selected(v) { selected = v; markRows(); },
      get scope() { return scope; },
      set scope(v) { scope = v; renderScopes(); render(); },
      get open() { return open; },
      set open(fn) { open = fn; },
    };
  }

  const SCOPE_LABELS = { cameras: 'Cameras', detectors: 'Detectors', relay: 'Relay' };

  return { search, mount, MAX_HITS, SCOPE_LABELS };
});
