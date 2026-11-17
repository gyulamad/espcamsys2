'use strict';
// sound-library.js — the alarm sound library on the settings page: the list of sound files with a button to try each
// one (in THIS browser, or on the relay machine's own speaker), to delete it, and an upload. Everything acts at once,
// like the camera list: a sound is not part of the SAVE bar. Which sound an alarm uses is chosen in the form above
// (the "Alarm sounds" settings), where this list's changes show up as soon as they happen (onChange).
//
//   const library = CamSoundLibrary.mount(container, { fetch, notify, confirm, onChange, run, createAudio });
//   library.refresh()        reads the list again
//
// The server decides what is allowed (sounds.php / sounds-admin.php, and the relay behind them: name, format, size,
// how many); the checks here only save a round trip and say it in plain words — nothing depends on them. Every name,
// size and message that comes from the server is put on the page as TEXT, never as markup.
// The pure helpers are tested in tests/node/test_sound_library.js, the page part in tests/dom/test_sound_library_dom.js.

(function (root) {
  const EXTENSIONS = ['.wav', '.mp3', '.ogg'];
  const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  const MIN_BYTES = 44;   // the relay's lower limit: a WAV header alone is 44 bytes
  // What marks a request as the dashboard's own deliberate one: sounds-admin.php refuses a change without it, so a form
  // on another site cannot make a browser add, replace or delete a sound. (The same constant as every dashboard page.)
  const AJAX_HEADERS = { 'X-Requested-With': 'camdash' };

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // A file name from the person's computer -> a name the library accepts: letters, digits . _ - only (anything else
  // becomes _), starting with a letter or digit, at most 64 characters, the extension in lower case. null when the
  // extension is not one of the three formats.
  function safeName(fileName) {
    const last = String(fileName || '').split(/[\\/]/).pop();
    const dot = last.lastIndexOf('.');
    const ext = dot < 0 ? '' : last.slice(dot).toLowerCase();
    if (!EXTENSIONS.includes(ext)) return null;
    let base = last.slice(0, dot).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '');
    base = base.slice(0, 64 - ext.length);
    if (base === '') return null;
    const name = base + ext;
    return NAME_PATTERN.test(name) ? name : null;
  }

  // May this file be uploaded? -> { name, replaces } | { error }. `state`: { maxBytes, maxSounds, sounds: [{ name }] }.
  function checkUpload(file, state) {
    if (!file) return { error: 'Choose a sound file first.' };
    const name = safeName(file.name);
    if (name === null) return { error: 'A sound must be a ' + EXTENSIONS.join(', ') + ' file.' };
    if (file.size < MIN_BYTES) return { error: 'That file is too small to be a sound.' };
    if (file.size > state.maxBytes) return { error: 'That file is too large (' + formatBytes(file.size) + '): a sound can be at most ' + formatBytes(state.maxBytes) + '.' };
    const replaces = state.sounds.some((s) => s.name === name);
    if (!replaces && state.sounds.length >= state.maxSounds) return { error: 'There are already ' + state.maxSounds + ' sounds — delete one first.' };
    return { name, replaces };
  }

  const soundUrl = (name) => 'sounds.php?name=' + encodeURIComponent(name);
  const adminUrl = (action, name) => 'sounds-admin.php?action=' + action + '&name=' + encodeURIComponent(name);

  // deps: fetch, notify(text, kind), confirm(text) -> boolean, onChange(names) after every change of the list, run(button, fn) (a busy indicator around an action;
  // default: just run it), createAudio(url) (default: new Audio).
  function mount(container, deps) {
    const doc = container.ownerDocument;
    const {
      fetch: request, notify = () => {}, confirm: ask = () => true, onChange = () => {},
      run = (button, fn) => fn(), createAudio = (url) => new root.Audio(url),
    } = deps;
    let state = { sounds: [], maxBytes: 0, maxSounds: 0 };
    let previewing = null;

    const el = (tag, props, ...children) => {
      const e = doc.createElement(tag);
      Object.assign(e, props || {});
      for (const c of children) e.append(c);
      return e;
    };
    const list = el('div', { className: 'sound-list' });
    const file = el('input', { type: 'file', accept: EXTENSIONS.join(',') + ',audio/*' });
    file.setAttribute('aria-label', 'Sound file to upload');
    const uploadBtn = el('button', { className: 'btn', type: 'button', textContent: '⬆ UPLOAD' });
    const limits = el('div', { className: 'help' });
    container.append(list, el('div', { className: 'add' }, file, uploadBtn), limits);

    // One change to the library: the answer's error text, or null when it worked.
    async function call(action, name, body) {
      const init = { method: 'POST', headers: Object.assign({}, AJAX_HEADERS) };
      if (body !== undefined) { init.body = body; init.headers['Content-Type'] = 'application/octet-stream'; }
      let res;
      try {
        res = await request(adminUrl(action, name), init);
      } catch (err) {
        return 'Could not reach the dashboard server';
      }
      const data = await res.json().catch(() => ({}));
      return res.ok && data.ok ? { data } : (data.error || 'Error ' + res.status);
    }

    function preview(name) {
      if (previewing) { try { previewing.pause(); } catch (err) { /* already gone */ } }
      previewing = createAudio(soundUrl(name));
      const started = previewing.play();
      if (started && typeof started.catch === 'function') started.catch(() => notify('Your browser could not play ' + name + '.', 'error'));
    }

    async function tryOnRelay(name) {
      const r = await call('play', name);
      if (typeof r === 'string') notify(r, 'error');
      else notify('Playing ' + name + ' on the relay machine…', 'ok');
    }

    async function remove(name) {
      if (!ask('Delete the sound ' + name + '?')) return;
      const r = await call('delete', name);
      if (typeof r === 'string') { notify(r, 'error'); return; }
      notify('Deleted ' + name + '.', 'ok');
      await refresh();
    }

    function draw() {
      list.textContent = '';
      if (!state.sounds.length) list.append(el('div', { className: 'help', textContent: 'No sounds yet — upload one below.' }));
      for (const s of state.sounds) {
        const play = el('button', { className: 'btn', type: 'button', textContent: '▶ PLAY', title: 'Play it in this browser' });
        const relay = el('button', { className: 'btn', type: 'button', textContent: '🔊 ON RELAY', title: 'Play it on the relay machine\'s own speaker' });
        const del = el('button', { className: 'btn', type: 'button', textContent: '🗑 DELETE' });
        play.addEventListener('click', () => preview(s.name));
        relay.addEventListener('click', () => run(relay, () => tryOnRelay(s.name)));
        del.addEventListener('click', () => run(del, () => remove(s.name)));
        list.append(el('div', { className: 'cam-row sound-row' }, el('div', { className: 'nm' }, s.name, el('small', { textContent: formatBytes(s.bytes) })), play, relay, del));
      }
      limits.textContent = 'WAV, MP3 or OGG, up to ' + formatBytes(state.maxBytes) + ' each, at most ' + state.maxSounds + ' sounds. '
        + 'Keep them short. A name uses letters, digits and . _ - only (anything else in the file\'s name becomes _). '
        + 'Uploading a name that exists replaces it. A sound an alarm uses cannot be deleted until another is chosen there.';
    }

    async function refresh() {
      try {
        const res = await request('sounds.php', { headers: AJAX_HEADERS });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.sounds)) throw new Error(data.error || 'Error ' + res.status);
        state = { sounds: data.sounds, maxBytes: data.maxBytes, maxSounds: data.maxSounds };
        draw();
        onChange(state.sounds.map((s) => s.name));
      } catch (err) {
        list.textContent = '';
        list.append(el('div', { className: 'help', textContent: 'Could not load the sounds: ' + (err && err.message ? err.message : err) }));
      }
    }

    async function upload() {
      const chosen = file.files && file.files[0];
      const checked = checkUpload(chosen, state);
      if (checked.error) { notify(checked.error, 'error'); return; }
      if (checked.replaces && !ask('A sound called ' + checked.name + ' exists already. Replace it?')) return;
      const r = await call('upload', checked.name, chosen);
      if (typeof r === 'string') { notify(r, 'error'); return; }
      file.value = '';
      notify((r.data.replaced ? 'Replaced ' : 'Uploaded ') + checked.name + '.', 'ok');
      await refresh();
    }
    uploadBtn.addEventListener('click', () => run(uploadBtn, upload));

    return { refresh };
  }

  const api = { mount, formatBytes, safeName, checkUpload, EXTENSIONS };
  root.CamSoundLibrary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
