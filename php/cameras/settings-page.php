<?php
// settings-page.php — the dashboard's SETTINGS page: every setting of the main system on one
// page (what used to be edited in the relay's config.js and the dashboard's config.php, plus
// the alarm length). The form is drawn from what system-settings.php sends, so a setting
// added there shows up here without touching this file. Saving, and restarting the relay
// when a change needs it, is done by system-settings.php.
require_once __DIR__ . '/auth.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Settings — ESP32-CAM Dashboard</title>
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
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px 6px; margin-bottom: 20px; background: var(--surface); }
  legend { font-family: var(--mono); font-size: .8rem; letter-spacing: .1em; color: var(--accent); padding: 0 8px; text-transform: uppercase; }
  .row { display: grid; grid-template-columns: 260px 1fr; gap: 6px 18px; padding: 10px 0; border-top: 1px solid var(--border); align-items: start; }
  .row:first-of-type { border-top: 0; }
  .row label { font-weight: 500; font-size: .9rem; }
  .row .tags { display: block; margin-top: 3px; }
  .tag { font-family: var(--mono); font-size: .6rem; border: 1px solid var(--border-light); border-radius: 20px; padding: 1px 7px; margin-right: 4px; color: var(--muted); }
  .tag.restart { border-color: var(--warn); color: var(--warn); }
  .tag.danger  { border-color: var(--accent2); color: var(--accent2); }
  .row input {
    width: 100%; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius);
    border: 1px solid var(--border-light); background: var(--bg); color: var(--text);
  }
  .row input:focus { outline: none; border-color: var(--accent); }
  .row input:disabled { opacity: .5; }
  .row input.changed { border-color: var(--warn); }
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
</style>
</head>
<body>
<header>
  <div>
    <h1>⚙ SETTINGS</h1>
    <p>Main system · relay and dashboard</p>
  </div>
  <a class="btn" href="index.php">← DASHBOARD</a>
</header>

<main>
  <div id="banners"></div>
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

<script>
  const GROUP_ORDER = ['Recording', 'Network', 'Keys', 'Log', 'Folders', 'Dashboard'];
  const BREAKING = ['camKey', 'pushPort'];
  const AJAX = { 'X-Requested-With': 'camdash' };
  let fields = [];
  let original = {};   // key -> the value loaded from the server (secrets: '')

  const $ = (id) => document.getElementById(id);
  const form = $('form'), statusEl = $('status'), saveBtn = $('save'), revertBtn = $('revert');

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }
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
      for (const f of groups[g]) fs.append(renderField(f));
      form.append(fs);
    }
    renderCameras(data.cameras || []);
    updateButtons();
  }

  // ── cameras: list, add, remove (each acts at once — they are not part of the SAVE bar) ──
  function renderCameras(cams) {
    $('cameras').hidden = false;
    const list = $('cam-list');
    list.textContent = '';
    if (!cams.length) list.append(el('div', { className: 'help', textContent: 'No cameras yet — add one below.' }));
    for (const c of cams) {
      const rm = el('button', { className: 'btn', textContent: '🗑 REMOVE' });
      rm.addEventListener('click', () => removeCamera(c));
      list.append(el('div', { className: 'cam-row' },
        el('div', { className: 'nm' }, c.icon + ' ' + c.name, el('small', { textContent: c.id })),
        el('a', { className: 'btn', href: 'camera-settings-page.php?cam=' + encodeURIComponent(c.id), textContent: '⚙ SETTINGS' }), rm));
    }
  }
  async function cameraAction(body) {
    const res = await fetch('camera-admin.php', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { setStatus(data.error || ('Error ' + res.status), 'err'); return false; }
    renderCameras(data.cameras);
    setStatus(data.message, 'ok');
    return true;
  }
  async function removeCamera(c) {
    if (!confirm('Remove ' + c.name + ' (' + c.id + ') from the dashboard?\n\nIts recordings are kept and the board is not touched.')) return;
    await cameraAction({ action: 'remove', id: c.id });
  }
  $('c-add').addEventListener('click', async () => {
    const ok = await cameraAction({ action: 'add', id: $('c-id').value.trim(), name: $('c-name').value, icon: $('c-icon').value.trim() || '🎥' });
    if (ok) { $('c-id').value = ''; $('c-name').value = ''; $('c-icon').value = ''; }
  });

  function renderField(f) {
    const id = 'f-' + f.key;
    const secret = f.type === 'secret';
    const input = el('input', {
      id, name: f.key,
      type: secret ? 'password' : (f.type === 'int' ? 'number' : 'text'),
      autocomplete: 'off', spellcheck: false,
    });
    if (f.type === 'int') { input.min = f.min; input.max = f.max; input.step = 1; }
    if (secret) {
      input.placeholder = f.isSet ? '(set — leave empty to keep)' : '(not set)';
      original[f.key] = '';
    } else {
      input.value = f.value;
      original[f.key] = String(f.value);
    }
    if (f.envOverride) { input.disabled = true; }
    input.addEventListener('input', () => { input.classList.toggle('changed', input.value !== original[f.key]); updateButtons(); });

    const tags = el('span', { className: 'tags' });
    if (f.restart) tags.append(el('span', { className: 'tag restart', textContent: 'restarts relay' }));
    if (BREAKING.includes(f.key)) tags.append(el('span', { className: 'tag danger', textContent: 'affects cameras' }));
    if (f.envOverride) tags.append(el('span', { className: 'tag', textContent: 'set by ' + f.envName + ' (read-only)' }));
    else if (f.source && f.source !== 'settings') tags.append(el('span', { className: 'tag', textContent: 'from ' + f.source }));

    const row = el('div', { className: 'row' }, el('div', {}, el('label', { htmlFor: id, textContent: f.label }), tags), input);
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
      if (!res.ok || !data.ok) { setStatus(data.error || ('Error ' + res.status), 'err'); updateButtons(); return; }
      const warn = data.restart === 'manual' || data.restart === 'timeout';
      await load();
      setStatus(data.message + (data.relogin ? ' The browser will ask you to log in again.' : ''), warn ? 'err' : 'ok');
    } catch (e) {
      // Changing the login makes this very request come back 401 in some browsers; reload tells the truth.
      setStatus('The answer did not arrive (' + e.message + '). Reloading what is stored…', 'err');
      setTimeout(load, 1500);
    }
  }

  saveBtn.addEventListener('click', save);
  revertBtn.addEventListener('click', () => { for (const f of fields) { const i = $('f-' + f.key); i.value = original[f.key]; i.classList.remove('changed'); } updateButtons(); setStatus('Reverted.', ''); });
  load();
</script>
</body>
</html>
