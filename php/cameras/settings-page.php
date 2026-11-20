<?php
// settings-page.php — THE settings page: the main system's settings (the relay's and the dashboard's
// own) plus the camera list, in the Settings Atlas layout (F-29 T7d, designs/Category-v2.png). What
// used to be two views — the one-page form of the old settings hub and the Atlas layout on
// relay-settings-page.php — is one page now (F-38): the Atlas is all there is, the old form is gone.
// The form is drawn from what system-settings.php sends, so a setting added there shows up here
// without touching this file; saving, and restarting the relay when a change needs it, is done by
// system-settings.php. Every setting of every tier is on the page (F-37: there is no LEVEL switch).
//
// The page follows the Settings Atlas design:
//   * a CATEGORY RAIL on the left — one entry per category (the relay's `group`, the dashboard's own
//     values are the "Dashboard" category), with the number of settings in it, in the order the page
//     promises, plus the CAMERAS entry at the end: the camera list of the old hub lives there now.
//     One category is shown at a time; edits made in another stay pending (see the tray).
//   * one row per setting: the short key with its tags ("affects cameras" for the keys flashed into
//     every board, "locked — config.js only" for the rows that decide which program the relay runs,
//     "changed" while the row holds an unsaved edit), the readable label, the help text, and the value
//     tags ("restarts relay", "set by …" for a row the environment overrides, "from config.js" for a
//     value read from there, and the default itself, highlighted while the shown value differs from
//     it). A number row shows its allowed range; one with a default can be reset to it with the row's
//     ↺ DEFAULT button, which goes through the same change tracking as a hand edit. The file and
//     folder paths are not on the page at all (F-09): system-settings.php filters them out.
//   * a PENDING-CHANGES tray at the bottom: every unsaved edit of every category with its old → new
//     value, a DISCARD button, and ONE apply button — nothing is written until it is pressed.
//     Applying saves through system-settings.php: the relay saves its settings, the dashboard writes
//     its own, and a save that needs it restarts the relay. The camera list and the alarm sound
//     library act at once; they are not part of APPLY.
//
// The SEARCH BOX at the top is always there (F-38, the old "JUMP TO SETTING" page is gone): it asks
// settings-search-index.php for the index of EVERY setting — each camera's keys, each detector's keys
// and the relay's and dashboard's own fields — and js/settings-search.js does the matching, the scope
// pills and the list. Typing shows the result list in the search's place; emptying the box brings the
// settings page back (as the ESC key does). A hit opens the page the setting is edited on with
// ?find=KEY — the camera settings page shows the key's category with the row framed and focused, this
// page opens the key's own category with the row framed — so the search is a jump, not a second
// editor: nothing is changed by it.
//
// The alarm sound library (js/sound-library.js) is listed in the "Alarm sounds" category: the sound
// rows are choices among its files, so it is shown with them.
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
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 14px 32px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .crumbs { font-family: var(--mono); font-size: .68rem; letter-spacing: .1em; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
  .crumbs .here { color: var(--accent); }
  .pending-pill { font-family: var(--mono); font-size: .7rem; letter-spacing: .12em; color: var(--warn); border: 1px solid var(--warn); border-radius: 20px; padding: 4px 12px; white-space: nowrap; }
  .btn { font-family: var(--mono); font-size: .75rem; padding: 7px 14px; border-radius: var(--radius); border: 1px solid var(--border-light); background: transparent; color: var(--text); cursor: pointer; letter-spacing: .06em; text-decoration: none; display: inline-block; transition: all .2s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 32px 150px; }
  .banner { border: 1px solid var(--border-light); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: .85rem; line-height: 1.4; }
  .banner.warn { border-color: var(--warn); color: var(--warn); }
  .banner.err  { border-color: var(--accent2); color: var(--accent2); }
  .banner.ok   { border-color: var(--ok); color: var(--ok); }
  /* ── the search box (F-38, designs/Search-v2.png): always there, the results take the page's place
     while a query is in it ── */
  .searchbox { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius); padding: 0 16px; height: 52px; }
  .searchbox:focus-within { box-shadow: 0 0 0 1px var(--accent); }
  .searchbox svg { flex: 0 0 auto; }
  .searchbox input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--text); font-family: var(--mono); font-size: 16px; }
  .searchbox input:focus { outline: none; }
  .searchbox input::placeholder { color: var(--muted); }
  .chip { font-family: var(--mono); font-size: .68rem; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; padding: 2px 7px; white-space: nowrap; }
  button.chip { cursor: pointer; background: transparent; }
  button.chip:hover { border-color: var(--accent); color: var(--accent); }
  #search-area { margin: 16px 0 0; }
  .scopebar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .scopebar .lbl { font-family: var(--mono); font-size: .68rem; letter-spacing: .1em; color: var(--muted); }
  .scope-pill { font-family: var(--mono); font-size: .75rem; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); color: var(--text); background: transparent; cursor: pointer; }
  .scope-pill:hover { border-color: var(--border-light); color: var(--accent); }
  .scope-pill.on { border-color: var(--accent); color: var(--accent); background: rgba(0, 229, 255, .07); }
  #results { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); min-height: 64px; }
  .hit { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); color: inherit; text-decoration: none; }
  .hit:last-child { border-bottom: 0; }
  .hit.sel { background: rgba(0, 229, 255, .07); }
  .hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .hit-what { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .hit-key { font-family: var(--mono); font-size: .88rem; }
  .hit-label { font-size: .82rem; color: var(--text); opacity: .85; }
  .hit-chips { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip.reboot { border-color: var(--warn); color: var(--warn); }
  .hit-value { font-family: var(--mono); font-size: .82rem; color: var(--text); min-width: 48px; text-align: right; }
  .search-hint { padding: 18px 16px; font-size: .85rem; color: var(--muted); line-height: 1.5; }
  .search-hint.err { color: var(--accent2); }
  #note { font-size: .8rem; color: var(--warn); line-height: 1.45; min-height: 0; display: block; }
  #footer-hint { font-size: .8rem; color: var(--muted); line-height: 1.5; margin-top: 10px; }
  /* ── the Atlas layout: category rail + one category's rows ── */
  .page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 8px 28px; align-items: start; margin-top: 16px; }
  .rail { position: sticky; top: 14px; display: flex; flex-direction: column; gap: 2px; }
  .rail .rail-head { font-family: var(--mono); font-size: .62rem; letter-spacing: .18em; color: var(--muted); padding: 2px 10px 8px; text-transform: uppercase; }
  .rail-item { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; text-align: left; font-family: var(--sans); font-weight: 400; font-size: .88rem; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: var(--radius); padding: 7px 10px; cursor: pointer; }
  .rail-item:hover { border-color: var(--border-light); }
  .rail-item.on { border-color: var(--accent); color: var(--accent); background: rgba(0, 229, 255, .06); }
  .rail-count { font-family: var(--mono); font-size: .68rem; color: var(--muted); }
  .catwrap { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px 24px; flex-wrap: wrap; margin-bottom: 10px; }
  .cat-head h2 { font-size: 1.35rem; font-weight: 500; letter-spacing: .01em; }
  .cat-head p { font-size: .82rem; color: var(--muted); margin-top: 4px; max-width: 560px; line-height: 1.45; }
  /* ── one setting row: what (key, label, tags, help) left, the value (range, input, reset) right ── */
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px); gap: 2px 20px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 10px; align-items: start; }
  /* the row the search jumped to (?find=key, F-29 T7b) */
  .row.found { border-color: var(--accent); background: rgba(0, 229, 255, .07); }
  .keyline { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .keyline label { font-weight: 500; font-size: .92rem; font-family: var(--mono); letter-spacing: .02em; }
  .tags { display: inline-flex; gap: 4px; flex-wrap: wrap; align-items: baseline; }
  .tag { font-family: var(--mono); font-size: .6rem; border: 1px solid var(--border-light); border-radius: 20px; padding: 1px 7px; color: var(--muted); white-space: nowrap; }
  .tag.lock, .tag.restart { border-color: var(--warn); color: var(--warn); }
  .tag.danger { border-color: var(--accent2); color: var(--accent2); }
  .tag.changed { border-color: var(--warn); color: var(--warn); background: rgba(255, 176, 32, .12); }
  .tag.default { border-color: var(--accent); color: var(--accent); }
  .tag.defval.differs { border-color: var(--warn); color: var(--warn); }
  .rowlabel { font-size: .9rem; font-weight: 400; margin-top: 3px; }
  .tagrow { margin-top: 7px; }
  .side { grid-row: 1 / span 3; grid-column: 2; display: flex; flex-direction: column; gap: 6px; }
  .range { font-family: var(--mono); font-size: .62rem; letter-spacing: .12em; color: var(--muted); text-transform: uppercase; text-align: right; }
  .ctl { display: flex; gap: 8px; align-items: stretch; }
  .ctl input, .ctl select { flex: 1; min-width: 0; width: auto; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .ctl input:focus, .ctl select:focus { outline: none; border-color: var(--accent); }
  .ctl input:disabled, .ctl select:disabled { opacity: .6; }
  .ctl input.changed, .ctl select.changed { border-color: var(--warn); }
  .btn.reset { flex: 0 0 auto; white-space: nowrap; font-size: .62rem; padding: 5px 9px; border-color: var(--border); color: var(--muted); }
  .help { grid-column: 1; font-size: .75rem; color: var(--muted); line-height: 1.4; margin-top: 5px; }
  /* ── the alarm sound library: acts at once, so it sits apart from the rows it feeds ── */
  .sound-slot { border: 1px dashed var(--border-light); border-radius: var(--radius); padding: 4px 14px 8px; margin-bottom: 14px; }
  .sound-slot .slot-help { font-size: .72rem; color: var(--muted); line-height: 1.4; padding: 8px 0 2px; }
  /* ── the cameras list (the old hub's fieldset, one category of the rail now) ── */
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px 6px; margin-bottom: 20px; background: var(--surface); }
  fieldset legend { font-family: var(--mono); font-size: .8rem; letter-spacing: .1em; color: var(--accent); padding: 0 8px; text-transform: uppercase; }
  .cams .cam-row { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .cams .cam-row:first-of-type { border-top: 0; }
  .cams .cam-row .nm { flex: 1; min-width: 160px; font-size: .95rem; }
  .cams .cam-row .nm small { font-family: var(--mono); color: var(--muted); margin-left: 6px; }
  .cams .add { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 0 6px; border-top: 1px solid var(--border); }
  .cams .add input { flex: 1; min-width: 120px; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .cams .add input.icon { flex: 0 0 80px; min-width: 60px; text-align: center; }
  .cams .add .icon-picker { flex-basis: 80px; min-width: 60px; }
  /* The hidden attribute must win over this page's own display rules — .btn, .row, .rail, .catwrap,
     .page and #search-area's children set one, and an author display would otherwise beat the browser's
     [hidden] (the same note as Layout.php's .btn). */
  .btn[hidden], .row[hidden], .rail[hidden], .catwrap[hidden], .pending-pill[hidden], .tag[hidden], .page[hidden], #search-area[hidden], #note[hidden], #cameras[hidden], #tray-note[hidden], #pending-list[hidden], #sound-slot[hidden] { display: none; }
  /* ── the pending-changes tray: every unsaved edit, DISCARD, and the one APPLY ── */
  .tray { position: fixed; left: 0; right: 0; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 10px 32px 12px; }
  .tray.has-changes { border-top-color: var(--warn); background: #16130b; }
  #pending-list { max-height: 150px; overflow-y: auto; margin-bottom: 8px; }
  .pending-row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; font-family: var(--mono); font-size: .74rem; padding: 3px 0; }
  .pending-row b { color: var(--accent); font-weight: 400; }
  .pending-row .pv { color: var(--text); }
  .pending-row .pc { color: var(--muted); font-size: .66rem; }
  #tray-note { font-size: .78rem; color: var(--warn); line-height: 1.45; margin-bottom: 8px; }
  .traybar { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  #status { font-family: var(--mono); font-size: .75rem; flex: 1; min-width: 200px; }
  #status.err { color: var(--accent2); } #status.ok { color: var(--ok); } #status.busy { color: var(--warn); }
  @media (max-width: 800px) {
    header, main, .tray { padding-left: 16px; padding-right: 16px; }
    .page { grid-template-columns: 1fr; }
    .rail { position: static; flex-direction: row; flex-wrap: wrap; padding-bottom: 6px; }
    .rail .rail-head { flex-basis: 100%; }
    .row { grid-template-columns: 1fr; }
    .side { grid-column: 1; grid-row: auto; }
    .help { grid-column: 1; }
    .pending-pill { order: 3; }
    .hit-value { min-width: 0; }
  }
<?= CamLayout::navBarStyle() ?>
<?= CamLayout::busyStyle() ?>
<?= CamLayout::iconPickerStyle() ?>
</style>
</head>
<body>
<?= CamLayout::navBar(null) ?>
<header>
  <div>
    <nav class="crumbs" aria-label="Where you are"><span class="here">SETTINGS</span></nav>
    <h1>⚙ SETTINGS</h1>
    <p>Relay, dashboard and cameras · the main system's settings</p>
  </div>
  <span class="pending-pill" id="pending-count" hidden>0 PENDING</span>
</header>

<main>
  <div id="banners"></div>

  <div class="searchbox" id="searchbox">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>
    <input id="q" type="text" aria-label="Jump to any setting" placeholder="Jump to any setting: try jpeg, port, alarm" autocomplete="off" spellcheck="false"
           aria-controls="results" aria-describedby="footer-hint">
    <button class="chip" id="esc" type="button" title="Clear the search; again goes back">ESC</button>
  </div>
  <div id="search-area" hidden>
    <div class="scopebar" id="scopebar" role="group" aria-label="Scope">
      <span class="lbl">SHOW</span>
    </div>
    <div id="results" role="listbox" aria-label="Matching settings"></div>
    <span id="note" aria-live="polite"></span>
    <footer id="footer-hint">Searches names, plain-language labels and help text. Enter opens the category with the setting highlighted.</footer>
  </div>

  <div class="page" id="page">
    <nav class="rail" id="rail" hidden aria-label="Setting categories"></nav>
    <div class="content">
      <div class="catwrap" id="catwrap" hidden>
        <div class="cat-head">
          <h2 id="cat-title"></h2>
          <p id="cat-desc"></p>
        </div>
      </div>
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
      <form id="form" onsubmit="return false;"></form>
    </div>
  </div>
</main>

<div class="tray" id="tray">
  <div id="pending-list"></div>
  <div id="tray-note" hidden></div>
  <div class="traybar">
    <button class="btn" id="revert" disabled>↺ DISCARD</button>
    <button class="btn primary" id="save" disabled>⬆ APPLY</button>
    <span id="status">Loading…</span>
  </div>
</div>

<script src="js/toast.js"></script>
<script src="js/busy.js"></script>
<script src="js/settings-search.js"></script>
<script src="js/icon-catalog.js"></script>
<script src="js/icon-picker.js"></script>
<script src="js/sound-library.js"></script>
<script>
  const AJAX = { 'X-Requested-With': 'camdash' };
  const GROUP_ORDER = ['Recording', 'Person check', 'Alarm sounds', 'Network', 'Keys', 'Log', 'Folders', 'Detectors', 'Notifications', 'Security', 'Diagnostics', 'Dashboard'];
  const BREAKING = ['camKey', 'pushPort'];   // flashed into every camera: changing them stops the connections
  const NUMERIC = ['int', 'float'];          // drawn as a number input (a float's step comes from the relay)
  const SECRET_MASK = '********';
  const CAMERAS_CAT = 'Cameras';             // the rail entry that is not a settings group: the camera list
  let fields = [];
  let cams = [];         // the cameras the server sent (id, name, icon)
  let original = {};   // key -> the value loaded from the server (secrets: '')
  let activeCat = null;      // the category shown; null until the first render picks the first one
  // A jump from the search (?find=KEY, F-29 T7b): the key's category opens with the row framed. A key
  // the relay does not have is ignored — the page then opens as always. Relay keys are camelCase and
  // case-sensitive, so the word is taken as it comes.
  const FIND = new URLSearchParams(location.search).get('find') || '';
  let foundShown = false;    // the jump is applied once: a reload after a save must not scroll away again

  const $ = (id) => document.getElementById(id);
  const form = $('form'), statusEl = $('status'), saveBtn = $('save'), revertBtn = $('revert');
  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }
  // The result of pressing a button (APPLY, DISCARD, a camera's add / remove): a toast popup (F-12)
  // instead of a message in the tray. The tray's own #status line stays for the passive states
  // (loading, pending-changes count, saving...).
  function notify(text, kind) { CamToast.show(text, kind || 'info'); }
  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children) e.append(c);
    return e;
  }
  function banner(text, cls) { $('banners').append(el('div', { className: 'banner ' + cls, textContent: text })); }

  // ── categories (the Atlas rail) ──
  // The relay names a group for every setting (the dashboard's own values are the "Dashboard" group); they
  // are shown in the order the page promises, with a group the relay gains later after the known ones. A
  // value without a group (should not happen) shares the last entry, "Other".
  const CAT_DESC = {
    'Recording': 'How long alarm recordings run, the pre-roll, and when the recording disk counts as full.',
    'Person check': 'Sorting out recordings without a person in them, and how sure the detector must be.',
    'Alarm sounds': 'Which sound plays where when an alarm starts or a person is found — the sound files it chooses from are listed with them.',
    'Network': 'The relay\u2019s ports: where the dashboard reaches it and where the cameras push their frames.',
    'Keys': 'The shared secrets: what the cameras must match, and what protects the relay\u2019s controls.',
    'Log': 'How large the relay\u2019s own log grows, and how many rotated files are kept.',
    'Detectors': 'The person detector\u2019s live view on the dashboard, and its no-picture warning.',
    'Notifications': 'The Telegram messages and the links they carry, and how often they may repeat.',
    'Security': 'Who may read, how failed logins are locked out, and the strict response headers.',
    'Diagnostics': 'Watchdogs that report when the relay itself stalls.',
    'Dashboard': 'This dashboard\u2019s own settings: its login, where it reaches the relay, and how its pages behave.',
  };
  const OTHER_CAT = { label: 'Other', desc: 'Values the relay names no group for — everything else has one.' };
  const CAMERAS_DESC = 'The cameras this dashboard shows — adding and removing acts at once, it is not part of APPLY.';
  const catOf = (f) => f.group || '';
  const catLabel = (c) => (c === '' ? OTHER_CAT.label : c);
  function catList() {
    const seen = [];
    for (const f of fields) { const c = catOf(f); if (!seen.includes(c)) seen.push(c); }
    const known = GROUP_ORDER.filter((g) => seen.includes(g));
    const unknown = seen.filter((g) => g !== '' && !GROUP_ORDER.includes(g));
    return seen.includes('') ? known.concat(unknown, ['']) : known.concat(unknown);
  }

  // ── values as text ──
  // What one value looks like in the page's inputs: a switch as the text the relay takes ("true" /
  // "false"), a command as one line, everything else as plain text.
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
  // A value as it is spoken about in words (the tray): an empty one is "none", a secret never shows what
  // it holds, a switch reads on/off, everything else as text.
  function fmtValue(f, v) {
    if (f && f.type === 'secret') return v === '' ? '(empty)' : SECRET_MASK;
    if (v === '') return '(none)';
    if (f && f.type === 'bool') return v === 'true' ? 'on' : v === 'false' ? 'off' : String(v);
    return String(v);
  }
  function rangeText(f) {
    if (f.type === 'bool') return 'ON / OFF';
    if (NUMERIC.includes(f.type) && f.max !== undefined && f.max !== null) return f.min + ' TO ' + f.max;
    return '';
  }

  // A true/false setting is an ON/OFF choice whose value is the text the relay takes ("true" / "false"), so it
  // goes through the same change tracking, discard and save as every other field.
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
  // A word choice (what to do with a clip without a person, ...): one of the relay's offered words.
  // The saved word is always selectable, even when the relay did not list it (the same rule as the sounds).
  function choiceInput(id, f) {
    const select = el('select', { id, name: f.key });
    for (const o of (f.options || [])) select.append(el('option', { value: o, textContent: o }));
    const saved = asText(f.value);
    if (saved !== '' && !(f.options || []).includes(saved)) select.append(el('option', { value: saved, textContent: saved + ' (not offered)' }));
    return select;
  }

  // The sound files themselves: list, try, upload, delete (js/sound-library.js). They act at once, like the
  // camera list — they are not part of APPLY. The slot shows only in the Alarm sounds category.
  function soundSlot() {
    const box = el('div', { className: 'cams sound-library' });
    const slot = el('div', { id: 'sound-slot', className: 'sound-slot' },
      el('div', { className: 'slot-help', textContent: 'The sound files the choices below pick from — uploading and deleting act at once; they are not part of APPLY.' }),
      box);
    if (window.CamSoundLibrary) {
      window.CamSoundLibrary.mount(box, { fetch: window.fetch.bind(window), notify, confirm: (text) => confirm(text), onChange: refreshSoundOptions, run: CamBusy.run }).refresh();
    }
    return slot;
  }
  // The library changed (a sound uploaded or deleted): every sound choice offers the new list, keeping what is chosen.
  function refreshSoundOptions(names) {
    for (const f of fields.filter((x) => x.type === 'sound')) {
      const select = $('f-' + f.key);
      if (!select) continue;
      fillSoundOptions(select, names, original[f.key], select.value);
      select.classList.toggle('changed', select.value !== original[f.key]);
    }
    refresh();
  }

  // ── the cameras: list, add, remove (each acts at once — they are not part of APPLY) ──
  function renderCameras(list) {
    cams = list;
    const box = $('cam-list');
    box.textContent = '';
    if (!list.length) box.append(el('div', { className: 'help', textContent: 'No cameras yet — add one below.' }));
    for (const c of list) {
      const rm = el('button', { className: 'btn', textContent: '🗑 REMOVE' });
      rm.addEventListener('click', () => CamBusy.run(rm, () => removeCamera(c)));
      const settings = el('a', { className: 'btn', href: 'camera-settings-page.php?cam=' + encodeURIComponent(c.id), textContent: '⚙ SETTINGS' });
      settings.setAttribute('data-page-load', '');   // opens a page: js/busy.js covers this one meanwhile
      box.append(el('div', { className: 'cam-row' },
        el('div', { className: 'nm' }, c.icon + ' ' + c.name, el('small', { textContent: c.id })),
        settings, rm));
    }
  }
  async function cameraAction(body) {
    const res = await fetch('camera-admin.php', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { notify(data.error || ('Error ' + res.status), 'error'); return false; }
    renderCameras(data.cameras);
    renderRail();   // the Cameras entry counts them
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

  // ── one row: key + tags, readable label, help on the left; range, input, reset on the right ──
  function buildRow(f) {
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
      // a secret is never shown: only whether it is set (the server never sends the value either)
      input.placeholder = f.isSet ? '(set — leave empty to keep)' : '(not set)';
      original[f.key] = '';
    } else {
      input.value = f.value === undefined || f.value === null ? '' : asText(f.value);
      original[f.key] = input.value;
    }
    if (locked || f.envOverride) { input.disabled = true; }
    input.addEventListener('input', () => { refresh(); });
    input.addEventListener('change', () => { refresh(); });

    // Reset to default: the default goes into the input, and from there through the SAME change
    // tracking and save as a hand-made change (no separate path to the relay). No button while the
    // input already holds the default, and none for what has no default (secrets, locked rows,
    // environment-read-only rows).
    const defText = defaultEdit(f);
    const reset = (defText === undefined || locked || f.envOverride) ? null : el('button', {
      className: 'btn reset', type: 'button', title: 'Put the default back, then APPLY', textContent: '↺ DEFAULT',
    });
    if (reset) {
      reset.disabled = input.value === defText;
      input.addEventListener('input', () => { reset.disabled = input.value === defText; });
      reset.addEventListener('click', () => { input.value = defText; input.dispatchEvent(new Event('input', { bubbles: true })); });
    }

    // Tags beside the key: what a change of this value does to the cameras, whether the page may change it
    // at all, and that it is edited right now.
    const keyTags = el('span', { className: 'tags' });
    if (BREAKING.includes(f.key)) keyTags.append(el('span', { className: 'tag danger', textContent: 'affects cameras', title: 'changing it stops every camera from connecting until each board is updated with the new value' }));
    if (locked) keyTags.append(el('span', { className: 'tag lock', textContent: 'locked — config.js only' }));
    keyTags.append(el('span', { className: 'tag changed', id: 'c-' + f.key, hidden: true, textContent: 'changed' }));

    // Value tags: when a change takes effect, where the value comes from, and what the default is.
    const tags = el('span', { className: 'tags' });
    if (f.restart) tags.append(el('span', { className: 'tag restart', textContent: 'restarts relay', title: 'takes effect only after the relay restarts' }));
    if (f.envOverride) tags.append(el('span', { className: 'tag', textContent: 'set by ' + f.envName + ' (read-only)' }));
    else if (f.source && f.source !== 'settings') tags.append(el('span', { className: 'tag', textContent: 'from ' + f.source }));
    const defLabel = defaultLabel(f);
    if (defLabel !== null) {
      const differs = !secret && input.value !== defText;
      tags.append(el('span', { className: 'tag defval' + (differs ? ' differs' : ''), id: 'dv-' + f.key, textContent: 'default ' + defLabel }));
    }

    const what = el('div', { className: 'what' },
      el('div', { className: 'keyline' }, el('label', { htmlFor: id, textContent: f.key, title: f.label || '' }), keyTags));
    if (f.label) what.append(el('div', { className: 'rowlabel', textContent: f.label }));

    const side = el('div', { className: 'side' });
    const range = rangeText(f);
    if (range) side.append(el('div', { className: 'range', textContent: range }));
    const ctl = el('div', { className: 'ctl' }, input);
    if (reset) ctl.append(reset);
    side.append(ctl);

    const row = el('div', { className: 'row', id: 'r-' + f.key }, what, side, el('div', { className: 'tagrow' }, tags), el('div', { className: 'help', textContent: f.help }));
    row.dataset.cat = catOf(f);
    return row;
  }

  // ── the rail and the category heading ──
  function renderRail() {
    const rail = $('rail');
    rail.textContent = '';
    rail.append(el('div', { className: 'rail-head', textContent: 'RELAY' }));
    for (const c of catList()) {
      const n = fields.filter((f) => catOf(f) === c).length;
      const b = el('button', { className: 'rail-item' + (c === activeCat ? ' on' : ''), type: 'button' },
        el('span', { textContent: catLabel(c), title: c === '' ? OTHER_CAT.desc : (CAT_DESC[c] || '') }), el('span', { className: 'rail-count', textContent: String(n) }));
      b.dataset.cat = c;
      b.addEventListener('click', () => { selectCategory(c); });
      rail.append(b);
    }
    // the cameras are not a settings group, but they live on this page like one: their rail entry counts them
    const b = el('button', { className: 'rail-item' + (activeCat === CAMERAS_CAT ? ' on' : ''), type: 'button' },
      el('span', { textContent: CAMERAS_CAT, title: CAMERAS_DESC }), el('span', { className: 'rail-count', textContent: String(cams.length) }));
    b.dataset.cat = CAMERAS_CAT;
    b.addEventListener('click', () => { selectCategory(CAMERAS_CAT); });
    rail.append(b);
    rail.hidden = false;
  }
  function renderCatHead() {
    $('cat-title').textContent = activeCat === CAMERAS_CAT ? CAMERAS_CAT : catLabel(activeCat);
    $('cat-desc').textContent = activeCat === CAMERAS_CAT ? CAMERAS_DESC
      : (activeCat === '' ? OTHER_CAT.desc : (CAT_DESC[activeCat] || ''));
  }
  function selectCategory(c) {
    clearFound();   // the mark points where the search landed; moving on clears it
    activeCat = c;
    renderCatHead();
    for (const b of document.querySelectorAll('#rail .rail-item')) b.classList.toggle('on', b.dataset.cat === c);
    refresh();
  }
  // Every setting is shown, whatever tier the relay names it for (the LEVEL switch is gone): a row is
  // hidden only because another category is the one on view. Hidden rows keep their values, so moving
  // between categories never loses an edit: it is still tracked, and the tray counts it.
  function updateVisibility() {
    for (const f of fields) {
      const row = $('r-' + f.key);
      if (!row) continue;
      row.hidden = catOf(f) !== activeCat;
    }
    const slot = $('sound-slot');
    if (slot) slot.hidden = activeCat !== 'Alarm sounds';
    $('cameras').hidden = activeCat !== CAMERAS_CAT;
  }

  // Marks each row about its edit: the input's changed border, the row's "changed" tag, and whether the
  // shown value differs from the default (the default tag is highlighted while it does).
  function updateRowMarks() {
    for (const f of fields) {
      const i = $('f-' + f.key);
      if (!i || i.disabled) continue;
      const changed = i.value !== original[f.key];
      i.classList.toggle('changed', changed);
      const changedTag = $('c-' + f.key);
      if (changedTag) changedTag.hidden = !changed;
      const defTag = $('dv-' + f.key);
      if (defTag) defTag.classList.toggle('differs', i.value !== defaultEdit(f));
    }
  }

  // ── the pending-changes tray ──
  // Only what differs from what the server sent, from every category (locked and read-only rows cannot change).
  function changes() {
    const out = {};
    for (const f of fields) {
      const i = $('f-' + f.key);
      if (!i || i.disabled) continue;
      if (i.value !== original[f.key]) out[f.key] = i.value;
    }
    return out;
  }
  let lastPending = -1;   // how many edits the last tray answer showed (-1: none yet); -1 → 0 keeps the status line
  function renderTray(pending) {
    const names = Object.keys(pending);
    const list = $('pending-list');
    list.textContent = '';
    for (const key of names) {
      const f = fields.find((x) => x.key === key) || {};
      list.append(el('div', { className: 'pending-row' },
        el('b', { textContent: key }),
        el('span', { className: 'pv', textContent: fmtValue(f, original[key]) + ' \u2192 ' + fmtValue(f, pending[key]) }),
        el('span', { className: 'pc', textContent: catLabel(catOf(f)) })));
    }
    const n = names.length;
    const pill = $('pending-count');
    pill.textContent = n + ' PENDING';
    pill.hidden = n === 0;
    $('tray-note').hidden = n === 0;
    $('tray').classList.toggle('has-changes', n > 0);
    if (n === 0 && lastPending > 0) setStatus('', '');   // the tray emptied (applied or discarded): the count line goes too
    lastPending = n;
    if (n > 0) {
      const rb = names.filter((key) => { const f = fields.find((x) => x.key === key); return f && f.restart; }).length;
      const breaking = names.filter((key) => BREAKING.includes(key));
      let note = n + ' pending change' + (n === 1 ? '' : 's') + '. Applying writes ' + (n === 1 ? 'it' : 'them')
        + ' to the relay and this dashboard at once — nothing is written until you apply.';
      if (rb > 0) note += ' ' + rb + ' of ' + (n === 1 ? 'it takes' : 'them take') + ' effect only after the relay restarts.';
      if (breaking.length) note += ' Changing ' + breaking.join(' / ') + ' stops every camera from connecting until each board is updated with the new value.';
      $('tray-note').textContent = note;
      setStatus(n + ' pending change' + (n === 1 ? '' : 's'), '');
    }
    saveBtn.disabled = revertBtn.disabled = n === 0;
  }

  function refresh() {
    updateVisibility();
    updateRowMarks();
    renderTray(changes());
  }

  // ── the search's jump (?find=KEY, F-29 T7b) ──
  // The jumped-to row is framed and its input focused (a locked or read-only one cannot be). The mark
  // goes when the category changes — it points where the search landed, it is not an edit state.
  function clearFound() { for (const r of form.querySelectorAll('.row.found')) r.classList.remove('found'); }
  function highlightFound() {
    if (!FIND) return;
    const row = $('r-' + FIND);
    if (!row || row.hidden) return;
    row.classList.add('found');
    if (row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    const i = $('f-' + FIND);
    if (i && !i.disabled) i.focus({ preventScroll: true });
  }

  function render(data) {
    fields = data.fields;
    cams = data.cameras || [];
    original = {};
    $('banners').textContent = '';
    form.textContent = '';
    if (!data.configWritable) banner('config.php is not writable by the web server, so the login and relay address cannot be changed here. Run deploy.sh as root once (it fixes this), or: sudo chown www-data config.php', 'warn');
    if (!data.supervised) banner('The relay was not started by systemd or pm2, so it cannot restart itself: settings marked "restarts relay" are saved but applied only after you restart it by hand.', 'warn');

    // the first category is shown (normally Recording); "Other" is only picked by hand
    activeCat = catList()[0] || '';
    // The search's jump (?find=): the key's own category opens, so the row the search landed on is
    // the one on view. Only activeCat is set here: refresh() below redraws with it.
    if (FIND && !foundShown) {
      const found = fields.find((x) => x.key === FIND);
      if (found) {
        foundShown = true;
        activeCat = catOf(found);
      }
    }
    renderRail();
    renderCatHead();
    $('catwrap').hidden = false;
    if (fields.some((f) => f.type === 'sound')) form.append(soundSlot());   // the sound files first: the choices below are made from them
    for (const f of fields) form.append(buildRow(f));
    renderCameras(cams);
    refresh();
    highlightFound();
  }

  async function load(keepStatus) {
    if (!keepStatus) setStatus('Loading…');
    try {
      const res = await fetch('system-settings.php', { headers: AJAX });
      const data = await res.json();
      if (!res.ok) { $('banners').textContent = ''; banner(data.error || ('Error ' + res.status), 'err'); setStatus(data.error || ('Error ' + res.status), 'err'); return null; }
      render(data);
      if (!keepStatus) setStatus('Loaded.', '');
      return data;
    } catch (e) { setStatus('Could not load the settings: ' + e.message, 'err'); return null; }
  }

  async function save() {
    const values = changes();
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
      if (!res.ok || !data.ok) { notify(data.error || ('Error ' + res.status), 'error'); refresh(); return; }
      const warn = data.restart === 'manual' || data.restart === 'timeout';
      await load(true);
      notify(data.message + (data.relogin ? ' The browser will ask you to log in again.' : ''), warn ? 'error' : 'ok');
    } catch (e) {
      // Changing the login makes this very request come back 401 in some browsers; reloading tells the truth.
      notify('The answer did not arrive (' + e.message + '). Reloading what is stored…', 'error');
      setTimeout(() => { load(); }, 1500);
    }
  }

  saveBtn.addEventListener('click', () => CamBusy.run(saveBtn, save));
  // DISCARD puts every input back to what the server sent — edits from every category, shown or hidden —
  // so the tray empties and nothing is sent. Locked and read-only inputs are skipped (they cannot change).
  revertBtn.addEventListener('click', () => {
    for (const f of fields) {
      const i = $('f-' + f.key);
      if (!i || i.disabled) continue;
      i.value = original[f.key];
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    notify('Discarded — nothing was sent.', 'ok');
  });

  // ── the search box (F-38) ──
  // The controller is kept on the window (like the pages keep their helpers), so the tests can reach
  // the state: CamSearch.hits, CamSearch.selected, CamSearch.scope. It does not take the focus when the
  // index arrives (autoFocus: false) — this page is the settings first; the search takes the focus only
  // when it is clicked into.
  window.CamSearch = window.CamSettingsSearch.mount({
    input: $('q'), scopeBar: $('scopebar'), results: $('results'), note: $('note'),
    indexUrl: 'settings-search-index.php', autoFocus: false,
  });
  // Typing swaps the settings page for the result list; emptying the box brings the settings back
  // (what ESC did on the old search page). The list sits in #search-area, the settings in #page —
  // the same page, one at a time.
  function syncSearchView() {
    const searching = $('q').value !== '';
    $('search-area').hidden = !searching;
    $('page').hidden = searching;
  }
  $('q').addEventListener('input', syncSearchView);
  // The ESC chip does what the key does: clear the search, and on an empty one go back.
  $('esc').addEventListener('click', () => {
    if ($('q').value !== '') { $('q').value = ''; $('q').dispatchEvent(new Event('input', { bubbles: true })); $('q').focus(); }
    else window.history.back();
  });

  // The new camera's icon input gets a chooser bubble with a search bar (js/icon-picker.js); without the scripts it stays a plain input.
  if (window.CamIconPicker && window.CamIconCatalog) window.CamIconPicker.attach($('c-icon'), window.CamIconCatalog.GROUPS);

  load();
</script>
<?= CamLayout::storageWarningScript() ?>
<?= CamLayout::setupModeAlertScript() ?>
</body>
</html>
