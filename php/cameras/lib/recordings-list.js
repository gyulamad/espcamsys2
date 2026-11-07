// recordings-list.js — the footage list, in ONE place. The dashboard's per-camera FILES panel (index.php)
// and the all-cameras page (all-recordings.php) both draw and drive their list with this file, so the rows,
// the buttons, the selection rules and the delete / download / play behaviour cannot drift apart.
//
// A list has a SOURCE: the cameras whose footage it shows. One camera = a per-camera panel, every camera =
// the all-files page; the code path is the same (load every camera's list, merge, newest first).
//
// Everything goes through recordings.php (camera + file name per request), so the dashboard's login, the
// anti-forgery header, the file-name check and the audit log apply exactly as before. Page elements are
// built with createElement / textContent only, never from HTML strings (security review F-05).
//
// Pages include this file through CamLayout::recordingsListScript() (lib/Layout.php), which also sets
// CamRecordingsList.SAFE_FILENAME from CamLogic::SAFE_FILENAME_REGEX. Unit tested in
// tests/node/test_recordings_list.js (the pure parts) and tests/dom/test_all_recordings_dom.js (the page).

(function (root) {
  'use strict';

  const ENDPOINT = 'recordings.php';
  const AJAX_HEADERS = { 'X-Requested-With': 'camdash' };
  // The relay names a clip <camera id>_<ISO time of the trigger with : and . turned into ->.mp4, e.g.
  // cam1_2026-10-23T09-35-22-123Z.mp4. The time is what "recording time" means for the order of the list.
  const STAMP_PATTERN = /_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.mp4$/;

  const api = {
    // What a recording's name may look like. Overwritten by the page with CamLogic::SAFE_FILENAME_REGEX.
    SAFE_FILENAME: /^[A-Za-z0-9_.-]+\.mp4$/,
  };

  // ── Pure parts (no page, no network) ─────────────────────────────────────

  // When the clip was recorded (ms since the epoch), read from its name; null if the name carries no time.
  function recordedAtMs(filename) {
    const m = STAMP_PATTERN.exec(String(filename));
    if (!m) return null;
    const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
    const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    const back = new Date(t);
    // Date.UTC rolls 2026-13-45 over to a real date; such a name is not a time the relay wrote.
    return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
  }

  // Newest first, like the relay's own per-camera list. Clips without a readable time go last; equal
  // times (and clips without one) fall back to camera + name so the order never jumps between reloads.
  function sortNewestFirst(files) {
    const timeOf = (f) => recordedAtMs(f.filename);
    return files.slice().sort((a, b) => {
      const ta = timeOf(a), tb = timeOf(b);
      if (ta !== tb) {
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      }
      if (a.cam !== b.cam) return a.cam < b.cam ? -1 : 1;
      if (a.filename !== b.filename) return a.filename < b.filename ? 1 : -1;
      return 0;
    });
  }

  // Keeps only what this page may show: an object with a plain recording name. Every entry is tagged
  // with its camera, which is what the actions need. (recordings.php already filters names; this is the
  // second lock so a name can never reach an id, a URL or the page if that filter were bypassed.)
  function tagFiles(cam, list) {
    return list
      .filter((f) => f && typeof f.filename === 'string' && api.SAFE_FILENAME.test(f.filename))
      .map((f) => ({
        cam,
        filename: f.filename,
        sizeBytes: Number.isInteger(f.sizeBytes) && f.sizeBytes >= 0 ? f.sizeBytes : 0,
        seen: f.seen !== false,   // an older relay does not say: counts as seen, so nothing is bold by mistake
        person: f.person === true,
        scan: scanOf(f.scan),
      }));
  }

  // The person check's state of one clip, or null: only the three known shapes get through.
  function scanOf(scan) {
    if (!scan || typeof scan.state !== 'string') return null;
    if (scan.state === 'queued' || scan.state === 'processing') return { state: scan.state };
    if (scan.state === 'error') return { state: 'error', reason: typeof scan.reason === 'string' ? scan.reason : '' };
    return null;
  }

  // Text shown next to a clip that is being (or was tried to be) checked; '' when there is nothing to say.
  function scanLabel(scan) {
    if (!scan) return '';
    if (scan.state === 'queued') return '⏳ waiting to be checked…';
    if (scan.state === 'processing') return '⏳ processing…';
    return `⚠ check failed${scan.reason ? `: ${scan.reason}` : ''}`;
  }

  // Is any clip still waiting for / in the middle of its check? (the list then reloads itself)
  function hasPendingScan(files) {
    return files.some((f) => f.scan && f.scan.state !== 'error');
  }

  // results: [{ cam, files } | { cam, error }] -> { files (merged, newest first), failed: [cam, ...] }
  function mergeResults(results) {
    const files = [];
    const failed = [];
    for (const r of results) {
      if (!r.files) { failed.push(r.cam); continue; }
      files.push(...r.files);
    }
    return { files: sortNewestFirst(files), failed };
  }

  function recordingUrl(cam, query) {
    return `${ENDPOINT}?cam=${encodeURIComponent(cam)}&${query}`;
  }
  const archiveUrl = (cam) => recordingUrl(cam, 'archive=1');
  const archiveListUrl = (cam) => recordingUrl(cam, 'archiveList=1');
  const archivePlayUrl = (cam, filename) => recordingUrl(cam, `archivePlay=${encodeURIComponent(filename)}`);
  const archiveDownloadUrl = (cam, filename) => recordingUrl(cam, `archiveDownload=${encodeURIComponent(filename)}`);
  const thumbUrl = (cam, filename) => recordingUrl(cam, `thumb=${encodeURIComponent(filename)}`);
  const downloadUrl = (cam, filename) => recordingUrl(cam, `download=${encodeURIComponent(filename)}`);
  const playUrl = (cam, filename) => recordingUrl(cam, `play=${encodeURIComponent(filename)}`);

  // A link that opens the all-files page ON a clip (the person notification's link): "?cam=cam1&play=<clip>"
  // -> { cam, filename }, or null when there is no such request or it is not about a known camera and a
  // plain recording name (anything else in the address is ignored, never used).
  function parsePlayRequest(search, cams) {
    const params = new URLSearchParams(String(search || ''));
    const cam = params.get('cam');
    const filename = params.get('play');
    if (cam === null || filename === null) return null;
    if (!cams.includes(cam) || !api.SAFE_FILENAME.test(filename)) return null;
    return { cam, filename };
  }

  // What the button's hover text says: what the archive is, what the button does, and how to look first.
  const ARCHIVE_HINT = 'Permanently deletes the archive: the recordings the person check sorted out because nobody is in them. '
    + 'This cannot be undone. To check them first, look in recordings/<camera>/no-person/ on the relay (over SSH) — see INSTALL.md.';

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // <div class="x">: h('div', {className: 'x'}, child, 'text', ...). Properties are set on the element,
  // `onxxx` are listeners, `dataset` is merged: nothing is ever parsed as markup.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el[k] = v;
    }
    el.append(...children);
    return el;
  }

  // The picture of the person in large: the same JPEG as the thumbnail (it is the whole frame), over the page.
  // A click anywhere on it, or Escape, closes it. Only one is ever open.
  function showPicture(src, caption) {
    const old = document.body.querySelector('.files-lightbox');
    if (old) old.remove();
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    const overlay = h('div', { className: 'files-lightbox', role: 'dialog', ariaLabel: caption, onclick: close },
      h('img', { src, alt: caption }),
      h('span', { className: 'files-lightbox-caption', textContent: caption }));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  // ── Talking to recordings.php ────────────────────────────────────────────

  // The clips a recordings.php list URL answers with, tagged with the camera. Throws when it is not a list.
  async function fetchTagged(cam, url, fetchFn) {
    const res = await fetchFn(url);
    const list = await res.json();
    if (!res.ok || !Array.isArray(list)) throw new Error('not a list');
    return tagFiles(cam, list);
  }

  // One camera's clips. Throws when recordings.php does not answer with a list.
  const fetchCameraFiles = (cam, fetchFn) => fetchTagged(cam, `${ENDPOINT}?cam=${encodeURIComponent(cam)}`, fetchFn);

  // One camera's archived clips (what the person check sorted out), the same way.
  const fetchArchiveFiles = (cam, fetchFn) => fetchTagged(cam, archiveListUrl(cam), fetchFn);

  // Every given camera's clips, merged. A camera that cannot be read is reported in `failed` and does not
  // stop the others (one camera's folder being unreadable must not blank the whole list).
  async function loadCameras(cams, fetchFn, fetchOne = fetchCameraFiles) {
    const results = await Promise.all(cams.map((cam) =>
      fetchOne(cam, fetchFn).then((files) => ({ cam, files }), () => ({ cam, files: null }))));
    return mergeResults(results);
  }

  // How many clips one camera's archive holds. Throws when recordings.php does not answer with a plain count.
  async function fetchArchiveCount(cam, fetchFn) {
    const res = await fetchFn(archiveUrl(cam));
    const data = await res.json();
    if (!res.ok || !data || !Number.isInteger(data.count) || data.count < 0) throw new Error('not a count');
    return data.count;
  }

  // The archive size over the given cameras. A camera whose archive cannot be read counts as 0 and does
  // not stop the others (the list itself is more important than this number).
  async function loadArchiveTotal(cams, fetchFn) {
    const counts = await Promise.all(cams.map((cam) => fetchArchiveCount(cam, fetchFn).catch(() => 0)));
    return counts.reduce((sum, n) => sum + n, 0);
  }

  // A POST of the dashboard (delete one / delete all / mark seen); throws with the server's reason.
  async function post(cam, query, fetchFn) {
    const res = await fetchFn(recordingUrl(cam, query), { method: 'POST', headers: AJAX_HEADERS });
    if (res.ok) return;
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || ('HTTP ' + res.status));
  }

  // What differs between a row of the recordings and a row of the archive: the element ids and the URLs.
  const ARCHIVE_ROW_ID = 'archived';

  // ── The list on a page ───────────────────────────────────────────────────

  // options:
  //   panel      the element the list is drawn into
  //   prefix     what the element ids end with (the camera id for a camera's panel, 'all' for the all page)
  //   cams       the camera ids this list shows
  //   camLabel   (cam) => text shown in front of each row, or null for no label (a single camera's panel)
  //   deleteAllConfirm   the question asked before DELETE ALL
  //   scanPollMs         how often the list reloads while clips are being checked for a person (default 4000; 0 = never)
  //   fetch      defaults to window.fetch (tests pass a fake)
  //   hooks      what the page adds around a request, all optional:
  //     withPaused(fn)        runs a request that needs room (the dashboard closes its live pictures meanwhile)
  //     holdForDownload()     a download was handed to the browser
  //     playersChanged()      the video window was opened, closed, or its clip ended
  //     loaded(files, failed) the list was (re)loaded
  //     confirm / alert       default to the window's
  function create(options) {
    const { panel, prefix, cams } = options;
    const fetchFn = options.fetch || ((...a) => root.fetch(...a));
    const hooks = Object.assign({
      withPaused: (fn) => fn(),
      holdForDownload() {},
      playersChanged() {},
      loaded() {},
      confirm: (text) => root.confirm(text),
      alert: (text) => root.alert(text),
    }, options.hooks);
    const elId = (key) => `files-${key}-${prefix}`;
    let archiveOpen = false;   // is the archive's own list showing?

    function boxes(onlySeen) {
      return Array.from(panel.querySelectorAll('.files-select')).filter((b) => !onlySeen || b.dataset.seen === '1');
    }

    function selected() {
      return Array.from(panel.querySelectorAll('.files-select:checked')).map((b) => ({ cam: b.dataset.cam, filename: b.value }));
    }

    // Keeps the bottom buttons' labels and enabled states in step with the ticks.
    function updateSelectionUI() {
      const n = selected().length;
      const set = (key, disabled, text) => {
        const btn = document.getElementById(elId(key));
        if (!btn) return;
        btn.disabled = disabled;
        btn.textContent = text;
      };
      set('del-selected', n === 0, `🗑 DELETE SELECTED (${n})`);
      set('dl-selected', n === 0, `⬇ DOWNLOAD SELECTED (${n})`);
      set('sort-selected', n === 0, `🧑 SORT OUT SELECTED (${n})`);
      const all = boxes(false), seen = boxes(true);
      set('sel-all', all.length === 0, all.length > 0 && all.every((b) => b.checked) ? '☐ UNSELECT ALL' : '☑ SELECT ALL');
      set('sel-seen', seen.length === 0, seen.length > 0 && seen.every((b) => b.checked) ? '☐ UNSELECT ALL SEEN' : '☑ SELECT ALL SEEN');
    }

    // "Select all" / "Select all seen": ticks every target, or — when they are all ticked already — unticks
    // them. The seen variant leaves unseen clips alone.
    function toggleSelectAll(onlySeen) {
      const targets = boxes(onlySeen);
      const allTicked = targets.length > 0 && targets.every((b) => b.checked);
      targets.forEach((b) => { b.checked = !allTicked; });
      updateSelectionUI();
    }

    function setContent(...nodes) {
      panel.replaceChildren(...nodes);   // the video window lives outside the list: a redraw leaves it alone
    }

    // Playing or downloading a clip counts as seeing it: the row stops being bold right away, and the
    // relay is told (fire and forget — if that fails the clip simply shows as unseen again on the next load).
    function markSeen(cam, filename) {
      const row = document.getElementById(`row-${cam}-${filename}`);
      if (row) {
        row.classList.remove('unseen');
        const box = row.querySelector('.files-select');
        if (box) box.dataset.seen = '1';
      }
      updateSelectionUI();
      post(cam, `seen=${encodeURIComponent(filename)}`, fetchFn).catch(() => null);
    }

    // ── The video window ──
    // A clip plays in a MODAL over the page — as large as the screen allows, which is what makes it usable on
    // a phone — and the list stays behind it, one tap (CLOSE, Escape, a tap beside the video) away. Every PLAY
    // button, the archive's too, and a link that opens the page on a clip (the person notification) go through
    // here, so they all look and behave the same. A plain HTML5 <video>: the browser's own controls do the rest
    // (full screen too). ?play= streams the same bytes as ?download= with Range forwarding, so seeking works.
    // Only one window is ever open; closing it removes the <video>, which stops playback.
    let openClip = null;   // { key, close } of the window that is open, or null
    function openVideo(key, src, caption) {
      if (openClip && openClip.key === key) return;   // that clip is showing already: do not restart it
      if (openClip) openClip.close();
      function close() {
        overlay.remove();
        document.body.classList.remove('files-modal-open');
        document.removeEventListener('keydown', onKey);
        openClip = null;
        hooks.playersChanged();
      }
      function onKey(e) {
        if (e.key === 'Escape') close();
      }
      const closeButton = h('button', { className: 'cam-btn files-video-close', type: 'button', textContent: '✕ CLOSE', ariaLabel: `Close the video ${caption}`, onclick: close });
      const overlay = h('div', { className: 'files-video-modal', role: 'dialog', ariaModal: 'true', ariaLabel: caption, onclick: (e) => { if (e.target === overlay) close(); } },
        h('div', { className: 'files-video-bar' },
          h('span', { className: 'files-video-title', title: caption, textContent: caption }),
          closeButton),
        h('div', { className: 'files-video-stage' },
          h('video', { controls: true, autoplay: true, playsInline: true, src, onended: hooks.playersChanged })));
      document.addEventListener('keydown', onKey);
      document.body.classList.add('files-modal-open');
      document.body.appendChild(overlay);
      openClip = { key, close };
      if (typeof closeButton.focus === 'function') closeButton.focus();
      hooks.playersChanged();
    }

    // What a row's PLAY does: playing counts as seeing it.
    function playRecording(cam, filename) {
      markSeen(cam, filename);
      openVideo(`${cam}/${filename}`, playUrl(cam, filename), filename);
    }

    // Plays a clip of the list as if its PLAY button had been pressed, and scrolls its row into view behind the
    // window. -> false when the clip is not in the list (deleted, or sorted into the archive since): the list is
    // simply shown as it is.
    function playClip(cam, filename) {
      const clipRow = document.getElementById(`row-${cam}-${filename}`);
      if (!clipRow) return false;
      if (!(openClip && openClip.key === `${cam}/${filename}`)) playRecording(cam, filename);
      if (typeof clipRow.scrollIntoView === 'function') clipRow.scrollIntoView({ block: 'start' });
      return true;
    }

    async function runDeletes(requests, failureText) {
      const settled = await hooks.withPaused(async () => {
        const out = await Promise.allSettled(requests);
        await refresh();
        return out;
      });
      const failed = settled.filter((r) => r.status === 'rejected');
      if (failed.length > 0) hooks.alert(`${failureText}${failed.length === requests.length ? '' : ` (${failed.length} of ${requests.length})`}: ${failed[0].reason.message}`);
    }

    async function deleteOne(cam, filename) {
      if (!hooks.confirm(`Delete ${filename}? This cannot be undone.`)) return;
      await runDeletes([post(cam, `delete=${encodeURIComponent(filename)}`, fetchFn)], 'Could not delete recording');
    }

    async function deleteAll() {
      if (!hooks.confirm(options.deleteAllConfirm)) return;
      await runDeletes(cams.map((cam) => post(cam, 'deleteAll=1', fetchFn)), 'Could not delete recordings');
    }

    // Deletes every ticked clip with the same single-file delete the DEL button uses, then reloads the list
    // once. Anything that fails stays in the list and stays ticked, and the user is told how many did not go.
    async function deleteSelected() {
      const picked = selected();
      if (picked.length === 0) return;
      if (!hooks.confirm(`Delete ${plural(picked.length, 'selected recording')}? This cannot be undone.`)) return;
      await runDeletes(picked.map((p) => post(p.cam, `delete=${encodeURIComponent(p.filename)}`, fetchFn)), 'Could not delete recordings');
    }

    // Deletes the archive of every camera of this list for good, after asking (the question says how many).
    async function deleteArchive(archiveTotal) {
      if (archiveTotal === 0) return;
      if (!hooks.confirm(`Permanently delete the ${plural(archiveTotal, 'archived recording')} that the person check sorted out? This cannot be undone.`)) return;
      await runDeletes(cams.map((cam) => post(cam, 'deleteArchive=1', fetchFn)), 'Could not delete the archive');
    }

    // Gives one archived clip back to the recordings; the relay never overwrites one of the same name.
    async function restoreOne(cam, filename) {
      if (!hooks.confirm(`Restore ${filename} to the recordings?`)) return;
      try {
        await hooks.withPaused(async () => {
          await post(cam, `restore=${encodeURIComponent(filename)}`, fetchFn);
        });
      } catch (e) {
        hooks.alert(`Could not restore the recording: ${e.message}`);
      }
      await refresh();
    }

    function toggleArchive() {
      archiveOpen = !archiveOpen;
      return refresh();
    }

    // Downloads every ticked clip. A browser takes one download per click, so they start one after another
    // through a hidden link, with a short pause between (many browsers ask once to "allow multiple downloads").
    // Each clip counts as seen, same as the GET button.
    async function downloadSelected() {
      const picked = selected();
      if (picked.length > 0) hooks.holdForDownload();
      for (let i = 0; i < picked.length; i++) {
        const link = h('a', { href: downloadUrl(picked[i].cam, picked[i].filename), download: picked[i].filename });
        document.body.appendChild(link);
        link.click();
        link.remove();
        markSeen(picked[i].cam, picked[i].filename);
        if (i < picked.length - 1) await new Promise((resolve) => setTimeout(resolve, options.downloadPauseMs ?? 500));
      }
    }

    // "Sort out": the relay checks the clips for a person; one without any is moved aside (or deleted, as the
    // relay is set up). Asks first, since clips leave the list. Then the list is reloaded and keeps reloading
    // while anything is queued or processing.
    async function sortOut(requests, question) {
      if (!hooks.confirm(question)) return;
      const settled = await Promise.allSettled(requests);
      const failed = settled.filter((r) => r.status === 'rejected');
      if (failed.length > 0) hooks.alert(`Could not start the person check${failed.length === requests.length ? '' : ` (${failed.length} of ${requests.length})`}: ${failed[0].reason.message}`);
      await refresh();
    }

    function sortOutSelected() {
      const picked = selected();
      if (picked.length === 0) return Promise.resolve();
      return sortOut(picked.map((p) => post(p.cam, `scan=${encodeURIComponent(p.filename)}`, fetchFn)),
        `Check ${plural(picked.length, 'selected recording')} for a person? Recordings without a person are removed from this list.`);
    }

    function sortOutAll() {
      return sortOut(cams.map((cam) => post(cam, 'scanAll=1', fetchFn)),
        'Check every recording not checked yet for a person? Recordings without a person are removed from this list.');
    }

    let pollTimer = null;
    const playerOpen = () => openClip !== null;
    // Reload while clips are being checked — but never while a clip is playing (a reload would close the player).
    function schedulePoll(files) {
      clearTimeout(pollTimer);
      const ms = options.scanPollMs ?? 4000;
      if (ms <= 0 || !hasPendingScan(files)) return;
      pollTimer = setTimeout(() => (playerOpen() ? schedulePoll(files) : refresh()), ms);
    }

    function row(f, keep) {
      const label = options.camLabel ? options.camLabel(f.cam) : null;
      return [
        h('div', { className: 'files-row' + (f.seen ? '' : ' unseen'), id: `row-${f.cam}-${f.filename}` },
          h('input', { type: 'checkbox', className: 'files-select', value: f.filename, checked: keep.has(`${f.cam}/${f.filename}`),
                       ariaLabel: `Select ${f.filename}`, dataset: { cam: f.cam, seen: f.seen ? '1' : '0' }, onchange: updateSelectionUI }),
          ...(label === null ? [] : [h('span', { className: 'files-cam', title: label, textContent: label })]),
          ...(f.person ? [h('button', { className: 'files-thumb-btn', type: 'button', title: 'Click to enlarge', ariaLabel: `Enlarge the picture of the person in ${f.filename}`,
                                       onclick: () => showPicture(thumbUrl(f.cam, f.filename), f.filename) },
            h('img', { className: 'files-thumb', src: thumbUrl(f.cam, f.filename), alt: `Person in ${f.filename}`, loading: 'lazy', width: 96 }))] : []),
          h('span', { className: 'files-name', textContent: f.filename }),
          h('span', { className: 'files-size', textContent: formatBytes(f.sizeBytes) }),
          ...(f.scan ? [h('span', { className: 'files-scan' + (f.scan.state === 'error' ? ' error' : ''), textContent: scanLabel(f.scan) })] : []),
          h('button', { className: 'cam-btn', textContent: '▶ PLAY', onclick: () => playRecording(f.cam, f.filename) }),
          h('a', { className: 'cam-btn', textContent: '⬇ GET', href: downloadUrl(f.cam, f.filename), onclick: () => { hooks.holdForDownload(); markSeen(f.cam, f.filename); } }),
          h('button', { className: 'cam-btn danger', textContent: '🗑 DEL', onclick: () => deleteOne(f.cam, f.filename) })),
      ];
    }

    // One row of the archive: where it is from, its name and size, and what can be done with it.
    function archiveRow(f) {
      const label = options.camLabel ? options.camLabel(f.cam) : null;
      return [
        h('div', { className: 'files-row', id: `${ARCHIVE_ROW_ID}-${f.cam}-${f.filename}` },
          ...(label === null ? [] : [h('span', { className: 'files-cam', textContent: label })]),
          h('span', { className: 'files-name', textContent: f.filename }),
          h('span', { className: 'files-size', textContent: formatBytes(f.sizeBytes) }),
          h('button', { className: 'cam-btn', textContent: '▶ PLAY', onclick: () => openVideo(`${ARCHIVE_ROW_ID}/${f.cam}/${f.filename}`, archivePlayUrl(f.cam, f.filename), f.filename) }),
          h('a', { className: 'cam-btn', textContent: '⬇ GET', href: archiveDownloadUrl(f.cam, f.filename), onclick: () => hooks.holdForDownload() }),
          h('button', { className: 'cam-btn', textContent: '♻ RESTORE', title: 'Put this recording back into the list', onclick: () => restoreOne(f.cam, f.filename) })),
      ];
    }

    // The archive's list under the header while it is open. { files, failed } as loadCameras gives them.
    function archiveSection({ files, failed }) {
      const notes = failed.length === 0 ? [] : [empty(`Could not load the archive of: ${failed.map((c) => (options.camLabel ? options.camLabel(c) : c)).join(', ')}`)];
      const body = files.length === 0 && failed.length === 0 ? [empty('The archive is empty.')] : files.flatMap(archiveRow);
      return h('div', { className: 'files-archive' },
        h('div', { className: 'files-archive-title', textContent: `Archive: ${plural(files.length, 'recording')} that the person check sorted out` }),
        ...notes, ...body);
    }

    function footer() {
      return h('div', { className: 'files-panel-footer' },
        h('button', { className: 'cam-btn', id: elId('sel-all'), textContent: '☑ SELECT ALL', onclick: () => toggleSelectAll(false) }),
        h('button', { className: 'cam-btn', id: elId('sel-seen'), textContent: '☑ SELECT ALL SEEN', onclick: () => toggleSelectAll(true) }),
        h('button', { className: 'cam-btn', id: elId('dl-selected'), disabled: true, textContent: '⬇ DOWNLOAD SELECTED (0)', onclick: downloadSelected }),
        h('button', { className: 'cam-btn', id: elId('sort-selected'), disabled: true, textContent: '🧑 SORT OUT SELECTED (0)', onclick: sortOutSelected }),
        h('button', { className: 'cam-btn danger', id: elId('del-selected'), disabled: true, textContent: '🗑 DELETE SELECTED (0)', onclick: deleteSelected }));
    }

    const empty = (text) => h('div', { className: 'files-empty', textContent: text });

    // The header: the clip count (when there are clips) and the buttons that act on the whole list.
    function header(fileCount, archiveTotal) {
      return h('div', { className: 'files-panel-header' },
        h('span', { textContent: fileCount > 0 ? plural(fileCount, 'recording') : '' }),
        ...(fileCount > 0 ? [h('button', { className: 'cam-btn', id: elId('sort-all'), textContent: '🧑 SORT OUT ALL', onclick: sortOutAll })] : []),
        ...(archiveTotal > 0 ? [h('button', { className: 'cam-btn', id: elId('browse-archive'), title: 'Look at the archived recordings and put back the ones you want to keep',
                                             textContent: archiveOpen ? '📂 HIDE ARCHIVE' : '📂 BROWSE ARCHIVE', onclick: toggleArchive })] : []),
        ...(archiveTotal > 0 ? [h('button', { className: 'cam-btn danger', id: elId('delete-archive'), title: ARCHIVE_HINT,
                                             textContent: `🗄 DELETE ARCHIVE (${archiveTotal})`, onclick: () => deleteArchive(archiveTotal) })] : []),
        ...(fileCount > 0 ? [h('button', { className: 'cam-btn danger', id: elId('delete-all'), textContent: '🗑 DELETE ALL', onclick: deleteAll })] : []));
    }

    // Loads and draws the list. A draw that fails shows a message in the panel instead of throwing.
    async function refresh() {
      try {
        const [{ files, failed }, archiveTotal] = await Promise.all([loadCameras(cams, fetchFn), loadArchiveTotal(cams, fetchFn)]);
        if (archiveTotal === 0) archiveOpen = false;   // nothing left to browse (restored or deleted)
        const archived = archiveOpen ? await loadCameras(cams, fetchFn, fetchArchiveFiles) : null;
        const archiveNodes = archived ? [archiveSection(archived)] : [];
        hooks.loaded(files, failed);
        schedulePoll(files);
        if (cams.length > 0 && failed.length === cams.length) {   // every camera failed (no cameras is just an empty list)
          setContent(empty('Could not load recordings.'));
          return;
        }
        const notice = failed.length === 0 ? [] : [empty(`Could not load the recordings of: ${failed.map((c) => (options.camLabel ? options.camLabel(c) : c)).join(', ')}`)];
        if (files.length === 0) {
          // Everything may have been sorted into the archive: it can still be deleted from here.
          setContent(...(archiveTotal > 0 ? [header(0, archiveTotal)] : []), ...archiveNodes, ...notice, empty('No recordings yet.'));
          return;
        }
        // Keep whatever was ticked across a re-render (the list refreshes itself when a recording finishes).
        const keep = new Set(selected().map((p) => `${p.cam}/${p.filename}`));
        setContent(header(files.length, archiveTotal), ...archiveNodes, ...notice, ...files.flatMap((f) => row(f, keep)), footer());
        updateSelectionUI();
      } catch (e) {
        setContent(empty('Could not load recordings.'));
      }
    }

    return { refresh, selected, toggleSelectAll, deleteAll, playClip };
  }

  Object.assign(api, {
    create, parsePlayRequest, loadCameras, fetchCameraFiles, post, recordedAtMs, sortNewestFirst, tagFiles, mergeResults,
    fetchArchiveCount, fetchArchiveFiles, loadArchiveTotal, ARCHIVE_HINT, archiveListUrl, archivePlayUrl, archiveDownloadUrl,
    recordingUrl, downloadUrl, playUrl, archiveUrl, thumbUrl, showPicture, scanOf, scanLabel, hasPendingScan, formatBytes, h,
  });

  root.CamRecordingsList = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
