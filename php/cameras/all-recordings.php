<?php
// all-recordings.php — the ALL FILES page: every saved recording of every camera in one list, newest
// first, with the same rows and buttons as a camera's own FILES panel on the dashboard (play, download,
// delete, select, select all / all seen, download / delete selected, delete all).
//
// ?cam=<camera>&play=<clip> opens the page with that clip playing in the video window, exactly as if its PLAY
// button had been pressed (the link in the person notification): the visitor stays in the web app, with every
// other recording behind the window.
//
// The page only draws the shell. The list itself is lib/recordings-list.js — the same code the
// dashboard's per-camera panels run — and it reads and changes footage through recordings.php (one
// request per camera and file), so the login, the anti-forgery header, the file-name check and the audit
// log are exactly the ones the per-camera list already has. Nothing here talks to the relay.
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/cameras.php';
require_once __DIR__ . '/lib/Logic.php';
require_once __DIR__ . '/lib/Layout.php';

// Camera id => the name shown in front of each clip. Encoded so it can never end the script or become markup.
$cameraLabelsJson = json_encode(
    CamLogic::cameraLabels($cameras),
    JSON_FORCE_OBJECT | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
);
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>All files — ESP32-CAM Dashboard</title>
<?= CamLayout::faviconLinks() ?>
<link rel="stylesheet" href="fonts/fonts.css">
<style>
  :root {
    --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80;
    --accent: #00e5ff; --accent2: #ff4f5e; --text: #cdd8f0; --muted: #4a5780;
    --seen: #858c99;   /* footage already played or downloaded: a neutral gray, readable on the panel */
    --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif; --radius: 6px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-weight: 300; min-height: 100vh; }
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    padding: 18px 32px; border-bottom: 1px solid var(--border); background: var(--surface);
  }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  header h1 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: .12em; color: var(--accent); }
  header p { font-size: .72rem; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
  .btn {
    font-family: var(--mono); font-size: .75rem; padding: 7px 14px; border-radius: var(--radius);
    border: 1px solid var(--border-light); background: transparent; color: var(--text);
    cursor: pointer; letter-spacing: .06em; text-decoration: none; display: inline-block; transition: all .2s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 32px 60px; }
  .files-panel { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); font-size: .7rem; }
  @media (max-width: 700px) {
    header, main { padding-left: 16px; padding-right: 16px; }
  }
<?= CamLayout::recordingsListStyle() ?>
<?= CamLayout::navBarStyle() ?>
<?= CamLayout::busyStyle() ?>
</style>
</head>
<body>
<?= CamLayout::navBar('all-files') ?>
<header>
  <div>
    <h1>📼 ALL FILES</h1>
    <p>Every camera · newest first</p>
  </div>
  <div class="header-actions">
    <button class="btn" id="btn-refresh" type="button" title="Load the list again">↺ REFRESH</button>
  </div>
</header>

<main>
  <div class="files-panel open" id="files-all"><div class="files-empty">Loading…</div></div>
</main>

<script src="js/busy.js"></script>
<?= CamLayout::recordingsListScript() ?>
<script>
  const CAMERA_LABELS = <?= $cameraLabelsJson ?>;
  const list = CamRecordingsList.create({
    panel: document.getElementById('files-all'),
    prefix: 'all',
    cams: Object.keys(CAMERA_LABELS),
    camLabel: (cam) => CAMERA_LABELS[cam],
    deleteAllConfirm: 'Delete ALL recordings for EVERY camera? This cannot be undone.',
  });
  document.getElementById('btn-refresh').addEventListener('click', list.refresh);
  // Opened from a link ("all-recordings.php?cam=cam1&play=<clip>", e.g. the person notification): the list
  // loads as always and that clip opens in the video window, as with PLAY. Anything else in the address is ignored.
  const wanted = CamRecordingsList.parsePlayRequest(location.search, Object.keys(CAMERA_LABELS));
  list.refresh().then(() => { if (wanted) list.playClip(wanted.cam, wanted.filename); });
</script>
<?= CamLayout::storageWarningScript() ?>
</body>
</html>
