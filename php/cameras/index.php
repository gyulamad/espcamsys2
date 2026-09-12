<?php
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

  .controls { display: flex; align-items: center; gap: 8px; }

  .btn {
    font-family: var(--mono); font-size: .7rem;
    padding: 6px 12px; border-radius: var(--radius);
    border: 1px solid var(--border);
    background: transparent; color: var(--muted);
    cursor: pointer; letter-spacing: .06em; transition: all .2s;
  }
  .btn:hover, .btn.active { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 8px rgba(0,229,255,.2); }

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
    background: rgba(0,0,0,.2); gap: 10px;
  }

  .cam-title {
    display: flex; align-items: center; gap: 8px;
    font-size: .82rem; font-weight: 500;
    letter-spacing: .05em; text-transform: uppercase; color: var(--text);
  }

  .cam-actions { display: flex; gap: 6px; align-items: center; }

  .cam-btn {
    font-family: var(--mono); font-size: .65rem;
    padding: 3px 8px; border-radius: 3px;
    border: 1px solid var(--border);
    background: transparent; color: var(--muted);
    cursor: pointer; text-decoration: none;
    transition: all .15s; letter-spacing: .04em;
  }
  .cam-btn:hover               { border-color: var(--accent);  color: var(--accent); }
  .cam-btn.danger:hover        { border-color: var(--accent2); color: var(--accent2); }

  .rec-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent2); box-shadow: 0 0 6px var(--accent2);
    animation: blink 1.4s ease-in-out infinite; flex-shrink: 0;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }

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
          <button class="cam-btn" onclick="reloadStream('<?= htmlspecialchars($cam['id']) ?>')">↺ RELOAD</button>
          <button class="cam-btn danger" id="hide-<?= htmlspecialchars($cam['id']) ?>"
                  onclick="toggleHide('<?= htmlspecialchars($cam['id']) ?>')">✕ HIDE</button>
        </div>
      </div>

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
    const pill = document.getElementById('pill-' + id);

    // Only reload if not hidden
    if (img.dataset.hidden === '1') return;

    setStatus(id, 'connecting', 'CONNECTING');
    showOverlay(id, '', '');
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

  // ── Hide / show ──
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
