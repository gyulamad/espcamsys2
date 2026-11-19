<?php
// settings-page.php — the dashboard's SETTINGS page: every setting of the main system on one
// page (what used to be edited in the relay's config.js and the dashboard's config.php, plus
// the alarm length). The form is drawn from what system-settings.php sends, so a setting
// added there shows up here without touching this file. Saving, and restarting the relay
// when a change needs it, is done by system-settings.php.
//
// The rows come grouped by category (the relay's `group`), and carry their tier (basic /
// advanced / expert): the LEVEL switch at the top hides the rows above the chosen level, so
// the everyday settings come first and the expert ones are one click away. Every row shows
// the default it would fall back to (highlighted while the saved value differs), and one
// that has a default can be reset to it with the row's ↺ DEFAULT button — the default lands
// in the input and goes through the same change tracking and SAVE as a hand-made change.
// Rows the relay marks `locked` (the programs it runs) are shown read-only; the file and
// folder paths are not on the page at all (F-09).
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/lib/Layout.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Settings — ESP32-CAM Dashboard</title>
<?= CamLayout::faviconLinks() ?>
<link rel="stylesheet" href="fonts/fonts.css">
<style>
  :root {
    --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80;
    --accent: #00e5ff; --accent2: #ff4f5e; --warn: #ffb020; --ok: #2dd67b;
    --text: #cdd8f0; --muted: #4a5780;
    --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif; --radius: 6px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; min-height: 100vh; }
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    padding: 18px 32px; border-bottom: 1px solid var(--border); background: var(--surface);
  }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .btn {
    font-family: var(--mono); font-size: .75rem; padding: 7px 14px; border-radius: var(--radius);
    border: 1px solid var(--border-light); background: transparent; color: var(--text);
    cursor: pointer; letter-spacing: .06em; text-decoration: none; display: inline-block; transition: all .2s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  main { max-width: 860px; margin: 0 auto; padding: 24px 32px 120px; }
  .banner { border: 1px solid var(--border-light); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: .85rem; }
  .banner.warn { border-color: var(--warn); color: var(--warn); }
  .banner.err  { border-color: var(--accent2); color: var(--accent2); }
  .banner.ok   { border-color: var(--ok); color: var(--ok); }
  .tierbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 2px 0 16px; }
  .tierbar .lbl { font-family: var(--mono); font-size: .65rem; letter-spacing: .14em; color: var(--muted); }
  .btn.tier.on { border-color: var(--accent); color: var(--accent); }
  #tierinfo { font-family: var(--mono); font-size: .65rem; color: var(--muted); }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px 6px; margin-bottom: 20px; background: var(--surface); }
  legend { font-family: var(--mono); font-size: .8rem; letter-spacing: .1em; color: var(--accent); padding: 0 8px; text-transform: uppercase; }
  .row { display: grid; grid-template-columns: 260px 1fr; gap: 6px 18px; padding: 10px 0; border-top: 1px solid var(--border); align-items: start; }
  .row:first-of-type { border-top: 0; }
  /* the row the settings search jumped to (?find=key, F-29 T7b) */
  .row.found { background: rgba(0, 229, 255, .07); box-shadow: inset 2px 0 0 var(--accent); }
  .row label { font-weight: 500; font-size: .9rem; }
  .row .tags { display: block; margin-top: 3px; }
  .tag { font-family: var(--mono); font-size: .6rem; border: 1px solid var(--border-light); border-radius: 20px; padding: 1px 7px; margin-right: 4px; color: var(--muted); }
  .tag.restart { border-color: var(--warn); color: var(--warn); }
  .tag.danger  { border-color: var(--accent2); color: var(--accent2); }
  .tag.lock { border-color: var(--warn); color: var(--warn); }
  .tag.default.differs { border-color: var(--warn); color: var(--warn); }
  .row input, .row select {
    width: 100%; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius);
    border: 1px solid var(--border-light); background: var(--bg); color: var(--text);
  }
  .row input:focus, .row select:focus { outline: none; border-color: var(--accent); }
  .row input:disabled, .row select:disabled { opacity: .5; }
  .row input.changed, .row select.changed { border-color: var(--warn); }
  .ctl { display: flex; gap: 8px; align-items: stretch; }
  .ctl input, .ctl select { flex: 1; min-width: 0; width: auto; }
  .btn.reset { flex: 0 0 auto; white-space: nowrap; }
  .help { grid-column: 2; font-size: .75rem; color: var(--muted); line-height: 1.4; }
  .cams .cam-row { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .cams .cam-row:first-of-type { border-top: 0; }
  .cams .cam-row .nm { flex: 1; min-width: 160px; font-size: .95rem; }
  .cams .cam-row .nm small { font-family: var(--mono); color: var(--muted); margin-left: 6px; }
  .cams .add { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 0 6px; border-top: 1px solid var(--border); }
  .cams .add input { flex: 1; min-width: 120px; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .cams .add input.icon { flex: 0 0 80px; min-width: 60px; text-align: center; }
  .savebar {
    position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--border);
    padding: 12px 32px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  }
  #status { font-family: var(--mono); font-size: .75rem; flex: 1; min-width: 200px; }
  #status.err { color: var(--accent2); } #status.ok { color: var(--ok); } #status.busy { color: var(--warn); }
  @media (max-width: 700px) {
    header, main, .savebar { padding-left: 16px; padding-right: 16px; }
    .row { grid-template-columns: 1fr; } .help { grid-column: 1; }
  }
<?= CamLayout::navBarStyle() ?>
<?= CamLayout::busyStyle() ?>
<?= CamLayout::iconPickerStyle() ?>
  .cams .add .icon-picker { flex-basis: 80px; min-width: 60px; }
</style>
</head>
<body>
<?= CamLayout::navBar(null) ?>
<header>
  <div>
    <h1>⚙ SETTINGS</h1>
    <p>Main system · relay and dashboard</p>
  </div>
  <a class="btn" href="settings-search.php" data-page-load="" title="Find any setting by its name, its label or its help text">🔍 JUMP TO SETTING</a>
</header>

<main>
  <div id="banners"></div>
  <div class="tierbar" id="tierbar">
    <span class="lbl">LEVEL</span>
    <button class="btn tier on" type="button" data-tier="basic">BASIC</button>
    <button class="btn tier" type="button" data-tier="advanced">ADVANCED</button>
    <button class="btn tier" type="button" data-tier="expert">EXPERT</button>
    <span id="tierinfo"></span>
  </div>
  <form id="form" onsubmit="return false;"></form>
  <fieldset class="cams" id="cameras" hidden>
    <legend>Cameras on the dashboard</legend>
    <div id="cam-list"></div>
    <div class="add">
      <input id="c-id" placeholder="id (= the board's CAMERA_ID)" maxlength="64" autocomplete="off" aria-label="New camera id">
      <input id="c-name" placeholder="name" maxlength="60" autocomplete="off" aria-label="New camera name">
      <input id="c-icon" class="icon" placeholder="🎥" maxlength="8" autocomplete="off" aria-label="New camera icon">
      <button class="btn" id="c-add">+ ADD CAMERA</button>
    </div>
    <div class="help" style="padding-bottom:8px">Adding or removing only changes what this dashboard shows — no board is touched and no recording is deleted. A new camera's board must have the same value as its CAMERA_ID setting.</div>
  </fieldset>
</main>

<div class="savebar">
  <button class="btn primary" id="save" disabled>💾 SAVE</button>
  <button class="btn" id="revert" disabled>↺ REVERT</button>
  <span id="status">Loading…</span>
</div>

<script src="js/toast.js"></script>
<script src="js/busy.js"></script>
<script src="js/icon-catalog.js"></script>
<script src="js/icon-picker.js"></script>
<script src="js/sound-library.js"></script>
<script>
  const GROUP_ORDER = ['Recording', 'Person check', 'Alarm sounds', 'Network', 'Keys', 'Log', 'Folders', 'Detectors', 'Notifications', 'Security', 'Diagnostics', 'Dashboard'];
  const BREAKING = ['camKey', 'pushPort'];
  const NUMERIC = ['int', 'float'];   // drawn as a number input (a float's step comes from the relay)
  const AJAX = { 'X-Requested-With': 'camdash' };
  const LEVELS = ['basic', 'advanced', 'expert'];   // who a row is for (the relay's `tier`); the level picks how many are shown
  // A jump from the settings search (?find=key, F-29 T7b): the row is framed, at its level when it
  // sits above the chosen one. A key the page does not hold is ignored — the page opens as always.
  const FIND = new URLSearchParams(location.search).get('find') || '';
  let fields = [];
  let original = {};   // key -> the value loaded from the server (secrets: '')
  let tierLevel = 'basic';   // the level shown: rows above it stay in the form but hidden

  const $ = (id) => document.getElementById(id);
  const form = $('form'), statusEl = $('status'), saveBtn = $('save'), revertBtn = $('revert');

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }
  // The result of pressing a button (SAVE, REVERT, add / remove a camera): a toast popup (F-12) instead of
  // a message in the save bar, where a longer answer wrapped the bar into several lines. The save bar's
  // own #status line stays for the passive states (loading, unsaved-changes count, saving...).
  function notify(text, kind) { CamToast.show(text, kind || 'info'); }
  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children) e.append(c);
    return e;
  }
  function banner(text, cls) { $('banners').append(el('div', { className: 'banner ' + cls, textContent: text })); }

  function render(data) {
    fields = data.fields;
    original = {};
    form.textContent = '';
    $('banners').textContent = '';
    if (!data.configWritable) banner('config.php is not writable by the web server, so the login and relay address cannot be changed here. Run deploy.sh as root once (it fixes this), or: sudo chown www-data config.php', 'warn');
    if (!data.supervised) banner('The relay was not started by systemd or pm2, so it cannot restart itself: settings marked "restart" are saved but applied only after you restart it by hand.', 'warn');

    const groups = {};
    for (const f of fields) (groups[f.group] = groups[f.group] || []).push(f);
    const order = GROUP_ORDER.filter((g) => groups[g]).concat(Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g)));
    for (const g of order) {
      const fs = el('fieldset', {}, el('legend', { textContent: g }));
      if (g === 'Alarm sounds') fs.append(soundLibraryBox());   // the sound files first: the choices below are made from them
      for (const f of groups[g]) fs.append(renderField(f));
      form.append(fs);
    }
    renderCameras(data.cameras || []);
    applyTier();
    updateButtons();
    highlightFound();
  }

  // ── cameras: list, add, remove (each acts at once — they are not part of the SAVE bar) ──
  function renderCameras(cams) {
    $('cameras').hidden = false;
    const list = $('cam-list');
    list.textContent = '';
    if (!cams.length) list.append(el('div', { className: 'help', textContent: 'No cameras yet — add one below.' }));
    for (const c of cams) {
      const rm = el('button', { className: 'btn', textContent: '🗑 REMOVE' });
      rm.addEventListener('click', () => CamBusy.run(rm, () => removeCamera(c)));
      const settings = el('a', { className: 'btn', href: 'camera-settings-page.php?cam=' + encodeURIComponent(c.id), textContent: '⚙ SETTINGS' });
      settings.setAttribute('data-page-load', '');   // opens a page: js/busy.js covers this one meanwhile
      list.append(el('div', { className: 'cam-row' },
        el('div', { className: 'nm' }, c.icon + ' ' + c.name, el('small', { textContent: c.id })),
        settings, rm));
    }
  }
  async function cameraAction(body) {
    const res = await fetch('camera-admin.php', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { notify(data.error || ('Error ' + res.status), 'error'); return false; }
    renderCameras(data.cameras);
    notify(data.message, 'ok');
    return true;
  }
  async function removeCamera(c) {
    if (!confirm('Remove ' + c.name + ' (' + c.id + ') from the dashboard?\n\nIts recordings are kept and the board is not touched.')) return;
    await cameraAction({ action: 'remove', id: c.id });
  }
  $('c-add').addEventListener('click', () => CamBusy.run($('c-add'), async () => {
    const ok = await cameraAction({ action: 'add', id: $('c-id').value.trim(), name: $('c-name').value, icon: $('c-icon').value.trim() || '🎥' });
    if (ok) { $('c-id').value = ''; $('c-name').value = ''; $('c-icon').value = ''; }
  }));

  // A true/false setting is an ON/OFF choice whose value is the text the relay takes ("true" / "false"), so it
  // goes through the same change tracking, revert and save as every other field.
  function switchInput(id, name) {
    return el('select', { id, name }, el('option', { value: 'true', textContent: 'ON' }), el('option', { value: 'false', textContent: 'OFF' }));
  }

  // A sound setting is a choice among the sound files (what the relay sent as `options`), or none. The value saved
  // for it is always shown, even if its file is gone, so the form tells the truth; `wanted` is what stays selected.
  function fillSoundOptions(select, names, saved, wanted) {
    select.textContent = '';
    select.append(el('option', { value: '', textContent: '(no sound)' }));
    for (const name of names) select.append(el('option', { value: name, textContent: name }));
    if (saved && !names.includes(saved)) select.append(el('option', { value: saved, textContent: saved + ' (file missing)' }));
    select.value = [...select.options].some((o) => o.value === wanted) ? wanted : '';
  }
  function soundInput(id, f) {
    const select = el('select', { id, name: f.key });
    fillSoundOptions(select, f.options || [], String(f.value), String(f.value));
    return select;
  }
  // The library changed (a sound uploaded or deleted): every sound choice offers the new list, keeping what is chosen.
  function refreshSoundOptions(names) {
    for (const f of fields.filter((x) => x.type === 'sound')) {
      const select = $('f-' + f.key);
      if (!select) continue;
      fillSoundOptions(select, names, original[f.key], select.value);
      select.classList.toggle('changed', select.value !== original[f.key]);
    }
    updateButtons();
  }
  // The sound files themselves: list, try, upload, delete (js/sound-library.js). They act at once, like the cameras.
  function soundLibraryBox() {
    const box = el('div', { className: 'cams sound-library' });
    if (window.CamSoundLibrary) {
      window.CamSoundLibrary.mount(box, { fetch: window.fetch.bind(window), notify, confirm: (text) => confirm(text), onChange: refreshSoundOptions, run: CamBusy.run }).refresh();
    }
    return box;
  }

  // ── levels, defaults and locks (F-29 T6b) ──
  // What one value looks like in the page's inputs: a switch as the text the relay takes
  // ("true" / "false"), a command as one line, everything else as plain text.
  const asText = (v) => (Array.isArray(v) ? v.join(' ') : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  // The default as it goes into an input (undefined = the field has none: no reset, no default tag — secrets never have one).
  const defaultEdit = (f) => (f.default === undefined ? undefined : asText(f.default));
  // The default as it is shown in the row's tag: "default 60", "default ON", "default none".
  function defaultLabel(f) {
    const d = f.default;
    if (d === undefined) return null;
    if (d === '') return 'none';
    if (typeof d === 'boolean') return d ? 'ON' : 'OFF';
    return asText(d);
  }

  // A word choice (what to do with a clip without a person, ...): one of the relay's offered words.
  // The saved word is always selectable, even when the relay did not list it (the same rule as the sounds).
  function choiceInput(id, f) {
    const select = el('select', { id, name: f.key });
    for (const o of (f.options || [])) select.append(el('option', { value: o, textContent: o }));
    const saved = asText(f.value);
    if (saved !== '' && !(f.options || []).includes(saved)) select.append(el('option', { value: saved, textContent: saved + ' (not offered)' }));
    return select;
  }

  // The chosen level hides every row above it (the relay's tiers: basic < advanced < expert). Rows
  // without a tier — the dashboard's own settings — are shown at every level. Hidden rows keep their
  // values, so a change made at a higher level is not lost by switching back: it is still tracked, and
  // the save bar counts it. Nothing is dropped: the form stays complete and the level is only a view.
  function applyTier() {
    let hidden = 0;
    for (const row of form.querySelectorAll('.row[data-tier]')) {
      const hide = LEVELS.indexOf(row.dataset.tier) > LEVELS.indexOf(tierLevel);
      row.hidden = hide;
      if (hide) hidden += 1;
    }
    clearFound();
    for (const b of document.querySelectorAll('#tierbar .btn.tier')) b.classList.toggle('on', b.dataset.tier === tierLevel);
    $('tierinfo').textContent = hidden === 0
      ? 'every setting shown at ' + tierLevel
      : hidden + ' hidden at ' + tierLevel + ' — a higher level shows them';
  }

  // ── the search's jump (?find=key, F-29 T7b) ──
  // The jumped-to row is framed and its input focused (a locked or read-only one cannot be). The mark
  // goes when the level changes — it points where the search landed, it is not an edit state — and it
  // is applied once: a reload after a save must not scroll the page away again.
  let foundShown = false;
  function clearFound() { for (const row of form.querySelectorAll('.row.found')) row.classList.remove('found'); }
  function highlightFound() {
    if (!FIND || foundShown) return;
    const f = fields.find((x) => x.key === FIND);
    if (!f) return;
    foundShown = true;
    if (f.tier && LEVELS.indexOf(f.tier) > LEVELS.indexOf(tierLevel)) tierLevel = f.tier;
    applyTier();
    const row = $('r-' + FIND);
    if (!row || row.hidden) return;
    row.classList.add('found');
    if (row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    const i = $('f-' + FIND);
    if (i && !i.disabled) i.focus({ preventScroll: true });
  }

  function renderField(f) {
    const id = 'f-' + f.key;
    const secret = f.type === 'secret';
    const locked = f.locked === true;          // read-only: the server decides this, never the page
    let input;
    if (f.type === 'sound') input = soundInput(id, f);
    else if (f.type === 'bool') input = switchInput(id, f.key);
    else if (f.type === 'choice') input = choiceInput(id, f);
    else input = el('input', {
      id, name: f.key,
      type: secret ? 'password' : (NUMERIC.includes(f.type) ? 'number' : 'text'),
      autocomplete: 'off', spellcheck: false,
    });
    if (NUMERIC.includes(f.type)) { input.min = f.min; input.max = f.max; input.step = f.type === 'int' ? 1 : (f.step || 'any'); }
    if (secret) {
      input.placeholder = f.isSet ? '(set — leave empty to keep)' : '(not set)';
      original[f.key] = '';
    } else {
      input.value = asText(f.value);
      original[f.key] = asText(f.value);
    }
    if (locked || f.envOverride) { input.disabled = true; }

    // Reset to default: the default goes into the input, and from there through the SAME change
    // tracking and save as a hand-made change (no separate path to the relay). No button while the
    // input already holds the default, and none for what has no default (secrets, locked rows,
    // environment-read-only rows).
    const defText = defaultEdit(f);
    const reset = (defText === undefined || locked || f.envOverride) ? null : el('button', {
      className: 'btn reset', type: 'button', title: 'Put the default back, then SAVE', textContent: '↺ DEFAULT',
    });
    input.addEventListener('input', () => {
      input.classList.toggle('changed', input.value !== original[f.key]);
      if (reset) reset.disabled = input.value === defText;
      updateButtons();
    });
    if (reset) {
      reset.disabled = input.value === defText;
      reset.addEventListener('click', () => { input.value = defText; input.dispatchEvent(new Event('input', { bubbles: true })); });
    }

    const tags = el('span', { className: 'tags' });
    if (f.restart) tags.append(el('span', { className: 'tag restart', textContent: 'restarts relay' }));
    if (BREAKING.includes(f.key)) tags.append(el('span', { className: 'tag danger', textContent: 'affects cameras' }));
    if (locked) tags.append(el('span', { className: 'tag lock', textContent: 'locked — config.js only' }));
    if (f.envOverride) tags.append(el('span', { className: 'tag', textContent: 'set by ' + f.envName + ' (read-only)' }));
    else if (f.source && f.source !== 'settings') tags.append(el('span', { className: 'tag', textContent: 'from ' + f.source }));
    const defLabel = defaultLabel(f);
    if (defLabel !== null) {
      const differs = asText(f.value) !== defText;
      tags.append(el('span', { className: 'tag default' + (differs ? ' differs' : ''), textContent: 'default ' + defLabel }));
    }

    const ctl = el('div', { className: 'ctl' }, input);
    if (reset) ctl.append(reset);
    const row = el('div', { className: 'row', id: 'r-' + f.key }, el('div', {}, el('label', { htmlFor: id, textContent: f.label }), tags), ctl);
    if (f.tier) row.dataset.tier = f.tier;
    row.append(el('div', { className: 'help', textContent: f.help }));
    return row;
  }

  function changedValues() {
    const out = {};
    for (const f of fields) {
      const input = $('f-' + f.key);
      if (input.disabled) continue;
      if (input.value !== original[f.key]) out[f.key] = input.value;
    }
    return out;
  }
  function updateButtons() {
    const n = Object.keys(changedValues()).length;
    saveBtn.disabled = n === 0; revertBtn.disabled = n === 0;
    if (n > 0) setStatus(n + ' unsaved change' + (n === 1 ? '' : 's'), '');
  }

  async function load() {
    setStatus('Loading…');
    try {
      const res = await fetch('system-settings.php', { headers: AJAX });
      const data = await res.json();
      if (!res.ok) { setStatus(data.error || ('Error ' + res.status), 'err'); banner(data.error || ('Error ' + res.status), 'err'); return; }
      render(data);
      setStatus('Loaded.', '');
    } catch (e) { setStatus('Could not load the settings: ' + e.message, 'err'); }
  }

  async function save() {
    const values = changedValues();
    const keys = Object.keys(values);
    if (!keys.length) return;
    const breaking = keys.filter((k) => BREAKING.includes(k));
    if (breaking.length && !confirm('Changing ' + breaking.join(' / ') + ' stops EVERY camera from connecting until each board is updated with the new value.\n\nContinue?')) return;
    const restarts = keys.some((k) => (fields.find((f) => f.key === k) || {}).restart);
    saveBtn.disabled = revertBtn.disabled = true;
    setStatus(restarts ? 'Saving… the relay will restart (a few seconds)' : 'Saving…', 'busy');
    try {
      const res = await fetch('system-settings.php', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX),
        body: JSON.stringify({ values, confirm: breaking.length > 0 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { notify(data.error || ('Error ' + res.status), 'error'); updateButtons(); return; }
      const warn = data.restart === 'manual' || data.restart === 'timeout';
      await load();
      notify(data.message + (data.relogin ? ' The browser will ask you to log in again.' : ''), warn ? 'error' : 'ok');
    } catch (e) {
      // Changing the login makes this very request come back 401 in some browsers; reload tells the truth.
      notify('The answer did not arrive (' + e.message + '). Reloading what is stored…', 'error');
      setTimeout(load, 1500);
    }
  }

  saveBtn.addEventListener('click', () => CamBusy.run(saveBtn, save));
  // REVERT puts every input back to what the server sent (locked and read-only ones included —
  // harmless, they cannot change anyway); the input event keeps the changed marks, the reset
  // buttons and the save bar in step with what is on screen.
  revertBtn.addEventListener('click', () => {
    for (const f of fields) {
      const i = $('f-' + f.key);
      i.value = original[f.key];
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    notify('Reverted.', 'ok');
  });
  for (const b of document.querySelectorAll('#tierbar .btn.tier')) {
    b.addEventListener('click', () => { tierLevel = b.dataset.tier; applyTier(); });
  }
  // The new camera's icon input gets a chooser bubble with a search bar (js/icon-picker.js); without the scripts it stays a plain input.
  if (window.CamIconPicker && window.CamIconCatalog) window.CamIconPicker.attach($('c-icon'), window.CamIconCatalog.GROUPS);

  load();
</script>
<?= CamLayout::storageWarningScript() ?>
<?= CamLayout::setupModeAlertScript() ?>
</body>
</html>
