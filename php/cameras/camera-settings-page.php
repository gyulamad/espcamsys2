<?php
// camera-settings-page.php?cam=ID[&type=detector] — one camera's SETTINGS page (with &type=detector: the
// SETTINGS page of the person detector paired with that camera, same Atlas form, the detector's own
// settings — its detection tuning, picture and the rest; the calibration help below).
//
// The page follows the Settings Atlas design (designs/Main-v2.png, designs/Category-v2.png):
//   * a CATEGORY RAIL on the left — one entry per category the firmware's settings table names, with the
//     number of settings in it; the settings that have no category (the relay-connection identity values,
//     the serial-only locks, setup mode) sit under "Other". One category is shown at a time; edits made in
//     another stay pending (see the tray).
//   * a LEVEL switch — BASIC / ADVANCED / EXPERT. Rows above the chosen level stay in the form (hidden, with
//     their values), so switching levels never loses an edit.
//   * one row per setting: the short key with its tags ("was hard-coded" — its value used to be fixed in the
//     firmware, and this default was that old value; "serial only" for the locked keys; "changed" while the
//     row holds an unsaved edit), the readable label, the help text, and the value tags (where the value
//     comes from — "preferences" once the board stores it, "default" while it does not —, "live" or "reboot",
//     and the default itself). A number row shows its allowed range; one with a default can be reset to it
//     with the row's ↺ RESET button, which goes through the same change tracking as a hand edit.
//   * a PENDING-CHANGES tray at the bottom: every unsaved edit of every category with its old → new value,
//     a DISCARD button, and ONE apply button — nothing is written to the board until it is pressed.
//   * a LINKED SETTINGS panel (F-29 T8, designs/Main-v2.png): the rules that watch values which must
//     agree across devices (this board's against the relay's), each with its verdict. It watches only —
//     a rule that does not hold names the two values and where to change them; nothing is written.
//   * on a phone (designs/Mobile-v2.png, F-29 T7e): the tray's count and APPLY fold into a sticky
//     "N changes → APPLY" bar at the bottom, with 44 px touch targets on every control; the per-row list,
//     the reboot note and DISCARD live in a collapsible detail that opens with the bar's count button.
//     The page tags <html> with .is-mobile from matchMedia('(max-width: 800px)'); the @media block of the
//     same width is kept as a no-JS fallback for the basic stacking.
//
// The form is drawn from what camera-settings.php sends (the firmware's own settings table), so a setting
// added to the firmware shows up here by itself. Changes are queued on the relay; the board picks them up,
// applies them and restarts — see camera-settings.php.
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/lib/Layout.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Camera settings — ESP32-CAM Dashboard</title>
<?= CamLayout::faviconLinks() ?>
<link rel="stylesheet" href="fonts/fonts.css">
<style>
  :root {
    --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80;
    --accent: #00e5ff; --accent2: #ff4f5e; --warn: #ffb020; --ok: #2dd67b;
    --text: #cdd8f0; --muted: #4a5780;
    --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif; --radius: 6px;
    --touch: 44px;   /* the minimum size of a tappable control on a phone (designs/Mobile-v2.png, F-29 T7e) */
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; min-height: 100vh; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 14px 32px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .crumbs { font-family: var(--mono); font-size: .68rem; letter-spacing: .1em; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
  .crumbs a { color: var(--muted); text-decoration: none; }
  .crumbs a:hover { color: var(--accent); }
  .crumbs .sep { margin: 0 6px; }
  .crumbs .here { color: var(--accent); }
  .pending-pill { font-family: var(--mono); font-size: .7rem; letter-spacing: .12em; color: var(--warn); border: 1px solid var(--warn); border-radius: 20px; padding: 4px 12px; white-space: nowrap; }
  .hdr-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn { font-family: var(--mono); font-size: .75rem; padding: 7px 14px; border-radius: var(--radius); border: 1px solid var(--border-light); background: transparent; color: var(--text); cursor: pointer; letter-spacing: .06em; text-decoration: none; display: inline-block; transition: all .2s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.danger:hover { border-color: var(--accent2); color: var(--accent2); }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 32px 150px; }
  .banner { border: 1px solid var(--border-light); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; font-size: .85rem; line-height: 1.4; }
  .banner.warn { border-color: var(--warn); color: var(--warn); }
  .banner.err  { border-color: var(--accent2); color: var(--accent2); }
  .banner.ok   { border-color: var(--ok); color: var(--ok); }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px 8px; margin-bottom: 20px; background: var(--surface); }
  legend { font-family: var(--mono); font-size: .8rem; letter-spacing: .1em; color: var(--accent); padding: 0 8px; text-transform: uppercase; }
  .kv { font-family: var(--mono); font-size: .75rem; color: var(--muted); margin-bottom: 10px; line-height: 1.6; }
  /* ── the Atlas layout: category rail + one category's rows ── */
  .page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 8px 28px; align-items: start; margin-top: 6px; }
  .rail { position: sticky; top: 14px; display: flex; flex-direction: column; gap: 2px; }
  .rail .rail-head { font-family: var(--mono); font-size: .62rem; letter-spacing: .18em; color: var(--muted); padding: 2px 10px 8px; text-transform: uppercase; }
  .rail-item { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; text-align: left; font-family: var(--sans); font-weight: 400; font-size: .88rem; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: var(--radius); padding: 7px 10px; cursor: pointer; }
  .rail-item:hover { border-color: var(--border-light); }
  .rail-item.on { border-color: var(--accent); color: var(--accent); background: rgba(0, 229, 255, .06); }
  .rail-count { font-family: var(--mono); font-size: .68rem; color: var(--muted); }
  .catwrap { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px 24px; flex-wrap: wrap; margin-bottom: 10px; }
  .cat-head h2 { font-size: 1.35rem; font-weight: 500; letter-spacing: .01em; }
  .cat-head p { font-size: .82rem; color: var(--muted); margin-top: 4px; max-width: 560px; line-height: 1.45; }
  .tierbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 2px; }
  .tierbar .lbl { font-family: var(--mono); font-size: .65rem; letter-spacing: .14em; color: var(--muted); }
  .btn.tier.on { border-color: var(--accent); color: var(--accent); }
  #tierinfo { font-family: var(--mono); font-size: .65rem; color: var(--muted); }
  /* ── one setting row: what (key, label, tags, help) left, the value (range, input, reset) right ── */
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px); gap: 2px 20px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 10px; align-items: start; }
  .row.unused { opacity: .55; }
  .row.found { border-color: var(--accent); background: rgba(0, 229, 255, .07); }
  .keyline { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .keyline label { font-weight: 500; font-size: .92rem; font-family: var(--mono); letter-spacing: .02em; }
  .tags { display: inline-flex; gap: 4px; flex-wrap: wrap; align-items: baseline; }
  .tag { font-family: var(--mono); font-size: .6rem; border: 1px solid var(--border-light); border-radius: 20px; padding: 1px 7px; color: var(--muted); white-space: nowrap; }
  .tag.lock, .tag.hardcoded { border-color: var(--warn); color: var(--warn); }
  .tag.changed { border-color: var(--warn); color: var(--warn); background: rgba(255, 176, 32, .12); }
  .tag.apply { border-color: var(--border-light); }
  .tag.apply.reboot { border-color: var(--warn); color: var(--warn); }
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
  .inline { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .inline input { width: auto; flex: 1; min-width: 140px; font-family: var(--mono); font-size: .85rem; padding: 7px 9px; border-radius: var(--radius); border: 1px solid var(--border-light); background: var(--bg); color: var(--text); }
  .inline input.icon { flex: 0 0 90px; min-width: 70px; text-align: center; }
  /* The hidden attribute must win over this page's own display rules — .row, .rail, .catwrap and .btn set
     one, and an author display would otherwise beat the browser's [hidden] (the same note as Layout.php's .btn). */
  .btn[hidden], .row[hidden], .rail[hidden], .catwrap[hidden], .pending-pill[hidden], .tag[hidden], #tray-note[hidden], #pending-list[hidden], #linked[hidden], #mobile-bar[hidden] { display: none; }
  /* ── the Linked settings panel (F-29 T8, designs/Main-v2.png): values that must agree across
        devices, watched — each with its verdict, the reason in words under the formula ── */
  .linked-card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 14px 18px 10px; margin-top: 22px; }
  .linked-card .lbl { font-family: var(--mono); font-size: .8rem; letter-spacing: .12em; color: var(--accent); text-transform: uppercase; }
  .linked-desc { font-size: .75rem; color: var(--muted); margin: 5px 0 10px; line-height: 1.45; max-width: 560px; }
  .linked-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; border-top: 1px solid var(--border); padding: 7px 0; }
  .linked-row .mark { flex: 0 0 auto; font-family: var(--mono); font-size: .8rem; }
  .linked-row .formula { font-family: var(--mono); font-size: .74rem; color: var(--text); }
  .linked-row.ok .mark { color: var(--ok); }
  .linked-row.bad .mark { color: var(--accent2); }
  .linked-row.unknown .mark { color: var(--muted); }
  .linked-row .note { flex-basis: 100%; margin-left: 22px; font-size: .75rem; line-height: 1.45; color: var(--muted); }
  .linked-row.bad .note { color: var(--accent2); }
  .linked-row.unknown .formula { color: var(--muted); }
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
  /* ── the mobile bar: a sticky "N changes → APPLY" strip (designs/Mobile-v2.png, F-29 T7e) ──
     Hidden on desktop; the page tags <html> with .is-mobile (matchMedia) when the viewport is narrow, and
     the rules below take over: the desktop tray's pending list, note and action bar fold into a collapsible
     detail panel; the only thing always visible at the bottom is the count + APPLY. The bar's APPLY mirrors
     #save (same handler), so the save path is unchanged. The count button expands the detail (#tray-detail)
     so the user can see the per-row old → new values, the reboot note and DISCARD. */
  #mobile-bar { display: none; }
  .is-mobile #mobile-bar { display: flex; align-items: stretch; gap: 8px; padding: 6px 0 2px; }
  #mobile-bar .m-count { flex: 1; min-width: 0; font-family: var(--mono); font-size: .85rem; letter-spacing: .04em;
    text-align: left; color: var(--text); background: transparent; border: 1px solid var(--border-light); border-radius: var(--radius);
    padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
  #mobile-bar .m-count::after { content: '▾'; font-size: .7rem; color: var(--muted); transition: transform .15s; }
  #mobile-bar .m-count[aria-expanded="true"]::after { transform: rotate(180deg); }
  #mobile-bar .m-count:disabled { opacity: .55; cursor: default; }
  #mobile-bar .m-apply { flex: 0 0 auto; white-space: nowrap; }
  /* The detail panel: the same #pending-list, #tray-note and .traybar the desktop tray shows, but on mobile
     they sit under the bar and are hidden until the count button is pressed. The detail is the desktop
     tray's content repurposed, not a second copy (DRY). */
  .is-mobile .tray-detail { display: none; }
  .is-mobile .tray.m-expanded .tray-detail { display: block; }
  .is-mobile .tray { padding-top: 6px; padding-bottom: 8px; }
  .is-mobile .traybar #save, .is-mobile .traybar #status { display: none; }   /* the bar's APPLY and count cover them */
  .is-mobile .traybar { justify-content: flex-start; gap: 10px; padding-top: 6px; }
  /* The header's "N PENDING" pill (and the new JUMP TO SETTING link's row) is redundant with the mobile
     bar's count; hide the pill so the header stays compact. The link stays — search is reachable on a phone. */
  .is-mobile .pending-pill { display: none; }
  /* 44 px touch targets (designs/Mobile-v2.png). Every interactive control on a phone is at least 44 px
     tall, so a finger lands on one and not its neighbour. The value is hardcoded (the same convention as
     Layout.php's --nav-h and .files-video-close) rather than via var(--touch): the :root --touch above is
     only the documented constant, and hardcoding lets a jsdom test read the resolved min-height directly. */
  .is-mobile .btn, .is-mobile .rail-item, .is-mobile #tierbar .btn.tier,
  .is-mobile .ctl input, .is-mobile .ctl select, .is-mobile #mobile-bar .m-count, .is-mobile #mobile-bar .m-apply,
  .is-mobile .inline input, .is-mobile #e-icon, .is-mobile #e-name, .is-mobile #e-detector {
    min-height: 44px;
  }
  .is-mobile .btn.reset { padding-top: 8px; padding-bottom: 8px; }
  @media (max-width: 800px) {
    /* No-JS fallback: the .is-mobile class is what the page toggles from matchMedia when JS is on, but the
       basic stacking (rail wraps, rows go one column) must also work with scripts off, so the same shape
       is repeated here. The touch-target and mobile-bar rules are NOT duplicated: they need JS to add the
       class, and without JS the desktop tray stays as it is (still usable on a phone, just denser). */
    header, main, .tray { padding-left: 16px; padding-right: 16px; }
    .page { grid-template-columns: 1fr; }
    .rail { position: static; flex-direction: row; flex-wrap: wrap; padding-bottom: 6px; }
    .rail .rail-head { flex-basis: 100%; }
    .row { grid-template-columns: 1fr; }
    .side { grid-column: 1; grid-row: auto; }
    .help { grid-column: 1; }
    .pending-pill { order: 3; }
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
    <nav class="crumbs" aria-label="Where you are">
      <a href="settings-page.php" data-page-load="">← SETTINGS</a><span class="sep">/</span><span id="crumb-scope">CAMERAS</span><span class="sep">/</span><span class="here" id="crumb-cat"></span>
    </nav>
    <h1>⚙ <span id="title">CAMERA</span></h1>
    <p id="subtitle">Camera settings</p>
  </div>
  <div class="hdr-actions">
    <a class="btn" href="settings-search.php" data-page-load="" title="Find any setting by its name, its label or its help text">🔍 JUMP TO SETTING</a>
    <span class="pending-pill" id="pending-count" hidden>0 PENDING</span>
  </div>
</header>

<main>
  <div id="banners"></div>
  <div class="kv" id="calib-help" hidden>Calibrating the person detector: keep the dashboard open next to this page and watch the detector's BRIGHTNESS, MOTION and HUMAN readings.
DARK_THRESH: set it just below the brightness the picture has when it is too dark to see a person.
MOTION_THRESH: set it above the motion value of a still scene and below what a person walking makes.
MOTION_EMA_LEN / MOTION_EMA_PCT: optional motion auto-calibration. With MOTION_EMA_LEN above 0 (frames, e.g. 3000 = a few minutes) the motion threshold follows the average motion + MOTION_EMA_PCT percent (30 is a good start), never lower than MOTION_THRESH, so wind and rain raise it a little. 0 = off, the threshold stays fixed.
MOTION_X0 / Y0 / X1 / Y1: the part of the picture watched for motion (left, top, right, bottom in pixels of the 96x96 picture; at least 10 wide and high). Easier: drag the dashed rectangle on the detector's picture on the dashboard.
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
  <div class="page">
    <nav class="rail" id="rail" hidden aria-label="Setting categories"></nav>
    <div class="content">
      <div class="catwrap" id="catwrap" hidden>
        <div class="cat-head">
          <h2 id="cat-title"></h2>
          <p id="cat-desc"></p>
        </div>
        <div class="tierbar" id="tierbar">
          <span class="lbl">LEVEL</span>
          <button class="btn tier on" type="button" data-tier="basic">BASIC</button>
          <button class="btn tier" type="button" data-tier="advanced">ADVANCED</button>
          <button class="btn tier" type="button" data-tier="expert">EXPERT</button>
          <span id="tierinfo"></span>
        </div>
      </div>
      <form id="form" onsubmit="return false;"></form>
    </div>
  </div>

  <section class="linked-card" id="linked" hidden aria-label="Linked settings">
    <span class="lbl">Linked settings</span>
    <p class="linked-desc">Values that must agree across devices are watched for you. A rule that does not hold says what to change; the values themselves stay where they live — this tray changes nothing by itself.</p>
    <div id="linked-list"></div>
  </section>
</main>

<div class="tray" id="tray">
  <div class="tray-detail" id="tray-detail">
    <div id="pending-list"></div>
    <div id="tray-note" hidden></div>
    <div class="traybar">
      <button class="btn" id="revert" disabled>↺ DISCARD</button>
      <button class="btn primary" id="save" disabled>⬆ APPLY TO CAMERA</button>
      <button class="btn" id="cancel" hidden>✖ WITHDRAW QUEUED CHANGE</button>
      <span id="status">Loading…</span>
    </div>
  </div>
  <!-- The mobile bar: the page toggles <html>.is-mobile from matchMedia, and this sticky strip takes over
       from the desktop tray. The count button expands #tray-detail (above) so the per-row list, the reboot
       note and DISCARD are still reachable; the APPLY button mirrors #save. designs/Mobile-v2.png (F-29 T7e).
       The count button is always enabled (it just opens the detail — empty or not); the APPLY button is
       disabled while there is nothing to apply, mirroring #save. -->
  <div class="mobile-bar" id="mobile-bar" role="region" aria-label="Pending changes">
    <button class="btn m-count" id="m-count" type="button" aria-expanded="false" aria-controls="tray-detail">No changes</button>
    <button class="btn primary m-apply" id="m-apply" type="button" disabled>APPLY</button>
  </div>
</div>

<script src="js/toast.js"></script>
<script src="js/busy.js"></script>
<script src="js/stable-text.js"></script>
<script src="js/icon-catalog.js"></script>
<script src="js/icon-picker.js"></script>
<script>
  const CAM = new URLSearchParams(location.search).get('cam') || '';
  const AJAX = { 'X-Requested-With': 'camdash' };
  const TYPE = new URLSearchParams(location.search).get('type') === 'detector' ? 'detector' : 'recorder';
  // A jump from the settings search (?find=KEY, F-29 T7b): the key's category opens with the row
  // framed, at the level that shows it. A key the firmware does not have is ignored — the page then
  // opens as always.
  const FIND = (new URLSearchParams(location.search).get('find') || '').toUpperCase();
  const WHO = TYPE === 'detector' ? 'detector' : 'camera';
  const API = 'camera-settings.php?cam=' + encodeURIComponent(CAM) + (TYPE === 'detector' ? '&type=detector' : '');
  let keys = [], gpios = [], reported = null, camera = null, original = {}, pollTimer = null;
  let lastStructure = null;   // what the form (and the banners) were last built from; only a change rebuilds them
  let tierLevel = 'basic';    // the level shown: rows above it stay in the form but hidden (their edits survive)
  let activeCat = null;       // the category shown; null until the first render picks the first one
  const LEVELS = ['basic', 'advanced', 'expert'];   // who a row is for (the schema's tier); the level picks how many are shown

  const $ = (id) => document.getElementById(id);
  const form = $('form'), statusEl = $('status'), saveBtn = $('save'), revertBtn = $('revert'), cancelBtn = $('cancel');
  const mApply = $('m-apply'), mCount = $('m-count');   // the mobile bar's APPLY and count buttons (F-29 T7e)
  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ''; }
  // The result of pressing a button (APPLY, SAVE NAME, WITHDRAW...): a toast popup (F-12) instead of
  // a message in the tray, where a longer answer wrapped the buttons into several lines. The tray's
  // own #status line stays for the passive states (loading, pending-changes count, queuing...).
  function notify(t, kind) { CamToast.show(t, kind || 'info'); }
  function el(tag, props, ...kids) { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids) e.append(k); return e; }
  function banner(t, cls) { $('banners').append(el('div', { className: 'banner ' + cls, textContent: t })); }
  // What this page edits, spoken about in words: the camera itself — or, on the detector page
  // (&type=detector), the person detector paired with it. The apply confirm and the tray note
  // use the same wording, so every sentence on the page names the same device.
  function subject() { return TYPE === 'detector' ? 'the detector of ' + camera.name : camera.name; }
  function ago(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; }

  // ── mobile layout (designs/Mobile-v2.png, F-29 T7e) ──
  // The page tags <html> with .is-mobile when the viewport is narrow (matchMedia). The CSS then swaps the
  // desktop tray for a sticky "N changes → APPLY" bar (#mobile-bar) whose APPLY mirrors #save and whose
  // count button expands the same #tray-detail the desktop tray shows (the per-row list, the reboot note
  // and DISCARD) — see the rules above. matchMedia is the source of truth (not a resize handler: it fires
  // only on a real change, and it respects the user's zoom and accessibility prefs a resize handler
  // misses). When JS is off (or matchMedia is missing, as in old tests) the .is-mobile class never lands,
  // and the @media (max-width: 800px) block above keeps the basic stacking working.
  function applyMobile() {
    document.documentElement.classList.toggle('is-mobile', !!(window.matchMedia && window.matchMedia('(max-width: 800px)').matches));
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(max-width: 800px)');
    if (mq.addEventListener) mq.addEventListener('change', applyMobile);
    else if (mq.addListener) mq.addListener(applyMobile);   // Safari < 14
  }
  applyMobile();
  // The mobile APPLY button mirrors #save: clicking it goes through #save's own handler (CamBusy disabled
  // state and all), so the save path is the same one the desktop tray uses — no second copy of the rules.
  mApply.addEventListener('click', () => { if (!mApply.disabled) saveBtn.click(); });
  // The count button expands #tray-detail (the per-row list, the note and DISCARD) on mobile; on desktop
  // it is hidden, so the click is a no-op there.
  mCount.addEventListener('click', () => {
    const tray = $('tray'), open = tray.classList.contains('m-expanded');
    tray.classList.toggle('m-expanded', !open);
    mCount.setAttribute('aria-expanded', String(!open));
  });

  // Is this setting needed, given the values? (same rule as the firmware and camera-settings.php)
  function required(def, vals) {
    if (def.cond === 'optional') return false;
    if (def.cond === 'always' || def.condKey === null) return true;
    if (vals[def.condKey] === undefined || vals[def.condKey] === '') return true;
    const eq = vals[def.condKey] === def.condValue;
    return def.cond === 'equals' ? eq : !eq;
  }
  // An optional setting (SETUP_MODE) may be absent from a board; absent means off. It is always shown, so it can be turned on.
  const isOptional = (d) => d.cond === 'optional';
  const isFixed = (d) => d.locked || d.kind === 'secret' || d.kind === 'wifi';
  const SECRET_MASK = '********';

  // ── categories (the Atlas rail) ──
  // The firmware's table gives most settings a category; they are shown in the order the table names
  // them (a camera starts with Picture & link, a detector with Detection). The relay-connection identity
  // values, the serial-only locks and setup mode have no category — they share the last entry, "Other".
  // One line per category, from the Atlas design board (Main-v2): the camera's categories, and the two
  // the detector's own table names that a camera never has (Detection first, then Picture & live view).
  // A category without a line here just shows its rows without a blurb.
  const CAT_DESC = {
    'Detection': 'Person thresholds, darkness check and the motion gate with its watched area.',
    'Picture & live view': 'Frame rate, JPEG quality and write timeout of the live picture.',
    'Connection': 'Which Wi-Fi and which relay this board talks to, and how it finds it again.',
    'Picture & link': 'Frame pacing, JPEG quality and the resolution fallback on a slow link.',
    'Alarm input': 'Which pin listens, which level means alarm, and how it is debounced.',
    'Logging': 'What the board reports to the relay log, how often, and how it retries.',
    'Updates & sync': 'Over-the-air firmware, relay discovery and settings sync timing.',
    'Setup & security': 'The board\u2019s own setup Wi-Fi, its master password and request limits.',
    'Hardware & internals': 'Pin map, task stacks, serial. Expert tier only.',
  };
  const OTHER_CAT = { label: 'Other', desc: 'Identity values for the relay connection, the serial-only locks and setup mode \u2014 the firmware\u2019s table gives them no category.' };
  const catOf = (d) => d.category || '';
  const catLabel = (c) => (c === '' ? OTHER_CAT.label : c);
  function catList() {
    const seen = [];
    for (const d of keys) { const c = catOf(d); if (c !== '' && !seen.includes(c)) seen.push(c); }
    if (keys.some((d) => catOf(d) === '')) seen.push('');
    return seen;
  }

  // ── values as text ──
  // A boolean reads as on/off wherever it is spoken about in words (the reset button, the tray); the inputs
  // themselves keep the raw values the board stores ('1' / '0').
  const fmtBool = (v) => (v === '1' ? 'on' : v === '0' ? 'off' : String(v));
  function fmtValue(d, v) {
    if (v === undefined || v === null || v === '') return '(not set)';
    return d && d.kind === 'bool' ? fmtBool(v) : String(v);
  }
  function rangeText(d) {
    if (d.kind === 'bool') return 'ON / OFF';
    if ((d.kind === 'int' || d.kind === 'float') && d.max > 0) return d.min + ' TO ' + d.max;
    return '';
  }
  const hasDefault = (d) => d.default !== undefined && d.default !== null;
  const defaultText = (d) => (d.kind === 'bool' ? fmtBool(d.default) : String(d.default));

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

  // The status block above the form ("reported 12 s ago", "QUEUED: ... 3 s ago", ...). Its seconds tick, and
  // on a phone its sentences wrap into a varying number of lines: the block's height is reserved for what the
  // newest text wraps to (js/stable-text.js, F-35), so a tick of the clock cannot move the form below it.
  function setStateText(parts) {
    const text = parts.join('\n');
    const state = $('state');
    state.textContent = text;
    state.style.whiteSpace = 'pre-line';
    if (window.CamStableText && text !== '') window.CamStableText.reserveHeight(state, [text]);
  }

  // ── one row: key + tags, readable label, help on the left; range, input, reset on the right ──
  function buildRow(d) {
    const id = 'f-' + d.name, fixed = isFixed(d);
    // an absent optional on/off setting reads as Off (and is not a change until it is switched On)
    // a setting the board has not stored uses its default (the value that used to be fixed in the firmware): show that
    const usesDefault = reported[d.name] === undefined && hasDefault(d);
    const value = usesDefault ? d.default : reported[d.name] === undefined && isOptional(d) && d.kind === 'bool' ? '0' : reported[d.name];
    const input = makeInput(d, value);
    input.id = id; input.name = d.name;
    if (fixed) input.disabled = true;
    // a locked secret is read-only AND masked: the page never shows what a device sent, only that it is set
    // (the server masks it too, camera-settings.php; this is the page's own lock)
    if (fixed && (d.kind === 'secret' || d.kind === 'wifi')) { input.type = 'text'; input.value = value === undefined ? '(not set)' : d.kind === 'secret' ? SECRET_MASK : value; }
    original[d.name] = value === undefined ? '' : String(value);
    input.addEventListener('input', () => { refresh(); });
    input.addEventListener('change', () => { refresh(); });

    // Reset to default: the default goes into the input, and from there through the SAME change tracking
    // and apply as a hand-made change (no separate path to the board). No button while the input already
    // holds the default, and none for what has no default or cannot be changed here anyway.
    const reset = !fixed && hasDefault(d) ? el('button', {
      className: 'btn reset', type: 'button', title: 'Put the default back, then APPLY', textContent: '↺ RESET TO ' + defaultText(d),
    }) : null;
    if (reset) {
      reset.disabled = input.value === String(d.default);
      input.addEventListener('input', () => { reset.disabled = input.value === String(d.default); });
      reset.addEventListener('click', () => { input.value = String(d.default); input.dispatchEvent(new Event('input', { bubbles: true })); });
    }

    // Tags beside the key: what this setting used to be, what may change it, and that it is edited right now.
    const keyTags = el('span', { className: 'tags' });
    if (hasDefault(d)) keyTags.append(el('span', { className: 'tag hardcoded', textContent: 'was hard-coded', title: 'its value used to be fixed in the firmware — this default was that old value' }));
    if (fixed) keyTags.append(el('span', { className: 'tag lock', textContent: 'serial only' }));
    keyTags.append(el('span', { className: 'tag changed', id: 'c-' + d.name, hidden: true, textContent: 'changed' }));

    // Value tags: where the shown value comes from, when it takes effect, and what the default is.
    const tags = el('span', { className: 'tags' });
    if (reported[d.name] !== undefined) tags.append(el('span', { className: 'tag', textContent: 'preferences', title: 'stored in the board\u2019s flash' }));
    else if (usesDefault) tags.append(el('span', { className: 'tag default', textContent: 'default', title: 'the board has not stored this — it uses the default' }));
    if (d.apply) tags.append(el('span', { className: 'tag apply' + (d.apply === 'reboot' ? ' reboot' : ''), textContent: d.apply, title: d.apply === 'reboot' ? 'takes effect only after the ' + WHO + ' restarts' : 'takes effect at once' }));
    if (hasDefault(d)) tags.append(el('span', { className: 'tag defval', id: 'dv-' + d.name, textContent: 'default ' + defaultText(d) }));

    const what = el('div', { className: 'what' },
      el('div', { className: 'keyline' }, el('label', { htmlFor: id, textContent: d.name, title: d.label || '' }), keyTags));
    if (d.label) what.append(el('div', { className: 'rowlabel', textContent: d.label }));

    const side = el('div', { className: 'side' });
    const range = rangeText(d);
    if (range) side.append(el('div', { className: 'range', textContent: range }));
    const ctl = el('div', { className: 'ctl' }, input);
    if (reset) ctl.append(reset);
    side.append(ctl);

    const helpText = d.help
      + (reported[d.name] === undefined && isOptional(d) ? ' — not set on this ' + WHO + ' (treated as off)' : '')
      + (fixed ? (TYPE === 'detector' ? ' — connects the detector to the relay or drives its alarm pin, so it can only be changed over the USB serial port.' : ' — connects the camera to the relay, so it can only be changed over the USB serial port.') : '');

    const row = el('div', { className: 'row', id: 'r-' + d.name }, what, side, el('div', { className: 'tagrow' }, tags), el('div', { className: 'help', textContent: helpText }));
    if (d.tier) row.dataset.tier = d.tier;
    row.dataset.cat = catOf(d);
    return row;
  }

  // ── the rail, the category heading and the LEVEL switch ──
  function renderRail() {
    const rail = $('rail');
    rail.textContent = '';
    rail.append(el('div', { className: 'rail-head', textContent: TYPE === 'detector' ? 'DETECTOR' : 'CAMERAS' }));
    for (const c of catList()) {
      const n = keys.filter((d) => catOf(d) === c).length;
      const b = el('button', { className: 'rail-item' + (c === activeCat ? ' on' : ''), type: 'button' },
        el('span', { textContent: catLabel(c), title: c === '' ? OTHER_CAT.desc : '' }), el('span', { className: 'rail-count', textContent: String(n) }));
      b.dataset.cat = c;
      b.addEventListener('click', () => { selectCategory(c); });
      rail.append(b);
    }
    rail.hidden = false;
  }
  function renderCatHead() {
    $('cat-title').textContent = catLabel(activeCat);
    const desc = activeCat === '' ? OTHER_CAT.desc : (CAT_DESC[activeCat] || '');
    $('cat-desc').textContent = (desc ? desc + ' ' : '') + 'Editing ' + subject() + '.';
    $('crumb-cat').textContent = catLabel(activeCat);
  }
  function selectCategory(c) {
    activeCat = c;
    renderCatHead();
    for (const b of document.querySelectorAll('#rail .rail-item')) b.classList.toggle('on', b.dataset.cat === c);
    clearFound();
    refresh();
  }
  // The chosen level hides every row above it (basic < advanced < expert). Rows without a tier — the
  // serial-only ones and setup mode — are shown at every level. Hidden rows keep their values, so a change
  // made at a higher level is not lost by switching back: it is still tracked, and the tray counts it.
  // Nothing is dropped: the form stays complete and the level is only a view.
  function applyTier(level) {
    tierLevel = level;
    for (const b of document.querySelectorAll('#tierbar .btn.tier')) b.classList.toggle('on', b.dataset.tier === tierLevel);
    clearFound();
    refresh();
  }
  // ── the search's jump (?find=KEY, F-29 T7b) ──
  // The jumped-to row is framed and its input focused (a locked input cannot be). The mark stays
  // while the user works in this category and goes away when the category or the level changes —
  // it points where the search landed, it is not an edit state.
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
  for (const b of document.querySelectorAll('#tierbar .btn.tier')) {
    b.addEventListener('click', () => { applyTier(b.dataset.tier); });
  }

  function currentValues() {
    const v = {};
    for (const d of keys) {
      const i = $('f-' + d.name);
      v[d.name] = isFixed(d) ? (reported[d.name] === undefined ? '' : String(reported[d.name])) : i.value;
    }
    return v;
  }

  // ── visibility: needed by the current values, in the shown category, at the chosen level ──
  // Shows what the current values make necessary: unused settings are dimmed, and a setting that
  // is needed but has no value yet (a feature was just switched on) appears.
  function updateVisibility() {
    const vals = currentValues();
    let tierHidden = 0;
    for (const d of keys) {
      const row = $('r-' + d.name), i = $('f-' + d.name);
      if (!row) continue;
      const need = required(d, vals), has = reported[d.name] !== undefined;
      const catVisible = catOf(d) === activeCat;
      const aboveLevel = d.tier && LEVELS.indexOf(d.tier) > LEVELS.indexOf(tierLevel);
      row.hidden = (!need && !has && !isOptional(d)) || !catVisible || aboveLevel;
      row.classList.toggle('unused', !need && !isOptional(d));
      if (catVisible && aboveLevel) tierHidden += 1;
    }
    $('tierinfo').textContent = tierHidden === 0
      ? 'every setting shown at ' + tierLevel
      : tierHidden + ' hidden at ' + tierLevel + ' — a higher level shows them';
  }

  // Marks each row about its edit: the input's changed border, the row's "changed" tag, and whether the
  // shown value differs from the default (the default tag is highlighted while it does).
  function updateRowMarks() {
    for (const d of keys) {
      const i = $('f-' + d.name);
      if (!i) continue;
      const changed = !isFixed(d) && i.value !== original[d.name];
      i.classList.toggle('changed', changed);
      const changedTag = $('c-' + d.name);
      if (changedTag) changedTag.hidden = !changed;
      const defTag = $('dv-' + d.name);
      if (defTag) defTag.classList.toggle('differs', String(i.value) !== String(d.default));
    }
  }

  // ── the pending-changes tray ──
  let lastPending = -1;   // how many edits the last tray answer showed (-1: none yet); -1 → 0 keeps the status line
  function renderTray(pending) {
    const names = Object.keys(pending.values);
    const list = $('pending-list');
    list.textContent = '';
    for (const name of names) {
      const d = keys.find((k) => k.name === name) || {};
      list.append(el('div', { className: 'pending-row' },
        el('b', { textContent: name }),
        el('span', { className: 'pv', textContent: fmtValue(d, original[name]) + ' \u2192 ' + fmtValue(d, pending.values[name]) }),
        d.category ? el('span', { className: 'pc', textContent: catLabel(d.category) }) : el('span', { className: 'pc', textContent: catLabel('') })));
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
      const rb = names.filter((name) => { const d = keys.find((k) => k.name === name); return d && d.apply === 'reboot'; }).length;
      let note = n + ' pending change' + (n === 1 ? '' : 's') + '. ' + subject() + ' picks ' + (n === 1 ? 'it' : 'them')
        + ' up at its next settings sync (within about half a minute). Nothing is written until you apply.';
      if (rb > 0) note += ' ' + rb + ' of ' + (n === 1 ? 'it takes' : 'them take') + ' effect only after the ' + WHO + ' restarts.';
      $('tray-note').textContent = note;
      setStatus(n + ' pending change' + (n === 1 ? '' : 's'), '');
    }
    saveBtn.disabled = revertBtn.disabled = n === 0;
    // Mobile bar (F-29 T7e): its count mirrors the pill, its APPLY mirrors #save, and when the tray
    // empties (applied or discarded) the detail collapses again so the bar does not show a stale list.
    mApply.disabled = n === 0;
    mCount.textContent = n === 0 ? 'No changes' : (n + (n === 1 ? ' change' : ' changes'));
    if (n === 0 && $('tray').classList.contains('m-expanded')) {
      $('tray').classList.remove('m-expanded');
      mCount.setAttribute('aria-expanded', 'false');
    }
  }

  function refresh() {
    const pending = changes();
    updateVisibility();
    updateRowMarks();
    renderTray(pending);
  }

  // Only what differs from what the camera holds. A setting this edit has just made needed (a feature
  // was switched on) must be given a value; one the camera already needed before — a setting its
  // firmware predates, unreported and empty — is not this edit's doing and is not demanded, or no
  // change at all could be saved on such a board (the same rule as buildDeviceChange in Logic.php).
  function changes() {
    const vals = currentValues(), out = {}; let missing = null;
    for (const d of keys) {
      if (isFixed(d)) continue;
      const need = required(d, vals), neededBefore = required(d, reported);
      if (!need && reported[d.name] === undefined && !isOptional(d)) continue;
      if (vals[d.name] === '') { if (need && !neededBefore) missing = missing || d.name; continue; }
      if (vals[d.name] !== original[d.name]) out[d.name] = vals[d.name];
    }
    return { values: out, missing };
  }

  // ── the Linked settings panel (F-29 T8): the rules that watch values which must agree across
  // devices — this board's against the relay's — each with its verdict and, when it does not hold,
  // the reason in words. The panel only WATCHES: it changes nothing by itself; the values are
  // changed where they live (the rows above, the relay's settings page, or the USB serial port).
  function renderLinked(list) {
    const card = $('linked'), box = $('linked-list');
    if (!Array.isArray(list) || !list.length) { card.hidden = true; box.textContent = ''; return; }
    card.hidden = false;
    box.textContent = '';
    for (const r of list) {
      const cls = r.status === 'problem' ? 'bad' : r.status === 'ok' ? 'ok' : 'unknown';
      const mark = el('span', { className: 'mark', textContent: r.status === 'problem' ? '✗' : r.status === 'ok' ? '✓' : '?' });
      mark.setAttribute('aria-hidden', 'true');   // the row's words carry the meaning; the mark is decoration
      const row = el('div', { className: 'linked-row ' + cls }, mark, el('span', { className: 'formula', textContent: r.formula }));
      const note = r.status === 'problem' ? r.problem : r.note;
      if (note) row.append(el('span', { className: 'note', textContent: note }));
      box.append(row);
    }
  }

  function render(data) {
    camera = data.camera; keys = data.keys; gpios = data.gpios;
    const st = data.state; reported = st.reported ? st.reported.settings : null;
    renderLinked(data.linked);   // before the structure early-return: the panel follows every answer, form or not

    // The status text and the WITHDRAW button follow every answer (their seconds tick); the FORM, the rail
    // and the banners are built from the structure below, and are rebuilt only when it CHANGED. While a
    // change is queued this page polls every few seconds, and each rebuild used to move everything below
    // the form and wipe what was being typed (F-35): an unchanged answer now keeps both.
    const parts = [];
    if (st.reported) parts.push('Settings reported by the ' + WHO + ' ' + ago(st.now - st.reported.at));
    if (st.pending) parts.push('QUEUED: ' + st.pending.keys.join(', ') + ' (queued ' + ago(st.now - st.pending.at) + ') — waiting for the ' + WHO + ' to pick it up');
    if (st.last) parts.push('Last change: ' + st.last.result.toUpperCase() + (st.last.message ? ' — ' + st.last.message : '') + ' (' + ago(st.now - st.last.at) + ')');
    setStateText(parts);
    cancelBtn.hidden = !st.pending;
    const structure = JSON.stringify([camera, keys, gpios, st.reported, st.pending, st.last]);
    if (structure === lastStructure) return;
    lastStructure = structure;

    $('title').textContent = camera.icon + ' ' + camera.name + (TYPE === 'detector' ? ' — detector' : '');
    document.title = camera.name + (TYPE === 'detector' ? ' detector settings' : ' settings') + ' — ESP32-CAM Dashboard';
    if (TYPE === 'detector') {
      $('subtitle').textContent = 'Person detector settings (' + camera.deviceId + ')';
      $('calib-help').hidden = false; $('calib-help').style.whiteSpace = 'pre-line';
      $('crumb-scope').textContent = 'DETECTOR';
    }
    $('entry').hidden = TYPE === 'detector'; $('e-icon').value = camera.icon; $('e-name').value = camera.name; $('e-id').textContent = camera.id; $('e-detector').value = camera.detector || '';
    $('banners').textContent = ''; form.textContent = ''; original = {};
    saveBtn.textContent = '⬆ APPLY TO ' + (TYPE === 'detector' ? 'DETECTOR' : camera.name.toUpperCase());

    if (!reported) {
      banner('This ' + WHO + ' has not reported its settings yet. It reports once it runs the firmware that supports remote settings (' + (TYPE === 'detector' ? 'flash the detector with the current ESP32_CAM_TFLite_Person sketch, or publish it with ota-deploy.sh detector' : 'publish it with ota-deploy.sh') + ') and has reached the relay — then this page fills in.' + (TYPE === 'detector' ? '' : ' You can still rename it or remove it from the dashboard above.'), 'warn');
      $('rail').hidden = true; $('catwrap').hidden = true;
      $('pending-count').hidden = true;
      saveBtn.disabled = revertBtn.disabled = mApply.disabled = true;
      return;
    }
    // The categories come with the keys; the first one that has a name is shown (for a detector that is
    // its Detection category, for a camera Picture & link). "Other" is only picked by hand.
    const cats = catList();
    activeCat = cats.find((c) => c !== '') || cats[0] || '';
    // The search's jump (?find=): the key's own category, and the level that shows the row — a row
    // above the chosen level would stay hidden, and a highlight on an invisible row is no highlight.
    // Only tierLevel is set here: applyTier refreshes what is on screen, so it waits for the rows.
    const foundDef = FIND ? keys.find((d) => d.name === FIND) : null;
    if (foundDef) {
      activeCat = catOf(foundDef);
      if (foundDef.tier) tierLevel = foundDef.tier;
    }
    renderRail();
    renderCatHead();
    $('catwrap').hidden = false;
    for (const d of keys) form.append(buildRow(d));
    if (foundDef && foundDef.tier) applyTier(foundDef.tier);   // the level buttons catch up; refreshes too
    refresh();
    highlightFound();
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
      if (d && !d.state.pending && d.state.last) notify((TYPE === 'detector' ? 'Detector' : 'Camera') + ' answered: ' + d.state.last.result + (d.state.last.message ? ' — ' + d.state.last.message : ''), d.state.last.result === 'applied' ? 'ok' : 'error');
    }, 3000);
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AJAX), body: JSON.stringify(body) });
    return { res, data: await res.json().catch(() => ({})) };
  }

  saveBtn.addEventListener('click', () => CamBusy.run(saveBtn, async () => {
    const c = changes();
    if (c.missing) { notify(c.missing + ' is needed too — give it a value', 'error'); return; }
    if (!Object.keys(c.values).length) return;
    if (TYPE === 'detector') {
      const v = currentValues(), d = parseFloat(v.DETECT_THRESH), cl = parseFloat(v.CLEAR_THRESH);
      if (!isNaN(d) && !isNaN(cl) && cl > d) { notify('CLEAR_THRESH (' + v.CLEAR_THRESH + ') must not be higher than DETECT_THRESH (' + v.DETECT_THRESH + ')', 'error'); return; }
    }
    if (TYPE === 'recorder') {
      const v = currentValues(), lo = parseInt(v.JPEG_Q_MIN), hi = parseInt(v.JPEG_Q_MAX);
      if (!isNaN(lo) && !isNaN(hi) && lo > hi) { notify('JPEG_Q_MIN (' + v.JPEG_Q_MIN + ') must not be higher than JPEG_Q_MAX (' + v.JPEG_Q_MAX + ')', 'error'); return; }
    }
    if (!confirm('Apply ' + Object.keys(c.values).join(', ') + ' to ' + subject() + '?\n\n' + (TYPE === 'detector' ? 'The detector restarts to apply it (its picture and alarm pin pause for about 10 seconds).' : 'The camera restarts to apply it (its stream and any recording stop for a few seconds).'))) return;
    saveBtn.disabled = revertBtn.disabled = mApply.disabled = true; setStatus('Queuing…', 'busy');
    try {
      const { res, data } = await post(API, { values: c.values });
      if (!res.ok || !data.ok) { notify(data.error || ('Error ' + res.status), 'error'); refresh(); return; }
      await load(true);
      notify(data.message, data.queued ? 'busy' : 'ok');
    } catch (e) { notify('Failed: ' + e.message, 'error'); refresh(); }
  }));
  // DISCARD puts every input back to what the server sent — edits from every category, shown or hidden —
  // so the tray empties and nothing is sent. Locked and read-only inputs are skipped (they cannot change).
  revertBtn.addEventListener('click', () => { for (const d of keys) { if (isFixed(d)) continue; $('f-' + d.name).value = original[d.name]; } refresh(); notify('Discarded — nothing was sent.', 'ok'); });
  cancelBtn.addEventListener('click', () => CamBusy.run(cancelBtn, async () => {
    const { res, data } = await post(API, { cancel: true });
    notify(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'error');
    await load(true);
  }));

  $('e-save').addEventListener('click', () => CamBusy.run($('e-save'), async () => {
    const { res, data } = await post('camera-admin.php', { action: 'update', id: CAM, name: $('e-name').value, icon: $('e-icon').value });
    notify(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'error');
    if (res.ok) await load(true);
  }));
  $('e-detector-save').addEventListener('click', () => CamBusy.run($('e-detector-save'), async () => {
    const { res, data } = await post('camera-admin.php', { action: 'detector', id: CAM, detector: $('e-detector').value });
    notify(res.ok ? data.message : (data.error || ('Error ' + res.status)), res.ok ? 'ok' : 'error');
    if (res.ok) await load(true);
  }));
  $('e-remove').addEventListener('click', () => CamBusy.run($('e-remove'), async () => {
    if (!confirm('Remove ' + camera.name + ' from the dashboard?\n\nIts recordings are kept and the board is not touched. You can add it again later with the same id.')) return;
    const { res, data } = await post('camera-admin.php', { action: 'remove', id: CAM });
    if (res.ok) CamBusy.navigate('index.php'); else notify(data.error || ('Error ' + res.status), 'error');
  }));

  // The icon input gets a chooser bubble with a search bar (js/icon-picker.js). Without the scripts it stays a plain input.
  if (window.CamIconPicker && window.CamIconCatalog) window.CamIconPicker.attach($('e-icon'), window.CamIconCatalog.GROUPS);

  load();
</script>
<?= CamLayout::storageWarningScript() ?>
<?= CamLayout::setupModeAlertScript() ?>
</body>
</html>
