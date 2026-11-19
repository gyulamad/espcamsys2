<?php
// settings-search.php — "Jump to any setting" (F-29 T7b, designs/Search-v2.png): one search over
// EVERY setting of the dashboard — each camera's keys, each detector's keys (via the camera it is
// paired with) and the relay's and dashboard's own fields.
//
// The page is the shell only: the index (all entries, with names, plain-language labels, help text,
// categories and the url each hit opens) comes from settings-search-index.php, and
// js/settings-search.js does the matching, the scope pills and the list. A hit opens the page the
// setting is edited on with ?find=KEY — the camera settings page shows the key's category with the
// row framed and focused, the relay's page frames the row — so the search is a jump, not a second
// editor: nothing is changed here.
//
// Reachable from both settings pages' "🔍 JUMP TO SETTING" buttons.
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/lib/Layout.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jump to any setting — ESP32-CAM Dashboard</title>
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
  .crumbs a { color: var(--muted); text-decoration: none; }
  .crumbs a:hover { color: var(--accent); }
  .crumbs .sep { margin: 0 6px; }
  .crumbs .here { color: var(--accent); }
  main { max-width: 900px; margin: 0 auto; padding: 24px 32px 60px; display: flex; flex-direction: column; gap: 16px; }
  /* ── the search box (designs/Search-v2.png): magnifier, input, ESC ── */
  .searchbox { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius); padding: 0 16px; height: 52px; }
  .searchbox:focus-within { box-shadow: 0 0 0 1px var(--accent); }
  .searchbox svg { flex: 0 0 auto; }
  .searchbox input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--text); font-family: var(--mono); font-size: 16px; }
  .searchbox input:focus { outline: none; }
  .searchbox input::placeholder { color: var(--muted); }
  .chip { font-family: var(--mono); font-size: .68rem; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; padding: 2px 7px; white-space: nowrap; }
  button.chip { cursor: pointer; background: transparent; }
  button.chip:hover { border-color: var(--accent); color: var(--accent); }
  /* ── the scope pills ── */
  .scopebar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .scopebar .lbl { font-family: var(--mono); font-size: .68rem; letter-spacing: .1em; color: var(--muted); }
  .scope-pill { font-family: var(--mono); font-size: .75rem; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); color: var(--text); background: transparent; cursor: pointer; }
  .scope-pill:hover { border-color: var(--border-light); color: var(--accent); }
  .scope-pill.on { border-color: var(--accent); color: var(--accent); background: rgba(0, 229, 255, .07); }
  /* ── the hits ── */
  #results { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); min-height: 64px; }
  #results:empty { visibility: hidden; }
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
  #note { font-size: .8rem; color: var(--warn); line-height: 1.45; min-height: 0; }
  #note:empty { display: none; }
  footer { font-size: .8rem; color: var(--muted); line-height: 1.5; }
  @media (max-width: 640px) {
    header, main { padding-left: 16px; padding-right: 16px; }
    .hit-value { min-width: 0; }
  }
<?= CamLayout::navBarStyle() ?>
<?= CamLayout::busyStyle() ?>
</style>
</head>
<body>
<?= CamLayout::navBar(null) ?>
<header>
  <div>
    <nav class="crumbs" aria-label="Where you are">
      <a href="settings-page.php" data-page-load="">← SETTINGS</a><span class="sep">/</span><span class="here">SEARCH</span>
    </nav>
    <h1>⌕ JUMP TO ANY SETTING</h1>
    <p>Cameras · detectors · relay</p>
  </div>
</header>

<main>
  <div class="searchbox">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>
    <input id="q" type="text" aria-label="Jump to any setting" placeholder="Jump to any setting: try jpeg, port, alarm" autocomplete="off" spellcheck="false"
           aria-controls="results" aria-describedby="footer-hint">
    <button class="chip" id="esc" type="button" title="Clear the search; again goes back">ESC</button>
  </div>
  <div class="scopebar" id="scopebar" role="group" aria-label="Scope">
    <span class="lbl">SHOW</span>
  </div>
  <div id="results" role="listbox" aria-label="Matching settings"></div>
  <span id="note" aria-live="polite"></span>
  <footer id="footer-hint">Searches names, plain-language labels and help text. Enter opens the category with the setting highlighted.</footer>
</main>

<script src="js/busy.js"></script>
<script src="js/settings-search.js"></script>
<script>
  const $ = (id) => document.getElementById(id);
  const escBtn = $('esc');
  // The ESC chip does what the key does: clear the search, and on an empty one go back.
  escBtn.addEventListener('click', () => {
    if ($('q').value !== '') { $('q').value = ''; $('q').dispatchEvent(new Event('input', { bubbles: true })); $('q').focus(); }
    else window.history.back();
  });
  // The controller is kept on the window (like the pages keep their helpers), so an embedding page
  // and the tests can reach the state: CamSearch.hits, CamSearch.selected, CamSearch.scope.
  window.CamSearch = window.CamSettingsSearch.mount({ input: $('q'), scopeBar: $('scopebar'), results: $('results'), note: $('note'), indexUrl: 'settings-search-index.php' });
</script>
</body>
</html>
