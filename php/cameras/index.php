<?php
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
$count = count($cameras);
$cols  = CamLogic::computeGridColumns($count);

// How many recordings each camera has, worked out NOW so the FILES buttons
// already show it in the page the browser receives — no waiting for a
// background request. Short timeout: the relay is on the local network, and
// if it's down the page must still appear promptly (just without numbers;
// the live status poll fills them in once it's reachable). See
// CamLogic::collectRecordingCounts() for exactly what is asked of the relay.
$recordingCounts = CamLogic::collectRecordingCounts($cameras, function (string $url): ?string {
    $ctx = stream_context_create(['http' => ['timeout' => 2, 'ignore_errors' => true]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
});

// Whether the recording ON/OFF buttons can work: they need the relay's control
// key (see recording-switch.php). Without it they are shown disabled, saying why.
$switchConfigured = (string) ($config['relay_control_key'] ?? '') !== '';
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ESP32-CAM Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@300;500;700&display=swap" rel="stylesheet">
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
  .btn.recording {
    border-color: var(--accent2); color: var(--accent2);
    box-shadow: 0 0 8px rgba(255,79,94,.3);
    animation: blink 1.4s ease-in-out infinite;
  }

  .record-controls, .alarm-controls { display: flex; align-items: center; gap: 6px; }

  /* Recording ON/OFF switch — in the header (all cameras) and on each camera card */
  .switch-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .switch-controls .lbl { font-family: var(--mono); font-size: .62rem; color: var(--muted); }
  .switch-controls .lbl.title { color: var(--text); }
  .switch-controls input[type=number], .cam-switch-row input[type=number] {
    width: 56px; font-family: var(--mono); font-size: .65rem;
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: 3px; padding: 4px 6px;
  }
  .switch-controls .unit, .cam-switch-row .unit { font-family: var(--mono); font-size: .6rem; color: var(--muted); }
  .switch-pill {
    font-family: var(--mono); font-size: .62rem; padding: 2px 8px; border-radius: 20px;
    border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
  }
  .switch-pill.on  { color: var(--accent); border-color: rgba(0,229,255,.35); }
  .switch-pill.off { color: #ffb74d; border-color: #6b4a14; }
  .switch-note { font-family: var(--mono); font-size: .6rem; color: var(--muted); }
  .switch-note.err { color: var(--accent2); }
  .cam-btn.switched-off { opacity: .45; }
  .alarm-controls input[type=number],
  .record-controls input[type=number] {
    width: 60px; font-family: var(--mono); font-size: .7rem;
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius); padding: 6px 8px;
  }
  .record-controls span.unit,
  .alarm-controls span.unit,
  .alarm-controls span.lbl { font-family: var(--mono); font-size: .65rem; color: var(--muted); }
  .alarm-controls .lbl.title { color: var(--accent2); }
  /* Small "saved / saving / error" note next to the alarm fields */
  #alarm-status { font-family: var(--mono); font-size: .62rem; min-width: 70px; color: var(--muted); }
  #alarm-status.ok  { color: var(--accent); }
  #alarm-status.err { color: var(--accent2); }

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

  .cam-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  .cam-btn {
    font-family: var(--mono); font-size: .65rem;
    padding: 3px 8px; border-radius: 3px;
    border: 1px solid var(--border-light);
    background: transparent; color: var(--text);
    cursor: pointer; text-decoration: none;
    transition: all .15s; letter-spacing: .04em;
  }
  .cam-btn:hover               { border-color: var(--accent);  color: var(--accent); }
  .cam-btn.danger:hover        { border-color: var(--accent2); color: var(--accent2); }
  .cam-btn.danger              { border-color: #7a2e3a; color: var(--accent2); }
  .cam-btn:disabled            { opacity: .5; cursor: default; }
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
  .cam-record-row input[type=number] {
    width: 52px; font-family: var(--mono); font-size: .65rem;
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: 3px; padding: 4px 6px;
  }
  .cam-record-row .unit { font-family: var(--mono); font-size: .6rem; color: var(--muted); }

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

  .cam-stream-wrap img.stream {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    cursor: zoom-in;
  }

  /* Fullscreen the stream by clicking it — browser chrome fills the
     wrap div; the image itself just needs to stay centered/contained. */
  .cam-stream-wrap:fullscreen,
  .cam-stream-wrap:-webkit-full-screen {
    background: #000;
  }
  .cam-stream-wrap:fullscreen img.stream,
  .cam-stream-wrap:-webkit-full-screen img.stream {
    cursor: zoom-out;
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

  /* Recordings list panel */
  .files-panel {
    display: none; flex-direction: column; gap: 4px;
    padding: 8px 14px; border-top: 1px solid var(--border);
    background: rgba(0,0,0,.25);
    font-family: var(--mono); font-size: .62rem; color: var(--muted);
    /* Deliberately NO max-height / overflow: the list is as long as it needs
       to be and the page itself scrolls. A scroll box inside a scrolling page
       is awkward to use on touch devices (the finger scrolls the wrong one). */
  }
  .files-panel.open { display: flex; }
  .files-panel-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-bottom: 4px; margin-bottom: 2px; border-bottom: 1px solid var(--border);
  }
  .files-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .files-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .files-size { flex-shrink: 0; }
  .files-empty { color: var(--muted); padding: 4px 0; }
  .files-player video {
    width: 100%; max-height: 220px; border-radius: 4px;
    margin: 2px 0 6px; display: block; background: #000;
  }

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
</style>
</head>
<body>

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
    <button class="btn active" id="btn-grid" onclick="setLayout('grid')">⊞ GRID</button>
    <button class="btn"        id="btn-list" onclick="setLayout('list')">☰ LIST</button>
    <button class="btn" onclick="reloadAll()">↺ RELOAD ALL</button>
    <span class="record-controls">
      <input type="number" id="record-seconds" min="1" max="3600" value="60" title="Recording length in seconds">
      <span class="unit">sec</span>
      <span class="unit preroll-note" id="preroll-note-record"></span>
      <button class="btn" id="btn-record-all" onclick="recordAll()"
              title="Press again mid-recording to extend it by this many seconds from now">⏺ RECORD ALL</button>
      <button class="btn danger" id="btn-stop-all" onclick="stopRecordAll()" style="display:none;">⏹ STOP ALL</button>
      <button class="btn danger" id="btn-delete-all" onclick="deleteAllRecordingsEverywhere()"
              title="Delete every saved recording, for every camera">🗑 DELETE ALL FOOTAGE</button>
    </span>
    <span class="switch-controls" id="switch-all"
          title="Switch recording OFF while people are on site, so nothing is recorded for no reason. Applies to every camera the relay currently knows; each camera can then be changed on its own.">
      <span class="lbl title">⏻ RECORDING:</span>
      <span class="switch-pill" id="switch-all-pill">…</span>
      <input type="number" id="switch-all-minutes" step="1" value="60"
             title="Minutes to stay OFF. 0 or a negative number = OFF until you press ON.">
      <span class="unit">min</span>
      <button class="btn danger" id="btn-switch-all-off" onclick="switchRecording('all', null, 'off')"
              title="Switch recording OFF for every camera, for this many minutes (0 or negative = until switched ON)">⏻ ALL OFF</button>
      <button class="btn" id="btn-switch-all-on" onclick="switchRecording('all', null, 'on')"
              title="Switch recording back ON for every camera">⏻ ALL ON</button>
      <span class="switch-note" id="switch-all-note"></span>
    </span>
    <span class="alarm-controls"
          title="Used when a camera's alarm input triggers. Stored on the relay and applied to every camera — no reflashing needed. Changes apply to the next alarm.">
      <span class="lbl title">🚨 ALARM:</span>
      <span class="lbl">record</span>
      <input type="number" id="alarm-record-seconds" min="1" max="3600" value="60"
             title="How long an alarm-triggered recording runs (a repeat alarm extends it from that moment)" onchange="saveAlarmSettings()">
      <span class="unit">sec</span>
      <span class="unit preroll-note" id="preroll-note-alarm"></span>
      <span id="alarm-status"></span>
    </span>
  </div>
</header>

<main>
  <div class="grid" id="grid">
    <?php foreach ($cameras as $i => $cam):
      $proxyUrl = 'stream.php?cam=' . urlencode($cam['id']);
    ?>
    <div class="cam-card" id="card-<?= htmlspecialchars($cam['id']) ?>">

      <div class="cam-header">
        <div class="cam-title">
          <span><?= $cam['icon'] ?></span>
          <?= htmlspecialchars($cam['name']) ?>
        </div>
        <div class="cam-actions">
          <span class="rec-dot"></span>
          <span class="status-pill connecting" id="pill-<?= htmlspecialchars($cam['id']) ?>">CONNECTING</span>
          <span class="rec-pill" id="recpill-<?= htmlspecialchars($cam['id']) ?>"></span>
          <button class="cam-btn" onclick="reloadStream('<?= htmlspecialchars($cam['id']) ?>')">↺ RELOAD</button>
          <button class="cam-btn danger" id="hide-<?= htmlspecialchars($cam['id']) ?>"
                  onclick="toggleHide('<?= htmlspecialchars($cam['id']) ?>')">✕ HIDE</button>
        </div>
      </div>

      <!-- Recording + its file list live together: start/stop a recording,
           browse and download what's already been saved, all in one place. -->
      <div class="cam-record-row">
        <input type="number" id="seconds-<?= htmlspecialchars($cam['id']) ?>" min="1" max="3600" value="60"
               title="Recording length in seconds">
        <span class="unit">sec</span>
        <button class="cam-btn" id="rec-btn-<?= htmlspecialchars($cam['id']) ?>"
                title="Press again mid-recording to extend it by this many seconds from now"
                onclick="recordOne('<?= htmlspecialchars($cam['id']) ?>')">⏺ RECORD</button>
        <button class="cam-btn danger" id="stop-btn-<?= htmlspecialchars($cam['id']) ?>" style="display:none;"
                onclick="stopOne('<?= htmlspecialchars($cam['id']) ?>')">⏹ STOP</button>
        <button class="cam-btn" id="files-btn-<?= htmlspecialchars($cam['id']) ?>"
                title="Saved recordings for this camera — click to open the list"
                onclick="toggleRecordingsPanel('<?= htmlspecialchars($cam['id']) ?>')"><?= CamLogic::formatFilesButtonLabel($recordingCounts[$cam['id']] ?? null) ?></button>
      </div>

      <div class="cam-record-row cam-switch-row">
        <span class="switch-pill" id="sw-pill-<?= htmlspecialchars($cam['id']) ?>">…</span>
        <input type="number" id="sw-min-<?= htmlspecialchars($cam['id']) ?>" step="1" value="60"
               title="Minutes to stay OFF. 0 or a negative number = OFF until you press ON.">
        <span class="unit">min</span>
        <button class="cam-btn danger" id="sw-off-<?= htmlspecialchars($cam['id']) ?>"
                title="Switch recording OFF for this camera only, for this many minutes (0 or negative = until switched ON)"
                onclick="switchRecording('camera', '<?= htmlspecialchars($cam['id']) ?>', 'off')">⏻ OFF</button>
        <button class="cam-btn" id="sw-on-<?= htmlspecialchars($cam['id']) ?>"
                title="Switch recording back ON for this camera"
                onclick="switchRecording('camera', '<?= htmlspecialchars($cam['id']) ?>', 'on')">⏻ ON</button>
        <span class="switch-note" id="sw-note-<?= htmlspecialchars($cam['id']) ?>"></span>
      </div>

      <div class="files-panel" id="files-<?= htmlspecialchars($cam['id']) ?>"></div>

      <div class="cam-stream-wrap" id="wrap-<?= htmlspecialchars($cam['id']) ?>">

        <!-- Connecting spinner (visible until image loads) -->
        <div class="cam-overlay visible" id="overlay-<?= htmlspecialchars($cam['id']) ?>">
          <div class="spinner"></div>
          <span>CONNECTING…</span>
        </div>

        <img
          class="stream"
          id="img-<?= htmlspecialchars($cam['id']) ?>"
          src="<?= $proxyUrl ?>"
          alt="<?= htmlspecialchars($cam['name']) ?>"
          data-src="<?= $proxyUrl ?>"
          onload="onStreamLoad('<?= htmlspecialchars($cam['id']) ?>')"
          onerror="onStreamError('<?= htmlspecialchars($cam['id']) ?>')"
          onclick="toggleStreamFullscreen('<?= htmlspecialchars($cam['id']) ?>')"
          title="Click to view full screen"
        >

      </div>

      <div class="cam-footer">
        <span>PROXY → stream.php?cam=<?= htmlspecialchars($cam['id']) ?></span>
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

  // ── Stream state callbacks ──
  function onStreamLoad(id) {
    setStatus(id, 'live', 'LIVE');
    hideOverlay(id);
  }

  function onStreamError(id) {
    setStatus(id, 'error', 'ERROR');
    showOverlay(id, '✕', 'STREAM ERROR', true);
  }

  function setStatus(id, cls, label) {
    const pill = document.getElementById('pill-' + id);
    pill.className = 'status-pill ' + cls;
    pill.textContent = label;
  }

  function hideOverlay(id) {
    document.getElementById('overlay-' + id).classList.remove('visible');
  }

  function showOverlay(id, icon, msg, showRetry) {
    const el = document.getElementById('overlay-' + id);
    el.innerHTML = `<span class="x">${icon}</span><span>${msg}</span>`
      + (showRetry ? `<button class="cam-btn" onclick="reloadStream('${id}')">↺ RETRY</button>` : '');
    el.classList.add('visible');
  }

  // ── Reload a single stream ──
  function reloadStream(id) {
    const img  = document.getElementById('img-' + id);

    // Only reload if not hidden
    if (img.dataset.hidden === '1') return;

    setStatus(id, 'connecting', 'CONNECTING');
    document.getElementById('overlay-' + id).innerHTML =
      '<div class="spinner"></div><span>CONNECTING…</span>';
    document.getElementById('overlay-' + id).classList.add('visible');

    // Cache-bust so the browser actually re-requests
    img.src = img.dataset.src + '&_=' + Date.now();
  }

  function reloadAll() {
    document.querySelectorAll('img.stream').forEach(img => {
      const id = img.id.replace('img-', '');
      reloadStream(id);
    });
  }

  // ── Fullscreen — click the stream image to blow it up, click it again
  // (or press Esc) to leave. Fullscreens the wrap div rather than just the
  // <img> so the connecting/error overlay stays layered correctly on top
  // of it if the stream drops while zoomed in. ──
  function toggleStreamFullscreen(id) {
    const wrap = document.getElementById('wrap-' + id);
    if (!wrap) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === wrap) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(err => console.error('Fullscreen failed:', err));
    } else if (wrap.webkitRequestFullscreen) {
      wrap.webkitRequestFullscreen(); // Safari
    }
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
      btn.textContent = '✕ HIDE';
      btn.classList.remove('danger');
      reloadStream(id);
    } else {
      // Hide — stop the stream by clearing src
      img.dataset.hidden = '1';
      img.src = '';
      btn.textContent = '▶ SHOW';
      btn.classList.add('danger');
      setStatus(id, 'hidden', 'HIDDEN');
      showOverlay(id, '◼', 'FEED PAUSED', false);
      document.getElementById('overlay-' + id).innerHTML +=
        `<button class="cam-btn" onclick="toggleHide('${id}')">▶ RESTORE</button>`;
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

  const switchNoteTimers = {};
  function setSwitchNote(id, text, isError) {
    const el = document.getElementById(id === null ? 'switch-all-note' : 'sw-note-' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'switch-note' + (isError ? ' err' : '');
    clearTimeout(switchNoteTimers[id]);
    if (text) switchNoteTimers[id] = setTimeout(() => { el.textContent = ''; }, 8000);
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
      const raw = document.getElementById(scope === 'all' ? 'switch-all-minutes' : 'sw-min-' + id).value.trim();
      if (raw !== '' && !/^-?\d+$/.test(raw)) {
        setSwitchNote(noteId, 'Enter a whole number of minutes (0 or negative = until switched ON)', true);
        return;
      }
      const minutes = raw === '' ? 60 : parseInt(raw, 10);
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

  // Keep the "N min left" text ticking between status polls.
  setInterval(() => { getAllCameraIds().forEach(renderSwitch); }, 1000);

  async function recordAll() {
    const secondsInput = document.getElementById('record-seconds');
    const seconds = parseInt(secondsInput.value, 10);
    if (!Number.isFinite(seconds) || seconds < 1) {
      alert('Enter a valid number of seconds');
      return;
    }

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
  // using that card's own duration field instead of the header's.
  async function recordOne(id) {
    const secondsInput = document.getElementById('seconds-' + id);
    const seconds = parseInt(secondsInput.value, 10);
    if (!Number.isFinite(seconds) || seconds < 1) {
      alert('Enter a valid number of seconds');
      return;
    }
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
  }

  async function startRecording(id, seconds) {
    try {
      const res = await fetch(`record.php?cam=${encodeURIComponent(id)}&seconds=${seconds}`, { method: 'POST' });
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
      const res = await fetch(`record.php?cam=${encodeURIComponent(id)}&stop=1`, { method: 'POST' });
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

  async function toggleRecordingsPanel(id) {
    const panel = document.getElementById('files-' + id);
    const open = panel.classList.toggle('open');
    if (open) await refreshRecordingsList(id);
  }

  async function refreshRecordingsList(id) {
    const panel = document.getElementById('files-' + id);
    if (!panel || !panel.classList.contains('open')) return;
    try {
      const res = await fetch(`recordings.php?cam=${encodeURIComponent(id)}`);
      const files = await res.json();
      if (Array.isArray(files)) setFilesCount(id, files.length); // keep the button in step with what the list shows
      if (!Array.isArray(files) || files.length === 0) {
        panel.innerHTML = '<div class="files-empty">No recordings yet.</div>';
        return;
      }
      const header = `
        <div class="files-panel-header">
          <span>${files.length} recording${files.length === 1 ? '' : 's'}</span>
          <button class="cam-btn danger" onclick="deleteAllRecordings('${id}')">🗑 DELETE ALL</button>
        </div>
      `;
      const rows = files.map(f => `
        <div class="files-row">
          <span class="files-name">${escapeHtml(f.filename)}</span>
          <span class="files-size">${formatBytes(f.sizeBytes)}</span>
          <button class="cam-btn" onclick="togglePlayRecording('${id}', '${f.filename}')">▶ PLAY</button>
          <a class="cam-btn" href="recordings.php?cam=${encodeURIComponent(id)}&download=${encodeURIComponent(f.filename)}">⬇ GET</a>
          <button class="cam-btn danger" onclick="deleteRecording('${id}', '${f.filename}')">🗑 DEL</button>
        </div>
        <div class="files-player" id="player-${id}-${f.filename}"></div>
      `).join('');
      panel.innerHTML = header + rows;
    } catch (e) {
      panel.innerHTML = '<div class="files-empty">Could not load recordings.</div>';
    }
  }

  // Toggles a plain HTML5 <video> element in place under the clicked
  // file's row — the browser's own built-in player handles playback, no
  // extra library needed. recordings.php's ?play= streams the same bytes
  // as ?download= but with an inline Content-Disposition and Range-header
  // forwarding, so seeking/scrubbing works. Filenames only ever contain
  // [A-Za-z0-9_.-], enforced server-side, so it's safe to use one directly
  // in a DOM id/URL without extra escaping here.
  function togglePlayRecording(id, filename) {
    const container = document.getElementById(`player-${id}-${filename}`);
    if (!container) return;
    if (container.dataset.open === '1') {
      container.innerHTML = ''; // also stops playback — removing the <video> drops its media element
      container.dataset.open = '0';
      return;
    }
    const src = `recordings.php?cam=${encodeURIComponent(id)}&play=${encodeURIComponent(filename)}`;
    container.innerHTML = `<video controls autoplay src="${src}"></video>`;
    container.dataset.open = '1';
  }

  async function deleteRecording(id, filename) {
    if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`recordings.php?cam=${encodeURIComponent(id)}&delete=${encodeURIComponent(filename)}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      await refreshRecordingsList(id);
    } catch (e) {
      alert('Could not delete recording: ' + e.message);
    }
  }

  async function deleteAllRecordings(id) {
    if (!confirm('Delete ALL recordings for this camera? This cannot be undone.')) return;
    try {
      const res = await fetch(`recordings.php?cam=${encodeURIComponent(id)}&deleteAll=1`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      await refreshRecordingsList(id);
    } catch (e) {
      alert('Could not delete recordings: ' + e.message);
    }
  }

  // Global "DELETE ALL FOOTAGE" button — fans out a deleteAll request to
  // every configured camera, same pattern as recordAll()/stopRecordAll().
  async function deleteAllRecordingsEverywhere() {
    if (!confirm('Delete ALL recordings for EVERY camera? This cannot be undone.')) return;
    const btn = document.getElementById('btn-delete-all');
    btn.disabled = true;
    try {
      await Promise.all(getAllCameraIds().map(id =>
        fetch(`recordings.php?cam=${encodeURIComponent(id)}&deleteAll=1`, { method: 'POST' }).catch(() => null)
      ));
      // Refresh any panels currently open so deleted files disappear immediately.
      await Promise.all(getAllCameraIds().map(refreshRecordingsList));
      await pollAllStatuses(); // update the FILES counts of cameras whose list panel is closed right away
    } finally {
      btn.disabled = false;
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Status polling — the single mechanism that keeps the dashboard in
  // sync with state that can change on the relay without this browser tab
  // being the one that caused it: another tab, another user, or a
  // camera's alarm-trigger GPIO calling /record directly on the relay.
  // Without this, nothing here updates until the user next clicks
  // something — the REC pill and the file list would silently go
  // stale. Also doubles as the initial-state load on page
  // open (including "was already recording before I opened this page",
  // which previously wasn't handled at all). ──
  async function pollAllStatuses() {
    try {
      const res = await fetch('status.php');
      if (!res.ok) return;
      const data = await res.json();
      // Only trust a genuine status map. An error-shaped or malformed answer must
      // not be read as "no camera has any footage" and wipe the FILES counts.
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return;
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
    } catch (e) {
      // Relay unreachable this round — the next poll will try again.
    }
  }
  const STATUS_POLL_MS = 4000;
  pollAllStatuses();
  setInterval(pollAllStatuses, STATUS_POLL_MS);

  // ── Alarm settings — how long an alarm-triggered recording runs. Stored
  // on the relay (via settings.php), not on the camera boards, so changing
  // it here takes effect on the next alarm without reflashing anything.
  // Saved automatically whenever the field is changed. The same response
  // carries the relay's read-only pre-roll length (config.js), shown next
  // to the duration fields as "+ Ns pre-roll" since every recording is that
  // much longer than the number you type. ──
  const alarmRecordInput = document.getElementById('alarm-record-seconds');
  const alarmStatus      = document.getElementById('alarm-status');

  function setAlarmStatus(text, cls) {
    alarmStatus.textContent = text;
    alarmStatus.className = cls || '';
  }

  function applyAlarmSettings(s) {
    if (document.activeElement !== alarmRecordInput) alarmRecordInput.value = s.alarmRecordSeconds;

    const pre = Number(s.preRollSeconds);
    const note = pre > 0 ? `+ ${pre}s pre-roll` : '';
    const tip = pre > 0
      ? `Every recording also includes the ${pre}s of footage from just BEFORE it was triggered, so the clip is ${pre}s longer than this number.`
      : '';
    for (const id of ['preroll-note-record', 'preroll-note-alarm']) {
      const el = document.getElementById(id);
      el.textContent = note;
      el.title = tip;
    }
  }

  async function loadAlarmSettings() {
    try {
      const res = await fetch('settings.php');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyAlarmSettings(await res.json());
    } catch (e) {
      setAlarmStatus('load failed', 'err');
    }
  }

  async function saveAlarmSettings() {
    const rec = parseInt(alarmRecordInput.value, 10);
    if (!Number.isFinite(rec) || rec < 1) {
      setAlarmStatus('invalid value', 'err');
      return;
    }
    setAlarmStatus('saving…', '');
    try {
      const res = await fetch(`settings.php?alarmRecordSeconds=${rec}`, { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyAlarmSettings(await res.json()); // show exactly what the relay stored
      setAlarmStatus('saved ✓', 'ok');
      setTimeout(() => setAlarmStatus(''), 2500);
    } catch (e) {
      setAlarmStatus('save failed', 'err');
    }
  }
  loadAlarmSettings();

  // ── Layout toggle ──
  function setLayout(mode) {
    document.getElementById('grid').classList.toggle('layout-list', mode === 'list');
    document.getElementById('btn-grid').classList.toggle('active', mode === 'grid');
    document.getElementById('btn-list').classList.toggle('active', mode === 'list');
    localStorage.setItem('esp32-layout', mode);
  }
  const saved = localStorage.getItem('esp32-layout');
  if (saved) setLayout(saved);
</script>
</body>
</html>
