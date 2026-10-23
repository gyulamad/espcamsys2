<?php
// camera-settings-page.php?cam=ID[&type=detector] — one camera's SETTINGS page (with &type=detector: the
// CALIBRATE page of the person detector paired with that camera, same form, the detector's own settings): its dashboard entry (name, icon, remove)
// and the settings stored in the board itself. The form is drawn from what camera-settings.php sends
// (the firmware's own settings table), so a setting added to the firmware shows up here by itself.
// Changes are queued on the relay; the board picks them up, applies them and restarts — see camera-settings.php.
require_once __DIR__ . '/auth.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Camera settings — ESP32-CAM Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@300;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80;
    --accent: #00e5ff; --accent2: #ff4f5e; --warn: #ffb020; --ok: #2dd67b;
    --text: #cdd8f0; --muted: #4a5780;
    --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif; --radius: 6px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; min-height: 100vh; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 18px 32px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .btn { font-family: var(--mono); font-size: .75rem; padding: 7px 14px; border-radius: var(--radius); border: 1px solid var(--border-light); background: transparent; color: var(--text); cursor: pointer; letter-spacing: .06em; text-decoration: none; display: inline-block; transition: all .2s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.danger:hover { border-color: var(--accent2); color: var(--accent2); }
  main { max-width: 860px; margin: 0 auto; padding: 24px 32px 120px; }
  .banner { border: 1px solid var(--border-light); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: .85rem; line-height: 1.4; }
  .banner.warn { border-color: var(--warn); color: var(--warn); }
  .banner.err  { border-color: var(--accent2); color: var(--accent2); }
  .banner.ok   { border-color: var(--ok); color: var(--ok); }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px 8px; margin-bottom: 20px; background: var(--surface); }
  legend { font-family: var(--mono); font-size: .8rem; letter-spacing: .1em; color: var(--accent); padding: 0 8px; text-transform: uppercase; }
  .row { display: grid; grid-template-columns: 260px 1fr; gap: 6px 18px; padding: 10px 0; border-top: 1px solid var(--border); align-items: start; }
  .row:first-of-type { border-top: 0; }
  .row.unused { opacity: .55; }
  .row label { font-weight: 500; font-size: .9rem; font-family: var(--mono); }
  .tags { display: block; margin-top: 3px; }
  .tag { font-family: var(--mono); font-size: .6rem; border: 1px solid var(--border-light); border-radius: 20px; padding: 1px 7px; margin-right: 4px; color: var(--muted); }
  .tag.lock { border-color: var(--warn); color: var(--warn); }
  .row input, .row select { width: 100%; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .row input:focus, .row select:focus { outline: none; border-color: var(--accent); }
  .row input:disabled, .row select:disabled { opacity: .6; }
  .changed { border-color: var(--warn) !important; }
  .help { grid-column: 2; font-size: .75rem; color: var(--muted); line-height: 1.4; }
  .inline { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .inline input { width: auto; flex: 1; min-width: 140px; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .inline input.icon { flex: 0 0 90px; min-width: 70px; text-align: center; }
  .kv { font-family: var(--mono); font-size: .75rem; color: var(--muted); margin-bottom: 10px; line-height: 1.6; }
  .savebar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 12px 32px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  #status { font-family: var(--mono); font-size: .75rem; flex: 1; min-width: 200px; }
  #status.err { color: var(--accent2); } #status.ok { color: var(--ok); } #status.busy { color: var(--warn); }
  @media (max-width: 700px) { header, main, .savebar { padding-left: 16px; padding-right: 16px; } .row { grid-template-columns: 1fr; } .help { grid-column: 1; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>⚙ <span id="title">CAMERA</span></h1>
    <p id="subtitle">Camera settings</p>
  </div>
  <a class="btn" href="index.php">← DASHBOARD</a>
</header>

<main>
  <div id="banners"></div>
  <div class="kv" id="calib-help" hidden>Calibrating the person detector: keep the dashboard open next to this page and watch the detector's BRIGHTNESS, MOTION and HUMAN readings.
DARK_THRESH: set it just below the brightness the picture has when it is too dark to see a person.
MOTION_THRESH: set it above the motion value of a still scene and below what a person walking makes.
DETECT_THRESH / CLEAR_THRESH: the HUMAN score that switches the alarm pin on / back off (CLEAR must not be higher than DETECT).
Applying restarts the detector (about 10 seconds without a picture); then check the readings on the dashboard again.</div>
  <fieldset id="entry" hidden>
    <legend>On the dashboard</legend>
    <div class="inline">
      <input id="e-icon" class="icon" maxlength="8" aria-label="Icon" autocomplete="off">
      <input id="e-name" maxlength="60" aria-label="Name" autocomplete="off">
      <button class="btn" id="e-save">SAVE NAME</button>
    </div>
    <div class="kv">Camera id: <b id="e-id"></b> — it must equal the board's CAMERA_ID setting, so it cannot be edited here.</div>
    <div class="inline" title="The person detector board (ESP32_CAM_TFLite_Person) wired to this camera's alarm input. Its DETECTOR_ID setting. Leave empty for none.">
      <input id="e-detector" maxlength="64" placeholder="detector-1" aria-label="Person detector id" autocomplete="off" spellcheck="false">
      <button class="btn" id="e-detector-save">SAVE DETECTOR</button>
    </div>
    <div class="kv">Person detector id: its <b>DETECTOR_ID</b> setting. When set, the dashboard shows the detector's 96×96 picture, its brightness / motion / person values and its alarm pin level under this camera's picture. Empty = none.</div>
    <button class="btn danger" id="e-remove">🗑 REMOVE FROM DASHBOARD</button>
  </fieldset>

  <div class="kv" id="state"></div>
  <form id="form" onsubmit="return false;"></form>
</main>

<div class="savebar">
  <button class="btn primary" id="save" disabled>⬆ APPLY TO CAMERA</button>
  <button class="btn" id="revert" disabled>↺ REVERT</button>
  <button class="btn" id="cancel" hidden>✖ WITHDRAW QUEUED CHANGE</button>
  <span id="status">Loading…</span>
</div>

<script>
  const CAM = new URLSearchParams(location.search).get('cam') || '';
  const AJAX = { 'X-Requested-With': 'camdash' };
  const TYPE = new URLSearchParams(location.search).get('type') === 'detector' ? 'detector' : 'recorder';
  const WHO = TYPE === 'detector' ? 'detector' : 'camera';
  const API = 'camera-settings.php?cam=' + encodeURIComponent(CAM) + (TYPE === 'detector' ? '&type=detector' : '');
  let keys = [], gpios = [], reported = null, camera = null, original = {}, pollTimer = null;

  const $ = (id) => document.getElementById(id);
  const form = $('form'), statusEl = $('status'), saveBtn = $('save'), revertBtn = $('revert'), cancelBtn = $('cancel');
  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ''; }
  function el(tag, props, ...kids) { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids) e.append(k); return e; }
  function banner(t, cls) { $('banners').append(el('div', { className: 'banner ' + cls, textContent: t })); }
  function ago(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; }

  // Is this setting needed, given the values? (same rule as the firmware and camera-settings.php)
  function required(def, vals) {
    if (def.cond === 'always' || def.condKey === null) return true;
    if (vals[def.condKey] === undefined || vals[def.condKey] === '') return true;
    const eq = vals[def.condKey] === def.condValue;
    return def.cond === 'equals' ? eq : !eq;
  }
  const isFixed = (d) => d.locked || d.kind === 'secret' || d.kind === 'wifi';

  function makeInput(d, value) {
    const opts = (list) => { const s = el('select'); for (const [v, t] of list) s.append(el('option', { value: v, textContent: t })); return s; };
    let input;
    if (d.kind === 'bool') input = opts([['1', 'On (1)'], ['0', 'Off (0)']]);
    else if (d.kind === 'level') input = opts([['LOW', 'LOW'], ['HIGH', 'HIGH']]);
    else if (d.kind === 'pin' || d.kind === 'pin_or_off') input = opts((d.kind === 'pin_or_off' ? [['-1', 'Off (-1)']] : []).concat(gpios.map((g) => [String(g), 'GPIO ' + g])));
    else if (d.kind === 'int' || d.kind === 'float') { input = el('input', { type: 'number', min: d.min, max: d.max, step: d.kind === 'int' ? 1 : 'any' }); }
    else input = el('input', { type: 'text', spellcheck: false, autocomplete: 'off' });
    if (input.tagName === 'SELECT' && value === undefined) input.prepend(el('option', { value: '', textContent: '— choose —' }));
    input.value = value === undefined ? '' : value;
    return input;
  }

  function render(data) {
    camera = data.camera; keys = data.keys; gpios = data.gpios;
    const st = data.state; reported = st.reported ? st.reported.settings : null;
    $('title').textContent = camera.icon + ' ' + camera.name + (TYPE === 'detector' ? ' — detector' : '');
    document.title = camera.name + (TYPE === 'detector' ? ' detector calibration' : ' settings') + ' — ESP32-CAM Dashboard';
    if (TYPE === 'detector') { $('subtitle').textContent = 'Person detector calibration (' + camera.deviceId + ')'; $('calib-help').hidden = false; $('calib-help').style.whiteSpace = 'pre-line'; }
    $('entry').hidden = TYPE === 'detector'; $('e-icon').value = camera.icon; $('e-name').value = camera.name; $('e-id').textContent = camera.id; $('e-detector').value = camera.detector || '';
    $('banners').textContent = ''; form.textContent = ''; original = {};

    const parts = [];
    if (st.reported) parts.push('Settings reported by the ' + WHO + ' ' + ago(st.now - st.reported.at));
    if (st.pending) parts.push('QUEUED: ' + st.pending.keys.join(', ') + ' (queued ' + ago(st.now - st.pending.at) + ') — waiting for the ' + WHO + ' to pick it up');
    if (st.last) parts.push('Last change: ' + st.last.result.toUpperCase() + (st.last.message ? ' — ' + st.last.message : '') + ' (' + ago(st.now - st.last.at) + ')');
    $('state').textContent = parts.join('\n'); $('state').style.whiteSpace = 'pre-line';
    cancelBtn.hidden = !st.pending;

    if (!reported) {
      banner('This ' + WHO + ' has not reported its settings yet. It reports once it runs the firmware that supports remote settings (' + (TYPE === 'detector' ? 'flash the detector with the current ESP32_CAM_TFLite_Person sketch, or publish it with ota-deploy.sh detector' : 'publish it with ota-deploy.sh') + ') and has reached the relay — then this page fills in.' + (TYPE === 'detector' ? '' : ' You can still rename it or remove it from the dashboard above.'), 'warn');
      saveBtn.disabled = revertBtn.disabled = true;
      return;
    }
    const fs = el('fieldset', {}, el('legend', { textContent: 'Stored in the ' + WHO }));
    for (const d of keys) {
      const id = 'f-' + d.name, fixed = isFixed(d);
      const value = reported[d.name];
      const input = makeInput(d, value);
      input.id = id; input.name = d.name;
      if (fixed) input.disabled = true;
      if (fixed && (d.kind === 'secret' || d.kind === 'wifi')) { input.type = 'text'; input.value = value === undefined ? '(not set)' : value; }
      original[d.name] = value === undefined ? '' : String(value);
      input.addEventListener('input', () => { refresh(); });
      input.addEventListener('change', () => { refresh(); });
      const tags = el('span', { className: 'tags' });
      if (fixed) tags.append(el('span', { className: 'tag lock', textContent: 'serial only' }));
      const row = el('div', { className: 'row', id: 'r-' + d.name }, el('div', {}, el('label', { htmlFor: id, textContent: d.name }), tags), input, el('div', { className: 'help', textContent: d.help + (fixed ? (TYPE === 'detector' ? ' — connects the detector to the relay or drives its alarm pin, so it can only be changed over the USB serial port.' : ' — connects the camera to the relay, so it can only be changed over the USB serial port.') : '') }));
      fs.append(row);
    }
    form.append(fs);
    refresh();
  }

  function currentValues() {
    const v = {};
    for (const d of keys) {
      const i = $('f-' + d.name);
      v[d.name] = isFixed(d) ? (reported[d.name] === undefined ? '' : String(reported[d.name])) : i.value;
    }
    return v;
  }
  // Shows what the current values make necessary: unused settings are dimmed, and a setting that
  // is needed but has no value yet (a feature was just switched on) appears.
  function refresh() {
    const vals = currentValues();
    for (const d of keys) {
      const row = $('r-' + d.name), i = $('f-' + d.name);
      const need = required(d, vals), has = reported[d.name] !== undefined;
      row.hidden = !need && !has;
      row.classList.toggle('unused', !need);
      i.classList.toggle('changed', !isFixed(d) && i.value !== original[d.name]);
    }
    const n = Object.keys(changes().values).length;
    saveBtn.disabled = n === 0; revertBtn.disabled = n === 0;
    if (n > 0) setStatus(n + ' unsaved change' + (n === 1 ? '' : 's'), '');
  }
  // Only what differs from what the camera holds (plus a needed setting that has no value yet).
  function changes() {
    const vals = currentValues(), out = {}; let missing = null;
    for (const d of keys) {
      if (isFixed(d)) continue;
      const need = required(d, vals);
      if (!need && reported[d.name] === undefined) continue;
      if (vals[d.name] === '') { if (need) missing = missing || d.name; continue; }
      if (vals[d.name] !== original[d.name]) out[d.name] = vals[d.name];
    }
    return { values: out, missing };
  }

  async function load(keepStatus) {
    if (!keepStatus) setStatus('Loading…');
    try {
      const res = await fetch(API, { headers: AJAX });
      const data = await res.json();
      if (!res.ok) { $('banners').textContent = ''; banner(data.error || ('Error ' + res.status), 'err'); setStatus(data.error || ('Error ' + res.status), 'err'); return null; }
      render(data);
      if (!keepStatus) setStatus('Loaded.');
      schedulePoll(data.state);
      return data;
    } catch (e) { setStatus('Could not load: ' + e.message, 'err'); return null; }
  }
  // While a change is queued, look every few seconds so the page shows when the camera has applied it.
  function schedulePoll(state) {
    clearTimeout(pollTimer);
    if (state && state.pending) pollTimer = setTimeout(async () => {
      const d = await load(true);
      if (d && !d.state.pending && d.state.last) setStatus((TYPE === 'detector' ? 'Detector' : 'Camera') + ' answered: ' + d.state.last.result + (d.state.last.message ? ' — ' + d.state.last.message : ''), d.state.last.result === 'applied' ? 'ok' : 'err');
    }, 3000);
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX), body: JSON.stringify(body) });
    return { res, data: await res.json().catch(() => ({})) };
  }

  saveBtn.addEventListener('click', async () => {
    const c = changes();
    if (c.missing) { setStatus(c.missing + ' is needed too — give it a value', 'err'); return; }
    if (!Object.keys(c.values).length) return;
    if (TYPE === 'detector') {
      const v = currentValues(), d = parseFloat(v.DETECT_THRESH), cl = parseFloat(v.CLEAR_THRESH);
      if (!isNaN(d) && !isNaN(cl) && cl > d) { setStatus('CLEAR_THRESH (' + v.CLEAR_THRESH + ') must not be higher than DETECT_THRESH (' + v.DETECT_THRESH + ')', 'err'); return; }
    }
    if (!confirm('Apply ' + Object.keys(c.values).join(', ') + ' to ' + (TYPE === 'detector' ? 'the detector of ' : '') + camera.name + '?\n\n' + (TYPE === 'detector' ? 'The detector restarts to apply it (its picture and alarm pin pause for about 10 seconds).' : 'The camera restarts to apply it (its stream and any recording stop for a few seconds).'))) return;
    saveBtn.disabled = revertBtn.disabled = true; setStatus('Queuing…', 'busy');
    try {
      const { res, data } = await post(API, { values: c.values });
      if (!res.ok || !data.ok) { setStatus(data.error || ('Error ' + res.status), 'err'); refresh(); return; }
      await load(true);
      setStatus(data.message, data.queued ? 'busy' : 'ok');
    } catch (e) { setStatus('Failed: ' + e.message, 'err'); refresh(); }
  });
  revertBtn.addEventListener('click', () => { for (const d of keys) { if (isFixed(d)) continue; $('f-' + d.name).value = original[d.name]; } refresh(); setStatus('Reverted.', ''); });
  cancelBtn.addEventListener('click', async () => {
    const { res, data } = await post(API, { cancel: true });
    setStatus(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'err');
    load(true);
  });

  $('e-save').addEventListener('click', async () => {
    const { res, data } = await post('camera-admin.php', { action: 'update', id: CAM, name: $('e-name').value, icon: $('e-icon').value });
    setStatus(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'err');
    if (res.ok) load(true);
  });
  $('e-detector-save').addEventListener('click', async () => {
    const { res, data } = await post('camera-admin.php', { action: 'detector', id: CAM, detector: $('e-detector').value });
    setStatus(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'err');
    if (res.ok) load(true);
  });
  $('e-remove').addEventListener('click', async () => {
    if (!confirm('Remove ' + camera.name + ' from the dashboard?\n\nIts recordings are kept and the board is not touched. You can add it again later with the same id.')) return;
    const { res, data } = await post('camera-admin.php', { action: 'remove', id: CAM });
    if (res.ok) location.href = 'index.php'; else setStatus(data.error || ('Error ' + res.status), 'err');
  });

  load();
</script>
</body>
</html>
