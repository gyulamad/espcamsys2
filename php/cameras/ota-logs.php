<?php
// ota-logs.php — the OTA & LOGS page: what a person would otherwise watch over SSH after a release,
//   watch -n 10 "curl -s -H 'X-Control-Key: ...' http://127.0.0.1:8080/ota/status"
//   sudo tail -f .../camera.log /var/log/apache2/error.log | grep --line-buffered -E '\b(WARN|ERROR)\b'
// as a page in the browser: the firmware status of every board (are they on the version that was published?), and the
// end of the relay's log and of Apache's error log, filtered by level. Each part refreshes on its own timer, which the
// person sets on the page.
//
// The page only draws the shell. js/ota-logs.js asks ota-status.php and logs-tail.php, which add the control key (it never
// reaches the browser) and cut what the relay says down to plain text. Nothing here changes anything.
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OTA &amp; LOGS — ESP32-CAM Dashboard</title>
<?= CamLayout::faviconLinks() ?>
<link rel="stylesheet" href="fonts/fonts.css">
<style>
  :root {
    --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80;
    --accent: #00e5ff; --accent2: #ff4f5e; --text: #cdd8f0; --muted: #4a5780;
    --ok: #3ddc84; --warn: #ffb020;
    --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif; --radius: 6px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; min-height: 100vh; }
  header { padding: 18px 32px; border-bottom: 1px solid var(--border); background: var(--surface); }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  main { max-width: 1300px; margin: 0 auto; padding: 24px 32px 60px; display: flex; flex-direction: column; gap: 24px; }
  section { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 14px 16px; }
  section h2 { font-family: var(--mono); font-size: .9rem; letter-spacing: .1em; color: var(--accent); margin-bottom: 10px; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin-bottom: 10px; font-family: var(--mono); font-size: .75rem; }
  .controls label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .controls input[type=number] {
    width: 6em; padding: 4px 6px; font-family: var(--mono); font-size: .75rem; color: var(--text);
    background: var(--bg); border: 1px solid var(--border-light); border-radius: var(--radius);
  }
  .controls input[type=checkbox] { accent-color: var(--accent); }
  fieldset.levels { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; border: 0; }
  fieldset.levels legend { float: left; margin-right: 8px; padding: 0; }
  .updated { color: var(--muted); }
  .inline-error { color: var(--accent2); font-family: var(--mono); font-size: .75rem; min-height: 1em; margin-bottom: 6px; }
  .muted { color: var(--muted); }
  .ota-wrap { overflow-x: auto; }
  .ota-table { border-collapse: collapse; font-family: var(--mono); font-size: .75rem; min-width: 100%; }
  .ota-table th, .ota-table td { text-align: left; padding: 5px 14px 5px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .ota-table th { color: var(--muted); font-weight: normal; letter-spacing: .06em; }
  .ota-state-updated { color: var(--ok); }
  .ota-state-pending { color: var(--warn); }
  .ota-state-offline { color: var(--accent2); }
  .ota-state-nothing-published { color: var(--muted); }
  .log-pane {
    height: 60vh; min-height: 220px; overflow: auto; padding: 10px 12px; background: #070a10;
    border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--mono); font-size: .72rem;
  }
  .log-source + .log-source { margin-top: 14px; }
  .log-source-title { color: var(--accent); margin-bottom: 4px; }
  .log-source-error { color: var(--accent2); }
  .log-lines { white-space: pre-wrap; word-break: break-word; line-height: 1.35; }
  @media (max-width: 700px) {
    header, main { padding-left: 16px; padding-right: 16px; }
  }
<?= CamLayout::navBarStyle() ?>
<?= CamLayout::busyStyle() ?>
</style>
</head>
<body>
<?= CamLayout::navBar('ota-logs') ?>
<header>
  <h1>🛰 OTA &amp; LOGS</h1>
  <p>Firmware status of the boards · the end of the relay and Apache logs</p>
</header>

<main>
  <section aria-labelledby="ota-title">
    <h2 id="ota-title">OTA STATUS</h2>
    <div class="controls">
      <label>Refresh (s) <input type="number" id="ota-refresh" value="10" min="1" max="3600" step="1" inputmode="numeric"></label>
      <span class="updated" id="ota-updated" aria-live="polite"></span>
    </div>
    <div class="inline-error" id="ota-error" role="status"></div>
    <div class="ota-wrap" id="ota-table"><p class="muted">Loading…</p></div>
  </section>

  <section aria-labelledby="log-title">
    <h2 id="log-title">LOGS</h2>
    <div class="controls">
      <fieldset class="levels">
        <legend>Level</legend>
        <label><input type="checkbox" id="lvl-warn" checked> WARN</label>
        <label><input type="checkbox" id="lvl-error" checked> ERROR</label>
        <label><input type="checkbox" id="lvl-debug"> DEBUG</label>
        <label><input type="checkbox" id="lvl-info"> INFO</label>
        <label><input type="checkbox" id="lvl-all"> All</label>
      </fieldset>
      <label>Tail length <input type="number" id="log-lines" value="1000" min="1" max="5000" step="1" inputmode="numeric"></label>
      <label>Refresh (s) <input type="number" id="log-refresh" value="10" min="1" max="3600" step="1" inputmode="numeric"></label>
      <span class="updated" id="log-updated" aria-live="polite"></span>
    </div>
    <div class="inline-error" id="log-error" role="status"></div>
    <div class="log-pane" id="log-out" tabindex="0" aria-label="Log lines"><p class="muted">Loading…</p></div>
  </section>
</main>

<script src="js/busy.js"></script>
<script src="js/relay-json.js"></script>
<script src="js/ota-logs.js"></script>
<script>
  CamOtaLogs.mount({
    doc: document,
    request: CamRelayJson.request,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    isHidden: () => document.hidden,
    onVisibilityChange: (fn) => document.addEventListener('visibilitychange', fn),
  });
</script>
<?= CamLayout::storageWarningScript() ?>
<?= CamLayout::setupModeAlertScript() ?>
</body>
</html>
