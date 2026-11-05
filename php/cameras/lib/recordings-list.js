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
  const thumbUrl = (cam, filename) => recordingUrl(cam, `thumb=${encodeURIComponent(filename)}`);
  const downloadUrl = (cam, filename) => recordingUrl(cam, `download=${encodeURIComponent(filename)}`);
  const playUrl = (cam, filename) => recordingUrl(cam, `play=${encodeURIComponent(filename)}`);

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

  // One camera's clips, tagged with the camera. Throws when recordings.php does not answer with a list.
  async function fetchCameraFiles(cam, fetchFn) {
    const res = await fetchFn(`${ENDPOINT}?cam=${encodeURIComponent(cam)}`);
    const list = await res.json();
    if (!res.ok || !Array.isArray(list)) throw new Error('not a list');
    return tagFiles(cam, list);
  }

  // Every given camera's clips, merged. A camera that cannot be read is reported in `failed` and does not
  // stop the others (one camera's folder being unreadable must not blank the whole list).
  async function loadCameras(cams, fetchFn) {
    const results = await Promise.all(cams.map((cam) =>
      fetchCameraFiles(cam, fetchFn).then((files) => ({ cam, files }), () => ({ cam, files: null }))));
    return mergeResults(results);
  }

  // A POST of the dashboard (delete one / delete all / mark seen); throws with the server's reason.
  async function post(cam, query, fetchFn) {
    const res = await fetchFn(recordingUrl(cam, query), { method: 'POST', headers: AJAX_HEADERS });
    if (res.ok) return;
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || ('HTTP ' + res.status));
  }

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
  //     playersChanged()      a player was opened, closed or removed
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
      panel.replaceChildren(...nodes);
      hooks.playersChanged();   // the list was redrawn, which removed any player in it
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

    // A plain HTML5 <video> under the clicked row; the browser's own player does the rest. ?play= streams
    // the same bytes as ?download= with Range forwarding, so seeking works.
    function togglePlay(cam, filename) {
      const container = document.getElementById(`player-${cam}-${filename}`);
      if (!container) return;
      if (container.dataset.open === '1') {
        container.replaceChildren();   // removing the <video> stops playback
        container.dataset.open = '0';
        hooks.playersChanged();
        return;
      }
      container.replaceChildren(h('video', { controls: true, autoplay: true, src: playUrl(cam, filename), onended: hooks.playersChanged }));
      container.dataset.open = '1';
      hooks.playersChanged();
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
    const playerOpen = () => panel.querySelector('.files-player[data-open="1"]') !== null;
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
          h('button', { className: 'cam-btn', textContent: '▶ PLAY', onclick: () => { markSeen(f.cam, f.filename); togglePlay(f.cam, f.filename); } }),
          h('a', { className: 'cam-btn', textContent: '⬇ GET', href: downloadUrl(f.cam, f.filename), onclick: () => { hooks.holdForDownload(); markSeen(f.cam, f.filename); } }),
          h('button', { className: 'cam-btn danger', textContent: '🗑 DEL', onclick: () => deleteOne(f.cam, f.filename) })),
        h('div', { className: 'files-player', id: `player-${f.cam}-${f.filename}` }),
      ];
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

    // Loads and draws the list. A draw that fails shows a message in the panel instead of throwing.
    async function refresh() {
      try {
        const { files, failed } = await loadCameras(cams, fetchFn);
        hooks.loaded(files, failed);
        schedulePoll(files);
        if (cams.length > 0 && failed.length === cams.length) {   // every camera failed (no cameras is just an empty list)
          setContent(empty('Could not load recordings.'));
          return;
        }
        const notice = failed.length === 0 ? [] : [empty(`Could not load the recordings of: ${failed.map((c) => (options.camLabel ? options.camLabel(c) : c)).join(', ')}`)];
        if (files.length === 0) {
          setContent(...notice, empty('No recordings yet.'));
          return;
        }
        // Keep whatever was ticked across a re-render (the list refreshes itself when a recording finishes).
        const keep = new Set(selected().map((p) => `${p.cam}/${p.filename}`));
        const header = h('div', { className: 'files-panel-header' },
          h('span', { textContent: plural(files.length, 'recording') }),
          h('button', { className: 'cam-btn', id: elId('sort-all'), textContent: '🧑 SORT OUT ALL', onclick: sortOutAll }),
          h('button', { className: 'cam-btn danger', id: elId('delete-all'), textContent: '🗑 DELETE ALL', onclick: deleteAll }));
        setContent(header, ...notice, ...files.flatMap((f) => row(f, keep)), footer());
        updateSelectionUI();
      } catch (e) {
        setContent(empty('Could not load recordings.'));
      }
    }

    return { refresh, selected, toggleSelectAll, deleteAll };
  }

  Object.assign(api, {
    create, loadCameras, fetchCameraFiles, post, recordedAtMs, sortNewestFirst, tagFiles, mergeResults,
    recordingUrl, downloadUrl, playUrl, thumbUrl, showPicture, scanOf, scanLabel, hasPendingScan, formatBytes, h,
  });

  root.CamRecordingsList = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
