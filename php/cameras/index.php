<?php
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
$count = count($cameras);
$cols  = $count === 1 ? 1 : ($count <= 4 ? 2 : 3);
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

  .record-controls { display: flex; align-items: center; gap: 6px; }
  .record-controls input[type=number] {
    width: 60px; font-family: var(--mono); font-size: .7rem;
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius); padding: 6px 8px;
  }
  .record-controls span.unit { font-family: var(--mono); font-size: .65rem; color: var(--muted); }

  /* ── Main grid ── */
  main { flex: 1; padding: 24px 32px; }

  .grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    gap: 20px;
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

  /* Power-on duration field, sits directly next to the ⏻ ON/OFF button */
  .pwr-controls { display: flex; align-items: center; gap: 4px; }
  .pwr-controls input[type=number] {
    width: 52px; font-family: var(--mono); font-size: .65rem;
    background: transparent; border: 1px solid var(--border); color: var(--text);
    border-radius: 3px; padding: 4px 6px;
  }
  .pwr-controls .unit { font-family: var(--mono); font-size: .6rem; color: var(--muted); }

  /* Auto power-off countdown pill, shown while a camera is on a timer */
  .pwr-pill {
    font-family: var(--mono); font-size: .62rem;
    padding: 2px 7px; border-radius: 20px;
    border: 1px solid var(--border); color: var(--accent);
    white-space: nowrap; display: none;
  }
  .pwr-pill.active { display: inline-block; }

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
    max-height: 320px; overflow-y: auto;
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
      <button class="btn" id="btn-record-all" onclick="recordAll()"
              title="Press again mid-recording to extend it by this many seconds from now">⏺ RECORD ALL</button>
      <button class="btn danger" id="btn-stop-all" onclick="stopRecordAll()" style="display:none;">⏹ STOP ALL</button>
      <button class="btn danger" id="btn-delete-all" onclick="deleteAllRecordingsEverywhere()"
              title="Delete every saved recording, for every camera">🗑 DELETE ALL FOOTAGE</button>
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
          <span class="pwr-pill" id="pwrpill-<?= htmlspecialchars($cam['id']) ?>"></span>
          <span class="pwr-controls">
            <input type="number" id="pwr-seconds-<?= htmlspecialchars($cam['id']) ?>" min="1" max="3600" value="300"
                   title="How long ⏻ ON keeps the camera powered before it auto powers-off">
            <span class="unit">sec</span>
          </span>
          <button class="cam-btn" id="pwr-<?= htmlspecialchars($cam['id']) ?>" data-enabled="1"
                  title="Turn this camera's capture on for the given duration, or off now, on the device itself (power + bandwidth saving)"
                  onclick="togglePower('<?= htmlspecialchars($cam['id']) ?>')">⏻ ON</button>
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
        <button class="cam-btn" onclick="toggleRecordingsPanel('<?= htmlspecialchars($cam['id']) ?>')">📼 FILES</button>
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

  // ── Hide / show (local to this browser tab only — the camera itself
  // keeps capturing and pushing frames; use the ⏻ power button to actually
  // stop the device) ──
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

  // ── Power on/off (real, device-side — tells the ESP32-CAM to stop or
  // resume capturing/pushing frames entirely, for power and bandwidth
  // saving). Affects every viewer of this camera, not just this tab.
  //
  // Works the same way recording does: turning ON runs the camera for the
  // number of seconds in the field next to the button (300 by default),
  // then it powers itself back off automatically — nobody has to remember
  // to turn it off. Pressing ON again while already on extends it: the
  // countdown resets to the new seconds value measured from that second
  // press, rather than adding on top of what was left. Turning OFF is
  // immediate and cancels any pending auto-off. ──
  const powerCountdowns = {}; // id -> interval id

  async function togglePower(id) {
    const btn = document.getElementById('pwr-' + id);
    const wantEnable = btn.dataset.enabled === '0';
    btn.disabled = true;
    try {
      let url = `control.php?cam=${encodeURIComponent(id)}&enabled=${wantEnable ? 1 : 0}`;
      if (wantEnable) {
        const secondsInput = document.getElementById('pwr-seconds-' + id);
        const seconds = parseInt(secondsInput.value, 10);
        if (!Number.isFinite(seconds) || seconds < 1) {
          alert('Enter a valid number of seconds');
          return;
        }
        url += `&seconds=${seconds}`;
      }
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) throw new Error('control request failed: ' + res.status);
      const data = await res.json();
      setPower(id, data.enabled, data.enabledUntil);
    } catch (e) {
      console.error('Power toggle failed for', id, e);
    } finally {
      btn.disabled = false;
    }
  }

  // wasEnabled/wasRecording transitions (below) exist so polling every few
  // seconds — needed to pick up changes from other tabs, other users, or a
  // camera's own alarm-trigger GPIO calling the relay directly — doesn't
  // reset the live stream or re-render the overlay on every single poll
  // when nothing has actually changed.
  function setPower(id, enabled, enabledUntil) {
    const btn = document.getElementById('pwr-' + id);
    const wasEnabled = btn.dataset.enabled === '1';
    btn.dataset.enabled = enabled ? '1' : '0';
    btn.textContent = enabled ? '⏻ ON' : '⏻ OFF';
    btn.classList.toggle('danger', !enabled);

    if (enabled) {
      if (!wasEnabled) reloadStream(id); // only reconnect the <img> on an actual off->on transition
      if (enabledUntil) {
        const remaining = Math.max(1, Math.round((new Date(enabledUntil).getTime() - Date.now()) / 1000));
        beginPowerCountdown(id, remaining); // safe to call every poll — resyncs the pill to the real remaining time
      } else {
        endPowerCountdown(id); // on indefinitely (or unknown) — no countdown to show
      }
    } else {
      endPowerCountdown(id);
      if (wasEnabled) {
        setStatus(id, 'hidden', 'POWERED OFF');
        showOverlay(id, '⏻', 'CAMERA POWERED OFF', false);
        document.getElementById('overlay-' + id).innerHTML +=
          `<button class="cam-btn" onclick="togglePower('${id}')">⏻ TURN ON</button>`;
      }
    }
  }

  function beginPowerCountdown(id, seconds) {
    const pill = document.getElementById('pwrpill-' + id);
    if (!pill) return;
    let remaining = seconds;
    pill.classList.add('active');
    pill.textContent = `⏻ AUTO-OFF ${remaining}s`;

    if (powerCountdowns[id]) clearInterval(powerCountdowns[id]);
    powerCountdowns[id] = setInterval(async () => {
      remaining -= 1;
      if (remaining <= 0) {
        endPowerCountdown(id);
        // The relay's own timer is the source of truth for the actual
        // device state — re-check it rather than assuming OFF locally,
        // in case of clock drift or a mid-flight extend from this request.
        try {
          const res = await fetch(`control.php?cam=${encodeURIComponent(id)}`);
          if (res.ok) {
            const data = await res.json();
            setPower(id, data.enabled, data.enabledUntil);
          }
        } catch (e) {
          // Relay unreachable — leave things as-is, next reload will resync.
        }
      } else {
        pill.textContent = `⏻ AUTO-OFF ${remaining}s`;
      }
    }, 1000);
  }

  function endPowerCountdown(id) {
    const pill = document.getElementById('pwrpill-' + id);
    if (powerCountdowns[id]) { clearInterval(powerCountdowns[id]); delete powerCountdowns[id]; }
    if (pill) { pill.classList.remove('active'); pill.textContent = ''; }
  }

  // Initial per-camera power/recording state is seeded by pollAllStatuses()
  // near the bottom of this script, which also keeps re-polling afterwards —
  // see the comment there for why a single mechanism covers both cases.

  // ── Recording — one button + one duration field starts a timed,
  // server-side recording on every camera at once (footage is written on
  // the Pi by server.js, not on the ESP32-CAM boards). Pressing it again
  // while already recording extends that same recording: the relay resets
  // its countdown to the new seconds value measured from the moment of
  // this second press, rather than adding on top of what was left. ──
  const recordCountdowns = {}; // id -> interval id

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
        // Recording keeps the camera powered on for at least as long as the
        // recording runs (see ensurePoweredThrough() on the relay) — reflect
        // whatever power state that produced in the ⏻ button/pill right away,
        // instead of waiting for the next manual toggle or page load.
        if (data.enabled !== undefined) {
          setPower(id, data.enabled, data.enabledUntil);
        }
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
  // regardless of whether anything happened. Mirrors setPower()'s
  // wasEnabled gating for the same reason.
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
  // something — the ⏻ button, the REC pill, and the file list would all
  // silently go stale. Also doubles as the initial-state load on page
  // open (including "was already recording before I opened this page",
  // which previously wasn't handled at all). ──
  async function pollAllStatuses() {
    try {
      const res = await fetch('status.php');
      if (!res.ok) return;
      const data = await res.json();
      for (const id of getAllCameraIds()) {
        const s = data[id];
        if (!s) continue; // camera hasn't registered with the relay yet
        setPower(id, s.enabled, s.enabledUntil);
        applyRecordingState(id, s.recording, s.recordingEndAt);
      }
    } catch (e) {
      // Relay unreachable this round — the next poll will try again.
    }
  }
  const STATUS_POLL_MS = 4000;
  pollAllStatuses();
  setInterval(pollAllStatuses, STATUS_POLL_MS);

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
