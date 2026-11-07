<?php
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';
require_once __DIR__ . '/relay.php';
$count = count($cameras);
$dashboardLayout = CamLogic::dashboardLayout($_GET['layout'] ?? null);
$cols  = CamLogic::computeGridColumns($count);

// Pictures through ONE mux.php connection (config.php 'mux_enabled') or one stream.php per camera.
$muxEnabled = CamLogic::muxEnabled($config);

// How many recordings each camera has, worked out NOW so the FILES buttons
// already show it in the page the browser receives — no waiting for a
// background request. Short timeout: the relay is on the local network, and
// if it's down the page must still appear promptly (just without numbers;
// the live status poll fills them in once it's reachable). See
// CamLogic::collectRecordingCounts() for exactly what is asked of the relay.
$readHeaders = relay_read_headers($config);
$recordingCounts = CamLogic::collectRecordingCounts($cameras, function (string $url) use ($readHeaders): ?string {
    [$body] = relay_fetch($url, 'GET', 2, $readHeaders);
    return $body === false ? null : $body;
});

// Whether the recording ON/OFF buttons can work: they need the relay's control
// key (see recording-switch.php). Without it they are shown disabled, saying why.
$switchConfigured = (string) ($config['relay_control_key'] ?? '') !== '';

// The numbers the buttons use (recording length, how long OFF lasts) are set on the SETTINGS
// page, not typed on this page — the dashboard only has buttons.
$recordSeconds    = CamLogic::recordSeconds($config);
$switchOffMinutes = CamLogic::switchOffMinutes($config);
$offFor           = $switchOffMinutes > 0 ? "for $switchOffMinutes min" : 'until switched ON';

// The detector's motion area rule (picture size, smallest side), generated from the firmware's own
// constants: the picture's rectangle below is clamped to it, so a dragged area is always one the
// detector accepts.
$areaRule = (require __DIR__ . '/lib/device_schema.php')['detector']['rules']['motionArea'];
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ESP32-CAM Dashboard</title>
<script>
  // The live <img> elements start loading while the HTML is still being parsed, and the relay answers
  // with the last known frame at once, so an image can fire load/error BEFORE the main script at the
  // bottom of the page has run (that script waits for the stylesheet below; a slow font
  // download is enough). An event fired with no handler is never repeated, which left the card on
  // "CONNECTING" for a stream that was in fact running, until RELOAD was pressed. So these stand-ins
  // (defined before anything that can block) only remember what happened; the main script replays it.
  window.__earlyStreamEvents = [];
  function onStreamLoad(id)  { window.__earlyStreamEvents.push(['load', id]); }
  function onStreamError(id) { window.__earlyStreamEvents.push(['error', id]); }
</script>
<link rel="stylesheet" href="fonts/fonts.css">
<style>
  :root {
    --bg:      #0b0e14;
    --surface: #111520;
    --border:  #1e2840;
    --border-light: #3c4d80;
    --accent:  #00e5ff;
    --accent2: #ff4f5e;
    --text:    #cdd8f0;
    --muted:   #4a5780;
    --seen:    #858c99;   /* footage already played or downloaded: a neutral gray, readable on the panel (about 5.5:1) */
    --mono:    'Share Tech Mono', monospace;
    --sans:    'Barlow', sans-serif;
    --radius:  6px;
    --shadow:  0 4px 32px rgba(0,0,0,.55);
    --cols:    <?= $cols ?>;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-weight: 300;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  body::before {
    content: '';
    position: fixed; inset: 0;
    background: repeating-linear-gradient(
      0deg, transparent, transparent 3px,
      rgba(0,0,0,.08) 3px, rgba(0,0,0,.08) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    gap: 16px;
    flex-wrap: wrap;
  }

  .logo { display: flex; align-items: center; gap: 14px; }

  .logo-icon {
    width: 36px; height: 36px;
    border: 2px solid var(--accent);
    border-radius: var(--radius);
    display: grid; place-items: center;
    font-size: 18px; color: var(--accent);
    box-shadow: 0 0 12px rgba(0,229,255,.25);
  }

  .logo h1 {
    font-family: var(--mono);
    font-size: 1.1rem;
    letter-spacing: .12em;
    color: var(--accent);
    text-shadow: 0 0 16px rgba(0,229,255,.4);
  }

  .logo p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }

  .header-meta { display: flex; align-items: center; gap: 24px; }

  .badge {
    font-family: var(--mono); font-size: .7rem;
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid var(--border); color: var(--muted);
    letter-spacing: .06em;
  }
  .badge.online { border-color: #1a4d3a; color: #2dd67b; background: rgba(45,214,123,.07); }

  #clock { font-family: var(--mono); font-size: .85rem; color: var(--muted); letter-spacing: .1em; }

  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .btn {
    font-family: var(--mono); font-size: .7rem;
    padding: 6px 12px; border-radius: var(--radius);
    border: 1px solid var(--border-light);
    background: transparent; color: var(--text);
    cursor: pointer; letter-spacing: .06em; transition: all .2s;
  }
  .btn:hover, .btn.active { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 8px rgba(0,229,255,.2); }
  .btn:disabled { opacity: .5; cursor: default; }
  a.btn { text-decoration: none; display: inline-block; }
  .btn.recording {
    border-color: var(--accent2); color: var(--accent2);
    box-shadow: 0 0 8px rgba(255,79,94,.3);
    animation: blink 1.4s ease-in-out infinite;
  }

  .record-controls { display: flex; align-items: center; gap: 6px; }

  /* Recording ON/OFF switch — in the header (all cameras) and on each camera card */
  .switch-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .switch-controls .lbl { font-family: var(--mono); font-size: .62rem; color: var(--muted); }
  .switch-controls .lbl.title { color: var(--text); }
  .switch-pill {
    font-family: var(--mono); font-size: .62rem; padding: 2px 8px; border-radius: 20px;
    border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
  }
  .switch-pill.on  { color: var(--accent); border-color: rgba(0,229,255,.35); }
  .switch-pill.off { color: #ffb74d; border-color: #6b4a14; }
  .switch-note { font-family: var(--mono); font-size: .6rem; color: var(--muted); }
  .switch-note.err { color: var(--accent2); }
  .cam-btn.switched-off { opacity: .45; }

  /* Reboot / reset drop-down (CamLayout::rebootMenu): a split button — the main action plus an arrow
     that opens the list of every target. In the header (.btn) and on each camera card (.cam-btn). */
  .reboot-menu { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .reboot-split { position: relative; display: inline-flex; }
  .reboot-menu .danger { border-color: #7a2e3a; color: var(--accent2); }
  .reboot-menu .danger:hover:not(:disabled),
  .reboot-menu .reboot-caret[aria-expanded="true"] {
    border-color: var(--accent2); color: var(--accent2);
    box-shadow: 0 0 8px rgba(255,79,94,.25); position: relative; z-index: 1;
  }
  .reboot-menu .reboot-main  { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .reboot-menu .reboot-caret { border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -1px; padding-left: 7px; padding-right: 7px; }
  .reboot-list {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; min-width: 100%;
    display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 4px;
  }
  .reboot-list[hidden] { display: none; }
  .reboot-list.align-right { left: auto; right: 0; }   /* set by the page when the list would stick out of its card / the window */
  .reboot-item {
    font-family: var(--mono); font-size: .68rem; letter-spacing: .04em; text-align: left; white-space: nowrap;
    padding: 7px 10px; border: 0; border-radius: 3px; background: transparent; color: var(--text); cursor: pointer;
  }
  .reboot-item:hover, .reboot-item:focus-visible { background: rgba(255,79,94,.12); color: var(--accent2); outline: none; }
  .reboot-item:disabled { opacity: .5; cursor: default; }
  .reboot-item.default::after { content: '  · default'; color: var(--muted); }

  /* ── Main grid ── */
  main { flex: 1; padding: 24px 32px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    gap: 20px;
    /* Cards keep their own height: opening a long file list on one camera
       must not stretch the cards beside it in the same row. */
    align-items: start;
  }
  .grid.layout-list { grid-template-columns: 1fr; }

  /* ── Camera card ── */
  .cam-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: var(--shadow);
    transition: border-color .2s, box-shadow .2s;
    animation: fadeIn .4s ease both;
  }
  .cam-card:hover {
    border-color: rgba(0,229,255,.3);
    box-shadow: var(--shadow), 0 0 20px rgba(0,229,255,.08);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .cam-card:nth-child(1){animation-delay:.05s}
  .cam-card:nth-child(2){animation-delay:.10s}
  .cam-card:nth-child(3){animation-delay:.15s}
  .cam-card:nth-child(4){animation-delay:.20s}
  .cam-card:nth-child(5){animation-delay:.25s}
  .cam-card:nth-child(6){animation-delay:.30s}

  .cam-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid var(--border);
    background: rgba(0,0,0,.2); gap: 10px; flex-wrap: wrap;
  }

  .cam-title {
    display: flex; align-items: center; gap: 8px;
    font-size: .82rem; font-weight: 500;
    letter-spacing: .05em; text-transform: uppercase; color: var(--text);
  }

  a.cam-btn { text-decoration: none; display: inline-block; }
  .cam-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  <?= CamLayout::recordingsListStyle() ?>
  .cam-btn.recording {
    border-color: var(--accent2); color: var(--accent2);
    box-shadow: 0 0 6px rgba(255,79,94,.3);
    animation: blink 1.4s ease-in-out infinite;
  }

  /* Per-camera record controls */
  .cam-record-row {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 6px 14px; border-top: 1px solid var(--border);
    background: rgba(0,0,0,.15);
  }

  .rec-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent2); box-shadow: 0 0 6px var(--accent2);
    animation: blink 1.4s ease-in-out infinite; flex-shrink: 0;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }

  /* Recording-in-progress pill, separate from the LIVE/ERROR status pill */
  .rec-pill {
    font-family: var(--mono); font-size: .62rem;
    padding: 2px 7px; border-radius: 20px;
    border: 1px solid #4d1a1a; color: var(--accent2);
    white-space: nowrap; display: none;
  }
  .rec-pill.active { display: inline-block; animation: blink 1.4s ease-in-out infinite; }

  /* ── Stream image ── */
  .cam-stream-wrap {
    position: relative;
    width: 100%;
    background: #060810;
    aspect-ratio: 4/3;
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }

  .layout-list .cam-stream-wrap { aspect-ratio: 16/6; }

  <?= CamLayout::recordingFrameStyle() ?>

  /* The picture is a link to the camera's simple view (where a click on it goes full screen). */
  .cam-stream-wrap a.stream-link { display: block; width: 100%; height: 100%; }

  .cam-stream-wrap img.stream {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }

  /* Offline / error overlay */
  .cam-overlay {
    position: absolute; inset: 0;
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    background: rgba(6,8,16,.93);
    gap: 10px; color: var(--muted);
    font-family: var(--mono); font-size: .8rem; letter-spacing: .08em;
  }
  .cam-overlay.visible { display: flex; }
  .cam-overlay .x { font-size: 2rem; color: var(--accent2); }

  /* Spinner shown while connecting */
  .spinner {
    width: 28px; height: 28px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Person detector row: what the detector sees + the numbers behind its alarm line ── */
  .det-row {
    display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;
    padding: 10px 14px; border-top: 1px solid var(--border);
    background: rgba(0,0,0,.15);
  }
  .det-pic { position: relative; flex: 0 0 auto; width: 192px; height: 192px; background: #000; border: 1px solid var(--border); }
  .det-pic img { width: 100%; height: 100%; display: block; image-rendering: pixelated; object-fit: contain; }
  /* The motion area: the part of the picture watched for motion. Drag it to move it, its edges and corners
     to resize it; what lies outside is dimmed. The handles sit INSIDE the rectangle so the picture's own
     edge never clips them. */
  .det-pic { overflow: hidden; }
  .det-area { position: absolute; border: 1px dashed var(--accent); box-shadow: 0 0 0 400px rgba(0,0,0,.4); cursor: move; touch-action: none; user-select: none; }
  .det-area[hidden] { display: none; }
  .det-area.pending { border-color: #fff; border-style: solid; }
  .det-row.offline .det-area { display: none; }
  .det-area .h { position: absolute; touch-action: none; }
  .det-area .h-n, .det-area .h-s { left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
  .det-area .h-e, .det-area .h-w { top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
  .det-area .h-n { top: 0; } .det-area .h-s { bottom: 0; } .det-area .h-e { right: 0; } .det-area .h-w { left: 0; }
  .det-area .h-nw, .det-area .h-ne, .det-area .h-sw, .det-area .h-se { width: 9px; height: 9px; background: var(--accent); opacity: .85; }
  .det-area .h-nw { top: 0; left: 0; cursor: nwse-resize; } .det-area .h-se { bottom: 0; right: 0; cursor: nwse-resize; }
  .det-area .h-ne { top: 0; right: 0; cursor: nesw-resize; } .det-area .h-sw { bottom: 0; left: 0; cursor: nesw-resize; }
  .det-pic .det-off {
    position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    padding: 10px; overflow-y: auto; text-align: center;
    background: rgba(6,8,16,.85); color: var(--muted); font-family: var(--mono); font-size: .7rem; letter-spacing: .08em;
  }
  .det-pic .det-off .det-off-why { font-size: .55rem; letter-spacing: 0; line-height: 1.35; }
  .det-row.offline .det-off { display: flex; }
  .det-row.stale .det-vals { opacity: .45; }  /* the numbers are the last ones received, not live */
  .det-vals { flex: 1 1 200px; min-width: 200px; display: flex; flex-direction: column; gap: 7px; font-family: var(--mono); font-size: .65rem; }
  .det-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .det-line .k { color: var(--muted); letter-spacing: .06em; }
  .det-line .v { color: var(--text); text-align: right; }
  .det-bar { position: relative; height: 8px; background: #060810; border: 1px solid var(--border); border-radius: 2px; }
  .det-bar .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--accent); opacity: .75; }
  .det-bar .fill.hit { background: #2dd67b; }
  .det-bar .fill.warn { background: #f0a500; }
  .det-bar .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--accent2); }
  .det-bar .mark.soft { background: #f0a500; }
  /* The threshold sticks can be dragged (see the drag code below); the ::before is a wider grab area. */
  .det-bar .mark { cursor: ew-resize; touch-action: none; }
  .det-bar .mark::before { content: ''; position: absolute; top: -4px; bottom: -4px; left: -6px; right: -6px; }
  .det-bar .mark.pending { box-shadow: 0 0 0 1px #fff, 0 0 6px 1px rgba(255,255,255,.6); }
  .det-bar .mark.dragging { box-shadow: 0 0 0 1px #fff, 0 0 8px 2px rgba(255,255,255,.8); }
  .det-apply { display: none; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; border: 1px dashed #f0a500; border-radius: 4px; padding: 5px 8px; color: #f0a500; }
  .det-apply .det-apply-btns { display: flex; gap: 6px; }
  .det-sub { color: var(--muted); font-size: .58rem; }
  .det-chip { padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .det-chip.active { color: #2dd67b; border-color: #1a4d3a; }
  .det-chip.still  { color: #f0a500; border-color: #4d3a00; }
  .det-chip.dark   { color: var(--accent2); border-color: #4d1a1a; }
  .det-chip.high   { color: var(--accent2); border-color: var(--accent2); box-shadow: 0 0 6px rgba(255,79,94,.35); }
  .det-chip.low    { color: #2dd67b; border-color: #1a4d3a; }

  .cam-footer {
    padding: 7px 14px; border-top: 1px solid var(--border);
    background: rgba(0,0,0,.15);
    font-family: var(--mono); font-size: .65rem; color: var(--muted);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    overflow: hidden;
  }
  .cam-footer span { white-space: nowrap; }

  /* status pill */
  .status-pill {
    font-family: var(--mono); font-size: .62rem;
    padding: 2px 7px; border-radius: 20px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .status-pill.connecting { color: #f0a500; border-color: #4d3a00; }
  .status-pill.live       { color: #2dd67b; border-color: #1a4d3a; }
  .status-pill.error      { color: var(--accent2); border-color: #4d1a1a; }
  .status-pill.hidden     { color: var(--muted); }

  /* ── Footer ── */
  footer {
    padding: 12px 32px; border-top: 1px solid var(--border);
    background: var(--surface);
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--mono); font-size: .65rem;
    color: var(--muted); letter-spacing: .07em;
    flex-wrap: wrap; gap: 8px;
  }

  @media (max-width: 900px) {
    :root { --cols: 1; }
    header, main, footer { padding-left: 18px; padding-right: 18px; }
  }
  @media (max-width: 600px) { .header-meta { display: none; } }
  <?= CamLayout::navBarStyle() ?>
</style>
</head>
<body>
<?= CamLayout::navBar('dashboard-' . ($dashboardLayout ?? 'grid')) ?>
<header>
  <div class="logo">
    <div class="logo-icon">📷</div>
    <div>
      <h1>ESP32-CAM DASHBOARD</h1>
      <p>Raspberry Pi · Tor-safe proxy</p>
    </div>
  </div>

  <div class="header-meta">
    <span class="badge online">● LIVE</span>
    <span class="badge"><?= $count ?> CAMERA<?= $count !== 1 ? 'S' : '' ?></span>
    <span id="clock">--:--:--</span>
  </div>

  <div class="controls">
    <button class="btn" onclick="reloadAll()">↺ RELOAD ALL</button>
    <a class="btn" id="btn-settings" href="settings-page.php"
       title="Settings of the whole system: recording lengths, relay, keys, pre-roll, log, alarm, dashboard login">⚙ SETTINGS</a>
    <span class="record-controls">
      <button class="btn" id="btn-record-all" onclick="recordAll()"
              title="Record every camera for <?= $recordSeconds ?> s (set on the SETTINGS page). Press again mid-recording to extend it by that many seconds from now">⏺ RECORD ALL</button>
      <button class="btn danger" id="btn-stop-all" onclick="stopRecordAll()" style="display:none;">⏹ STOP ALL</button>
    </span>
    <span class="switch-controls" id="switch-all"
          title="Switch recording OFF while people are on site, so nothing is recorded for no reason. Applies to every camera the relay currently knows; each camera can then be changed on its own.">
      <span class="lbl title">⏻ RECORDING:</span>
      <span class="switch-pill" id="switch-all-pill">…</span>
      <button class="btn danger" id="btn-switch-all-off" onclick="switchRecording('all', null, 'off')"
              title="Switch recording OFF for every camera <?= $offFor ?> (set on the SETTINGS page)">⏻ ALL OFF</button>
      <button class="btn" id="btn-switch-all-on" onclick="switchRecording('all', null, 'on')"
              title="Switch recording back ON for every camera">⏻ ALL ON</button>
      <span class="switch-note" id="switch-all-note"></span>
    </span>
    <?= CamLayout::rebootMenu(CamLogic::rebootMenu('system'), 'btn') ?>
  </div>
</header>

<main>
  <div class="grid" id="grid">
    <?php foreach ($cameras as $i => $cam):
      $camId    = htmlspecialchars($cam['id']);
      $camName  = htmlspecialchars($cam['name']);
      $proxyUrl = 'stream.php?cam=' . urlencode($cam['id']);
    ?>
    <div class="cam-card" id="card-<?= $camId ?>">

      <div class="cam-header">
        <div class="cam-title">
          <span><?= htmlspecialchars($cam['icon']) ?></span>
          <?= $camName ?>
        </div>
        <div class="cam-actions">
          <span class="rec-dot"></span>
          <span class="status-pill connecting" id="pill-<?= $camId ?>">CONNECTING</span>
          <span class="rec-pill" id="recpill-<?= $camId ?>"></span>
          <button data-cam="<?= $camId ?>" class="cam-btn" onclick="reloadStream(this.dataset.cam)">↺ RELOAD</button>
          <a class="cam-btn" id="settings-<?= $camId ?>" href="camera-settings-page.php?cam=<?= urlencode($cam['id']) ?>"
             title="Settings of this camera: name, icon and everything stored in the board">⚙ SETTINGS</a>
          <?= CamLayout::rebootMenu(CamLogic::rebootMenu('camera', CamLogic::detectorIdOf($cam) !== null), 'cam-btn', $cam['id']) ?>
          <button data-cam="<?= $camId ?>" class="cam-btn danger" id="hide-<?= $camId ?>"
                  onclick="toggleHide(this.dataset.cam)">✕ HIDE</button>
        </div>
      </div>

      <!-- Recording + its file list live together: start/stop a recording,
           browse and download what's already been saved, all in one place. -->
      <div class="cam-record-row">
        <button data-cam="<?= $camId ?>" class="cam-btn" id="rec-btn-<?= $camId ?>"
                title="Record this camera for <?= $recordSeconds ?> s (set on the SETTINGS page). Press again mid-recording to extend it"
                onclick="recordOne(this.dataset.cam)">⏺ RECORD</button>
        <button data-cam="<?= $camId ?>" class="cam-btn danger" id="stop-btn-<?= $camId ?>" style="display:none;"
                onclick="stopOne(this.dataset.cam)">⏹ STOP</button>
        <button data-cam="<?= $camId ?>" class="cam-btn" id="files-btn-<?= $camId ?>"
                title="Saved recordings for this camera — click to open the list"
                onclick="toggleRecordingsPanel(this.dataset.cam)"><?= CamLogic::formatFilesButtonLabel($recordingCounts[$cam['id']] ?? null) ?></button>
      </div>

      <div class="cam-record-row cam-switch-row">
        <span class="switch-pill" id="sw-pill-<?= $camId ?>">…</span>
        <button data-cam="<?= $camId ?>" class="cam-btn danger" id="sw-off-<?= $camId ?>"
                title="Switch recording OFF for this camera only, <?= $offFor ?> (set on the SETTINGS page)"
                onclick="switchRecording('camera', this.dataset.cam, 'off')">⏻ OFF</button>
        <button data-cam="<?= $camId ?>" class="cam-btn" id="sw-on-<?= $camId ?>"
                title="Switch recording back ON for this camera"
                onclick="switchRecording('camera', this.dataset.cam, 'on')">⏻ ON</button>
        <span class="switch-note" id="sw-note-<?= $camId ?>"></span>
      </div>

      <div class="files-panel" id="files-<?= $camId ?>"></div>

      <div class="cam-stream-wrap rec-frame" id="wrap-<?= $camId ?>">

        <!-- Connecting spinner (visible until image loads) -->
        <div class="cam-overlay visible" id="overlay-<?= $camId ?>">
          <div class="spinner"></div>
          <span>CONNECTING…</span>
        </div>

        <a class="stream-link" href="<?= htmlspecialchars(CamLayout::simpleViewUrl($cam['id'])) ?>"
           title="Click to open this camera in the simple view">
          <img data-cam="<?= $camId ?>"
            class="stream"
            id="img-<?= $camId ?>"
            <?= $muxEnabled ? '' : 'src="' . $proxyUrl . '"' ?>

            alt="<?= $camName ?>"
            data-src="<?= $proxyUrl ?>"
            onload="onStreamLoad(this.dataset.cam)"
            onerror="onStreamError(this.dataset.cam)"
          >
        </a>

      </div>

      <?php if (CamLogic::detectorIdOf($cam) !== null): ?>
      <!-- The paired person detector: its 96x96 picture (what the model sees) and the numbers behind
           its alarm line, to aim it and tune its thresholds (DARK_THRESH, MOTION_THRESH, DETECT_THRESH...)
           with visual confirmation. Filled in by pollDetectors(). -->
      <div class="det-row offline" id="det-<?= $camId ?>" data-cam="<?= $camId ?>">
        <div class="det-pic">
          <img data-cam="<?= $camId ?>" id="detimg-<?= $camId ?>" alt="person detector view of <?= $camName ?>"
               data-src="detector-stream.php?cam=<?= urlencode($cam['id']) ?>" <?= $muxEnabled ? '' : 'src="detector-stream.php?cam=' . urlencode($cam['id']) . '"' ?>

               onload="this.dataset.failed=''" onerror="onDetectorImgError(this.dataset.cam)">
          <div class="det-area" id="detarea-<?= $camId ?>" data-cam="<?= $camId ?>" hidden title="Motion area: only motion inside this rectangle counts. Drag it to move it, drag an edge or corner to resize it, then APPLY.">
            <?php foreach (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as $h): ?><span class="h h-<?= $h ?>" data-h="<?= $h ?>"></span><?php endforeach; ?>
          </div>
          <div class="det-off" id="detoff-<?= $camId ?>"><div class="det-off-title" id="dettitle-<?= $camId ?>">DETECTOR OFFLINE</div><div class="det-off-why" id="detwhy-<?= $camId ?>"></div></div>
        </div>
        <div class="det-vals">
          <div class="det-line"><span class="k">DETECTOR</span><span class="det-chip" id="detgate-<?= $camId ?>">…</span><button type="button" class="cam-btn" id="detwatch-<?= $camId ?>" data-cam="<?= $camId ?>" hidden onclick="toggleDetectorWatch(this.dataset.cam)"></button><a class="cam-btn" id="detcalib-<?= $camId ?>" href="camera-settings-page.php?cam=<?= urlencode($cam['id']) ?>&amp;type=detector" title="Calibrate this detector: DARK_THRESH, MOTION_THRESH, DETECT_THRESH, CLEAR_THRESH ... from the browser">⚙ CALIBRATE</a></div>
          <div>
            <div class="det-line"><span class="k">BRIGHTNESS</span><span class="v" id="detbright-<?= $camId ?>">–</span></div>
            <div class="det-bar"><div class="fill" id="detbrightbar-<?= $camId ?>"></div><div class="mark" id="detbrightmark-<?= $camId ?>" style="display:none"></div></div>
            <div class="det-sub" id="detbrightsub-<?= $camId ?>"></div>
          </div>
          <div>
            <div class="det-line"><span class="k">MOTION</span><span class="v" id="detmotion-<?= $camId ?>">–</span></div>
            <div class="det-bar"><div class="fill" id="detmotionbar-<?= $camId ?>"></div><div class="mark" id="detmotionmark-<?= $camId ?>" style="display:none"></div></div>
            <div class="det-sub" id="detmotionsub-<?= $camId ?>"></div>
          </div>
          <div>
            <div class="det-line"><span class="k">HUMAN</span><span class="v" id="detperson-<?= $camId ?>">–</span></div>
            <div class="det-bar"><div class="fill" id="detpersonbar-<?= $camId ?>"></div><div class="mark" id="detpersondetect-<?= $camId ?>" style="display:none"></div><div class="mark soft" id="detpersonclear-<?= $camId ?>" style="display:none"></div></div>
            <div class="det-sub" id="detpersonsub-<?= $camId ?>"></div>
          </div>
          <div class="det-apply" id="detapply-<?= $camId ?>"><span id="detapplytxt-<?= $camId ?>"></span><span class="det-apply-btns"><button data-cam="<?= $camId ?>" type="button" class="cam-btn" id="detapplybtn-<?= $camId ?>" onclick="applyDetectorThresholds(this.dataset.cam)" title="Send the moved thresholds to the detector (it stores them and restarts)">APPLY</button><button data-cam="<?= $camId ?>" type="button" class="cam-btn" onclick="resetDetectorThresholds(this.dataset.cam)" title="Forget the moved thresholds">RESET</button></span></div>
          <div class="det-line"><span class="k" id="detpinlabel-<?= $camId ?>">ALARM PIN</span><span class="det-chip" id="detpin-<?= $camId ?>">–</span></div>
          <div class="det-sub" id="detinfo-<?= $camId ?>"></div>
        </div>
      </div>
      <?php endif; ?>

      <div class="cam-footer">
        <span>PROXY → <?= $muxEnabled ? 'mux.php' : 'stream.php?cam=' . $camId ?></span>
        <span>CAM <?= str_pad($i + 1, 2, '0', STR_PAD_LEFT) ?></span>
      </div>

    </div>
    <?php endforeach; ?>
  </div>
</main>

<footer>
  <span>ESP32-CAM DASHBOARD · <?= date('Y') ?> · PHP MJPEG PROXY</span>
  <span id="footer-time"></span>
</footer>

<?= CamLayout::recordingsListScript() ?>
<script src="js/dashboard-layout.js"></script>
<script src="js/screen-keeper.js"></script>
<script>if (window.CamScreenKeeper) CamScreenKeeper.create().keepAwake();   // live pictures: the device screen must not go dark</script>
<?php if ($muxEnabled): ?>
<script src="js/mux-codec.js"></script>
<script src="js/mux-client.js"></script>
<script src="js/mux-pictures.js"></script>
<?php endif; ?>
<script>
  // ── Clock ──
  function tick() {
    const t = new Date();
    document.getElementById('clock').textContent = t.toLocaleTimeString('en-GB', {hour12:false});
    document.getElementById('footer-time').textContent = t.toLocaleString('en-GB');
  }
  tick(); setInterval(tick, 1000);

  function getAllCameraIds() {
    return [...document.querySelectorAll('.cam-card')].map(el => el.id.replace('card-', ''));
  }

  // True while the live pictures are closed on purpose to make room for footage (see "Making room for footage").
  // Declared up here because the early-event replay below runs before the rest of the script.
  let streamsPaused = false;

  // ── Stream state callbacks ──
  function onStreamLoad(id) {
    if (streamsPaused) return;   // the picture was stopped on purpose (see "Making room for footage")
    clearStreamWatchdog(id);
    setStatus(id, 'live', 'LIVE');
    hideOverlay(id);
  }

  function onStreamError(id) {
    if (streamsPaused) return;
    clearStreamWatchdog(id);
    setStatus(id, 'error', 'ERROR');
    showOverlay(id, '✕', 'STREAM ERROR', true);
  }

  // A stream that is still "connecting" after this long is retried by itself (what pressing RELOAD
  // does): a request that was never answered fires neither load nor error, so nothing else would
  // ever notice it.
  const STREAM_CONNECT_TIMEOUT_MS = 15000;
  const streamWatchdogs = {};
  function clearStreamWatchdog(id) {
    clearTimeout(streamWatchdogs[id]);
    delete streamWatchdogs[id];
  }
  function armStreamWatchdog(id) {
    clearStreamWatchdog(id);
    streamWatchdogs[id] = setTimeout(() => reloadStream(id), STREAM_CONNECT_TIMEOUT_MS);
  }

  // Events the images fired before this script was ready (see the stand-ins in <head>).
  (function replayEarlyStreamEvents() {
    const early = window.__earlyStreamEvents || [];
    window.__earlyStreamEvents = [];
    for (const [kind, id] of early) (kind === 'load' ? onStreamLoad : onStreamError)(id);
    // Whatever is still connecting (no event yet) gets the watchdog too.
    for (const id of getAllCameraIds()) {
      const pill = document.getElementById('pill-' + id);
      if (pill && pill.classList.contains('connecting')) armStreamWatchdog(id);
    }
  })();

  // ── Where the pictures come from ──
  // Normally ONE connection (mux.php) carries every camera's picture: a browser allows only about 6 connections per
  // address over HTTP/1.1, and one stream.php per camera used to leave no room for the other requests of this page.
  // If mux.php cannot be used from here (js/mux-client.js: three attempts in a row that never delivered anything)
  // or is switched off in config.php, each camera gets its own stream.php connection, as before.
  // <pictures-source>
  const MUX_ENABLED = <?= $muxEnabled ? 'true' : 'false' ?>;
  let pictures = MUX_ENABLED && window.CamMuxPictures ? CamMuxPictures.create({
    url: 'mux.php',
    imgFor: (kind, id) => document.getElementById((kind === 'det' ? 'detimg-' : 'img-') + id),
    onStatus: (data) => onLiveDetectorData(data),
    onCameraStatus: (data) => onLiveCameraStatus(data),
    onDown: (ids) => ids.forEach((id) => onStreamError(id)),   // it is reopened by itself; pictures resume on their own
    onFallback: fallBackToStreams,
  }) : null;

  function openPicture(id) {
    if (pictures) {
      pictures.show(id);
      return;
    }
    const img = document.getElementById('img-' + id);
    img.src = img.dataset.src + '&_=' + Date.now();   // cache-bust so the browser actually re-requests
    armStreamWatchdog(id);
  }

  function closePicture(id) {
    if (pictures) {
      pictures.hide(id);
      return;
    }
    document.getElementById('img-' + id).src = '';
  }

  // The picture of the detector paired with a camera (the page asks for it in reconnectDetectorImg).
  function closeDetectorPicture(id) {
    if (pictures) {
      pictures.hideDetector(id);
      return;
    }
    const di = document.getElementById('detimg-' + id);
    if (di) di.src = '';
  }

  // The detectors' pictures and readings had their own connections too (detector-stream.php, detector-events.php).
  function fallBackToStreams() {
    console.warn('mux.php cannot be used from here: showing one stream.php connection per camera');
    pictures.close();
    pictures = null;
    getAllCameraIds().forEach((id) => reloadStream(id));
    const detectorRows = document.querySelectorAll('.det-row');
    detectorRows.forEach((row) => reconnectDetectorImg(row.dataset.cam));
    if (detectorRows.length > 0) openDetectorEvents();
  }

  // With mux.php the images have no src yet (a src would open a connection per picture): start them now.
  // (Also when the mux scripts could not be loaded: then every camera gets its own stream.php, via openPicture.)
  if (MUX_ENABLED) getAllCameraIds().forEach((id) => reloadStream(id));
  if (pictures) {
    pictures.watchCameraStatus(true);   // recording state, FILES counts, switch: pushed on the same connection
    const detectorRows = document.querySelectorAll('.det-row');
    detectorRows.forEach((row) => pictures.showDetector(row.dataset.cam));
    if (detectorRows.length > 0) pictures.watchStatus(true);   // the readings come on the same connection, whatever the tab does
  }
  // </pictures-source>

  function setStatus(id, cls, label) {
    const pill = document.getElementById('pill-' + id);
    pill.className = 'status-pill ' + cls;
    pill.textContent = label;
  }

  function hideOverlay(id) {
    document.getElementById('overlay-' + id).classList.remove('visible');
  }

  // Page elements are built with createElement / textContent / addEventListener — never from HTML
  // strings — so nothing that came from the relay or config.php (names, ids, messages) can ever become
  // markup or script (security review F-05). `h('div', {className: 'x'}, child, 'text', ...)`.
  function h(tag, props, ...children) {
    return CamRecordingsList.h(tag, props, ...children);   // lib/recordings-list.js: the one implementation
  }

  function showOverlay(id, icon, msg, showRetry) {
    const el = document.getElementById('overlay-' + id);
    el.replaceChildren(h('span', { className: 'x', textContent: icon }), h('span', { textContent: msg }));
    if (showRetry) el.append(h('button', { className: 'cam-btn', textContent: '↺ RETRY', onclick: () => reloadStream(id) }));
    el.classList.add('visible');
  }

  // ── Reload a single stream ──
  function reloadStream(id) {
    const img  = document.getElementById('img-' + id);

    // Only reload if not hidden, and not while the pictures are paused to make room for footage
    if (img.dataset.hidden === '1' || streamsPaused) return;

    setStatus(id, 'connecting', 'CONNECTING');
    const overlay = document.getElementById('overlay-' + id);
    overlay.replaceChildren(h('div', { className: 'spinner' }), h('span', { textContent: 'CONNECTING…' }));
    overlay.classList.add('visible');

    openPicture(id);
  }

  function reloadAll() {
    document.querySelectorAll('img.stream').forEach(img => {
      const id = img.id.replace('img-', '');
      reloadStream(id);
    });
  }

  // ── Hide / show (local to this browser tab only — it just stops THIS tab
  // from loading the live stream, which saves bandwidth when viewing over
  // a slow link. The camera itself keeps capturing and pushing frames, the
  // relay keeps its pre-roll buffer, and recordings are unaffected.) ──
  function toggleHide(id) {
    const img  = document.getElementById('img-' + id);
    const btn  = document.getElementById('hide-' + id);
    const hidden = img.dataset.hidden === '1';

    if (hidden) {
      // Restore
      img.dataset.hidden = '0';
      if (document.getElementById('detimg-' + id)) reconnectDetectorImg(id);
      btn.textContent = '✕ HIDE';
      btn.classList.remove('danger');
      reloadStream(id);
    } else {
      // Hide — stop the stream by clearing src
      img.dataset.hidden = '1';
      stopPictures(id);
      btn.textContent = '▶ SHOW';
      btn.classList.add('danger');
      setStatus(id, 'hidden', 'HIDDEN');
      showOverlay(id, '◼', 'FEED PAUSED', false);
      document.getElementById('overlay-' + id).append(
        h('button', { className: 'cam-btn', textContent: '▶ RESTORE', onclick: () => toggleHide(id) }));
    }
  }

  // Closes the live connections of one camera: its picture and its detector's picture.
  function stopPictures(id) {
    clearStreamWatchdog(id);
    closePicture(id);
    closeDetectorPicture(id);
  }

  // Opens them again (cameras the user pressed HIDE on stay closed: both functions skip them).
  function restartAllPictures() {
    for (const id of getAllCameraIds()) {
      reloadStream(id);
      if (document.getElementById('detimg-' + id)) reconnectDetectorImg(id);
    }
  }

  // ── Making room for footage ──
  // Every live picture is a connection that never ends, and a browser allows only about 6 at a time to
  // one address (Brave and Chrome; Firefox copes better). A dashboard with 4 cameras and a detector has
  // 5 of them open, so the file list, a clip that is playing (it needs two connections to seek), a
  // download or a delete waits in the browser's queue and never starts: the list stays empty and the video
  // loads forever. So while the user is waiting for footage, ALL live pictures are closed, and they come
  // back when nothing needs the room any more. Requests nest (a list load while a clip plays): the pictures
  // return only when the last one is done. Pressing the browser's stop button used to be the only cure.
  // <stream-pause>
  function createStreamPauser(pauseAll, resumeAll) {
    let holds = 0;
    return {
      // Asks for room. Returns the function that gives it back (safe to call more than once).
      acquire() {
        holds += 1;
        if (holds === 1) pauseAll();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          holds -= 1;
          if (holds === 0) resumeAll();
        };
      },
    };
  }
  // </stream-pause>

  const streamPauser = createStreamPauser(pauseLiveStreams, resumeLiveStreams);

  function pauseLiveStreams() {
    streamsPaused = true;
    for (const id of getAllCameraIds()) {
      if (document.getElementById('img-' + id).dataset.hidden === '1') continue;   // already closed by the user
      stopPictures(id);
      setStatus(id, 'hidden', 'PAUSED');
      showOverlay(id, '◼', 'LIVE VIEW PAUSED WHILE FOOTAGE LOADS', false);
    }
  }

  function resumeLiveStreams() {
    streamsPaused = false;
    restartAllPictures();
  }

  // Runs one request for footage with the live pictures closed.
  async function withLiveViewPaused(request) {
    const release = streamPauser.acquire();
    try {
      return await request();
    } finally {
      release();
    }
  }

  // A download is handed to the browser, which tells the page nothing about it: give its request
  // time to get started (it keeps its connection afterwards), then let the pictures come back.
  const DOWNLOAD_START_MS = 5000;
  function holdLiveViewPausedWhileDownloadStarts() {
    const release = streamPauser.acquire();
    setTimeout(release, DOWNLOAD_START_MS);
  }

  // A clip being played holds the room until its window is closed or the clip has played to its end.
  let playerRelease = null;
  function updatePlayerHold() {
    const playing = Array.from(document.querySelectorAll('.files-video-modal video')).some(video => !video.ended);
    if (playing && !playerRelease) {
      playerRelease = streamPauser.acquire();
      return;
    }
    if (!playing && playerRelease) {
      playerRelease();
      playerRelease = null;
    }
  }

  // ── Recording — one button + one duration field starts a timed,
  // server-side recording on every camera at once (footage is written on
  // the Pi by server.js, not on the ESP32-CAM boards). Pressing it again
  // while already recording extends that same recording: the relay resets
  // its countdown to the new seconds value measured from the moment of
  // this second press, rather than adding on top of what was left. ──
  const recordCountdowns = {}; // id -> interval id


  // ── Recording ON/OFF switch ──
  // Switching recording OFF keeps the cameras streaming (live view is unaffected)
  // but nothing is recorded — no alarm, no person detector, no RECORD button — and
  // a recording in progress is stopped (what it captured is saved). OFF is for N
  // minutes (then it switches itself back ON) or, with 0 or a negative number,
  // until you press ON. The state lives on the relay (it survives restarts); this
  // page only asks it to change (via recording-switch.php, which adds the secret
  // control key — the browser never has it) and shows what the relay reports.
  const SWITCH_ENABLED = <?= $switchConfigured ? 'true' : 'false' ?>;
  const RECORD_SECONDS = <?= (int) $recordSeconds ?>;          // from the SETTINGS page
  const SWITCH_OFF_MINUTES = <?= (int) $switchOffMinutes ?>;   // from the SETTINGS page
  const switchState = {};   // camera id -> { forever, untilAt } while OFF (untilAt: this browser's clock, ms); absent = recording is ON

  function formatRemaining(ms) {
    const mins = Math.ceil(ms / 60000);
    if (ms < 60000) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
  }

  function switchLabel(st) {
    if (!st) return { text: 'REC ON', off: false };
    if (st.forever) return { text: 'REC OFF · until switched ON', off: true };
    const left = Math.max(0, st.untilAt - Date.now());
    const until = new Date(st.untilAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { text: `REC OFF · ${formatRemaining(left)} left (until ${until})`, off: true };
  }

  function renderSwitch(id) {
    const st = switchState[id];
    const label = switchLabel(st);
    const pill = document.getElementById('sw-pill-' + id);
    if (pill) { pill.textContent = label.text; pill.className = 'switch-pill ' + (label.off ? 'off' : 'on'); }
    const rec = document.getElementById('rec-btn-' + id);
    if (rec) {
      rec.classList.toggle('switched-off', label.off);
      rec.title = label.off ? 'Recording is switched OFF for this camera — press ON first'
                            : 'Press again mid-recording to extend it by this many seconds from now';
    }
  }

  function renderSwitchAll() {
    const ids = getAllCameraIds();
    const off = ids.filter(id => switchState[id]).length;
    const pill = document.getElementById('switch-all-pill');
    if (!pill) return;
    if (off === 0)             { pill.textContent = 'ALL ON';                     pill.className = 'switch-pill on'; }
    else if (off === ids.length) { pill.textContent = 'ALL OFF';                   pill.className = 'switch-pill off'; }
    else                       { pill.textContent = `${off} of ${ids.length} OFF`; pill.className = 'switch-pill off'; }
  }

  // `off` is what the relay reports for a camera: null (may record) or { forever, until, remainingMs }.
  function applySwitchState(id, off) {
    if (!off) delete switchState[id];
    else switchState[id] = { forever: !!off.forever, untilAt: off.forever ? null : Date.now() + off.remainingMs };
    renderSwitch(id);
    renderSwitchAll();
  }

  // A short message next to a button (a .switch-note element) that clears itself after 8 s.
  const noteTimers = new WeakMap();
  function setNote(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', !!isError);
    clearTimeout(noteTimers.get(el));
    if (text) noteTimers.set(el, setTimeout(() => { el.textContent = ''; }, 8000));
  }

  function setSwitchNote(id, text, isError) {
    setNote(document.getElementById(id === null ? 'switch-all-note' : 'sw-note-' + id), text, isError);
  }

  // scope: 'camera' (with id) or 'all'; action: 'on' or 'off'.
  async function switchRecording(scope, id, action) {
    const noteId = scope === 'all' ? null : id;
    if (!SWITCH_ENABLED) {
      setSwitchNote(noteId, 'Not set up: add relay_control_key to config.php (see INSTALL.md)', true);
      return;
    }
    let url = `recording-switch.php?scope=${scope}&action=${action}`;
    if (scope === 'camera') url += `&cam=${encodeURIComponent(id)}`;

    if (action === 'off') {
      const minutes = SWITCH_OFF_MINUTES;
      if (scope === 'all') {
        const forHowLong = minutes > 0 ? `for ${minutes} minutes` : 'until you switch it back ON';
        if (!confirm(`Switch recording OFF for ALL cameras ${forHowLong}?\n\nNothing will be recorded meanwhile, and recordings in progress are stopped.`)) return;
      }
      url += `&minutes=${encodeURIComponent(String(minutes))}`;
    }

    const buttons = scope === 'all'
      ? ['btn-switch-all-off', 'btn-switch-all-on'].map(b => document.getElementById(b))
      : ['sw-off-' + id, 'sw-on-' + id].map(b => document.getElementById(b));
    buttons.forEach(b => { if (b) b.disabled = true; });
    try {
      // The custom header is required by the server: a page on another website can't make a browser send it.
      const res = await fetch(url, { method: 'POST', headers: { 'X-Requested-With': 'camdash' } });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.ok && data && data.ok) {
        for (const affectedId of data.affected) applySwitchState(affectedId, data.off[affectedId] || null);
        const n = data.affected.length;
        const what = scope === 'all' ? `${n} camera${n === 1 ? '' : 's'}` : 'this camera';
        setSwitchNote(noteId, action === 'on' ? `Recording is ON for ${what}`
          : (data.forever ? `Recording is OFF for ${what} until switched ON` : `Recording is OFF for ${what} for ${data.minutes} min`), false);
        pollAllStatuses(); // a recording that was running has just been stopped: pick that up now
      } else {
        let msg = (data && data.error) || `Request failed (HTTP ${res.status})`;
        if (res.status === 401) msg = "The relay refused the control key — relay_control_key in config.php must equal controlKey in the relay's config.js";
        setSwitchNote(noteId, msg, true);
      }
    } catch (e) {
      setSwitchNote(noteId, 'Could not reach the dashboard server', true);
    } finally {
      buttons.forEach(b => { if (b) b.disabled = false; });
    }
  }

  // ── Reboot / reset menus (CamLayout::rebootMenu): in the header for the system, on a camera card for
  // that camera and/or its detector. The main button runs the menu's default target, the arrow opens
  // the list of the others. A hard reset cannot be taken back, so every target asks first. The server
  // side is reboot.php?target=<target>[&cam=<id>]: POST, with the same anti-forgery header as the other
  // buttons. One listener (below) serves every menu. ──
  function closeRebootLists() {
    document.querySelectorAll('.reboot-list:not([hidden])').forEach(list => {
      list.hidden = true;
      list.parentElement.querySelector('.reboot-caret').setAttribute('aria-expanded', 'false');
    });
  }

  function toggleRebootList(caret) {
    const list = caret.parentElement.querySelector('.reboot-list');
    const opening = list.hidden;
    closeRebootLists();
    if (!opening) return;
    list.hidden = false;
    caret.setAttribute('aria-expanded', 'true');
    // Open towards the left when the list would stick out of its card (cards clip) or the window.
    list.classList.remove('align-right');
    const limit = (list.closest('.cam-card') || document.documentElement).getBoundingClientRect().right;
    if (list.getBoundingClientRect().right > limit) list.classList.add('align-right');
  }

  async function requestReboot(menu, target, confirmText) {
    if (!confirm(confirmText)) return;
    let url = `reboot.php?target=${encodeURIComponent(target)}`;
    if (menu.dataset.cam) url += `&cam=${encodeURIComponent(menu.dataset.cam)}`;
    const note = menu.querySelector('.reboot-note');
    const buttons = menu.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    setNote(note, 'Sending…', false);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'X-Requested-With': 'camdash' } });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.ok && data && data.ok) setNote(note, data.message || 'Reboot requested', false);
      else setNote(note, (data && data.error) || `Request failed (HTTP ${res.status})`, true);
    } catch (e) {
      setNote(note, 'Could not reach the dashboard server', true);
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  document.addEventListener('click', ev => {
    const caret = ev.target.closest('.reboot-caret');
    if (caret) { toggleRebootList(caret); return; }
    closeRebootLists();   // any other click closes an open list
    const action = ev.target.closest('.reboot-main, .reboot-item');
    if (action) requestReboot(action.closest('.reboot-menu'), action.dataset.target, action.dataset.confirm);
  });

  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const open = document.querySelector('.reboot-list:not([hidden])');
    if (!open) return;
    closeRebootLists();
    open.parentElement.querySelector('.reboot-caret').focus();
  });

  // Keep the "N min left" text ticking between status polls.
  setInterval(() => { getAllCameraIds().forEach(renderSwitch); }, 1000);

  async function recordAll() {
    const seconds = RECORD_SECONDS;
    const btn = document.getElementById('btn-record-all');
    btn.disabled = true;
    const results = await Promise.all(getAllCameraIds().map(id => startRecording(id, seconds)));
    btn.disabled = false;

    if (results.some(r => r && r.recording)) {
      btn.classList.add('recording');
      document.getElementById('btn-stop-all').style.display = '';
    }
    const skipped = results.filter(r => r && r.suppressed).length;
    if (skipped > 0) setSwitchNote(null, `${skipped} camera${skipped === 1 ? ' is' : 's are'} switched OFF and ${skipped === 1 ? 'was' : 'were'} not recorded`, false);
  }

  async function stopRecordAll() {
    const btn = document.getElementById('btn-stop-all');
    btn.disabled = true;
    await Promise.all(getAllCameraIds().map(stopRecording));
    btn.disabled = false;
  }

  // Same start/extend behaviour as "RECORD ALL", just scoped to one camera
  // for a single camera. Both use the length from the SETTINGS page.
  async function recordOne(id) {
    const seconds = RECORD_SECONDS;
    const btn = document.getElementById('rec-btn-' + id);
    btn.disabled = true;
    await startRecording(id, seconds);
    btn.disabled = false;
  }

  async function stopOne(id) {
    const btn = document.getElementById('stop-btn-' + id);
    btn.disabled = true;
    await stopRecording(id);
    btn.disabled = false;
  }

  function updateRecordAllButtonState() {
    const anyRecording = Object.keys(recordCountdowns).length > 0;
    document.getElementById('btn-record-all').classList.toggle('recording', anyRecording);
    document.getElementById('btn-stop-all').style.display = anyRecording ? '' : 'none';
  }

  function updateCameraRecordButtonState(id, recording) {
    const recBtn = document.getElementById('rec-btn-' + id);
    const stopBtn = document.getElementById('stop-btn-' + id);
    if (recBtn) recBtn.classList.toggle('recording', recording);
    if (stopBtn) stopBtn.style.display = recording ? '' : 'none';
    const frame = document.getElementById('wrap-' + id);   // the picture's red blinking frame (CamLayout::recordingFrameStyle)
    if (frame) frame.classList.toggle('recording', recording);
  }

  async function startRecording(id, seconds) {
    try {
      const res = await fetch(`record.php?cam=${encodeURIComponent(id)}&seconds=${seconds}`, { method: 'POST', headers: { 'X-Requested-With': 'camdash' } });
      const data = await res.json();
      if (res.ok && data.recording) {
        beginRecordCountdown(id, seconds); // restarts the countdown, whether this was a fresh start or an extend
      } else if (data && data.suppressed) {
        // The camera is switched OFF: nothing was started. Say so, instead of failing silently.
        setSwitchNote(id, 'Recording is switched OFF for this camera — press ON first', true);
      } else {
        console.warn('Record start failed for', id, data);
      }
      return data;
    } catch (e) {
      console.error('Record start error for', id, e);
      return null;
    }
  }

  async function stopRecording(id) {
    try {
      const res = await fetch(`record.php?cam=${encodeURIComponent(id)}&stop=1`, { method: 'POST', headers: { 'X-Requested-With': 'camdash' } });
      const data = await res.json().catch(() => null);
      endRecordCountdown(id);
      return data;
    } catch (e) {
      console.error('Record stop error for', id, e);
      return null;
    }
  }

  function beginRecordCountdown(id, seconds) {
    const pill = document.getElementById('recpill-' + id);
    let remaining = seconds;
    pill.classList.add('active');
    pill.textContent = `⏺ REC ${remaining}s`;

    if (recordCountdowns[id]) clearInterval(recordCountdowns[id]);
    recordCountdowns[id] = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        endRecordCountdown(id);
      } else {
        pill.textContent = `⏺ REC ${remaining}s`;
      }
    }, 1000);
    updateRecordAllButtonState();
    updateCameraRecordButtonState(id, true);
  }

  function endRecordCountdown(id) {
    const pill = document.getElementById('recpill-' + id);
    if (recordCountdowns[id]) { clearInterval(recordCountdowns[id]); delete recordCountdowns[id]; }
    pill.classList.remove('active');
    pill.textContent = '';
    updateRecordAllButtonState();
    updateCameraRecordButtonState(id, false);
    refreshRecordingsList(id); // pick up the newly finished file if the panel is open
  }

  // Poll-driven counterpart to beginRecordCountdown/endRecordCountdown:
  // decides which one applies based on whether recording state actually
  // changed since the last poll, so this is safe to call every few seconds
  // regardless of whether anything happened.
  function applyRecordingState(id, recording, endAt) {
    const wasRecording = !!recordCountdowns[id];
    if (recording) {
      if (endAt) {
        const remaining = Math.max(1, Math.round((new Date(endAt).getTime() - Date.now()) / 1000));
        beginRecordCountdown(id, remaining); // resyncs the pill to the relay's real remaining time either way —
                                              // catches extends triggered from another tab or the alarm GPIO too
      }
    } else if (wasRecording) {
      endRecordCountdown(id); // recording finished server-side without this tab's own countdown reaching 0
    }
  }

  // ── Recordings list panel — browse, play, download and delete saved footage ──
  // The list itself (rows, buttons, selection, play / download / delete) is lib/recordings-list.js, the
  // same code the all-files page runs. This page adds what only the dashboard needs: the live pictures are
  // closed while footage loads (a list per camera panel, see recordingsListOf), and the FILES button
  // shows the recording count.

  // <recordings-panels>
  // Shows how many recordings a camera has right on its FILES button —
  // "📼 FILES (3)" — so you don't have to open the list to know. The page
  // arrives with the number already in it (PHP wrote it, see the top of this
  // file); from there it's kept current by the relay's /status (polled every
  // few seconds, so it follows clips finishing and deletes made anywhere) and
  // set instantly whenever this tab loads the list itself. Anything that isn't
  // a whole number (a folder the relay couldn't read) leaves the button
  // showing whatever it showed before rather than a wrong number. The text
  // must match CamLogic::formatFilesButtonLabel() in lib/Logic.php.
  function setFilesCount(id, count) {
    if (!Number.isInteger(count) || count < 0) return;
    const btn = document.getElementById('files-btn-' + id);
    if (btn) btn.textContent = `📼 FILES (${count})`;
  }

  const recordingLists = {};   // camera id -> the list drawn in its panel
  function recordingsListOf(id) {
    if (!recordingLists[id]) {
      recordingLists[id] = CamRecordingsList.create({
        panel: document.getElementById('files-' + id),
        prefix: id,
        cams: [id],
        camLabel: null,   // one camera: no need to say which
        deleteAllConfirm: 'Delete ALL recordings for this camera? This cannot be undone.',
        hooks: {
          withPaused: withLiveViewPaused,
          holdForDownload: holdLiveViewPausedWhileDownloadStarts,
          playersChanged: updatePlayerHold,
          // keep the button in step with what the list shows (but never from a list that could not be read in full)
          loaded: (files, failed) => { if (failed.length === 0) setFilesCount(id, files.length); },
        },
      });
    }
    return recordingLists[id];
  }

  async function toggleRecordingsPanel(id) {
    const panel = document.getElementById('files-' + id);
    const open = panel.classList.toggle('open');
    if (!open) return;
    await withLiveViewPaused(() => refreshRecordingsList(id));
  }

  // Redraws a camera's list if its panel is open (the list refreshes itself when a recording finishes).
  async function refreshRecordingsList(id) {
    const panel = document.getElementById('files-' + id);
    if (!panel || !panel.classList.contains('open')) return;
    await recordingsListOf(id).refresh();
  }
  // </recordings-panels>

  // ── Status polling — the single mechanism that keeps the dashboard in
  // sync with state that can change on the relay without this browser tab
  // being the one that caused it: another tab, another user, or a
  // camera's alarm-trigger GPIO calling /record directly on the relay.
  // Without this, nothing here updates until the user next clicks
  // something — the REC pill and the file list would silently go
  // stale. Also doubles as the initial-state load on page
  // open (including "was already recording before I opened this page",
  // which previously wasn't handled at all). ──
  // <camera-status-source>
  async function pollAllStatuses() {
    try {
      const res = await fetch('status.php');
      if (!res.ok) return;
      const data = await res.json();
      // Only trust a genuine status map. An error-shaped or malformed answer must
      // not be read as "no camera has any footage" and wipe the FILES counts.
      if (!isStatusMap(data)) return;
      applyCameraStatuses(data);
    } catch (e) {
      // Relay unreachable this round — the next poll will try again.
    }
  }

  // Shows a { camId: status } map (status.php's answer, or the same pushed on the mux.php connection).
  function applyCameraStatuses(data) {
    for (const id of getAllCameraIds()) {
      const s = data[id];
      if (!s) {
        // Neither connected to the relay yet nor any footage on disk for it.
        setFilesCount(id, 0);
        applySwitchState(id, null); // a camera the relay doesn't know can't be switched OFF
        continue;
      }
      applyRecordingState(id, s.recording, s.recordingEndAt);
      setFilesCount(id, s.recordingCount);
      applySwitchState(id, s.recordingOff || null);
    }
  }

  // The same map pushed on the mux.php connection (every 2 s): while it keeps coming the interval below does not
  // ask status.php. The page still asks once at load, after its own commands and when it comes back to the screen.
  const CAMERA_STATUS_LIVE_MS = 8000;   // delivering if the last push is younger than this (the relay pushes every 2 s)
  let cameraStatusAt = 0;
  const cameraStatusIsLive = () => Date.now() - cameraStatusAt < CAMERA_STATUS_LIVE_MS;
  function onLiveCameraStatus(data) {
    if (!isStatusMap(data)) return;
    cameraStatusAt = Date.now();
    applyCameraStatuses(data);
  }

  // What the interval does: ask status.php, unless the pushed map is arriving.
  function pollStatusesUnlessLive() {
    if (!cameraStatusIsLive()) pollAllStatuses();
  }
  // </camera-status-source>
  // ── Person detector rows (cameras with a 'detector' in config.php) ──
  // The detector keeps one connection open to the relay and pushes its 96x96 grayscale picture and
  // the numbers behind its alarm line up it (it may sit behind a NAT router, so nothing connects to
  // it). The picture is a normal MJPEG <img>; the numbers are polled about once a second so you can
  // aim the detector and tune DARK_THRESH / MOTION_THRESH / DETECT_THRESH / CLEAR_THRESH per camera
  // and SEE the effect: a bar per value, a red mark at the threshold the value has to cross, and the
  // alarm pin level the detector is driving. When the detector is not showing, the picture says WHY
  // (the relay works it out: never connected, connection lost, no picture, ...).
  const DETECTOR_POLL_MS = 1000;           // the polling fallback's interval
  const DETECTOR_LIVE_MS = 3500;           // the live stream counts as delivering if its last message is younger than this (the relay pushes at least every 1 s)
  const DETECTOR_EVENTS_RETRY_MS = 5000;   // after the live stream was refused, try it again this often
  const detEl = (k, id) => document.getElementById('det' + k + '-' + id);
  const setW = (e, frac) => { e.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%'; };
  function placeMark(e, frac) {
    if (frac === null) { e.style.display = 'none'; return; }
    e.style.display = ''; e.style.left = 'calc(' + Math.max(0, Math.min(1, frac)) * 100 + '% - 1px)';
  }
  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // What is printed over the picture while it is not showing: a title and, below it, the reason.
  function setDetectorOverlay(id, title, why) {
    detEl('title', id).textContent = title || '';
    detEl('why', id).textContent = why || '';
    detEl('off', id).title = why || '';
  }

  // ── The motion area ──
  // The rectangle over the detector's picture is the part watched for motion (MOTION_X0/Y0/X1/Y1, in pixels
  // of the 96x96 picture, left/top inside and right/bottom outside). Pure geometry first (tests/node/
  // test_area_geometry.js runs exactly this block): it keeps every area inside the picture and at least
  // AREA_MIN pixels wide and high, which is what the detector accepts.
  // <area-geometry>
  const AREA_FRAME = <?= (int) $areaRule['frame'] ?>, AREA_MIN = <?= (int) $areaRule['minSide'] ?>;
  const AREA_KEYS = { x0: 'MOTION_X0', y0: 'MOTION_Y0', x1: 'MOTION_X1', y1: 'MOTION_Y1' };
  const isAreaKey = k => Object.values(AREA_KEYS).includes(k);
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  // `start` moved or resized by (dx, dy) picture pixels. handle: 'move' or n, ne, e, se, s, sw, w, nw.
  function dragArea(start, handle, dx, dy) {
    const a = { x0: start.x0, y0: start.y0, x1: start.x1, y1: start.y1 };
    if (handle === 'move') {
      const w = start.x1 - start.x0, h = start.y1 - start.y0;
      a.x0 = clampInt(start.x0 + dx, 0, AREA_FRAME - w); a.x1 = a.x0 + w;
      a.y0 = clampInt(start.y0 + dy, 0, AREA_FRAME - h); a.y1 = a.y0 + h;
      return a;
    }
    if (handle.includes('w')) a.x0 = clampInt(start.x0 + dx, 0, start.x1 - AREA_MIN);
    if (handle.includes('e')) a.x1 = clampInt(start.x1 + dx, start.x0 + AREA_MIN, AREA_FRAME);
    if (handle.includes('n')) a.y0 = clampInt(start.y0 + dy, 0, start.y1 - AREA_MIN);
    if (handle.includes('s')) a.y1 = clampInt(start.y1 + dy, start.y0 + AREA_MIN, AREA_FRAME);
    return a;
  }
  // The area the detector reports with the not yet applied edges laid over it ({} = none pending).
  function effectiveArea(reported, pending) {
    const a = {};
    Object.keys(AREA_KEYS).forEach(k => { a[k] = pending[AREA_KEYS[k]] !== undefined ? pending[AREA_KEYS[k]] : reported[k]; });
    return a;
  }
  const fmtArea = a => a.x0 + ',' + a.y0 + ' – ' + a.x1 + ',' + a.y1;
  const isWholePicture = a => a.x0 === 0 && a.y0 === 0 && a.x1 === AREA_FRAME && a.y1 === AREA_FRAME;
  // </area-geometry>

  // ── Dragging the threshold sticks ──
  // Drag a stick along its bar to try a threshold: the stick, the "value/threshold" number and the text
  // under the bar follow the mouse at once. Nothing is sent while dragging — the moved thresholds wait
  // (white glow) until APPLY queues them for the detector in ONE change, because the detector stores a
  // change and restarts. RESET forgets them. Once the detector reports the new values they are dropped.
  const detLast = {};      // cam id -> last report received
  const detLastD = {};     // cam id -> last detector status (what renderDetector was given)
  const detIdle = {};      // cam id -> true while the detector's live view is off (no picture to retry for)
  const detPending = {};   // cam id -> { SETTING: value } moved but not applied yet
  const detApplying = {};  // cam id -> true between APPLY and the detector reporting the values
  const detDrag = {};      // cam id -> { key, scale } while a stick is held
  const DET_STICKS = {     // setting -> [mark element, bar element, value kind]
    DARK_THRESH:   ['brightmark',   'brightbar', 'int'],
    MOTION_THRESH: ['motionmark',   'motionbar', 'int'],
    DETECT_THRESH: ['persondetect', 'personbar', 'pct'],
    CLEAR_THRESH:  ['personclear',  'personbar', 'pct'],
  };
  const isDragging = (id, key) => !!(detDrag[id] && detDrag[id].key === key);
  const detKind = k => (DET_STICKS[k] || [0, 0, 'int'])[2];   // how a value is written: int or pct (the area's edges are ints)

  // The motion threshold the readings are judged against: a value dragged but not applied yet, else the one the
  // detector reports as in force (MOTION_THRESH, or more while the auto-calibration follows a noisy scene), else -
  // a detector from before that report - the set one.
  function motionLimitOf(sc, eff, pd) {
    if (pd.MOTION_THRESH !== undefined) return eff.MOTION_THRESH;
    return Number.isFinite(sc.motionLimit) ? sc.motionLimit : eff.MOTION_THRESH;
  }

  // <motion-scale>
  // What the motion bar's full width stands for. It has to stay STILL: the stick is placed (and dragged) on this
  // scale, so a scale that moved would carry the stick away from the pointer. It therefore depends on ONE
  // thing only — the MOTION_THRESH the detector reports (the setting the stick sets, which does not move; NOT the
  // threshold in force, which the auto-calibration raises and lowers with the scene) — and not on the value being dragged (the stick would
  // jump on release: drag it to 10 % and the scale shrank to fit, throwing it back to the middle) and not
  // on the live motion readings (a spike stretched the scale to the spike: the stick was squeezed against
  // the left edge and one pixel was hundreds of units). Motion above the scale simply fills the bar.
  // The bar is MOTION_SCALE_HEADROOM times the reported threshold wide: room to raise it, and the live
  // reading still shows up to that many times the threshold. It changes only when the reported threshold does
  // (after APPLY, or a change made elsewhere); `previous` is what this returned last time ({ reported, scale }).
  const MOTION_SCALE_HEADROOM = 4;
  const MOTION_SCALE_MIN = 100;
  function nextMotionScale(previous, reported) {
    if (previous && previous.reported === reported) return previous;
    return { reported, scale: Math.max(reported * MOTION_SCALE_HEADROOM, MOTION_SCALE_MIN) };
  }
  // </motion-scale>
  const detScale = {};     // cam id -> { reported, scale } (nextMotionScale)
  function motionScale(id, sc) {
    detScale[id] = nextMotionScale(detScale[id], sc.motionAtLeast);
    return detScale[id].scale;
  }

  // The detector's reported value of a setting, in the same unit as the pending one.
  function reportedThreshold(r, key) {
    const area = r.scene.area || {};
    return { DARK_THRESH: r.scene.darkBelow, MOTION_THRESH: r.scene.motionAtLeast, DETECT_THRESH: r.person.detectAt, CLEAR_THRESH: r.person.clearAt,
             MOTION_X0: area.x0, MOTION_Y0: area.y0, MOTION_X1: area.x1, MOTION_Y1: area.y1 }[key];
  }
  const sameThreshold = (a, b) => Math.abs(a - b) < 0.0051;

  // A pending value the detector now reports (or one dragged back to what it already has) is no longer pending.
  function dropAppliedPending(id, r) {
    const pd = detPending[id];
    if (!pd) return;
    Object.keys(pd).forEach(k => { if (!isDragging(id, k) && sameThreshold(pd[k], reportedThreshold(r, k))) delete pd[k]; });
    if (!Object.keys(pd).length) { delete detPending[id]; delete detApplying[id]; }
  }

  function markPendingSticks(id) {
    const pd = detPending[id] || {};
    Object.keys(DET_STICKS).forEach(k => detEl(DET_STICKS[k][0], id).classList.toggle('pending', pd[k] !== undefined));
  }

  function renderApplyBar(id) {
    const box = detEl('apply', id), pd = detPending[id];
    if (!box) return;
    if (!pd) { box.style.display = 'none'; return; }
    const r = detLast[id];
    const fmt = (k, v) => detKind(k) === 'pct' ? Math.round(v * 100) + ' %' : v;
    const parts = Object.keys(pd).filter(k => !isAreaKey(k)).map(k => k + ' ' + (r ? fmt(k, reportedThreshold(r, k)) + ' → ' : '') + fmt(k, pd[k]));
    if (r && r.scene.area && Object.keys(pd).some(isAreaKey)) parts.push('motion area ' + fmtArea(r.scene.area) + ' → ' + fmtArea(effectiveArea(r.scene.area, pd)));
    const busy = !!detApplying[id];
    detEl('applytxt', id).textContent = (busy ? 'queued — the detector applies it and restarts: ' : 'not applied yet: ') + parts.join(', ');
    detEl('applybtn', id).disabled = busy;
    box.style.display = 'flex';
  }

  function setPendingThreshold(id, key, value) {
    const r = detLast[id];
    if (r && sameThreshold(value, reportedThreshold(r, key))) {
      if (detPending[id]) delete detPending[id][key];
      if (detPending[id] && !Object.keys(detPending[id]).length) delete detPending[id];
    } else {
      (detPending[id] = detPending[id] || {})[key] = value;
    }
    detApplying[id] = false;   // changed since it was queued: it has to be applied again
  }

  // Value under the pointer for one stick, kept inside what the detector accepts.
  function thresholdFromX(id, key, frac) {
    const r = detLast[id], pd = detPending[id] || {};
    const kind = DET_STICKS[key][2];
    if (kind === 'int') {
      const max = key === 'DARK_THRESH' ? 255 : Math.round(detDrag[id].scale);
      return Math.max(1, Math.min(max, Math.round(frac * max)));   // 0 would switch the check off
    }
    const v = Math.round(frac * 100) / 100;
    const detect = pd.DETECT_THRESH !== undefined ? pd.DETECT_THRESH : r.person.detectAt;
    const clear  = pd.CLEAR_THRESH  !== undefined ? pd.CLEAR_THRESH  : r.person.clearAt;
    return key === 'DETECT_THRESH' ? Math.max(clear, Math.min(1, v)) : Math.max(0.01, Math.min(detect, v));   // 0.01..1, clear <= detect
  }

  function startStickDrag(ev, id, key, mark) {
    const r = detLast[id];
    if (!r || ev.button > 0) return;
    ev.preventDefault();
    const bar = detEl(DET_STICKS[key][1], id).parentElement;   // the whole bar, not its (partly filled) .fill
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pd = detPending[id] || {};
    // Both person sticks at the same spot: the amber one is on top, but which one is meant depends on the
    // direction it is pulled (right = the red one, left = the amber one), decided on the first movement.
    const tied = key === 'CLEAR_THRESH' && Math.abs(
      (pd.DETECT_THRESH !== undefined ? pd.DETECT_THRESH : r.person.detectAt) -
      (pd.CLEAR_THRESH  !== undefined ? pd.CLEAR_THRESH  : r.person.clearAt)) < 0.005;
    detDrag[id] = { key, scale: key === 'MOTION_THRESH' ? motionScale(id, r.scene) : 0 };
    const startX = ev.clientX;
    let decided = !tied;
    try { mark.setPointerCapture(ev.pointerId); } catch (e) { /* older browser: window listeners below still work */ }
    const place = (k, el) => {
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const v = thresholdFromX(id, k, frac);
      setPendingThreshold(id, k, v);
      placeMark(el, DET_STICKS[k][2] === 'pct' ? v : v / (k === 'DARK_THRESH' ? 255 : Math.round(detDrag[id].scale)));
      return v;
    };
    const redraw = () => { if (detLast[id]) renderDetector(id, detLastD[id]); };
    const onMove = e => {
      ev = e;
      if (!decided) {
        if (Math.abs(e.clientX - startX) < 3) return;
        decided = true;
        if (e.clientX > startX) { detDrag[id].key = key = 'DETECT_THRESH'; mark.classList.remove('dragging'); mark = detEl(DET_STICKS[key][0], id); }
        mark.classList.add('dragging');
      }
      place(key, mark);
      redraw();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      mark.classList.remove('dragging');
      delete detDrag[id];
      redraw();
    };
    mark.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // One listener for every stick (ids look like detbrightmark-<cam>), so it does not matter when the rows are drawn.
  document.addEventListener('pointerdown', ev => {
    const m = ev.target.closest && ev.target.closest('.det-bar .mark');
    if (!m || !m.id) return;
    const hit = /^det(brightmark|motionmark|persondetect|personclear)-(.+)$/.exec(m.id);
    if (!hit) return;
    const key = { brightmark: 'DARK_THRESH', motionmark: 'MOTION_THRESH', persondetect: 'DETECT_THRESH', personclear: 'CLEAR_THRESH' }[hit[1]];
    startStickDrag(ev, hit[2], key, m);
  });

  // Moving / resizing the motion area on the picture. Nothing is sent while dragging: the edges wait
  // (white outline) with the thresholds until APPLY queues them in ONE change.
  function startAreaDrag(ev, id, handle, el) {
    const r = detLast[id];
    if (!r || !r.scene.area || ev.button > 0) return;
    ev.preventDefault();
    const scale = el.parentElement.clientWidth / AREA_FRAME;   // screen pixels per picture pixel
    if (!(scale > 0)) return;
    const start = effectiveArea(r.scene.area, detPending[id] || {});
    const x = ev.clientX, y = ev.clientY;
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* older browser: window listeners below still work */ }
    const onMove = e => {
      const a = dragArea(start, handle, (e.clientX - x) / scale, (e.clientY - y) / scale);
      Object.keys(AREA_KEYS).forEach(k => setPendingThreshold(id, AREA_KEYS[k], a[k]));
      if (detLast[id]) renderDetector(id, detLastD[id]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  document.addEventListener('pointerdown', ev => {
    const el = ev.target.closest && ev.target.closest('.det-area');
    if (el && el.dataset.cam) startAreaDrag(ev, el.dataset.cam, ev.target.dataset.h || 'move', el);
  });

  async function applyDetectorThresholds(id) {
    const pd = detPending[id];
    if (!pd || detApplying[id]) return;
    const values = {};
    Object.keys(pd).forEach(k => { values[k] = detKind(k) === 'pct' ? pd[k].toFixed(2) : String(pd[k]); });
    const txt = detEl('applytxt', id);
    detEl('applybtn', id).disabled = true;
    txt.textContent = 'sending…';
    try {
      const res = await fetch('camera-settings.php?cam=' + encodeURIComponent(id) + '&type=detector', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'camdash' },
        body: JSON.stringify({ values }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      if (!j.queued) { delete detPending[id]; renderApplyBar(id); return; }   // the detector already has these values
      detApplying[id] = true;
      renderApplyBar(id);
    } catch (e) {
      detApplying[id] = false;
      renderApplyBar(id);
      txt.textContent = 'could not apply: ' + e.message;
    }
  }

  function resetDetectorThresholds(id) {
    delete detPending[id];
    delete detApplying[id];
    if (detLast[id]) renderDetector(id, detLastD[id]);
  }

  // Nothing could be learned about the detector this round (the dashboard lost the relay, say).
  function renderDetectorProblem(id, title, why) {
    const row = document.getElementById('det-' + id);
    if (!row) return;
    row.classList.add('offline', 'stale');
    setDetectorOverlay(id, title, why);
  }

  function renderDetector(id, d) {
    const row = document.getElementById('det-' + id);
    if (!row) return;
    detLastD[id] = d;
    detIdle[id] = !!d && d.state === 'idle';
    renderWatchButton(id, d);
    const r = d && d.report;
    const online = !!(d && d.online && r);
    const showing = online && !!d.hasPicture;
    row.classList.toggle('offline', !showing);
    row.classList.toggle('stale', !online);
    if (showing) {
      setDetectorOverlay(id, '', '');
      reconnectDetectorImgIfFailed(id);   // the picture is available again: don't wait for the retry timer
    } else if (!d) {
      setDetectorOverlay(id, 'NO DATA', 'the dashboard got no answer about this detector');
    } else {
      const idle = d.state === 'idle';
      setDetectorOverlay(
        id,
        idle ? 'LIVE VIEW OFF' : d.state === 'no-picture' ? 'NO PICTURE' : 'DETECTOR OFFLINE',
        idle ? 'Press ▶ WATCH to see the sensor values and the picture. The detector keeps detecting and driving its alarm pin; it only rests its Wi-Fi.' : (d.message || '')
      );
    }
    if (!r) return;   // never heard from: keep the dashes
    const sc = r.scene, pe = r.person;
    detLast[id] = r;
    dropAppliedPending(id, r);
    const pd = detPending[id] || {};
    // A threshold dragged but not applied yet shows in place of the one the detector reports.
    const eff = {
      DARK_THRESH:   pd.DARK_THRESH   !== undefined ? pd.DARK_THRESH   : sc.darkBelow,
      MOTION_THRESH: pd.MOTION_THRESH !== undefined ? pd.MOTION_THRESH : sc.motionAtLeast,
      DETECT_THRESH: pd.DETECT_THRESH !== undefined ? pd.DETECT_THRESH : pe.detectAt,
      CLEAR_THRESH:  pd.CLEAR_THRESH  !== undefined ? pd.CLEAR_THRESH  : pe.clearAt,
    };

    const gate = detEl('gate', id);
    gate.textContent = { dark: 'DARK — paused', still: 'STILL — paused', active: 'ACTIVE — detecting', off: 'GATE OFF' }[sc.state] || sc.state.toUpperCase();
    gate.className = 'det-chip ' + (sc.state === 'off' ? '' : sc.state);

    // Brightness 0..255, mark = DARK_THRESH (below it the picture counts as dark)
    setW(detEl('brightbar', id), sc.brightness / 255);
    const darkOn = eff.DARK_THRESH > 0;
    // "current/threshold", e.g. 45/230 (just the value while the check is off)
    detEl('bright', id).textContent = darkOn ? sc.brightness + '/' + eff.DARK_THRESH : sc.brightness;
    if (!isDragging(id, 'DARK_THRESH')) placeMark(detEl('brightmark', id), darkOn ? eff.DARK_THRESH / 255 : null);
    detEl('brightbar', id).className = 'fill' + (darkOn && sc.brightness < eff.DARK_THRESH ? ' warn' : '');
    detEl('brightsub', id).textContent = darkOn ? 'dark below ' + eff.DARK_THRESH + ' (DARK_THRESH)' : 'darkness check off (DARK_THRESH=0)';

    // Motion; the bar's scale is a fixed multiple of the REPORTED threshold (see nextMotionScale), so the stick
    // stays where it was put whatever the live readings do.
    const mOn = eff.MOTION_THRESH > 0;
    const limit = mOn ? motionLimitOf(sc, eff, pd) : 0;   // the number the reading is compared with
    const mScale = motionScale(id, sc);
    detEl('motion', id).textContent = mOn ? sc.motion + '/' + limit : sc.motion;
    setW(detEl('motionbar', id), sc.motion / mScale);
    if (!isDragging(id, 'MOTION_THRESH')) placeMark(detEl('motionmark', id), mOn ? eff.MOTION_THRESH / mScale : null);
    detEl('motionbar', id).className = 'fill' + (mOn && sc.motion >= limit ? ' hit' : '');
    const area = sc.area ? effectiveArea(sc.area, pd) : null;   // null: a detector from before the motion area
    detEl('motionsub', id).textContent = (mOn
      ? 'moving at ≥ ' + limit + (limit > eff.MOTION_THRESH ? ' (raised by the auto-calibration; MOTION_THRESH ' + eff.MOTION_THRESH + ' is the lowest)' : ' (MOTION_THRESH)') + ', detection stays on ' + sc.holdS + ' s after (MOTION_HOLD_S)'
      : 'motion check off (MOTION_THRESH=0)') +
      (area ? (isWholePicture(area) ? '; whole picture counts' : '; only inside the dashed area ' + fmtArea(area)) : '');
    const box = detEl('area', id);
    box.hidden = !area;
    if (area) {
      box.style.left = area.x0 / AREA_FRAME * 100 + '%';
      box.style.top = area.y0 / AREA_FRAME * 100 + '%';
      box.style.width = (area.x1 - area.x0) / AREA_FRAME * 100 + '%';
      box.style.height = (area.y1 - area.y0) / AREA_FRAME * 100 + '%';
      box.classList.toggle('pending', Object.keys(pd).some(isAreaKey));
    }

    // Human score (null while the model is paused: dark / still)
    const hasScore = pe.score !== null && pe.score !== undefined;
    detEl('person', id).textContent = hasScore ? Math.round(pe.score * 100) + '/' + Math.round(eff.DETECT_THRESH * 100) + ' %' + (pe.detected ? '  — PERSON' : '') : 'model paused';
    setW(detEl('personbar', id), hasScore ? pe.score : 0);
    detEl('personbar', id).className = 'fill' + (pe.detected ? ' hit' : '');
    if (!isDragging(id, 'DETECT_THRESH')) placeMark(detEl('persondetect', id), eff.DETECT_THRESH);
    if (!isDragging(id, 'CLEAR_THRESH')) placeMark(detEl('personclear', id), eff.CLEAR_THRESH);
    detEl('personsub', id).textContent = 'person at ≥ ' + Math.round(eff.DETECT_THRESH * 100) + ' % (DETECT_THRESH, red), clears below ' + Math.round(eff.CLEAR_THRESH * 100) + ' % (CLEAR_THRESH, amber)';
    markPendingSticks(id);
    renderApplyBar(id);

    // The alarm line the detector drives (its PERSON_GPIO, wired to the camera's alarm input)
    detEl('pinlabel', id).textContent = 'ALARM PIN (GPIO ' + r.gpio.pin + ')';
    const pin = detEl('pin', id);
    pin.textContent = r.gpio.high ? 'HIGH' : 'LOW';
    pin.className = 'det-chip ' + (r.gpio.high ? 'high' : 'low');

    // The board itself, for tracking down trouble: where it is, how strong its Wi-Fi, how long it has run,
    // its memory, which firmware it runs (did the update reach it?), and the trouble it counted.
    const info = [];
    if (r.ip) info.push(r.ip);
    if (r.rssi !== null && r.rssi !== undefined) info.push(r.rssi + ' dBm');
    if (r.uptimeMs !== null && r.uptimeMs !== undefined) info.push('up ' + fmtUptime(r.uptimeMs));
    const lk = r.link || {};
    if (lk.heap !== null && lk.heap !== undefined) info.push(Math.round(lk.heap / 1024) + ' KB free');
    if (lk.reconnects) info.push(lk.reconnects + ' reconnects');
    if (lk.jpegFails) info.push(lk.jpegFails + ' JPEG failures');
    if (r.fw) info.push('fw ' + r.fw);
    detEl('info', id).textContent = info.join(' · ');
  }

  // The WATCH button: the detector streams its sensor values and small picture only while somebody wants to
  // look, so its Wi-Fi radio can rest (it keeps detecting and driving its alarm pin either way).
  // Pure logic first (tests/node/test_detector_watch.js runs exactly this block).
  // <detector-watch>
  const WATCH_KEEP_MS = 20000;               // while somebody watches, the page tells the relay "still looking" this often
  const WATCH_ACTIVE_MS = 10 * 60 * 1000;    // ... as long as the person touched the page within this time
  const fmtLeft = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const isStreaming = (d) => !!d && (d.state === 'online' || d.state === 'no-picture');
  // What the button of one detector shows and does, from its status (the detector-status.php shape).
  //   -> { hidden, label, title, action: 'on' | 'off' }
  function watchButton(d) {
    const view = d && d.view;
    if (!view || !view.supported) return { hidden: true, label: '', title: '', action: 'on' };   // an older firmware streams all the time
    if (isStreaming(d)) {
      const left = d.report && typeof d.report.viewLeftS === 'number' ? d.report.viewLeftS : null;
      return { hidden: false, label: '■ STOP' + (left === null ? '' : ' (' + fmtLeft(left) + ')'), title: 'Stop the live view now, so the detector can rest', action: 'off' };
    }
    if (view.wanted) return { hidden: false, label: '… STARTING', title: 'Asked: the detector checks in about every 30 s while it rests. Click to cancel.', action: 'off' };
    return { hidden: false, label: '▶ WATCH', title: 'Show the sensor values and the small picture (the detector rests when nobody watches)', action: 'on' };
  }
  // Should this page tell the relay "still looking" now? Only while the live view is wanted or running, the
  // page is in view, and the person has been active on it lately — an abandoned tab lets the view run out.
  function keepAliveDue(d, nowMs, lastActivityMs, hidden) {
    if (hidden || !d || !d.view || !d.view.supported) return false;
    if (!d.view.wanted && !isStreaming(d)) return false;
    return nowMs - lastActivityMs < WATCH_ACTIVE_MS;
  }
  // </detector-watch>

  async function postDetectorView(id, action) {
    try {
      const res = await fetch('detector-view.php?cam=' + encodeURIComponent(id) + '&action=' + action, { method: 'POST', headers: { 'X-Requested-With': 'camdash' } });
      if (res.ok) return true;
      let why = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) why = j.error; } catch (e) { /* not JSON */ }
      setDetectorOverlay(id, 'LIVE VIEW', why);
    } catch (e) {
      setDetectorOverlay(id, 'LIVE VIEW', 'could not reach the dashboard: ' + ((e && e.message) || e));
    }
    return false;
  }
  function toggleDetectorWatch(id) {
    const b = watchButton(detLastD[id]);
    if (b.hidden) return;
    lastActivityAt = Date.now();
    detEl('watch', id).disabled = true;   // re-enabled by the next status (the relay pushes one at once)
    postDetectorView(id, b.action).then((ok) => { if (!ok) detEl('watch', id).disabled = false; });
  }
  function renderWatchButton(id, d) {
    const el = detEl('watch', id);
    if (!el) return;
    const b = watchButton(d);
    el.hidden = b.hidden;
    el.textContent = b.label;
    el.title = b.title;
    el.disabled = false;
  }
  // "Still looking" while somebody watches (the activity of the person is what keeps the view alive).
  let lastActivityAt = Date.now();
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { lastActivityAt = Date.now(); }, { passive: true }));
  function keepDetectorViewsAlive() {
    document.querySelectorAll('.det-row').forEach((row) => {
      const id = row.dataset.cam;
      if (keepAliveDue(detLastD[id], Date.now(), lastActivityAt, document.hidden)) postDetectorView(id, 'keep');
    });
  }

  // Shows one { camId: status } answer on every detector row. Both the live stream and the polling fallback
  // end up here. Applied at most once per animation frame, and only the newest answer: when messages come
  // faster than the screen draws, the ones in between are skipped, never queued.
  let pendingDetectorData = null;
  function showDetectorData(data) {
    const schedule = pendingDetectorData === null;
    pendingDetectorData = data;
    if (!schedule) return;
    requestAnimationFrame(() => {
      const latest = pendingDetectorData;
      pendingDetectorData = null;
      document.querySelectorAll('.det-row').forEach(row => renderDetector(row.dataset.cam, latest[row.dataset.cam]));
    });
  }
  function showDetectorProblem(why) {
    pendingDetectorData = null;
    document.querySelectorAll('.det-row').forEach(row => renderDetectorProblem(row.dataset.cam, 'NO DATA', why));
  }
  const isStatusMap = (data) => !!data && typeof data === 'object' && !Array.isArray(data) && !data.error;

  // A { camId: status } answer that arrived over a live connection (detector-events.php below, or mux.php): it is
  // what the page shows, and while they keep coming the polling fallback stays quiet.
  function onLiveDetectorData(data) {
    if (!isStatusMap(data)) return;
    detectorEventsAt = Date.now();
    detectorPollFailures = 0;
    showDetectorData(data);
  }

  // LIVE: the dashboard keeps one Server-Sent Events stream open (detector-events.php) and the relay pushes
  // the numbers the moment a detector sends them — no polling interval in between. If the stream cannot be
  // had (an older relay, a proxy that buffers, a network hiccup) the polling below takes over by itself.
  let detectorEvents = null;
  let detectorEventsAt = 0;     // when the last message arrived
  let detectorEventsTimer = null;
  const detectorStreamIsLive = () => Date.now() - detectorEventsAt < DETECTOR_LIVE_MS;
  function closeDetectorEvents() {
    clearTimeout(detectorEventsTimer);
    detectorEventsTimer = null;
    if (detectorEvents) detectorEvents.close();
    detectorEvents = null;
  }
  function openDetectorEvents() {
    closeDetectorEvents();
    if (pictures || document.hidden || typeof EventSource === 'undefined') return;   // (with mux.php the readings come on its connection)
    const source = new EventSource('detector-events.php');
    detectorEvents = source;
    source.addEventListener('detectors', (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch (err) { /* not JSON: ignore this message */ }
      onLiveDetectorData(data);
    });
    source.onerror = () => {
      // The browser retries by itself while it is CONNECTING; once CLOSED (an HTTP error answer) it never does.
      if (source.readyState !== EventSource.CLOSED) return;
      if (detectorEvents === source) detectorEvents = null;
      clearTimeout(detectorEventsTimer);
      detectorEventsTimer = setTimeout(openDetectorEvents, DETECTOR_EVENTS_RETRY_MS);
    };
  }

  // FALLBACK: ask once a second while no live stream is delivering.
  let detectorsPolling = false;
  let detectorPollFailures = 0;
  async function pollDetectors() {
    if (detectorsPolling || document.hidden || detectorStreamIsLive()) return;
    detectorsPolling = true;
    try {
      const res = await fetch('detector-status.php', { cache: 'no-store' });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok || !isStatusMap(data)) {
        throw new Error((data && data.error) || ('the dashboard got HTTP ' + res.status));
      }
      if (detectorStreamIsLive()) return; // the stream delivered while this answer was on its way: it is newer
      detectorPollFailures = 0;
      showDetectorData(data);
    } catch (e) {
      // One failed round is a blip; two in a row mean the numbers on screen are no longer live — say so.
      detectorPollFailures += 1;
      if (detectorPollFailures >= 2) showDetectorProblem(String((e && e.message) || e));
    } finally {
      detectorsPolling = false;
    }
  }

  // The picture stream: the relay answers at once (frames, or an error saying why there are none), so a
  // detector that is offline just makes this fail quickly and retry every few seconds.
  const detImgTimers = {};
  function reconnectDetectorImg(id) {
    clearTimeout(detImgTimers[id]);
    delete detImgTimers[id];
    const img = document.getElementById('detimg-' + id);
    const cam = document.getElementById('img-' + id);
    if (!img || document.hidden || streamsPaused || (cam && cam.dataset.hidden === '1')) return;
    if (pictures) {   // the picture comes on the one connection, whenever the detector streams (also after it was idle)
      pictures.showDetector(id);
      return;
    }
    if (detIdle[id]) return;   // idle: the picture comes back by itself when the view is switched on
    img.dataset.failed = '';
    img.dataset.lastTry = String(Date.now());
    img.src = img.dataset.src + '&_=' + Date.now();
  }
  function reconnectDetectorImgIfFailed(id) {
    const img = document.getElementById('detimg-' + id);
    // not more than once every 2 s, so a stream the relay keeps refusing is not hammered at the poll rate
    if (img && img.dataset.failed === '1' && Date.now() - Number(img.dataset.lastTry || 0) > 2000) reconnectDetectorImg(id);
  }
  function onDetectorImgError(id) {
    if (streamsPaused) return;
    const img = document.getElementById('detimg-' + id);
    if (img) img.dataset.failed = '1';
    clearTimeout(detImgTimers[id]);
    detImgTimers[id] = setTimeout(() => reconnectDetectorImg(id), 5000);
  }
  // ── Coming back to the page ──
  // A locked phone (or a tab left in the background for a while) cannot keep its connections: the streams
  // die without a sound and the pictures are blank when the page is shown again. So after the page has been
  // hidden for a while, every picture starts over from a new connection and the numbers are asked for at
  // once. Cameras the user pressed HIDE on stay hidden (reloadStream / reconnectDetectorImg both skip them).
  const RESUME_AFTER_HIDDEN_MS = 3000;   // shorter than this is a tab switch, not a lock: the streams are fine
  let hiddenSince = null;
  function resumeAfterHidden() {
    restartAllPictures();
    if (pictures) pictures.reconnect();   // the one connection may have died without a sound too
    pollAllStatuses();
    if (document.querySelector('.det-row')) pollDetectors();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenSince = Date.now(); return; }
    const away = hiddenSince === null ? Infinity : Date.now() - hiddenSince;   // shown without ever being seen hidden: reload too
    hiddenSince = null;
    if (away >= RESUME_AFTER_HIDDEN_MS) resumeAfterHidden();
  });
  // Back/forward cache: the page returns exactly as it was left, with the connections the browser closed meanwhile.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) resumeAfterHidden(); });

  if (document.querySelector('.det-row')) {
    // (mux.php wanted but its scripts did not load: the detectors' pictures start the old way, like the cameras')
    if (MUX_ENABLED && !pictures) document.querySelectorAll('.det-row').forEach((row) => reconnectDetectorImg(row.dataset.cam));
    openDetectorEvents();
    pollDetectors();
    setInterval(pollDetectors, DETECTOR_POLL_MS);
    // A hidden tab needs no live numbers (and holds no connection); coming back reopens the stream.
    document.addEventListener('visibilitychange', () => { if (document.hidden) closeDetectorEvents(); else openDetectorEvents(); });
    setInterval(keepDetectorViewsAlive, WATCH_KEEP_MS);
  }

  const STATUS_POLL_MS = 4000;
  pollAllStatuses();
  setInterval(pollStatusesUnlessLive, STATUS_POLL_MS);

  // ── Layout: DASHBOARD GRID / DASHBOARD LIST of the navigation bar (js/dashboard-layout.js) ──
  if (window.CamDashboardLayout) {
    CamDashboardLayout.wire({ document, location, history, storage: localStorage });
  }
</script>
<?= CamLayout::storageWarningScript() ?>
</body>
</html>
